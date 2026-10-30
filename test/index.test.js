/**
 * Tests for the tools/execute injection phase (issue #1) plus regression
 * coverage for the existing llm/stream behavior.
 *
 * Run with: node --test test/
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, Config, normalizeSessionId } from '../index.js'

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

/** Cordis-like context stub: captures on() handlers, runs effect() setup. */
function makeContext() {
  const handlers = new Map()
  const disposers = []
  const errors = []
  const warnings = []
  const ctx = {
    logger: {
      warn(line) { warnings.push(String(line)) },
      error(line) { errors.push(String(line)) },
    },
    on(event, handler) {
      handlers.set(event, handler)
    },
    effect(fn) {
      disposers.push(fn())
    },
  }
  return { ctx, handlers, disposers, errors, warnings }
}

/** Install recorder, apply plugin, and wire automatic cleanup. */
function boot(t, config = {}) {
  const recorder = installFetchRecorder()
  const { ctx, handlers, disposers, errors, warnings } = makeContext()
  // Go through the Schema, the way the harness loads the plugin: defaults for
  // toolEndpoints/overwriteHeaders/header come from Config, not from apply().
  apply(ctx, Config(config))
  t.after(() => {
    for (const dispose of disposers) dispose?.()
    recorder.restore()
  })
  return { ctx, handlers, recorder, errors, warnings }
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

test('normalizeSessionId: every harness id shape maps onto one wire value', () => {
  // Persistent sessions report `session-<uuid>`.
  assert.equal(normalizeSessionId(`session-${UUID}`), UUID)
  // An id minted without an explicit name is `session-<n>`: only the prefix goes.
  assert.equal(normalizeSessionId('session-42'), '42')
  // Configurable agents report `<agentId>-session-<uuid>`: the UUID is the identity.
  assert.equal(normalizeSessionId(`agent-alpha-session-${UUID}`), UUID)
  assert.equal(normalizeSessionId(`sub-agent-2-session-${UUID}`), UUID)
  // A UUID is case-insensitive, so every spelling normalizes to lower case.
  assert.equal(normalizeSessionId(`agent-alpha-session-${UPPER_UUID}`), UUID)
  assert.equal(normalizeSessionId(`session-${UPPER_UUID}`), UUID)
  // The tail match is case-insensitive end to end, separator included.
  assert.equal(normalizeSessionId(`agent-alpha-SESSION-${UUID}`), UUID)
  // A bare UUID passes through.
  assert.equal(normalizeSessionId(UUID), UUID)
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

test('llm/stream: agent-form id is normalized to the bare UUID', async (t) => {
  const { handlers, recorder } = boot(t, { header: 'x-session-id' })
  async function* inner() {
    await fetch('https://llm.example.com/v1/chat/completions')
    yield 'chunk-1'
  }
  const gen = handlers.get('llm/stream')({ sessionId: `agent-alpha-session-${UUID}` }, () => inner())
  for await (const _ of gen) { /* drain */ }
  assert.equal(recorder.calls.length, 1)
  assert.equal(recorder.calls[0].headers.get('x-session-id'), UUID)
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
  assert.equal(recorder.calls[0].headers.get('x-opencode-session'), UUID)
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
  assert.equal(recorder.calls[0].headers.get('x-opencode-session'), UUID)
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

