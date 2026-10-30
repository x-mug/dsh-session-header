/**
 * Tests for the tools/execute injection phase (issue #1) plus regression
 * coverage for the existing llm/stream behavior.
 *
 * Run with: node --test test/
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, Config, normalizeSessionId, register, unregister } from '../index.js'

/** Record every fetch the plugin (and the code under test) performs. */
function installFetchRecorder() {
  const calls = []
  const original = globalThis.fetch
  const fn = async (input, init) => {
    const headers = new Headers(input instanceof Request ? input.headers : undefined)
    if (init?.headers !== undefined) {
      for (const [key, value] of new Headers(init.headers)) headers.set(key, value)
    }
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url
    calls.push({ url, headers, redirect: init?.redirect, request: input instanceof Request ? input : undefined })
    return new Response('ok', { status: 200 })
  }
  globalThis.fetch = fn
  return {
    fn,
    original,
    calls,
    restore() {
      globalThis.fetch = original
    },
  }
}

/** Cordis-like context stub: captures logger output, handlers, effects and services. */
function makeContext(services = {}) {
  const handlers = new Map()
  const disposers = []
  const errors = []
  const warnings = []
  const infos = []
  const ctx = {
    logger: {
      warn(line) { warnings.push(String(line)) },
      error(line) { errors.push(String(line)) },
      info(line) { infos.push(String(line)) },
    },
    fiber: { entry: { options: { id: 'session-header' } } },
    get(name) { return services[name] },
    on(event, handler) {
      handlers.set(event, handler)
    },
    effect(fn) {
      disposers.push(fn())
    },
  }
  return { ctx, handlers, disposers, errors, warnings, infos }
}

/** Apply one plugin instance against the fetch already installed (no recorder). */
function bootInstance(config = {}, services = {}) {
  const { ctx, handlers, disposers, errors, warnings, infos } = makeContext(services)
  apply(ctx, Config(config))
  return { ctx, handlers, disposers, errors, warnings, infos }
}

/** Install recorder, apply plugin, and wire automatic cleanup. */
function boot(t, config = {}, services = {}) {
  const recorder = installFetchRecorder()
  const { ctx, handlers, disposers, errors, warnings, infos } = makeContext(services)
  // Go through the Schema, the way the harness loads the plugin: defaults for
  // toolEndpoints/overwriteHeaders/header come from Config, not from apply().
  apply(ctx, Config(config))
  t.after(() => {
    for (const dispose of disposers) dispose?.()
    recorder.restore()
  })
  return { ctx, handlers, recorder, errors, warnings, infos }
}

