/**
 * Inject one HTTP header (default `x-session-id`) onto every LLM provider
 * request the harness sends, carrying the harness session id of that exact
 * call — so turns, compaction/title helper calls, and in-process subagent
 * children each report their own session.
 *
 * The harness has no per-request header seam: `GenerateOptions` carries no
 * headers field, and each adapter builds its own wire headers inside
 * `stream()`. The two official interception points compose into one here:
 *
 * - the `llm/stream` waterfall names the calls that are LLM calls and carries
 *   `options.sessionId`, and
 * - a `globalThis.fetch` patch adds the header, so every fetch-based adapter
 *   (llm-deepseek, llm-pi-ai, and any SDK whose transport bottoms out in
 *   global fetch) is covered without touching adapter code.
 *
 * Context propagation uses AsyncLocalStorage: each `iterator.next()` resumes
 * the adapter's stream inside `als.run()`, so the adapter's internal `fetch`
 * lands in the store, while unrelated fetches (web RPC, telemetry, tools)
 * see no store and pass through untouched.
 *
 * A fixed value can be configured instead of the live session id (sent
 * verbatim). The live id is normalized to one stable wire shape — an
 * `<agentId>-session-<uuid>` id yields that UUID, any other id only loses a
 * leading `session-` — so the same conversation reports the same id whichever
 * harness path produced it. Calls with neither a configured value nor a
 * session id get no header. A header anyone else already set is never overwritten
 * (`Headers` matching is case-insensitive, the same rule the wire uses).
 * The fetch patch is one shared dispatcher registered on `globalThis` under a
 * stable Symbol: several instances (or an HMR re-apply) share a single wrapper
 * layer, and unloading removes only that instance's hook — the original fetch
 * comes back once the last hook is gone and nothing else wrapped us.
 *
 * @module dsh-session-header
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import Schema from '@deepseek-ai/schemastery'

export const name = 'dsh-session-header'

// Hard dependency: nothing to do until the llm runtime exists.
export const inject = ['llm']

/**
 * Session-header names the DSH/magpie ecosystem already uses for the identity
 * this plugin carries. Seeing one of them on a request means someone else is
 * already stamping the session, so this plugin stays out of the way.
 */
const DEFAULT_NATIVE_SESSION_HEADERS = [
  'x-session-id',
  'x-opencode-session',
  'x-session-affinity',
  'session_id',
  'session-id',
  'x-claude-code-session-id',
  'x-conversation-id',
  'x-deepseek-harness-session-id',
]

