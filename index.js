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
 * Unloading the plugin restores the original fetch.
 *
 * @module dsh-session-header
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import Schema from '@deepseek-ai/schemastery'

export const name = 'dsh-session-header'

// Hard dependency: nothing to do until the llm runtime exists.
export const inject = ['llm']

export const Config = Schema.object({
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
   * Header names this plugin is allowed to OVERWRITE when they already carry a
   * value. Everything else keeps the "never overwrite" rule. Some official
   * providers hard-code placeholder values (e.g. dsh-web-search-deepseek sends
   * `x-opencode-session: dsh-web-search`), which a gateway rejects as missing;
   * listing the header here lets the live session id replace that placeholder.
   * Case-insensitive match, default empty = never overwrite.
   */
  overwriteHeaders: Schema.array(Schema.string()).default([]),
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
 * @returns {string | undefined} a diagnostic, or undefined when both are usable.
 */
function configDiagnostic(header, value) {
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
 * Plugin entry. `config.header` names the header, `config.value` optionally
 * fixes its value; per call, the AsyncLocalStorage store carries the resolved
 * value (plus the tool-phase gate), and a present store marks "this is an LLM
 * fetch".
 */
export function apply(ctx, config) {
  // The Schema above already filled the defaults (the harness validates plugin
  // config through it), so these are read once here rather than re-defaulted on
  // every injection.
  const { header, value: fixedValue, toolEndpoints, overwriteHeaders } = config

  // Fail closed BEFORE any global side effect: nothing is patched and no
  // listener is registered, so a rejected config cannot degrade requests. Log
  // first, then throw: Cordis catches an apply() rejection and marks the fiber
  // failed, which is exactly the state an operator needs to see — a silent
  // return would leave the plugin looking healthy while doing nothing.
  const problem = configDiagnostic(header, fixedValue)
  if (problem !== undefined) {
    ctx.logger.error(`dsh-session-header: not installing — ${problem}`)
    throw new Error(`dsh-session-header: ${problem}`)
  }

  const als = new AsyncLocalStorage()
  const originalFetch = globalThis.fetch
  // Only one question is ever asked of `overwriteHeaders`: may we replace OUR
  // header? Case-insensitive match, the same rule the wire uses.
  const mayOverwrite = overwriteHeaders.some((name) => name.toLowerCase() === header.toLowerCase())

  // Pre-compile toolEndpoints into origin-anchored matchers so the whitelist
  // can never match a sibling domain: `https://gateway.example.com` must not
  // match `https://gateway.example.com.evil.io/x`. The URL parser normalizes
  // host casing and default ports; the path comparison then enforces a
  // boundary character so `/zen/go/v1` matches `/zen/go/v1/messages` but not
  // `/zen/go/v10`. Unparseable or non-http(s) prefixes are dropped (fail
  // closed: a broken prefix simply never matches, so no header is sent).
  const endpointMatchers = toolEndpoints
    .map((prefix) => {
      let parsed
      try {
        parsed = new URL(prefix)
      } catch {
        ctx.logger.warn(`dsh-session-header: ignoring unparseable toolEndpoint ${JSON.stringify(prefix)}`)
        return undefined
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        ctx.logger.warn(`dsh-session-header: ignoring non-http(s) toolEndpoint ${JSON.stringify(prefix)}`)
        return undefined
      }
      return { origin: parsed.origin, path: parsed.pathname }
    })
    .filter((entry) => entry !== undefined)

  const urlMatchesEndpoint = (input) => {
    let target
    try {
      const raw =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url
      if (typeof raw !== 'string') return false
      target = new URL(raw)
    } catch {
      return false
    }
    return endpointMatchers.some(({ origin, path }) => {
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

  // One warning per distinct internal failure. A failure mode repeats on every
  // request, so logging per request would bury everything else; the cap keeps
  // an adversarial stream of novel messages from growing the set forever.
  const reportedFallbacks = new Set()
  const reportFallback = (error) => {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    const signature = detail.slice(0, 200)
    if (reportedFallbacks.size >= 32 || reportedFallbacks.has(signature)) return
    reportedFallbacks.add(signature)
    ctx.logger.warn(`dsh-session-header: not injecting this request after an internal error (${signature})`)
  }

  const patchedFetch = (input, init) => {
    // Only the plugin's own work runs inside this try: the upstream call is
    // made after it succeeds, so a plugin bug falls back to the untouched
    // request instead of retrying — or swallowing — someone else's fetch.
    let target = input
    let overrides = init
    try {
      const injection = als.getStore()
      // No store, no value, or a tool-phase fetch outside the whitelist: pass
      // the caller's own arguments through untouched.
      if (
        injection !== undefined &&
        injection.value !== undefined &&
        !(injection.toolPhase === true && !urlMatchesEndpoint(input))
      ) {
        // Collect headers from both fetch() spellings: a Request object carries
        // its own, and init.headers overrides them per the fetch standard.
        const headers = new Headers(input instanceof Request ? input.headers : undefined)
        if (init?.headers !== undefined) {
          for (const [key, value] of new Headers(init.headers)) headers.set(key, value)
        }
        // Inject only when absent — unless `overwriteHeaders` lists our header,
        // in which case the live session id replaces whatever placeholder value
        // another layer (an official provider) hard-coded.
        if (!headers.has(header) || mayOverwrite) {
          headers.set(header, injection.value)
          if (input instanceof Request && init === undefined) {
            // A bare Request input owns its headers; rebuild it so the original
            // — which may be reused by the caller — keeps arriving providers
            // without us.
            target = new Request(input, { headers })
            overrides = undefined
          } else {
            overrides = { ...init, headers }
          }
        }
      }
    } catch (error) {
      reportFallback(error)
      return originalFetch(input, init)
    }
    return originalFetch(target, overrides)
  }

  globalThis.fetch = patchedFetch
  // cordis `ctx.effect`: the callback runs IMMEDIATELY (setup); its RETURN
  // VALUE is the disposer collected for fiber unload. v0.1.0 ran the restore
  // in the callback body — undoing the patch in the same tick — so the fix
  // returns the restore as the disposer.
  ctx.effect(() => () => {
    if (globalThis.fetch === patchedFetch) {
      globalThis.fetch = originalFetch
    } else {
      // Someone else replaced fetch after we loaded; their patch fronts ours,
      // so restoring ours would silently drop theirs.
      ctx.logger.warn('dsh-session-header: global fetch was replaced after load; not restoring')
    }
  })

  ctx.on('llm/stream', async function* (options, next) {
    const inner = next()
    const iterator = inner[Symbol.asyncIterator]()
    const scope = { value: resolveValue(options.sessionId) }
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
    // `toolPhase` turns on the whitelist gate for every fetch in this chain.
    return als.run({ value: resolveValue(agentId), toolPhase: true }, () => next())
  })
}