test('tools/execute: injects header when URL matches a configured endpoint prefix', async (t) => {
  const { handlers, recorder } = boot(t, {
    header: 'x-opencode-session',
    toolEndpoints: ['https://gateway.example.com/'],
  })
  const exec = { agent: { id: 'session-uuid-123' } }
  const next = async () => {
    await fetch('https://gateway.example.com/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    })
  }
  await handlers.get('tools/execute')(exec, next)
  assert.equal(recorder.calls.length, 1)
  const headers = recorder.calls[0].headers
  assert.equal(headers.get('x-opencode-session'), 'uuid-123')
  assert.equal(headers.get('content-type'), 'application/json')
})

test('tools/execute: leaves third-party tool URLs untouched', async (t) => {
  const { handlers, recorder } = boot(t, {
    header: 'x-opencode-session',
    toolEndpoints: ['https://gateway.example.com/'],
  })
  const exec = { agent: { id: 'session-uuid-123' } }
  const next = async () => {
    await fetch('https://web.example.org/page', { headers: { a: 'b' } })
    await fetch('https://gateway.example.com/messages')
  }
  await handlers.get('tools/execute')(exec, next)
  assert.equal(recorder.calls.length, 2)
  assert.equal(recorder.calls[0].url, 'https://web.example.org/page')
  assert.equal(recorder.calls[0].headers.has('x-opencode-session'), false)
  assert.equal(recorder.calls[1].url, 'https://gateway.example.com/messages')
  assert.equal(recorder.calls[1].headers.get('x-opencode-session'), 'uuid-123')
})

test('tools/execute: default (no toolEndpoints) keeps upstream behavior — no injection', async (t) => {
  const { handlers, recorder } = boot(t, { header: 'x-opencode-session' })
  const exec = { agent: { id: 'session-uuid-123' } }
  let ran = false
  const next = async () => {
    ran = true
    await fetch('https://gateway.example.com/messages')
  }
  await handlers.get('tools/execute')(exec, next)
  assert.equal(ran, true)
  assert.equal(recorder.calls.length, 1)
  assert.equal(recorder.calls[0].headers.has('x-opencode-session'), false)
})

test('tools/execute: no agent session id means no injection even when matched', async (t) => {
  const { handlers, recorder } = boot(t, { toolEndpoints: ['https://gateway.example.com/'] })
  const exec = { agent: {} }
  const next = async () => {
    await fetch('https://gateway.example.com/messages')
  }
  await handlers.get('tools/execute')(exec, next)
  assert.equal(recorder.calls.length, 1)
  assert.equal(recorder.calls[0].headers.has('x-session-id'), false)
})

test('tools/execute: fixed config.value wins over the agent session id', async (t) => {
  const { handlers, recorder } = boot(t, {
    header: 'x-opencode-session',
    value: 'fixed-value',
    toolEndpoints: ['https://gateway.example.com/'],
  })
  const exec = { agent: { id: 'session-uuid-123' } }
  const next = async () => {
    await fetch('https://gateway.example.com/messages')
  }
  await handlers.get('tools/execute')(exec, next)
  assert.equal(recorder.calls.length, 1)
  assert.equal(recorder.calls[0].headers.get('x-opencode-session'), 'fixed-value')
})

test('tools/execute: URL object input is matched by prefix', async (t) => {
  const { handlers, recorder } = boot(t, {
    header: 'x-opencode-session',
    toolEndpoints: ['https://gateway.example.com/'],
  })
  const exec = { agent: { id: 'session-uuid-123' } }
  const next = async () => {
    await fetch(new URL('https://gateway.example.com/v1/messages'))
  }
  await handlers.get('tools/execute')(exec, next)
  assert.equal(recorder.calls.length, 1)
  assert.equal(recorder.calls[0].headers.get('x-opencode-session'), 'uuid-123')
})

// --- overwriteHeaders: replace placeholder values hard-coded by official plugins ---

test('tools/execute: overwriteHeaders replaces an existing placeholder header value', async (t) => {
  const { handlers, recorder } = boot(t, {
    header: 'x-opencode-session',
    overwriteHeaders: ['x-opencode-session'],
    toolEndpoints: ['https://gateway.example.com/'],
  })
  const exec = { agent: { id: 'session-uuid-123' } }
  const next = async () => {
    // Simulates dsh-web-search-deepseek's hard-coded placeholder header.
    await fetch('https://gateway.example.com/messages', {
      headers: { 'x-opencode-session': 'dsh-web-search' },
    })
  }
  await handlers.get('tools/execute')(exec, next)
  assert.equal(recorder.calls.length, 1)
  assert.equal(recorder.calls[0].headers.get('x-opencode-session'), 'uuid-123')
})

test('tools/execute: header NOT listed in overwriteHeaders stays untouched', async (t) => {
  const { handlers, recorder } = boot(t, {
    header: 'x-opencode-session',
    overwriteHeaders: ['another-header'],
    toolEndpoints: ['https://gateway.example.com/'],
  })
  const exec = { agent: { id: 'session-uuid-123' } }
  const next = async () => {
    await fetch('https://gateway.example.com/messages', {
      headers: { 'x-opencode-session': 'dsh-web-search' },
    })
  }
  await handlers.get('tools/execute')(exec, next)
  assert.equal(recorder.calls.length, 1)
  assert.equal(recorder.calls[0].headers.get('x-opencode-session'), 'dsh-web-search')
})

test('llm/stream: overwriteHeaders also applies in the LLM scope', async (t) => {
  const { handlers, recorder } = boot(t, {
    header: 'x-opencode-session',
    overwriteHeaders: ['x-opencode-session'],
  })
  async function* inner() {
    await fetch('https://llm.example.com/v1/messages', {
      headers: { 'x-opencode-session': 'placeholder' },
    })
    yield 'chunk-1'
  }
  const gen = handlers.get('llm/stream')({ sessionId: 'session-abc' }, () => inner())
  for await (const _ of gen) { /* drain */ }
  assert.equal(recorder.calls.length, 1)
  assert.equal(recorder.calls[0].headers.get('x-opencode-session'), 'abc')
})

// --- llm/stream regression (existing behavior must not change) ---

test('llm/stream: still injects unconditionally with the live session id', async (t) => {
  const { handlers, recorder } = boot(t, { header: 'x-session-id' })
  async function* inner() {
    await fetch('https://llm.example.com/v1/chat/completions')
    yield 'chunk-1'
    yield 'chunk-2'
  }
  const gen = handlers.get('llm/stream')({ sessionId: 'session-abc' }, () => inner())
  const chunks = []
  for await (const chunk of gen) chunks.push(chunk)
  assert.deepEqual(chunks, ['chunk-1', 'chunk-2'])
  assert.equal(recorder.calls.length, 1)
  assert.equal(recorder.calls[0].headers.get('x-session-id'), 'abc')
})

test('llm/stream: never overwrites a header someone else already set', async (t) => {
  const { handlers, recorder } = boot(t, { header: 'x-session-id' })
  async function* inner() {
    await fetch('https://llm.example.com/v1/chat', { headers: { 'x-session-id': 'already-set' } })
    yield 'chunk-1'
  }
  const gen = handlers.get('llm/stream')({ sessionId: 'session-abc' }, () => inner())
  for await (const _ of gen) { /* drain */ }
  assert.equal(recorder.calls.length, 1)
  assert.equal(recorder.calls[0].headers.get('x-session-id'), 'already-set')
})

test('unloading restores the fetch that was installed before apply', async (t) => {
  const recorder = installFetchRecorder()
  const { ctx, disposers } = makeContext()
  apply(ctx, Config({}))
  const patched = globalThis.fetch
  assert.notEqual(patched, recorder.fn)
  for (const dispose of disposers) dispose?.()
  assert.equal(globalThis.fetch, recorder.fn)
  recorder.restore()
})

// --- review follow-ups: Request spelling, case-insensitive overwrite, boundary ---

test('tools/execute: Request input matching the whitelist is injected', async (t) => {
  const { handlers, recorder } = boot(t, {
    header: 'x-opencode-session',
    overwriteHeaders: ['x-opencode-session'],
    toolEndpoints: ['https://gateway.example.com/'],
  })
  const exec = { agent: { id: 'session-uuid-123' } }
  const next = async () => {
    const request = new Request('https://gateway.example.com/messages', {
      method: 'POST',
      headers: { 'x-opencode-session': 'dsh-web-search' },
    })
    await fetch(request)
  }
  await handlers.get('tools/execute')(exec, next)
  assert.equal(recorder.calls.length, 1)
  assert.equal(recorder.calls[0].headers.get('x-opencode-session'), 'uuid-123')
})

test('tools/execute: Request input NOT matching the whitelist passes through untouched', async (t) => {
  const { handlers, recorder } = boot(t, {
    header: 'x-opencode-session',
    toolEndpoints: ['https://gateway.example.com/'],
  })
  const exec = { agent: { id: 'session-uuid-123' } }
  const next = async () => {
    const request = new Request('https://other.example.org/messages', {
      method: 'POST',
      headers: { 'x-opencode-session': 'dsh-web-search' },
    })
    await fetch(request)
  }
  await handlers.get('tools/execute')(exec, next)
  assert.equal(recorder.calls.length, 1)
  assert.equal(recorder.calls[0].url, 'https://other.example.org/messages')
  assert.equal(recorder.calls[0].headers.get('x-opencode-session'), 'dsh-web-search')
})

test('tools/execute: sibling domain never matches (host boundary)', async (t) => {
  const { handlers, recorder } = boot(t, {
    header: 'x-opencode-session',
    toolEndpoints: ['https://gateway.example.com'], // no trailing slash on purpose
  })
  const exec = { agent: { id: 'session-uuid-123' } }
  const next = async () => {
    await fetch('https://gateway.example.com.evil.io/messages')
    await fetch('https://gateway.example.com/messages')
  }
  await handlers.get('tools/execute')(exec, next)
  assert.equal(recorder.calls.length, 2)
  assert.equal(recorder.calls[0].url, 'https://gateway.example.com.evil.io/messages')
  assert.equal(recorder.calls[0].headers.has('x-opencode-session'), false)
  assert.equal(recorder.calls[1].url, 'https://gateway.example.com/messages')
  assert.equal(recorder.calls[1].headers.get('x-opencode-session'), 'uuid-123')
})

test('tools/execute: path prefix respects boundaries (/v1 not /v10)', async (t) => {
  const { handlers, recorder } = boot(t, {
    header: 'x-opencode-session',
    toolEndpoints: ['https://gateway.example.com/zen/go/v1'],
  })
  const exec = { agent: { id: 'session-uuid-123' } }
  const next = async () => {
    await fetch('https://gateway.example.com/zen/go/v10/messages')
    await fetch('https://gateway.example.com/zen/go/v1/messages')
  }
  await handlers.get('tools/execute')(exec, next)
  assert.equal(recorder.calls.length, 2)
  assert.equal(recorder.calls[0].headers.has('x-opencode-session'), false)
  assert.equal(recorder.calls[1].headers.get('x-opencode-session'), 'uuid-123')
})

test('tools/execute: case-insensitive overwrite of a placeholder header', async (t) => {
  const { handlers, recorder } = boot(t, {
    header: 'x-opencode-session',
    overwriteHeaders: ['X-OPENCODE-SESSION'], // deliberately different case
    toolEndpoints: ['https://gateway.example.com/'],
  })
  const exec = { agent: { id: 'session-uuid-123' } }
  const next = async () => {
    await fetch('https://gateway.example.com/messages', {
      headers: { 'X-OPENCODE-SESSION': 'dsh-web-search' }, // different case on wire
    })
  }
  await handlers.get('tools/execute')(exec, next)
  assert.equal(recorder.calls.length, 1)
  assert.equal(recorder.calls[0].headers.get('x-opencode-session'), 'uuid-123')
})

// --- session id normalization: one stable wire value per conversation ---

const UUID = '7f3e9a52-1b6c-4d8e-9f01-23456789abcd'
const UPPER_UUID = '7F3E9A52-1B6C-4D8E-9F01-23456789ABCD'
const WIRE = `session-${UUID}`

test('normalizeSessionId: every harness id shape maps onto one wire value', () => {
  // Persistent sessions report `session-<uuid>`.
  assert.equal(normalizeSessionId(`session-${UUID}`), WIRE)
  // An id minted without an explicit name is `session-<n>`: only the prefix goes.
  assert.equal(normalizeSessionId('session-42'), '42')
  // Configurable agents report `<agentId>-session-<uuid>`: the UUID is the identity.
  assert.equal(normalizeSessionId(`agent-alpha-session-${UUID}`), WIRE)
  assert.equal(normalizeSessionId(`sub-agent-2-session-${UUID}`), WIRE)
  // A UUID is case-insensitive, so every spelling normalizes to lower case.
  assert.equal(normalizeSessionId(`agent-alpha-session-${UPPER_UUID}`), WIRE)
  assert.equal(normalizeSessionId(`session-${UPPER_UUID}`), WIRE)
  // The tail match is case-insensitive end to end, separator included.
  assert.equal(normalizeSessionId(`agent-alpha-SESSION-${UUID}`), WIRE)
  // A bare UUID gains the same branding as every other shape.
  assert.equal(normalizeSessionId(UUID), WIRE)
  // Conservative: only a trailing `-session-<uuid>` is unwrapped.
  assert.equal(normalizeSessionId('agent-session-not-a-uuid'), 'agent-session-not-a-uuid')
  assert.equal(normalizeSessionId('prefix-session-abc'), 'prefix-session-abc')
  assert.equal(normalizeSessionId('agent-session-'), 'agent-session-')
  // Ordinary strings and the empty id are returned unchanged.
  assert.equal(normalizeSessionId('custom-session-thing'), 'custom-session-thing')
  assert.equal(normalizeSessionId(''), '')
  // An absent id is not a value: it stays undefined, never the string "undefined".
  assert.equal(normalizeSessionId(undefined), undefined)
})

test('llm/stream: agent-form id is normalized to the branded session id', async (t) => {
  const { handlers, recorder } = boot(t, { header: 'x-session-id' })
  async function* inner() {
    await fetch('https://llm.example.com/v1/chat/completions')
    yield 'chunk-1'
  }
  const gen = handlers.get('llm/stream')({ sessionId: `agent-alpha-session-${UUID}` }, () => inner())
  for await (const _ of gen) { /* drain */ }
  assert.equal(recorder.calls.length, 1)
  assert.equal(recorder.calls[0].headers.get('x-session-id'), WIRE)
})

test('llm/stream: a call without a session id gets no header', async (t) => {
  const { handlers, recorder } = boot(t, { header: 'x-session-id' })
  async function* inner() {
    await fetch('https://llm.example.com/v1/chat/completions')
    yield 'chunk-1'
  }
  const gen = handlers.get('llm/stream')({}, () => inner())
  for await (const _ of gen) { /* drain */ }
  assert.equal(recorder.calls.length, 1)
  assert.equal(recorder.calls[0].headers.has('x-session-id'), false)
})

test('llm/stream: fixed config.value wins over an agent-form session id', async (t) => {
  const { handlers, recorder } = boot(t, { header: 'x-session-id', value: 'fixed-value' })
  async function* inner() {
    await fetch('https://llm.example.com/v1/chat/completions')
    yield 'chunk-1'
  }
  const gen = handlers.get('llm/stream')({ sessionId: `agent-alpha-session-${UUID}` }, () => inner())
  for await (const _ of gen) { /* drain */ }
  assert.equal(recorder.calls.length, 1)
  assert.equal(recorder.calls[0].headers.get('x-session-id'), 'fixed-value')
})


test('llm/stream: an Auto review id names the session it works for', async (t) => {
  const agents = { currentInitiator: () => ({ session: { id: `session-${UUID}` } }) }
  const { handlers, recorder } = boot(t, { header: 'x-session-id' }, { agents })
  async function* inner() {
    await fetch('https://llm.example.com/v1/chat/completions')
    yield 'chunk-1'
  }
  const gen = handlers.get('llm/stream')({ sessionId: 'auto-review:abc123' }, () => inner())
  for await (const _ of gen) { /* drain */ }
  assert.equal(recorder.calls.length, 1)
  assert.equal(recorder.calls[0].headers.get('x-session-id'), `auto-review:${WIRE}`)
})

test('llm/stream: without an initiator the review id is sent unchanged', async (t) => {
  const { handlers, recorder } = boot(t, { header: 'x-session-id' })
  async function* inner() {
    await fetch('https://llm.example.com/v1/chat/completions')
    yield 'chunk-1'
  }
  const gen = handlers.get('llm/stream')({ sessionId: 'auto-review:abc123' }, () => inner())
  for await (const _ of gen) { /* drain */ }
  assert.equal(recorder.calls[0].headers.get('x-session-id'), 'auto-review:abc123')
})

test('llm/stream: an empty reviewSessionPrefix disables the rewrite', async (t) => {
  const agents = { currentInitiator: () => ({ session: { id: `session-${UUID}` } }) }
  const { handlers, recorder } = boot(t, { header: 'x-session-id', reviewSessionPrefix: '' }, { agents })
  async function* inner() {
    await fetch('https://llm.example.com/v1/chat/completions')
    yield 'chunk-1'
  }
  const gen = handlers.get('llm/stream')({ sessionId: 'auto-review:abc123' }, () => inner())
  for await (const _ of gen) { /* drain */ }
  assert.equal(recorder.calls[0].headers.get('x-session-id'), 'auto-review:abc123')
})

test('llm/stream: a throwing initiator service never breaks the request', async (t) => {
  const agents = {
    currentInitiator() {
      throw new Error('service unavailable')
    },
  }
  const { handlers, recorder } = boot(t, { header: 'x-session-id' }, { agents })
  async function* inner() {
    await fetch('https://llm.example.com/v1/chat/completions')
    yield 'chunk-1'
  }
  const gen = handlers.get('llm/stream')({ sessionId: 'auto-review:abc123' }, () => inner())
  for await (const _ of gen) { /* drain */ }
  assert.equal(recorder.calls[0].headers.get('x-session-id'), 'auto-review:abc123')
})

test('llm/stream: a review id already naming its session stays stable', async (t) => {
  const agents = { currentInitiator: () => ({ session: { id: `session-${UUID}` } }) }
  const { handlers, recorder } = boot(t, { header: 'x-session-id' }, { agents })
  async function* inner() {
    await fetch('https://llm.example.com/v1/chat/completions')
    yield 'chunk-1'
  }
  const gen = handlers.get('llm/stream')({ sessionId: `auto-review:${WIRE}` }, () => inner())
  for await (const _ of gen) { /* drain */ }
  assert.equal(recorder.calls[0].headers.get('x-session-id'), `auto-review:${WIRE}`)
})

test('tools/execute: agent-form id is normalized the same way', async (t) => {
  const { handlers, recorder } = boot(t, {
    header: 'x-opencode-session',
    toolEndpoints: ['https://gateway.example.com/'],
  })
  const exec = { agent: { id: `agent-alpha-session-${UUID}` } }
  const next = async () => {
    await fetch('https://gateway.example.com/messages')
  }
  await handlers.get('tools/execute')(exec, next)
  assert.equal(recorder.calls.length, 1)
  assert.equal(recorder.calls[0].headers.get('x-opencode-session'), WIRE)
})

test('tools/execute: uppercase UUID tail is lowercased', async (t) => {
  const { handlers, recorder } = boot(t, {
    header: 'x-opencode-session',
    toolEndpoints: ['https://gateway.example.com/'],
  })
  const exec = { agent: { id: `agent-alpha-session-${UPPER_UUID}` } }
  const next = async () => {
    await fetch('https://gateway.example.com/messages')
  }
  await handlers.get('tools/execute')(exec, next)
  assert.equal(recorder.calls.length, 1)
  assert.equal(recorder.calls[0].headers.get('x-opencode-session'), WIRE)
})

test('tools/execute: non-UUID agent id with a -session- tail is not truncated', async (t) => {
  const { handlers, recorder } = boot(t, {
    header: 'x-opencode-session',
    toolEndpoints: ['https://gateway.example.com/'],
  })
  const exec = { agent: { id: 'agent-session-not-a-uuid' } }
  const next = async () => {
    await fetch('https://gateway.example.com/messages')
  }
  await handlers.get('tools/execute')(exec, next)
  assert.equal(recorder.calls.length, 1)
  assert.equal(recorder.calls[0].headers.get('x-opencode-session'), 'agent-session-not-a-uuid')
})

// --- config validation: a rejected config fails loudly and touches nothing ---

/** Apply a config that must be rejected; the recorder stands in for the real fetch. */
function bootRejected(config) {
  const recorder = installFetchRecorder()
  const { ctx, handlers, disposers, errors, warnings } = makeContext()
  let thrown
  try {
    apply(ctx, Config(config))
  } catch (error) {
    thrown = error
  }
  return {
    recorder,
    handlers,
    disposers,
    errors,
    warnings,
    thrown,
    restore() {
      for (const dispose of disposers) dispose?.()
      recorder.restore()
    },
  }
}

test('apply: an invalid header name is logged, thrown, and leaves fetch untouched', () => {
  const { recorder, handlers, errors, thrown, restore } = bootRejected({ header: 'x session id' })
  try {
    assert.ok(thrown instanceof Error)
    assert.match(thrown.message, /not a valid HTTP field name/)
    assert.equal(errors.length, 1)
    assert.match(errors[0], /not a valid HTTP field name/)
    assert.equal(globalThis.fetch, recorder.fn)
    assert.equal(handlers.size, 0)
  } finally {
    restore()
  }
})

test('apply: a rejected config still lets ordinary fetches through exactly once', async () => {
  const { recorder, handlers, errors, restore } = bootRejected({ header: 'cookie' })
  try {
    assert.equal(errors.length, 1)
    assert.equal(handlers.has('llm/stream'), false)
    assert.equal(handlers.has('tools/execute'), false)
    await fetch('https://llm.example.com/v1/chat', { headers: { accept: 'text/event-stream' } })
    assert.equal(recorder.calls.length, 1)
    assert.equal(recorder.calls[0].headers.has('cookie'), false)
  } finally {
    restore()
  }
})

test('apply: every forbidden header name is rejected', () => {
  for (const header of ['authorization', 'cookie', 'content-type', 'user-agent', 'x-forwarded-for', 'host']) {
    const { errors, thrown, restore } = bootRejected({ header })
    try {
      assert.ok(thrown instanceof Error, `${header} must be rejected`)
      assert.equal(errors.length, 1)
      assert.match(errors[0], /is forbidden/)
    } finally {
      restore()
    }
  }
})

test('apply: the forbidden list matches case-insensitively', () => {
  const { errors, thrown, restore } = bootRejected({ header: 'Authorization' })
  try {
    assert.ok(thrown instanceof Error)
    assert.equal(errors.length, 1)
    assert.match(errors[0], /is forbidden/)
  } finally {
    restore()
  }
})

test('apply: an empty header name is rejected', () => {
  const { errors, thrown, restore } = bootRejected({ header: '' })
  try {
    assert.ok(thrown instanceof Error)
    assert.match(errors[0], /non-empty string/)
  } finally {
    restore()
  }
})

test('apply: a value with CR/LF is rejected', () => {
  const { recorder, errors, thrown, restore } = bootRejected({ header: 'x-session-id', value: 'a\r\nInjected: yes' })
  try {
    assert.ok(thrown instanceof Error)
    assert.match(errors[0], /not a valid HTTP header value/)
    assert.equal(globalThis.fetch, recorder.fn)
  } finally {
    restore()
  }
})

test('apply: an empty value is rejected and sends no header', async () => {
  const { recorder, errors, thrown, restore } = bootRejected({ header: 'x-session-id', value: '' })
  try {
    assert.ok(thrown instanceof Error)
    assert.match(errors[0], /must not be empty/)
    await fetch('https://llm.example.com/v1/chat')
    assert.equal(recorder.calls.length, 1)
    assert.equal(recorder.calls[0].headers.has('x-session-id'), false)
  } finally {
    restore()
  }
})

test('apply: a valid custom header still injects', async (t) => {
  const { handlers, recorder } = boot(t, { header: 'X-Request-Id' })
  async function* inner() {
    await fetch('https://llm.example.com/v1/chat/completions')
    yield 'chunk-1'
  }
  const gen = handlers.get('llm/stream')({ sessionId: 'session-abc' }, () => inner())
  for await (const _ of gen) { /* drain */ }
  assert.equal(recorder.calls.length, 1)
  assert.equal(recorder.calls[0].headers.get('x-request-id'), 'abc')
})

test('llm/stream: an empty session id gets no header', async (t) => {
  const { handlers, recorder } = boot(t, { header: 'x-session-id' })
  async function* inner() {
    await fetch('https://llm.example.com/v1/chat/completions')
    yield 'chunk-1'
  }
  const gen = handlers.get('llm/stream')({ sessionId: '' }, () => inner())
  for await (const _ of gen) { /* drain */ }
  assert.equal(recorder.calls.length, 1)
  assert.equal(recorder.calls[0].headers.has('x-session-id'), false)
})

test('patchedFetch: an internal error falls back to the untouched request once', async (t) => {
  const { handlers, recorder, warnings } = boot(t, { header: 'x-session-id' })
  async function* inner() {
    const RealHeaders = globalThis.Headers
    class ExplodingHeaders extends RealHeaders {
      set() {
        throw new Error('boom')
      }
    }
    globalThis.Headers = ExplodingHeaders
    try {
      await fetch('https://llm.example.com/v1/chat/completions')
    } finally {
      globalThis.Headers = RealHeaders
    }
    yield 'chunk-1'
  }
  const gen = handlers.get('llm/stream')({ sessionId: 'session-abc' }, () => inner())
  for await (const _ of gen) { /* drain */ }
  assert.equal(recorder.calls.length, 1)
  assert.equal(recorder.calls[0].headers.has('x-session-id'), false)
  assert.equal(warnings.filter((line) => /after an internal error/.test(line)).length, 1)
})

test('patchedFetch: repeated internal errors warn once per signature', async (t) => {
  const { handlers, recorder, warnings } = boot(t, { header: 'x-session-id' })
  async function* inner() {
    const RealHeaders = globalThis.Headers
    class ExplodingHeaders extends RealHeaders {
      set() {
        throw new Error('boom')
      }
    }
    globalThis.Headers = ExplodingHeaders
    try {
      await fetch('https://llm.example.com/v1/a')
      await fetch('https://llm.example.com/v1/b')
    } finally {
      globalThis.Headers = RealHeaders
    }
    yield 'chunk-1'
  }
  const gen = handlers.get('llm/stream')({ sessionId: 'session-abc' }, () => inner())
  for await (const _ of gen) { /* drain */ }
  assert.equal(recorder.calls.length, 2)
  assert.equal(warnings.filter((line) => /after an internal error/.test(line)).length, 1)
})

// --- phase allowlists + optional redirect guard ---

test('llmEndpointAllowlist: only matching URLs are injected', async (t) => {
  const { handlers, recorder } = boot(t, {
    header: 'x-session-id',
    llmEndpointAllowlist: ['https://llm.example.com/v1'],
  })
  async function* inner() {
    await fetch('https://llm.example.com/v1/chat')
    await fetch('https://other.example.org/v1/chat')
    yield 'chunk-1'
  }
  const gen = handlers.get('llm/stream')({ sessionId: 'session-abc' }, () => inner())
  for await (const _ of gen) { /* drain */ }
  assert.equal(recorder.calls.length, 2)
  assert.equal(recorder.calls[0].headers.get('x-session-id'), 'abc')
  assert.equal(recorder.calls[1].headers.has('x-session-id'), false)
})

test('llmEndpointAllowlist: a sibling domain never matches', async (t) => {
  const { handlers, recorder } = boot(t, {
    header: 'x-session-id',
    llmEndpointAllowlist: ['https://llm.example.com'],
  })
  async function* inner() {
    await fetch('https://llm.example.com.evil.io/v1/chat')
    yield 'chunk-1'
  }
  const gen = handlers.get('llm/stream')({ sessionId: 'session-abc' }, () => inner())
  for await (const _ of gen) { /* drain */ }
  assert.equal(recorder.calls.length, 1)
  assert.equal(recorder.calls[0].headers.has('x-session-id'), false)
})

test('llmEndpointAllowlist: path prefixes respect boundaries', async (t) => {
  const { handlers, recorder } = boot(t, {
    header: 'x-session-id',
    llmEndpointAllowlist: ['https://llm.example.com/zen/go/v1'],
  })
  async function* inner() {
    await fetch('https://llm.example.com/zen/go/v10/messages')
    await fetch('https://llm.example.com/zen/go/v1/messages')
    yield 'chunk-1'
  }
  const gen = handlers.get('llm/stream')({ sessionId: 'session-abc' }, () => inner())
  for await (const _ of gen) { /* drain */ }
  assert.equal(recorder.calls.length, 2)
  assert.equal(recorder.calls[0].headers.has('x-session-id'), false)
  assert.equal(recorder.calls[1].headers.get('x-session-id'), 'abc')
})

test('llmEndpointAllowlist: an empty list leaves the LLM phase unrestricted', async (t) => {
  const { handlers, recorder } = boot(t, { header: 'x-session-id' })
  async function* inner() {
    await fetch('https://anything.example.org/v1/chat')
    yield 'chunk-1'
  }
  const gen = handlers.get('llm/stream')({ sessionId: 'session-abc' }, () => inner())
  for await (const _ of gen) { /* drain */ }
  assert.equal(recorder.calls.length, 1)
  assert.equal(recorder.calls[0].headers.get('x-session-id'), 'abc')
})

test('tool phase: llmEndpointAllowlist does not gate tool fetches', async (t) => {
  const { handlers, recorder } = boot(t, {
    header: 'x-opencode-session',
    toolEndpoints: ['https://gateway.example.com/'],
    llmEndpointAllowlist: ['https://llm.example.com/v1'],
  })
  const exec = { agent: { id: 'session-uuid-123' } }
  const next = async () => {
    await fetch('https://gateway.example.com/messages')
  }
  await handlers.get('tools/execute')(exec, next)
  assert.equal(recorder.calls.length, 1)
  assert.equal(recorder.calls[0].headers.get('x-opencode-session'), 'uuid-123')
})

test('redirectGuard: a stamped init-form request gets redirect "error"', async (t) => {
  const { handlers, recorder } = boot(t, { header: 'x-session-id', redirectGuard: true })
  async function* inner() {
    await fetch('https://llm.example.com/v1/chat', { method: 'POST' })
    yield 'chunk-1'
  }
  const gen = handlers.get('llm/stream')({ sessionId: 'session-abc' }, () => inner())
  for await (const _ of gen) { /* drain */ }
  assert.equal(recorder.calls.length, 1)
  assert.equal(recorder.calls[0].headers.get('x-session-id'), 'abc')
  assert.equal(recorder.calls[0].redirect, 'error')
})

test('redirectGuard: an explicit init.redirect is preserved', async (t) => {
  const { handlers, recorder } = boot(t, { header: 'x-session-id', redirectGuard: true })
  async function* inner() {
    await fetch('https://llm.example.com/v1/chat', { redirect: 'manual' })
    yield 'chunk-1'
  }
  const gen = handlers.get('llm/stream')({ sessionId: 'session-abc' }, () => inner())
  for await (const _ of gen) { /* drain */ }
  assert.equal(recorder.calls.length, 1)
  assert.equal(recorder.calls[0].redirect, 'manual')
})

test('redirectGuard: a Request input is rebuilt with redirect "error"', async (t) => {
  const { handlers, recorder } = boot(t, { header: 'x-session-id', redirectGuard: true })
  async function* inner() {
    await fetch(new Request('https://llm.example.com/v1/chat'))
    yield 'chunk-1'
  }
  const gen = handlers.get('llm/stream')({ sessionId: 'session-abc' }, () => inner())
  for await (const _ of gen) { /* drain */ }
  assert.equal(recorder.calls.length, 1)
  assert.equal(recorder.calls[0].headers.get('x-session-id'), 'abc')
  assert.equal(recorder.calls[0].request.redirect, 'error')
})

test('redirectGuard: a Request pinned to manual keeps its redirect', async (t) => {
  const { handlers, recorder } = boot(t, { header: 'x-session-id', redirectGuard: true })
  async function* inner() {
    await fetch(new Request('https://llm.example.com/v1/chat', { redirect: 'manual' }))
    yield 'chunk-1'
  }
  const gen = handlers.get('llm/stream')({ sessionId: 'session-abc' }, () => inner())
  for await (const _ of gen) { /* drain */ }
  assert.equal(recorder.calls.length, 1)
  assert.equal(recorder.calls[0].request.redirect, 'manual')
})

test('redirectGuard: off by default leaves the caller\'s redirect alone', async (t) => {
  const { handlers, recorder } = boot(t, { header: 'x-session-id' })
  async function* inner() {
    await fetch('https://llm.example.com/v1/chat')
    yield 'chunk-1'
  }
  const gen = handlers.get('llm/stream')({ sessionId: 'session-abc' }, () => inner())
  for await (const _ of gen) { /* drain */ }
  assert.equal(recorder.calls.length, 1)
  assert.equal(recorder.calls[0].headers.get('x-session-id'), 'abc')
  assert.equal(recorder.calls[0].redirect, undefined)
})

test('redirectGuard: a Request whose body was consumed warns and passes the call through', async (t) => {
  const { handlers, recorder, warnings } = boot(t, { header: 'x-session-id', redirectGuard: true })
  async function* inner() {
    const request = new Request('https://llm.example.com/v1/chat', { method: 'POST', body: 'payload' })
    await request.text() // consume the body: rebuilding this Request must fail
    await fetch(request)
    yield 'chunk-1'
  }
  const gen = handlers.get('llm/stream')({ sessionId: 'session-abc' }, () => inner())
  for await (const _ of gen) { /* drain */ }
  assert.equal(recorder.calls.length, 1)
  assert.equal(recorder.calls[0].headers.has('x-session-id'), false)
  assert.equal(warnings.filter((line) => /after an internal error/.test(line)).length, 1)
})

// --- fail-closed vs fail-soft: the two URL lists differ on purpose ---

test('apply: an invalid llmEndpointAllowlist entry is rejected at load', () => {
  for (const bad of ['not-a-url', 'ftp://llm.example.com/v1']) {
    const { errors, thrown, restore } = bootRejected({ llmEndpointAllowlist: [bad] })
    try {
      assert.ok(thrown instanceof Error, `${bad} must be rejected`)
      assert.equal(errors.length, 1)
      assert.match(errors[0], /llmEndpointAllowlist/)
    } finally {
      restore()
    }
  }
})

test('apply: invalid toolEndpoints entries only warn (soft failure)', async (t) => {
  const { handlers, warnings } = boot(t, {
    header: 'x-session-id',
    toolEndpoints: ['not-a-url'],
  })
  assert.equal(warnings.filter((line) => /unparseable toolEndpoint/.test(line)).length, 1)
  assert.equal(handlers.has('llm/stream'), true)
  assert.equal(handlers.has('tools/execute'), true)
})

// --- shared singleton dispatcher: one wrapper layer, idempotent unload ---

test('dispatcher: two instances share one layer and both hooks inject', async () => {
  const recorder = installFetchRecorder()
  const first = bootInstance({ header: 'x-first' })
  const oneLayer = globalThis.fetch
  const second = bootInstance({ header: 'x-second' })
  try {
    assert.notEqual(oneLayer, recorder.fn)
    assert.equal(globalThis.fetch, oneLayer) // second apply adds a hook, never a wrapper

    async function* firstCall() {
      await fetch('https://llm.example.com/v1/chat')
      yield 'chunk'
    }
    for await (const _ of first.handlers.get('llm/stream')({ sessionId: 'session-abc' }, () => firstCall())) { /* drain */ }
    async function* secondCall() {
      await fetch('https://llm.example.com/v1/chat')
      yield 'chunk'
    }
    for await (const _ of second.handlers.get('llm/stream')({ sessionId: 'session-abc' }, () => secondCall())) { /* drain */ }

    assert.equal(recorder.calls.length, 2)
    assert.equal(recorder.calls[0].headers.get('x-first'), 'abc')
    assert.equal(recorder.calls[1].headers.get('x-second'), 'abc')
    assert.equal(recorder.calls[0].headers.has('x-second'), false)
    assert.equal(recorder.calls[1].headers.has('x-first'), false)
  } finally {
    for (const dispose of first.disposers) dispose?.()
    for (const dispose of second.disposers) dispose?.()
    recorder.restore()
  }
})

test('dispatcher: an external wrapper survives a reload and no layer is added', async () => {
  const recorder = installFetchRecorder()
  const first = bootInstance({ header: 'x-session-id' })
  const dispatcher = globalThis.fetch
  let wrapperCalls = 0
  const wrapper = (input, init) => {
    wrapperCalls += 1
    return dispatcher(input, init)
  }
  globalThis.fetch = wrapper
  let second
  try {
    for (const dispose of first.disposers) dispose?.()
    // Our dispatcher is fronted by someone else: unload must not restore over it.
    assert.equal(globalThis.fetch, wrapper)
    assert.equal(first.warnings.filter((line) => /wrapped after this plugin loaded/.test(line)).length, 1)

    // An HMR-style reload registers into the same registry: still one layer.
    second = bootInstance({ header: 'x-session-id' })
    assert.equal(globalThis.fetch, wrapper)
    async function* inner() {
      await fetch('https://llm.example.com/v1/chat')
      yield 'chunk'
    }
    for await (const _ of second.handlers.get('llm/stream')({ sessionId: 'session-abc' }, () => inner())) { /* drain */ }
    assert.equal(wrapperCalls, 1)
    assert.equal(recorder.calls.length, 1)
    assert.equal(recorder.calls[0].headers.get('x-session-id'), 'abc')
  } finally {
    for (const dispose of second?.disposers ?? []) dispose?.()
    // Drop the leftover registry/wrapper so later tests start from a clean fetch.
    delete globalThis[Symbol.for('dsh-session-header#fetch-dispatcher@1')]
    recorder.restore()
  }
})

test('dispatcher: a throwing hook is isolated from the request and other hooks', async () => {
  const recorder = installFetchRecorder()
  const inst = bootInstance({ header: 'x-session-id' })
  try {
    register('test#boom', () => {
      throw new Error('boom')
    }, inst.ctx.logger)
    async function* firstCall() {
      await fetch('https://llm.example.com/v1/chat')
      yield 'chunk'
    }
    for await (const _ of inst.handlers.get('llm/stream')({ sessionId: 'session-abc' }, () => firstCall())) { /* drain */ }
    assert.equal(recorder.calls.length, 1) // the request still went out exactly once
    assert.equal(recorder.calls[0].headers.get('x-session-id'), 'abc') // our hook still worked
    const failures = () => inst.warnings.filter((line) => /skipped a failing fetch hook/.test(line)).length
    assert.equal(failures(), 1)

    async function* secondCall() {
      await fetch('https://llm.example.com/v1/chat')
      yield 'chunk'
    }
    for await (const _ of inst.handlers.get('llm/stream')({ sessionId: 'session-abc' }, () => secondCall())) { /* drain */ }
    assert.equal(failures(), 1) // same signature stays quiet on later requests
  } finally {
    unregister('test#boom')
    for (const dispose of inst.disposers) dispose?.()
    recorder.restore()
  }
})

test('dispatcher: a second dispose is silent and changes nothing', () => {
  const recorder = installFetchRecorder()
  const inst = bootInstance({ header: 'x-session-id' })
  try {
    for (const dispose of inst.disposers) dispose?.()
    assert.equal(globalThis.fetch, recorder.fn)
    const afterFirst = inst.warnings.length
    for (const dispose of inst.disposers) dispose?.()
    assert.equal(inst.warnings.length, afterFirst)
    assert.equal(globalThis.fetch, recorder.fn)
  } finally {
    recorder.restore()
  }
})

test('dispatcher: apply, dispose, apply installs one fresh layer and restores strictly', async () => {
  const recorder = installFetchRecorder()
  try {
    const first = bootInstance({ header: 'x-session-id' })
    const firstLayer = globalThis.fetch
    assert.notEqual(firstLayer, recorder.fn)
    for (const dispose of first.disposers) dispose?.()
    assert.equal(globalThis.fetch, recorder.fn)

    const second = bootInstance({ header: 'x-session-id' })
    assert.notEqual(globalThis.fetch, recorder.fn)
    assert.notEqual(globalThis.fetch, firstLayer) // a new single layer, not a stack
    async function* inner() {
      await fetch('https://llm.example.com/v1/chat')
      yield 'chunk'
    }
    for await (const _ of second.handlers.get('llm/stream')({ sessionId: 'session-abc' }, () => inner())) { /* drain */ }
    assert.equal(recorder.calls.length, 1) // one dispatch, not one per historical layer
    for (const dispose of second.disposers) dispose?.()
    assert.equal(globalThis.fetch, recorder.fn)
  } finally {
    recorder.restore()
  }
})

test('dispatcher: string, URL and Request inputs behave the same', async (t) => {
  const { handlers, recorder } = boot(t, { header: 'x-session-id' })
  async function* inner() {
    await fetch('https://llm.example.com/v1/chat')
    await fetch(new URL('https://llm.example.com/v1/chat'))
    await fetch(new Request('https://llm.example.com/v1/chat'))
    yield 'chunk'
  }
  const gen = handlers.get('llm/stream')({ sessionId: 'session-abc' }, () => inner())
  for await (const _ of gen) { /* drain */ }
  assert.equal(recorder.calls.length, 3)
  for (const call of recorder.calls) assert.equal(call.headers.get('x-session-id'), 'abc')
})

test('dispatcher: hook ids are unique across module copies and dispose stays scoped', async () => {
  // Two module copies of this package would each own a fresh counter; the ids
  // must not collide, or one copy's dispose deletes the other copy's hook.
  const recorder = installFetchRecorder()
  const first = bootInstance({ header: 'x-session-id' })
  const second = bootInstance({ header: 'x-session-id' })
  try {
    const registry = globalThis[Symbol.for('dsh-session-header#fetch-dispatcher@1')]
    assert.equal(registry.hooks.size, 2)
    const ids = [...registry.hooks.keys()]
    assert.notEqual(ids[0], ids[1])
    for (const id of ids) {
      assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    }
    // Disposing one copy removes exactly its own hook and keeps the layer.
    for (const dispose of first.disposers) dispose?.()
    assert.equal(registry.hooks.size, 1)
    assert.equal(globalThis.fetch, registry.dispatcher)
    // The survivor still injects through the shared registry.
    async function* inner() {
      await fetch('https://llm.example.com/v1/chat')
      yield 'chunk'
    }
    for await (const _ of second.handlers.get('llm/stream')({ sessionId: 'session-abc' }, () => inner())) { /* drain */ }
    assert.equal(recorder.calls.length, 1)
    assert.equal(recorder.calls[0].headers.get('x-session-id'), 'abc')
    for (const dispose of second.disposers) dispose?.()
    assert.equal(globalThis.fetch, recorder.fn)
  } finally {
    for (const dispose of second.disposers) dispose?.()
    recorder.restore()
  }
})

// --- host-side guards: kill switch, native-header detection, settings channel ---

/** Flush the fire-and-forget settings promise chain. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

test('guards: enabled=false installs nothing but keeps the schema loaded', () => {
  const recorder = installFetchRecorder()
  try {
    const inst = bootInstance({ enabled: false })
    assert.equal(inst.handlers.size, 0)
    assert.equal(inst.disposers.length, 0)
    assert.equal(globalThis.fetch, recorder.fn)
    assert.deepEqual(inst.errors, [])
    assert.equal(inst.infos.filter((line) => /disabled by configuration/.test(line)).length, 1)
    const defaults = Config({})
    assert.equal(defaults.enabled, true)
    // Volatile fields parse into live references, read through .get().
    assert.equal(defaults.nativeHeaderSeen.get(), false)
    assert.equal(defaults.nativeSessionHeaders.length, 8)
  } finally {
    recorder.restore()
  }
})

test('guards: an existing native session header stops injection and logs once', async (t) => {
  const { handlers, recorder, infos } = boot(t, { header: 'x-session-id' })
  async function* inner() {
    await fetch('https://llm.example.com/v1/chat', { headers: { 'X-DeepSeek-Harness-Session-Id': 'native' } })
    await fetch('https://llm.example.com/v1/chat', { headers: { 'x-deepseek-harness-session-id': 'native' } })
    yield 'chunk'
  }
  const gen = handlers.get('llm/stream')({ sessionId: 'session-abc' }, () => inner())
  for await (const _ of gen) { /* drain */ }
  assert.equal(recorder.calls.length, 2)
  for (const call of recorder.calls) {
    assert.equal(call.headers.has('x-session-id'), false)
    assert.equal(call.headers.get('x-deepseek-harness-session-id'), 'native')
  }
  // Case-insensitive detection, and the message is emitted exactly once.
  assert.equal(infos.filter((line) => /native session header/.test(line)).length, 1)
})