export const Config = Schema.object({
  /**
   * Master switch. `false` keeps the plugin configured — the schema still
   * loads, so a settings surface can turn it back on — while installing
   * nothing: no dispatcher hook and no listeners.
   */
  enabled: Schema.boolean().default(true),
  /**
   * Session-header names that mean "this request already carries the identity".
   * A request holding any of them (case-insensitive) is left untouched and
   * counted as a native skip. The default list covers the DSH/magpie ecosystem:
   * x-session-id, x-opencode-session, x-session-affinity, session_id,
   * session-id, x-claude-code-session-id, x-conversation-id and
   * x-deepseek-harness-session-id.
   */
  nativeSessionHeaders: Schema.array(Schema.string()).default(DEFAULT_NATIVE_SESSION_HEADERS),
  /**
   * Header name to inject; HTTP field names are case-insensitive on the wire.
   * An invalid field name, or a credential/routing/framing header, rejects the
   * configuration at apply time — logged, then thrown, so the plugin shows up
   * as failed instead of loading healthy and never injecting.
   */
  header: Schema.string().default('x-session-id'),
  /**
   * Fixed header value. Unset means "use the harness session id of the call
   * in flight" (`GenerateOptions.sessionId`); calls with neither get no header.
   * When set it must be non-empty and a valid HTTP header value (no CR/LF/NUL).
   */
  value: Schema.string(),
  /**
   * URL prefixes matched during tool execution. When non-empty, fetches that
   * happen inside a `tools/execute` waterfall (tool calls such as a web-search
   * Messages API against your model gateway) get the header ONLY when their
   * URL starts with one of these prefixes. Third-party tool targets (web_fetch
   * of arbitrary pages, GitHub, MCP servers, ...) stay untouched. Empty (the
   * default) keeps the upstream single-scope behavior: only LLM provider
   * requests are injected.
   */
  toolEndpoints: Schema.array(Schema.string()).default([]),
  /**
   * Allowlist of URL prefixes for the LLM phase. Empty (the default) means NO
   * restriction: every fetch inside an `llm/stream` scope is a candidate, which
   * is what a provider adapter's own internal fetches need — the opposite of
   * `toolEndpoints`, where empty disables the tool phase. When non-empty, only
   * fetches whose URL starts with one of these prefixes get the header (same
   * origin-equal + path-boundary rule as `toolEndpoints`). Setting it is the
   * recommended posture. A prefix whose path is `/` covers the whole origin,
   * including same-origin OAuth token endpoints; write a specific path prefix
   * to keep those out. Every entry must parse as an http(s) URL: a bad entry
   * rejects the configuration at load, so a typo cannot silently turn the
   * allowlist into "no restriction" (unlike `toolEndpoints`, which only warns).
   */
  llmEndpointAllowlist: Schema.array(Schema.string()).default([]),
  /**
   * Header names this plugin is allowed to OVERWRITE when they already carry a
   * value. Everything else keeps the "never overwrite" rule. Some official
   * providers hard-code placeholder values (e.g. dsh-web-search-deepseek sends
   * `x-opencode-session: dsh-web-search`), which a gateway rejects as missing;
   * listing the header here lets the live session id replace that placeholder.
   * Case-insensitive match, default empty = never overwrite.
   */
  overwriteHeaders: Schema.array(Schema.string()).default([]),
  /**
   * Redirection guard, off by default so an existing deployment keeps its
   * current behavior. When on, a request this plugin actually stamps gets
   * `redirect: 'error'` unless the caller pinned `init.redirect`: fetch strips
   * credentials on a cross-origin redirect but would carry this header to the
   * new origin, so following one can leak the session id. Only an explicit
   * `init.redirect` is preserved verbatim: a `Request` input keeps a
   * non-default `redirect` (e.g. `manual`) but its default `follow` becomes
   * `error`.
   */
  redirectGuard: Schema.boolean().default(false),
  /**
   * Whether a native session header has ever been seen on a request. Written
   * automatically by this plugin — once, when the first one shows up — so the
   * client plugin can offer uninstalling this redundant plugin. Clearing it by
   * hand makes the client prompt appear again; it is not a normal user switch.
   * Volatile because it is written through the settings service, which only
   * edits live fields.
   */
  nativeHeaderSeen: Schema.boolean().default(false).volatile().description('Written automatically when a native session header is detected; clearing it by hand makes the client prompt appear again.'),
})

/**
 * The trailing `-session-<uuid>` shape of the ids the harness's configurable
 * agents report (`<agentId>-session-<uuid>`, built by dsh-agent-loop). Only a
 * canonical 36-character UUID tail is accepted, and the whole tail match is
 * case-insensitive, so an upper-case UUID still normalizes.
 */
const AGENT_SESSION_ID = /-session-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i

/** A value that is already one canonical UUID, in any casing. */
const UUID_ONLY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Normalize one harness session id into the value sent on the wire.
 *
 * - `<prefix>-session-<uuid>` (a configurable agent's id, ending in a
 *   canonical UUID) becomes that UUID;
 * - any other id starting with `session-` becomes the id without that prefix;
 * - everything else is returned unchanged;
 * - `undefined` stays `undefined`, which means "no session to report".
 *
 * A bare UUID is lowercased: UUIDs compare case-insensitively, so the same
 * session must not reach the wire in two spellings. Any other value keeps its
 * own casing. Only the trailing `-session-<uuid>` shape is unwrapped, so an id
 * that merely contains "session" (or `session-` mid-string) is never truncated.
 * @param {unknown} id - the raw id the harness reported.
 * @returns {string | undefined} the value to send for this id.
 */
export function normalizeSessionId(id) {
  if (id === undefined) return undefined
  const text = String(id)
  const agentForm = AGENT_SESSION_ID.exec(text)
  const bare = agentForm !== null ? agentForm[1] : text.replace(/^session-/, '')
  return UUID_ONLY.test(bare) ? bare.toLowerCase() : bare
}

