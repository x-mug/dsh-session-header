# dsh-session-header

English | [中文](README.zh.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that injects an `x-session-id` HTTP header onto **every LLM provider request** the harness sends, carrying the **harness session id of that exact call**.

## Why

The harness has no per-request header seam — `GenerateOptions` has no headers field and every adapter builds its own wire headers internally. If your model gateway (or an intermediary proxy) keys routing, caching, or auditing on a session header, the harness cannot send one by itself.

This plugin closes that gap with the two official interception points composed together:

- the **`llm/stream` waterfall** names the calls that are LLM calls and carries `options.sessionId`;
- a **`globalThis.fetch` patch** adds the header, so every fetch-based adapter (`llm-deepseek`, `llm-pi-ai`, and any SDK whose transport bottoms out in global fetch) is covered without touching adapter code.

Context propagation uses `AsyncLocalStorage`. With the default empty `toolEndpoints` no `tools/execute` scope is established, so only fetches that happen inside an LLM call's stream are touched; web RPC, telemetry, and tool traffic pass through untouched. With a non-empty `toolEndpoints` every `tools/execute` call that carries an agent id also runs inside a scope, and only fetches whose URL starts with a configured prefix get the header; everything else — web RPC, telemetry, and third-party tool targets — stays untouched. The `llm/stream` scope itself has no URL whitelist — that gate applies only in the tool phase — so any fetch inside an LLM call's stream is a candidate for injection — the only remaining limits are a resolved value and the overwrite rule below. A header anyone else already set keeps its value unless `overwriteHeaders` opts this plugin's header in (case-insensitive, per HTTP semantics). Unloading the plugin restores the original `fetch`, but only while `globalThis.fetch` still points at this plugin's patch: if another patch wrapped it afterwards, the unload logs a warning and leaves that patch in place.

Semantics of the value:

- default: `GenerateOptions.sessionId` of the call in flight, normalized before it goes on the wire: an `<agentId>-session-<uuid>` id yields that UUID, and any other id only loses a leading `session-` prefix — so a persistent `session-<uuid>` sends a bare UUID, and a configurable agent reports that same UUID instead of its `<agentId>-session-<uuid>` spelling; main-session turns, compaction/title helper calls, and in-process subagent children each report **their own** session id (subagents get their own child session ids); inside a `tools/execute` call the id comes from `exec.agent.id` (the agent running the tool) and is normalized the same way;
- `value` config: a fixed value for every call instead (sent verbatim, no prefix stripping);
- calls with neither get no header.

## Install

Requires the `dsh` CLI and Node ≥ 22.

### As a bundle (recommended)

```sh
dsh plugin --profile <name> add github:homily707/dsh-session-header
```

This package is plain JavaScript with no build scripts, so the pnpm ≥ 10 build allowance is not needed. For a reproducible install, pin a tag or commit (`github:homily707/dsh-session-header#<tag-or-sha>`). Verify the layer and boot:

```sh
dsh --profile <name> --dump-config   # look for the "# == dsh-session-header" layer
dsh --profile <name>
```

### As a `--patch` overlay from a local checkout

```yaml
# my-overlay.yml — plugin rows need an absolute module path here
- insert:
    - id: session-header
      name: /absolute/path/to/dsh-session-header/index.js
      config:
        header: x-session-id
        # value: my-fixed-session-id
```

```sh
dsh --patch ./my-overlay.yml
```

## Configuration

| field | type | default | meaning |
| --- | --- | --- | --- |
| `header` | string | `x-session-id` | header name to inject; case-insensitive on the wire |
| `value` | string | — | fixed value; unset = the harness session id of the call in flight |
| `toolEndpoints` | string[] | `[]` | URL prefixes matched during tool execution. When non-empty, fetches inside a `tools/execute` waterfall — e.g. a gateway web-search Messages API called from a tool — get the header only when their URL starts with one of these prefixes; third-party tool targets (web_fetch of arbitrary pages, GitHub, MCP servers) stay untouched. A prefix whose parsed path is `/` matches the whole origin, so every path under that origin receives the session id. Empty (default) keeps the upstream LLM-only injection. |
| `overwriteHeaders` | string[] | `[]` | Must contain this plugin's own `header` name (case-insensitive) to allow replacing that header's existing value; any other name has no effect. Everything else keeps the "never overwrite" rule. Some official providers hard-code placeholder values (e.g. `dsh-web-search-deepseek` sends `x-opencode-session: dsh-web-search`), which gateways reject as missing; to replace that placeholder, set that header's name as this plugin's header too — e.g. `header: x-opencode-session` with `overwriteHeaders: [x-opencode-session]` — so the live session id replaces it. |

## Verify it

Point a provider's `baseURL` at a logging gateway (or any endpoint that echoes request headers) and start a session:

```
x-session-id: ba104306-a748-4052-a6e3-ab60be2e4c1f
```

Every request of the same conversation carries the same id; a spawned subagent's requests carry the child session id.

## Notes

- The `llm-deepseek` adapter already sends its own `x-deepseek-harness-session-id` on every request; this plugin is provider-neutral and never overwrites an existing header by default — only when `overwriteHeaders` explicitly lists this plugin's own header is the existing value replaced.
- `attributionHeaders()` (the harness User-Agent attribution contract) is never touched.
- Concurrent sessions are handled correctly: the header value is resolved per call through AsyncLocalStorage, not through shared mutable state.

## License

[MIT](LICENSE)