test('guards: an existing own header keeps the never-overwrite rule', async (t) => {
  const { handlers, recorder, infos } = boot(t, { header: 'x-session-id' })
  async function* inner() {
    await fetch('https://llm.example.com/v1/chat', { headers: { 'x-session-id': 'someone-else' } })
    yield 'chunk'
  }
  const gen = handlers.get('llm/stream')({ sessionId: 'session-abc' }, () => inner())
  for await (const _ of gen) { /* drain */ }
  assert.equal(recorder.calls.length, 1)
  assert.equal(recorder.calls[0].headers.get('x-session-id'), 'someone-else')
  // Our own header is never "native": that value could be a sibling instance's
  // injection, so it must not stand this one down.
  assert.equal(infos.filter((line) => /native session header/.test(line)).length, 0)
})

test('guards: a sibling instance header is never mistaken for a native one', async () => {
  const recorder = installFetchRecorder()
  const updates = []
  const settings = {
    update(...args) {
      updates.push(args)
      return Promise.resolve()
    },
  }
  // Two rows of the same plugin (HMR, a duplicate entry): both inject the same
  // header name, and the second hook sees the first hook's value on the call.
  const first = bootInstance({ header: 'x-session-id' }, { settings })
  const second = bootInstance({ header: 'x-session-id' }, { settings })
  try {
    async function* inner() {
      await fetch('https://llm.example.com/v1/chat')
      yield 'chunk'
    }
    // Compose both llm/stream handlers the way the waterfall does, so both
    // AsyncLocalStorage scopes are live for the one adapter fetch.
    const piped = first.handlers.get('llm/stream')({ sessionId: 'session-abc' }, () =>
      second.handlers.get('llm/stream')({ sessionId: 'session-abc' }, () => inner()),
    )
    for await (const _ of piped) { /* drain */ }
    await flush()
    assert.equal(recorder.calls.length, 1)
    assert.equal(recorder.calls[0].headers.get('x-session-id'), 'abc')
    assert.equal(second.infos.filter((line) => /native session header/.test(line)).length, 0)
    assert.equal(updates.length, 0) // no nativeHeaderSeen write, no "uninstall me" prompt
  } finally {
    for (const dispose of first.disposers) dispose?.()
    for (const dispose of second.disposers) dispose?.()
    recorder.restore()
  }
})