/**
 * Headers this plugin never writes.
 *
 * - credentials: `authorization`, `proxy-authorization`, cookies, API keys —
 *   the session id must never be handed to a gateway as proof of identity;
 * - routing: `host`, `origin`, `referer`, `forwarded`, `x-forwarded-for`,
 *   `x-real-ip` — these describe where a request came from, which the plugin
 *   cannot know;
 * - framing/meta: `content-length`, `content-type`, `content-encoding`,
 *   `transfer-encoding`, `connection`, `upgrade`, `te`, `trailer`,
 *   `keep-alive`, `expect`, `accept`, `user-agent` — writing any of these
 *   corrupts the request or overrides what the caller negotiated.
 */
const FORBIDDEN_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'upgrade',
  'x-api-key',
  'api-key',
  'te',
  'trailer',
  'keep-alive',
  'proxy-authenticate',
  'forwarded',
  'x-forwarded-for',
  'x-real-ip',
  'origin',
  'referer',
  'content-type',
  'content-encoding',
  'expect',
  'accept',
  'user-agent',
])

/**
 * Validate a configured header name and fixed value against the runtime
 * `Headers` implementation — the same oracle the hot path uses, so no
 * hand-written field-name grammar can drift from what actually gets written.
 * @param {string} header - the configured header name.
 * @param {string | undefined} value - the configured fixed value, if any.
 * @param {string[]} llmEndpointAllowlist - LLM-phase URL prefixes.
 * @returns {string | undefined} a diagnostic, or undefined when all are usable.
 */
function configDiagnostic(header, value, llmEndpointAllowlist) {
  if (typeof header !== 'string' || header.length === 0) {
    return `config.header must be a non-empty string (got ${JSON.stringify(header)})`
  }
  try {
    new Headers().set(header, 'x')
  } catch (error) {
    return `config.header ${JSON.stringify(header)} is not a valid HTTP field name: ${error instanceof Error ? error.message : String(error)}`
  }
  if (FORBIDDEN_HEADERS.has(header.toLowerCase())) {
    return `config.header ${JSON.stringify(header)} is forbidden: this plugin never writes credential, routing, or framing headers`
  }
  // The LLM allowlist is a restriction, so a bad entry must not be dropped: an
  // empty result would read as "no restriction" and silently widen the
  // injection surface. toolEndpoints keeps its soft failure (it only widens
  // when valid, and empty already means "tool phase off").
  if (Array.isArray(llmEndpointAllowlist)) {
    for (const prefix of llmEndpointAllowlist) {
      let parsed
      try {
        parsed = new URL(prefix)
      } catch {
        return `config.llmEndpointAllowlist entry ${JSON.stringify(prefix)} is not a valid URL`
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return `config.llmEndpointAllowlist entry ${JSON.stringify(prefix)} is not an http(s) URL`
      }
    }
  }
  if (value !== undefined) {
    if (value.length === 0) {
      return 'config.value must not be empty; unset it to use the live session id'
    }
    try {
      new Headers().set(header, value)
    } catch (error) {
      return `config.value is not a valid HTTP header value: ${error instanceof Error ? error.message : String(error)}`
    }
  }
  return undefined
}

/**
 * Key of the shared fetch dispatcher registry on `globalThis`. `Symbol.for`
 * survives module duplication — two copies of this package (HMR, a linked
 * checkout) must find the same registry — and the `@1` suffix lets a future
 * incompatible dispatcher format coexist instead of misreading this shape.
 */
const DISPATCHER_KEY = Symbol.for('dsh-session-header#fetch-dispatcher@1')

/**
 * The registry on `globalThis` holds only `{ dispatcher, hooks }`. The captured
 * original fetch stays in this module's closure and is never read back out of
 * the registry.
 */
let capturedOriginalFetch
let warnedOrphan = false
let isolatedFailures = 0
const isolatedSignatures = new Set()
let dispatchWarn


