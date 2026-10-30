/**
 * Browser-half contract: the factory is registered, both slots are offered,
 * the one-time notice obeys the recorded fact and the dismissal stamp, and a
 * missing or unreadable form degrades instead of throwing.
 *
 * The bundle runs in a page, so this file installs the page-shaped globals
 * (`window`, `localStorage`, `__ModuleLoader__`) plus a tiny React stand-in
 * BEFORE importing it, and then drives the exported `apply` through a fake
 * Cordis context. No build step, no jsdom.
 */
import assert from 'node:assert/strict'
import test, { after } from 'node:test'

const CLIENT_URL = new URL('../client.js', import.meta.url)

// ---------------------------------------------------------------------------
// Page stand-ins, installed before the bundle body executes.
// ---------------------------------------------------------------------------

const storage = new Map()
const localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => {
    storage.set(key, String(value))
  },
  removeItem: (key) => {
    storage.delete(key)
  }
}

const factories = new Map()
const previousWindow = globalThis.window
globalThis.window = {
  navigator: { language: 'zh-CN' },
  localStorage,
  __ModuleLoader__: {
    load: ({ id, factory }) => {
      assert.equal(typeof id, 'string')
      factories.set(id, factory)
    }
  }
}

after(() => {
  globalThis.window = previousWindow
  storage.clear()
})