test('guards: counters summarize on the first event and every 100 requests', async (t) => {
  const { handlers, recorder, infos } = boot(t, { header: 'x-session-id' })
  async function* inner() {
    for (let index = 0; index < 100; index += 1) {
      await fetch('https://llm.example.com/v1/chat', { headers: { session_id: `native-${index}` } })
    }
    yield 'chunk'
  }
  const gen = handlers.get('llm/stream')({ sessionId: 'session-abc' }, () => inner())
  for await (const _ of gen) { /* drain */ }
  assert.equal(recorder.calls.length, 100)
  const summaries = infos.filter((line) => /nativeSkipped=/.test(line))
  assert.equal(summaries.length, 2)
  assert.match(summaries[0], /nativeSkipped=1/)
  assert.match(summaries[1], /nativeSkipped=100/)
})

test('guards: a native sighting writes nativeHeaderSeen to settings exactly once', async (t) => {
  const updates = []
  const settings = {
    update(...args) {
      updates.push(args)
      return Promise.resolve()
    },
  }
  const { handlers, recorder } = boot(t, { header: 'x-session-id' }, { settings })
  async function* inner() {
    await fetch('https://llm.example.com/v1/chat', { headers: { 'x-deepseek-harness-session-id': 'native' } })
    await fetch('https://llm.example.com/v1/chat', { headers: { 'x-deepseek-harness-session-id': 'native' } })
    yield 'chunk'
  }
  const gen = handlers.get('llm/stream')({ sessionId: 'session-abc' }, () => inner())
  for await (const _ of gen) { /* drain */ }
  await flush()
  assert.equal(recorder.calls.length, 2)
  for (const call of recorder.calls) assert.equal(call.headers.has('x-session-id'), false)
  assert.equal(updates.length, 1)
  assert.equal(updates[0][0], 'session-header') // the plugin's own entry id
  assert.deepEqual(updates[0][1], { nativeHeaderSeen: true })
  assert.equal(updates[0][2], undefined) // no expectedRevision = no CAS
})

test('guards: a settings failure never affects the request and warns once', async (t) => {
  const settings = {
    update() {
      return Promise.reject(new Error('settings down'))
    },
  }
  const { handlers, recorder, warnings } = boot(t, { header: 'x-session-id' }, { settings })
  async function* inner() {
    await fetch('https://llm.example.com/v1/chat', { headers: { 'x-deepseek-harness-session-id': 'native' } })
    await fetch('https://llm.example.com/v1/chat', { headers: { 'x-deepseek-harness-session-id': 'native' } })
    yield 'chunk'
  }
  const gen = handlers.get('llm/stream')({ sessionId: 'session-abc' }, () => inner())
  for await (const _ of gen) { /* drain */ }
  await flush()
  assert.equal(recorder.calls.length, 2)
  for (const call of recorder.calls) {
    assert.equal(call.headers.has('x-session-id'), false)
    assert.equal(call.headers.get('x-deepseek-harness-session-id'), 'native')
  }
  assert.equal(warnings.filter((line) => /nativeHeaderSeen/.test(line)).length, 1)
})