/**
 * Register one hook in the shared dispatch layer, creating the layer only when
 * it is absent. An existing registry gains a hook and nothing else: `register`
 * never installs a second wrapper, so repeated loads (HMR, two instances) cannot
 * deepen the chain.
 *
 * Hook contract: `(input, init) => { input?, init? } | undefined`.
 *
 * - A hook must NOT read or consume `input.body`. It may replace the whole
 *   `input` (e.g. rebuild a `Request` carrying extra headers — which already
 *   fails once the body was used) or layer values onto `init`.
 * - Returning nothing (or undefined) means "pass the call through untouched".
 * - Hooks run in registration order against the progressively updated call.
 *   Each hook here injects only when the header is absent, so the first
 *   registrant wins unless it was configured to overwrite.
 * - A hook that throws is skipped for that request: the dispatcher isolates it
 *   (later hooks and the request itself continue) and reports it once per
 *   distinct signature, rate-limited like the injection failures.
 * @param {string} id - this registration's unique id, used to remove it later.
 * @param {function} hook - the hook described above.
 * @param {{ warn: function }} [logger] - sink for dispatcher-level diagnostics.
 * @returns {function} the dispatcher installed for this registry.
 */
export function register(id, hook, logger) {
  let registry = globalThis[DISPATCHER_KEY]
  if (registry === undefined) {
    const originalFetch = globalThis.fetch
    capturedOriginalFetch = originalFetch
    const hooks = new Map()
    const dispatcher = (input, init) => {
      let currentInput = input
      let currentInit = init
      for (const registered of hooks.values()) {
        let next
        try {
          next = registered(currentInput, currentInit)
        } catch (error) {
          // Isolate the failing hook: it cannot skip later hooks, change the
          // request, or turn its own bug into the caller's failure.
          isolatedFailures += 1
          const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
          const signature = detail.slice(0, 200)
          if (isolatedSignatures.size < 32 && !isolatedSignatures.has(signature)) {
            isolatedSignatures.add(signature)
            dispatchWarn?.(`dsh-session-header: skipped a failing fetch hook (${signature}; ${isolatedFailures} isolated failure(s) so far)`)
          }
          continue
        }
        if (next !== null && typeof next === 'object') {
          if ('input' in next) currentInput = next.input
          if ('init' in next) currentInit = next.init
        }
      }
      return originalFetch(currentInput, currentInit)
    }
    registry = { dispatcher, hooks }
    globalThis[DISPATCHER_KEY] = registry
    globalThis.fetch = dispatcher
  }
  // The dispatcher is shared, so its diagnostics go to the most recent
  // registrant's logger (typically the instance whose hook is being called).
  if (typeof logger?.warn === 'function') dispatchWarn = logger.warn.bind(logger)
  registry.hooks.set(id, hook)
  return registry.dispatcher
}

/**
 * Remove one hook. Idempotent: removing an id that is already gone — including a
 * second dispose of the same instance — does nothing and warns nothing.
 *
 * When the last hook goes, restore the captured fetch only if our dispatcher is
 * still the installed one: a patch applied after ours sits in front of it, so
 * restoring would silently drop that patch. In that case the now-inert
 * dispatcher stays in the chain (no hooks ⇒ pure passthrough) and the operator
 * is told once.
 * @param {string} id - the registration id handed to {@link register}.
 * @param {{ warn: function }} [logger] - sink for the one orphan warning.
 */
export function unregister(id, logger) {
  const registry = globalThis[DISPATCHER_KEY]
  if (registry === undefined) return
  if (!registry.hooks.delete(id)) return
  if (registry.hooks.size > 0) return
  if (globalThis.fetch !== registry.dispatcher) {
    if (warnedOrphan) return
    warnedOrphan = true
    logger?.warn?.('dsh-session-header: global fetch was wrapped after this plugin loaded; leaving that wrapper in place (the plugin now passes every call through)')
    return
  }
  if (capturedOriginalFetch === undefined) {
    // Only the module copy that created this registry holds the original fetch.
    if (warnedOrphan) return
    warnedOrphan = true
    logger?.warn?.('dsh-session-header: cannot restore the original fetch from this module copy; leaving the dispatcher inert (pure passthrough)')
    return
  }
  globalThis.fetch = capturedOriginalFetch
  delete globalThis[DISPATCHER_KEY]
}

/**
 * Plugin entry. `config.header` names the header, `config.value` optionally
 * fixes its value; per call, the AsyncLocalStorage store carries the resolved
 * value (plus the tool-phase gate), and a present store marks "this is an LLM
 * fetch".
 */