/** The smallest React that renders `createElement` trees and holds state. */
const react = {
  createElement: (tag, props, ...children) => ({ tag, props: props ?? {}, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {}
}

/** Platform module table stand-in: only `react` is requested. */
const requirePlatform = (name) => {
  if (name === 'react') return react
  throw new Error('unexpected platform module: ' + name)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Every string rendered anywhere in one element tree. */
const texts = (node) => {
  const found = []
  const walk = (value) => {
    if (value === null || value === undefined || typeof value === 'boolean') return
    if (typeof value === 'string' || typeof value === 'number') {
      found.push(String(value))
      return
    }
    if (Array.isArray(value)) {
      for (const child of value) walk(child)
      return
    }
    if (typeof value === 'object' && 'children' in value) {
      for (const child of value.children) walk(child)
    }
  }
  walk(node)
  return found.join('\n')
}

/** Let the initial `describe` promise chain settle. */
const settle = async () => {
  for (let round = 0; round < 4; round += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

/** One settings.describe answer for the `session-header` entry. */
const describeWith = (entryValue) => ({
  ok: true,
  value: {
    namespaces: [
      {
        ns: 'session-header',
        revision: 7,
        applies: 'live',
        value: entryValue,
        user: {},
        base: {}
      }
    ]
  }
})

/** A Cordis-shaped context that records slot registrations. */
const createContext = (describe) => {
  const registrations = []
  const disposers = []
  const ctx = {
    effect: (callback) => {
      const disposer = callback()
      if (typeof disposer === 'function') disposers.push(disposer)
      return disposer
    },
    locale: {
      register: () => {},
      // A bound translator that answers nothing forces the local dictionary,
      // which is what a page without the locale service sees.
      bind: () => () => undefined
    },
    slots: {
      inject: (_name, register) => {
        register()
      },
      register: (entry, component) => {
        registrations.push({ entry, component })
        return () => {}
      }
    },
    on: () => () => {},
    get: () => undefined,
    remote: {
      $on: () => () => {},
      settings: { describe }
    }
  }
  return { ctx, registrations, disposers }
}

/** Read one registration by slot name. */
const slotOf = (registrations, name) => {
  const found = registrations.find((row) => row.entry.name === name)
  assert.ok(found, 'expected a slot registration for ' + name)
  return found
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

await import(CLIENT_URL.href)

test('browser bundle: the loader receives this plugin factory', () => {
  const factory = factories.get('dsh-session-header')
  assert.equal(typeof factory, 'function', 'client.js must load under dsh-session-header')
  const exported = factory(requirePlatform)
  assert.equal(typeof exported.apply, 'function')
  assert.deepEqual(exported.inject, ['slots', 'locale', 'remote', 'remote.settings'])
})

test('browser bundle: apply offers both surfaces', async () => {
  const factory = factories.get('dsh-session-header')
  const { ctx, registrations } = createContext(async () => describeWith({ enabled: true, header: 'x-session-id' }))
  factory(requirePlatform).apply(ctx)
  await settle()

  assert.equal(registrations.length, 2, 'two slots registered')
  const overlay = slotOf(registrations, 'shell.overlay')
  const section = slotOf(registrations, 'settings.section')
  assert.equal(overlay.entry.id, 'dsh-session-header.native-notice')
  assert.equal(section.entry.id, 'dsh-session-header')
  assert.ok(overlay.entry.order < section.entry.order, 'the banner sorts before the settings row')
})

test('browser bundle: a native sighting raises the one-time notice', async () => {
  const factory = factories.get('dsh-session-header')
  const { ctx, registrations } = createContext(async () => describeWith({
    enabled: true,
    header: 'x-session-id',
    nativeHeaderSeen: true
  }))
  factory(requirePlatform).apply(ctx)
  await settle()

  const overlay = slotOf(registrations, 'shell.overlay')
  const banner = overlay.component(overlay.entry.inject())
  const copy = texts(banner)
  assert.match(copy, /DSH 已原生发送会话头/)
  assert.match(copy, /不再提示/)
  assert.match(copy, /知道了/)

  const section = slotOf(registrations, 'settings.section')
  const card = texts(section.component(section.entry.inject()))
  assert.match(card, /已检测到/)
  assert.match(card, /建议卸载/)
})

test('browser bundle: dismissal hides the notice and can be re-armed', async () => {
  const factory = factories.get('dsh-session-header')
  const { ctx, registrations } = createContext(async () => describeWith({
    enabled: true,
    header: 'x-session-id',
    nativeHeaderSeen: true
  }))
  factory(requirePlatform).apply(ctx)
  await settle()

  const overlay = slotOf(registrations, 'shell.overlay')
  const bannerProps = overlay.entry.inject()
  assert.notEqual(overlay.component(bannerProps), null, 'notice is visible before dismissal')

  bannerProps.dismiss('nativeHeaderSeen')
  assert.equal(storage.get('dsh-session-header:native-notice-dismissed.v1'), 'nativeHeaderSeen')
  assert.equal(overlay.component(bannerProps), null, 'no notice once dismissed')

  const section = slotOf(registrations, 'settings.section')
  const sectionProps = section.entry.inject()
  sectionProps.restore()
  assert.equal(storage.has('dsh-session-header:native-notice-dismissed.v1'), false, 'restore clears the stamp')
  await settle()
  assert.notEqual(overlay.component(bannerProps), null, 'restored notice is visible again')
})

test('browser bundle: only the exact field counts, and silence stays silent', async () => {
  const factory = factories.get('dsh-session-header')
  // A future nativeSomething:true must NOT mean "uninstall this plugin".
  const { ctx, registrations } = createContext(async () => describeWith({
    enabled: true,
    header: 'x-session-id',
    nativeSomethingElse: true,
    status: { nativeHeaderDetected: true }
  }))
  factory(requirePlatform).apply(ctx)
  await settle()

  const overlay = slotOf(registrations, 'shell.overlay')
  assert.equal(overlay.component(overlay.entry.inject()), null, 'unrelated fields never raise the banner')
  const section = slotOf(registrations, 'settings.section')
  assert.match(texts(section.component(section.entry.inject())), /未检测到/)
})

test('browser bundle: the exact field under status also counts', async () => {
  const factory = factories.get('dsh-session-header')
  const { ctx, registrations } = createContext(async () => describeWith({
    enabled: true,
    status: { nativeHeaderSeen: true }
  }))
  factory(requirePlatform).apply(ctx)
  await settle()

  const overlay = slotOf(registrations, 'shell.overlay')
  const banner = overlay.component(overlay.entry.inject())
  assert.notEqual(banner, null)
  assert.match(texts(banner), /DSH 已原生发送会话头/)
})

test('browser bundle: a deployment without this form degrades quietly', async () => {
  const factory = factories.get('dsh-session-header')
  const { ctx, registrations } = createContext(async () => ({ ok: true, value: { namespaces: [] } }))
  factory(requirePlatform).apply(ctx)
  await settle()

  const overlay = slotOf(registrations, 'shell.overlay')
  assert.equal(overlay.component(overlay.entry.inject()), null, 'no notice without a form')
  const section = slotOf(registrations, 'settings.section')
  assert.match(texts(section.component(section.entry.inject())), /没有注册/)
})

test('browser bundle: a failed describe renders a diagnostic instead of throwing', async () => {
  const factory = factories.get('dsh-session-header')
  const { ctx, registrations } = createContext(async () => {
    throw new Error('settings offline')
  })
  factory(requirePlatform).apply(ctx)
  await settle()

  const overlay = slotOf(registrations, 'shell.overlay')
  assert.equal(overlay.component(overlay.entry.inject()), null, 'no notice after a failed read')
  const section = slotOf(registrations, 'settings.section')
  assert.match(texts(section.component(section.entry.inject())), /读取失败/)
})
