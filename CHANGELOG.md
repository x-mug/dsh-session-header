# Changelog

All notable changes to this fork. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Forked from [`homily707/dsh-session-header`](https://github.com/homily707/dsh-session-header) at `79a96e6` (0.2.1).

## [Unreleased]

### Fixed

- Require and lock `@deepseek-ai/schemastery` 3.18.5 or newer: the previous
  locked version lacked `.volatile()` and caused the plugin to fail on import.
- The settings status panel no longer shows "未知" for the plugin state and the
  injected header name. Both rows read data the Host actually publishes: the
  plugin state comes from `pluginInventory` (active / disabled / failed), and
  `header` is now a volatile config field, which is the only kind the settings
  service exposes to a panel. Previously the panel read `enabled` and `header`
  from a form that deliberately projects volatile fields only, so those two
  values were always undefined.
- A live `header` edit — in the config document or through the settings
  service — is now re-validated and applies to the next request. An unusable
  new name stops injection with an error until it is fixed, instead of being
  written to the wire or silently ignored.
- Opening the settings section re-reads both sources, so a fiber that failed
  after the page loaded no longer leaves stale rows behind.

## [0.4.3] - 2026-10-30

### Added

- `reviewSessionPrefix` (default `auto-review:`): a helper call running under a
  synthetic session id keeps that identity but names the session it works for.
  An Auto review call whose session id is `auto-review:<hash>` now sends
  `auto-review:session-<initiating uuid>` on the wire, so the gateway can tie
  that traffic back to its conversation while still accounting for it separately.
  An empty prefix disables the rewrite; a missing or failing initiator service
  leaves the id unchanged.

## [0.4.2] - 2026-10-30

### Changed

- The wire value keeps DSH's `session-` branding: every UUID-shaped session id
  now goes out as `session-<lowercase-uuid>` (both an `<agentId>-session-<uuid>`
  id and a bare UUID map onto it). This is the same id DSH writes into its own
  session logs, so a gateway that reads those logs can link a request to its
  session and show the session title. Non-UUID ids keep their text after losing a
  leading `session-` prefix.

## [0.4.1] - 2026-10-30

### Added

- Locale metadata (`locale/zh.json`, `locale/en.json`) and a custom `icon.svg`
  so the plugin list shows a localized title, description and icon instead of the
  bare package name.

## [0.4.0] - 2026-10-30

### Added

- **Native-header stand-down.** When a request already carries one of the
  configured `nativeSessionHeaders` (the session headers the harness and its
  gateways use), the plugin stops injecting and records the sighting, so it makes
  itself redundant the moment the harness starts sending a session header on its
  own. The plugin's own `header` name is excluded from this check so two instances
  cannot mistake each other for a native sender.
- `enabled` kill switch (default `true`).
- `nativeSessionHeaders` configuration (defaults to the eight session header names
  used across the harness, Pi, OpenCode and Claude Code).
- Client half: a one-time banner in `shell.overlay`, shown when a native header has
  been detected, telling the user the plugin is no longer needed and can be
  uninstalled; plus a settings section showing the detected state, the inject header
  name, and a button that brings the notice back. Dismissal is remembered in
  `localStorage`.
- Injection counters (`injected`, `nativeSkipped`) logged on the first event of each
  kind and every 100 requests; `fallback` failures use their own rate-limited
  warning instead.

### Changed

- The host writes `nativeHeaderSeen` into its own volatile config exactly once per
  sighting so the client half can react without polling; a failing write never
  affects request handling.

### Fixed

- `exports` now exposes `./package.json` as well, so hosts reading the package
  manifest through the package name keep working.
- The client half parsed `settings.describe()` payloads with an inverted type check,
  which turned a successful response into an error state.

## [0.3.0] - 2026-10-30

### Added

- `llmEndpointAllowlist`: URL prefixes that narrow injection inside an `llm/stream`
  scope. Empty (default) means unrestricted; a non-empty list is the recommended
  posture. Unlike `toolEndpoints`, an unusable entry rejects the configuration at
  load instead of being silently dropped, so a typo cannot fall back to fail-open.
- `redirectGuard`: boolean, default `false`. When on, requests this plugin stamps
  get `redirect: 'error'` unless the caller pinned `init.redirect`.
- `engines.node >= 22` in package.json, matching both READMEs.

### Changed

- Session ids are normalized to one wire value: `<agentId>-session-<uuid>` becomes
  the bare UUID, `session-<uuid>` loses its prefix, bare UUIDs are lowercased, and
  `undefined` stays `undefined`. One conversation can no longer reach the gateway
  in two shapes, which previously split its cache identity.
- Fallback warnings are rate-limited by error signature; a failed `Request` rebuild
  now logs instead of silently dropping the injection.
- READMEs corrected: both injection scopes, conditional unload, `overwriteHeaders`
  only matching this plugin's own header, `toolEndpoints` path `/` covering the whole
  origin, and pinning a tag/commit for reproducible installs.

### Fixed

- A blank or malformed `header` name used to make every LLM call throw inside
  `Headers.set`. The configuration is now validated at load with the runtime
  `Headers` parser as the oracle and the plugin is marked failed instead of
  loading silently inert.
- `patchedFetch` computes inside a synchronous `try` and calls the upstream fetch
  outside it, so an upstream rejection is no longer mistaken for a plugin failure
  and retried.
- Each instance used to replace `globalThis.fetch` and restore it only when the
  global still pointed at that instance, so two instances stacked layers and
  unloading the inner one left a dead layer behind. A single Symbol-keyed registry
  now owns one dispatcher and a hook map: registering only adds a hook, hooks are
  isolated, and unloading restores the original fetch once the last hook is gone.
  Hook ids are random UUIDs so two module copies cannot delete each other's hook.

### Security

- 25-name credential/routing/framing denylist (`authorization`, `cookie`, `host`,
  `x-api-key`, `x-forwarded-*`, `content-length`, hop-by-hop names, `user-agent`, …),
  enforced at load.
- The `llm/stream` scope had no URL gate, so an OAuth refresh on another origin
  carried the header, and cross-origin redirects forwarded it because undici only
  strips `authorization` and `cookie`. `llmEndpointAllowlist` + `redirectGuard`
  cover both; both are opt-in so the default behaviour is unchanged.

### Upgrade notes

1. Invalid configuration now fails the plugin loudly instead of loading inert:
   a bad `header` name, an empty `value`, or a non-http(s)
   `llmEndpointAllowlist` entry rejects the configuration at load.
2. `value: ""` is rejected. To follow the session id, omit the key instead of
   setting it empty.
3. The wire value shape changed (`<agentId>-session-<uuid>` → bare lowercase UUID).
   Gateways or proxies that keyed on the old string must follow the new one.
4. Defaults are unchanged: `llmEndpointAllowlist: []` and `redirectGuard: false`
   behave exactly like 0.2.1.