export function apply(ctx, config) {
  // The Schema above already filled the defaults (the harness validates plugin
  // config through it), so these are read once here rather than re-defaulted on
  // every injection.
  const { enabled, nativeSessionHeaders, header, value: fixedValue, llmEndpointAllowlist, toolEndpoints, overwriteHeaders, redirectGuard } = config

  // Fail closed BEFORE any global side effect: nothing is patched and no
  // listener is registered, so a rejected config cannot degrade requests. Log
  // first, then throw: Cordis catches an apply() rejection and marks the fiber
  // failed, which is exactly the state an operator needs to see — a silent
  // return would leave the plugin looking healthy while doing nothing.
  const problem = configDiagnostic(header, fixedValue, llmEndpointAllowlist)
  if (problem !== undefined) {
    ctx.logger.error(`dsh-session-header: not installing — ${problem}`)
    throw new Error(`dsh-session-header: ${problem}`)
  }

  if (!enabled) {
    // Configured but switched off: install nothing (no hook, no listener) while
    // the schema stays loaded, so a settings surface can turn it back on.
    ctx.logger.info?.('dsh-session-header: disabled by configuration (enabled: false); nothing installed')
    return
  }

  const als = new AsyncLocalStorage()
  // Only one question is ever asked of `overwriteHeaders`: may we replace OUR
  // header? Case-insensitive match, the same rule the wire uses.
  const mayOverwrite = overwriteHeaders.some((name) => name.toLowerCase() === header.toLowerCase())

  // Compile configured URL prefixes into origin-anchored matchers so a
  // whitelist can never match a sibling domain: `https://gateway.example.com`
  // must not match `https://gateway.example.com.evil.io/x`. The URL parser
  // normalizes host casing and default ports; the path comparison then enforces
  // a boundary character so `/zen/go/v1` matches `/zen/go/v1/messages` but not
  // `/zen/go/v10`. Unparseable or non-http(s) prefixes are dropped (fail
  // closed: a broken prefix simply never matches, so no header is sent).
  const compileEndpoints = (phase, prefixes) =>
    prefixes
      .map((prefix) => {
        let parsed
        try {
          parsed = new URL(prefix)
        } catch {
          ctx.logger.warn(`dsh-session-header: ignoring unparseable ${phase} ${JSON.stringify(prefix)}`)
          return undefined
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          ctx.logger.warn(`dsh-session-header: ignoring non-http(s) ${phase} ${JSON.stringify(prefix)}`)
          return undefined
        }
        return { origin: parsed.origin, path: parsed.pathname }
      })
      .filter((entry) => entry !== undefined)

  const toolMatchers = compileEndpoints('toolEndpoint', toolEndpoints)
  const llmMatchers = compileEndpoints('llmEndpointAllowlist', llmEndpointAllowlist)

  /** Whether one fetch target matches any compiled prefix of a phase. */
  const matchesEndpoint = (matchers, input) => {
    let target
    try {
      const raw =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url
      if (typeof raw !== 'string') return false
      target = new URL(raw)
    } catch {
      return false
    }
    return matchers.some(({ origin, path }) => {
      if (target.origin !== origin) return false
      if (path === '/') return true
      const pathname = target.pathname
      return (
        pathname === path ||
        (pathname.startsWith(path) &&
          (path.endsWith('/') || pathname[path.length] === '/' || pathname[path.length] === '?' || pathname[path.length] === '#'))
      )
    })
  }

  // Shared by both scopes: a configured value is sent verbatim, a live id is
  // normalized to one stable wire shape, and no id at all means "no header".
  // An empty live id counts as no id — the same rule the tool phase applies to
  // `exec.agent.id` — so a blank session id never becomes an empty header.
  const resolveValue = (id) => {
    if (fixedValue !== undefined) return fixedValue
    if (id === undefined || id === '') return undefined
    return normalizeSessionId(id)
  }

  // Detection counters, logged rather than exposed (the host has no status
  // surface): the first event of each kind, then one line every 100 events.
  const counters = { injected: 0, nativeSkipped: 0, fallback: 0 }
  const counterSummary = () =>
    `injected=${counters.injected} nativeSkipped=${counters.nativeSkipped} fallback=${counters.fallback}`
  const noteCounters = (kind) => {
    const total = counters.injected + counters.nativeSkipped + counters.fallback
    if (counters[kind] === 1 || total % 100 === 0) {
      ctx.logger.info?.(`dsh-session-header: ${counterSummary()}`)
    }
  }

  // The host cannot show a dialog, so a native sighting is reported — once in
  // the log, and once through settings where the client plugin reads it and
  // offers to uninstall this redundant plugin.
  let nativeReported = false
  let nativeHeaderWriteAttempted = false
  const noteNativeHeader = (name) => {
    counters.nativeSkipped += 1
    if (!nativeReported) {
      nativeReported = true
      ctx.logger.info?.(`dsh-session-header: native session header "${name}" detected; this plugin stops injecting — consider uninstalling it`)
    }
    if (!nativeHeaderWriteAttempted) {
      // Exactly one attempt: a settings write must never repeat per request,
      // and a failure must never reach the caller.
      nativeHeaderWriteAttempted = true
      const recordFailure = (error) => {
        ctx.logger.warn?.(`dsh-session-header: could not record nativeHeaderSeen in settings: ${error instanceof Error ? error.message : String(error)}`)
      }
      try {
        const settings = ctx.get?.('settings')
        const namespace = ctx.fiber?.entry?.options.id
        if (typeof settings?.update === 'function' && typeof namespace === 'string') {
          // Fire and forget. expectedRevision stays undefined = no CAS, so the
          // write also succeeds when another surface changed this entry.
          Promise.resolve(settings.update(namespace, { nativeHeaderSeen: true }, undefined)).catch(recordFailure)
        }
      } catch (error) {
        recordFailure(error)
      }
    }
    noteCounters('nativeSkipped')
  }

  // One warning per distinct internal failure. A failure mode repeats on every
  // request, so logging per request would bury everything else; the cap keeps
  // an adversarial stream of novel messages from growing the set forever.
  const reportedFallbacks = new Set()
  const reportFallback = (error) => {
    counters.fallback += 1
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    const signature = detail.slice(0, 200)
    if (reportedFallbacks.size >= 32 || reportedFallbacks.has(signature)) return
    reportedFallbacks.add(signature)
    ctx.logger.warn(`dsh-session-header: not injecting this request after an internal error (${signature}; ${counters.fallback} failure(s) so far)`)
  }

  // Redirection policy: only rewrite a request the operator opted into
  // guarding, and never override a redirect the caller chose itself.
  const guardedRedirect = (input, init) => {
    if (init?.redirect !== undefined) return init.redirect
    if (input instanceof Request && input.redirect !== 'follow') return input.redirect
    return 'error'
  }

  // The injection itself is one dispatcher hook: it returns the arguments the
  // dispatcher should forward (or undefined to forward the caller's own
  // untouched), and the shared dispatcher calls the real fetch only after every
  // hook has run.
  const inject = (input, init) => {
    // Only the plugin's own work runs inside this try; returning undefined lets
    // the dispatcher forward the caller's own arguments, so a plugin bug can
    // never change — or re-issue — someone else's request.
    try {
      const injection = als.getStore()
      // No store, no value, or a fetch outside this phase's whitelist: pass the
      // caller's own arguments through untouched.
      if (
        injection === undefined ||
        injection.value === undefined ||
        (injection.matchers !== null && !matchesEndpoint(injection.matchers, input))
      ) {
        return undefined
      }
      // Collect headers from both fetch() spellings: a Request object carries
      // its own, and init.headers overrides them per the fetch standard.
      const headers = new Headers(input instanceof Request ? input.headers : undefined)
      if (init?.headers !== undefined) {
        for (const [key, value] of new Headers(init.headers)) headers.set(key, value)
      }
      // Someone else already carries the identity: leave the request alone and
      // record the sighting. Our own header name NEVER counts as native,
      // independent of `overwriteHeaders`: a second instance of this plugin
      // (HMR, a duplicate row) injects exactly this name, and reading its value
      // as "someone else already did it" would leave that instance permanently
      // stood down and claim this plugin is redundant.
      const ownHeader = header.toLowerCase()
      const nativeHeader = nativeSessionHeaders.find(
        (name) => name.toLowerCase() !== ownHeader && headers.has(name),
      )
      if (nativeHeader !== undefined) {
        noteNativeHeader(nativeHeader)
        return undefined
      }
      // Inject only when absent — unless `overwriteHeaders` lists our header, in
      // which case the live session id replaces whatever placeholder value
      // another layer (an official provider) hard-coded.
      if (headers.has(header) && !mayOverwrite) return undefined
      headers.set(header, injection.value)
      // Optional guard: fetch strips credentials on a cross-origin redirect but
      // would carry this header to the new origin, so a guarded request refuses
      // to follow one. Applied in BOTH call shapes and only when `redirectGuard`
      // is on and the caller pinned no redirect of its own.
      const extra = redirectGuard ? { redirect: guardedRedirect(input, init) } : {}
      if (input instanceof Request && init === undefined) {
        // A bare Request input owns its headers; rebuild it so the original —
        // which may be reused by the caller — keeps arriving providers without
        // us. The rebuild fails when the body was already consumed: say so
        // (rate-limited) and let the caller's own call through unmodified.
        const nextInput = new Request(input, { headers, ...extra })
        counters.injected += 1
        noteCounters('injected')
        return { input: nextInput }
      }
      counters.injected += 1
      noteCounters('injected')
      return { init: { ...init, headers, ...extra } }
    } catch (error) {
      reportFallback(error)
      return undefined
    }
  }

  // A random id, not a per-module counter: two module copies of this package
  // each start a counter at zero, and a colliding id would let one copy's
  // dispose delete the other copy's hook. The Map's insertion order (not the
  // id) is what fixes hook execution order.
  const hookId = randomUUID()
  try {
    register(hookId, inject, ctx.logger)
  } catch (error) {
    // A fetch patch that failed to install would leave the plugin looking
    // healthy while injecting nothing, which the loader must never miss.
    ctx.logger.error(`dsh-session-header: could not install the fetch dispatcher hook: ${error instanceof Error ? error.message : String(error)}`)
    throw error
  }
  // Mount self-check: the hook must actually be in the shared registry. A
  // silently ignored registration is the same dead-plugin failure as a throw,
  // so fail loudly instead of pretending to be installed.
  const mountedRegistry = globalThis[DISPATCHER_KEY]
  if (mountedRegistry === undefined || !mountedRegistry.hooks.has(hookId)) {
    const message = 'dsh-session-header: the fetch dispatcher hook did not register'
    ctx.logger.error(message)
    throw new Error(message)
  }
  // cordis `ctx.effect`: the callback runs IMMEDIATELY (setup); its RETURN VALUE
  // is the disposer collected for fiber unload, so unloading removes this
  // instance's hook — and restores the original fetch only when this was the
  // last hook and nothing wrapped our dispatcher.
  ctx.effect(() => () => unregister(hookId, ctx.logger))

  ctx.on('llm/stream', async function* (options, next) {
    const inner = next()
    const iterator = inner[Symbol.asyncIterator]()
    // Ungated by default (a provider adapter's own fetches must keep working);
    // a non-empty `llmEndpointAllowlist` opts this scope into the URL whitelist.
    const scope = {
      value: resolveValue(options.sessionId),
      matchers: llmMatchers.length > 0 ? llmMatchers : null,
    }
    let exhausted = false
    try {
      while (true) {
        // Each adapter step runs inside the store, so its internal fetch
        // (whenever in the call it happens) sees this call's injection facts.
        const result = await als.run(scope, () => iterator.next())
        if (result.done) {
          exhausted = true
          return
        }
        yield result.value
      }
    } finally {
      if (!exhausted) await iterator.return?.()
    }
  })

  // Tool execution happens BETWEEN two streamed turns — outside any
  // `llm/stream` scope — so gateway calls made from inside a tool (e.g. an
  // Anthropic-compatible web-search Messages API against the same baseURL)
  // used to miss the header entirely. The `tools/execute` waterfall carries
  // `exec.agent.id` = the harness session id of the agent running the tool
  // (main session, compaction/title helpers, and in-process subagents each
  // report their own). Cover the whole promise chain in a scope so every
  // fetch the tool awaits is a candidate — then let the whitelist decide.
  ctx.on('tools/execute', async (exec, next) => {
    const agentId = exec.agent?.id
    // Empty agent id (not just missing) also means "no session to report":
    // both scopes share the same no-value ⇒ no-header semantics.
    if (
      agentId === undefined ||
      typeof agentId !== 'string' ||
      agentId.length === 0 ||
      toolEndpoints.length === 0
    ) {
      return next()
    }
    // `matchers` turns on the whitelist gate for every fetch in this chain; an
    // empty result (every prefix was rejected) fails closed: nothing matches.
    return als.run({ value: resolveValue(agentId), matchers: toolMatchers }, () => next())
  })
}
