/**
 * Browser half: tell the user — once — that DSH now sends the session header on
 * its own, so this plugin stopped injecting and is safe to uninstall.
 *
 * The host half owns the fact; this half only reads and renders it. Two
 * surfaces:
 *
 * - `shell.overlay` (the frame-wide floating layer, additive by id) carries a
 *   one-time banner, because "this plugin is redundant" is a decision the user
 *   should see without opening settings.
 * - `settings.section` carries the durable status row, so the fact stays
 *   inspectable after the banner was dismissed.
 *
 * Data flow: the host writes the fact into this plugin's own volatile config
 * field (a `ctx.settings.update` CAS write). The browser reads it through
 * `remote.settings.describe()` and refreshes on the forwarded
 * `settings/document-updated` event, which reaches the page through
 * `ctx.remote.$on` because dsh-api-remotes allowlists it.
 *
 * Dismissal lives in localStorage: one notice per browser profile. The settings
 * section clears it to bring the banner back.
 *
 * @module dsh-session-header/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-header',
  factory: (require) => {
    const react = require('react')
    const h = react.createElement

    /** Locale namespace shared by both surfaces. */
    const LOCALE_NS = 'dsh-session-header'
    /** localStorage key holding the dismissal stamp. */
    const DISMISS_KEY = 'dsh-session-header:native-notice-dismissed.v1'
    /** Profile entry ids this plugin's settings form may be served under. */
    const ENTRY_IDS = ['dsh-session-header', 'session-header']
    /**
     * The one Host config field that means "the harness already stamped the
     * session". Exact name only: a future `nativeSomething: true` must not
     * raise an uninstall banner, so no prefix or pattern matching here.
     */
    const NATIVE_FLAG = 'nativeHeaderSeen'

    const dictionaries = {
      zh: {
        noticeTitle: 'DSH 已原生发送会话头',
        noticeBody: '检测到请求里已经带有会话头，本插件已停止注入。它现在没有作用，建议卸载。',
        noticeDismiss: '不再提示',
        noticeAck: '知道了',
        sectionLabel: '会话头注入',
        sectionTitle: '会话头注入',
        sectionSubtitle: '给 LLM 请求补一个会话标识头；DSH 原生发送后本插件会主动让位。',
        statusEnabled: '插件状态',
        statusEnabledOn: '启用',
        statusEnabledOff: '已关闭',
        statusNative: '原生会话头',
        statusNativeYes: '已检测到',
        statusNativeNo: '未检测到',
        statusHeader: '注入的请求头',
        statusEnabledFailed: '加载失败',
        statusEnabledLoading: '加载中',
        statusUnloading: '卸载中',
        statusNotLoaded: '未加载',
        statusUnknown: '未知',
        uninstallHint: '建议卸载：本插件已经多余。在终端执行 dsh plugin remove dsh-session-header，或在「设置 → 插件」里关掉它。',
        showAgain: '重新显示提示',
        shownAgain: '已重新启用提示',
        notRegistered: '宿主没有注册这个插件的配置表单，状态未知。',
        readFailed: '读取失败：{message}',
        raw: '原始信息'
      },
      en: {
        noticeTitle: 'DSH now sends the session header itself',
        noticeBody: 'A session header already reached the request, so this plugin stopped injecting. It no longer does anything — uninstall it.',
        noticeDismiss: "Don't show again",
        noticeAck: 'Got it',
        sectionLabel: 'Session header',
        sectionTitle: 'Session header',
        sectionSubtitle: 'Adds a session identity header to LLM requests; the plugin steps aside once DSH sends one itself.',
        statusEnabled: 'Plugin state',
        statusEnabledOn: 'enabled',
        statusEnabledOff: 'disabled',
        statusNative: 'Native session header',
        statusNativeYes: 'detected',
        statusNativeNo: 'not detected',
        statusHeader: 'Injected header',
        statusEnabledFailed: 'failed to load',
        statusEnabledLoading: 'loading',
        statusUnloading: 'unloading',
        statusNotLoaded: 'not loaded',
        statusUnknown: 'unknown',
        uninstallHint: 'Safe to uninstall: the plugin is redundant. Run dsh plugin remove dsh-session-header, or turn it off under Settings → Plugins.',
        showAgain: 'Show the notice again',
        shownAgain: 'Notice re-armed',
        notRegistered: 'The Host registered no settings form for this plugin, so the state is unknown.',
        readFailed: 'Read failed: {message}',
        raw: 'Raw details'
      }
    }

    /** Fill `{name}` placeholders without touching braces we did not declare. */
    const format = (template, vars) => {
      if (typeof template !== 'string') return ''
      if (vars === undefined) return template
      return template.replace(/\{([A-Za-z0-9_]+)\}/g, (whole, key) =>
        Object.hasOwn(vars, key) ? String(vars[key]) : whole)
    }

    /** Locale tag of the page, used only when the locale service is absent. */
    const fallbackLocale = () => {
      try {
        const tag = (window.navigator?.language ?? 'en').toLowerCase()
        return tag.startsWith('zh') ? 'zh' : 'en'
      } catch {
        return 'zh'
      }
    }

    /** Dismissal stamp, or null when the notice may still appear. */
    const readDismissed = () => {
      try {
        return window.localStorage?.getItem(DISMISS_KEY) ?? null
      } catch {
        return null
      }
    }
    const writeDismissed = (stamp) => {
      try {
        window.localStorage?.setItem(DISMISS_KEY, stamp)
      } catch {
        /* private mode / quota: the banner simply reappears next page load */
      }
    }
    const clearDismissed = () => {
      try {
        window.localStorage?.removeItem(DISMISS_KEY)
      } catch {
        /* nothing to clear */
      }
    }

    /** Unwrap one RPC envelope: `{ok, value}` or the value itself. */
    const unwrap = (raw) => (raw !== null && typeof raw === 'object' && 'ok' in raw
      ? (raw.ok === true ? raw.value : undefined)
      : raw)

    /** The namespace rows of one `settings.describe` answer, whatever its nesting. */
    const namespaceRows = (raw) => {
      const value = unwrap(raw)
      if (Array.isArray(value)) return value
      if (value === null || typeof value !== 'object') return []
      const inner = value.value !== null && typeof value.value === 'object' ? value.value : value
      for (const candidate of [value.namespaces, value.forms, inner.namespaces, inner.forms]) {
        if (Array.isArray(candidate)) return candidate
      }
      return []
    }

    /** This plugin's form row: exact entry ids first, then a suffix match. */
    const matchEntry = (rows) => {
      const exact = rows.find((row) => row !== null && typeof row === 'object' && ENTRY_IDS.includes(row.ns))
      if (exact !== undefined) return exact
      return rows.find((row) => typeof row?.ns === 'string' && /(^|[./:_-])session-header$/.test(row.ns))
    }

    /** This plugin's inventory row: exact entry ids first, then a suffix match. */
    const matchInventoryEntry = (snapshot) => {
      const entries = Array.isArray(snapshot?.entries) ? snapshot.entries : []
      const exact = entries.find((row) => row !== null && typeof row === 'object' && ENTRY_IDS.includes(row.entryId))
      if (exact !== undefined) return exact
      return entries.find((row) => typeof row?.entryId === 'string' && /(^|[./:_-])session-header$/.test(row.entryId))
    }

    /** Read `pluginInventory.list()` as a plain snapshot; failures stay silent. */
    const inventoryOf = async (remote) => {
      try {
        return unwrap(await remote.list())
      } catch {
        return undefined
      }
    }

    /** Effective field values: the live value with the user layer folded over it. */
    const fieldsOf = (entry) => {
      const value = entry?.value !== null && typeof entry?.value === 'object' ? entry.value : {}
      const user = entry?.user !== null && typeof entry?.user === 'object' ? entry.user : {}
      return { ...value, ...user }
    }

    /**
     * Whether the Host recorded a native sighting. Only the exact field counts,
     * at the top level or under the explicit `status` sub-object; anything else
     * stays silent on purpose.
     */
    const detectNative = (fields) => {
      if (fields[NATIVE_FLAG] === true) return { seen: true, key: NATIVE_FLAG }
      const status = fields.status
      if (status !== null && typeof status === 'object' && !Array.isArray(status) && status[NATIVE_FLAG] === true) {
        return { seen: true, key: 'status.' + NATIVE_FLAG }
      }
      return { seen: false, key: undefined }
    }

    /** Live view of the host-side fact, shared by both surfaces. */
    const createStore = () => {
      let snapshot = Object.freeze({
        status: 'idle',
        seen: false,
        seenKey: undefined,
        enabled: undefined,
        phase: undefined,
        header: undefined,
        ns: undefined,
        error: undefined,
        raw: undefined,
        // Bumped on every dismiss/restore so both surfaces re-read localStorage.
        epoch: 0
      })
      const listeners = new Set()
      return {
        get: () => snapshot,
        set: (patch) => {
          const next = Object.freeze({ ...snapshot, ...patch })
          if (Object.keys(patch).every((key) => Object.is(next[key], snapshot[key]))) return
          snapshot = next
          for (const listener of [...listeners]) {
            try {
              listener()
            } catch {
              /* one broken subscriber must not starve the other surfaces */
            }
          }
        },
        bump: () => {
          snapshot = Object.freeze({ ...snapshot, epoch: snapshot.epoch + 1 })
          for (const listener of [...listeners]) {
            try {
              listener()
            } catch {
              /* as above */
            }
          }
        },
        subscribe: (listener) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        }
      }
    }

    /** Subscribe a component to the store with plain hooks. */
    const makeUseSnapshot = (store) => () => {
      const [snapshot, setSnapshot] = react.useState(store.get)
      react.useEffect(() => {
        const unsubscribe = store.subscribe(() => setSnapshot(store.get()))
        setSnapshot(store.get())
        return () => {
          unsubscribe()
        }
      }, [])
      return snapshot
    }

    const S = {
      banner: {
        position: 'fixed',
        top: '10px',
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 60,
        width: 'min(760px, calc(100vw - 24px))',
        boxSizing: 'border-box',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: '12px',
        padding: '12px 16px',
        borderRadius: '10px',
        background: 'var(--dsw-alias-bg-l2, #1b1c1e)',
        border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.28))',
        boxShadow: '0 12px 32px rgba(0,0,0,0.28)',
        pointerEvents: 'auto',
        color: 'var(--dsw-alias-label-primary, #f7f8f8)'
      },
      bannerText: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: '200px', flex: '1 1 320px' },
      bannerTitle: { fontSize: '13px', fontWeight: 600, letterSpacing: '-0.1px' },
      bannerBody: { fontSize: '12px', lineHeight: 1.5, color: 'var(--dsw-alias-label-secondary, rgba(247,248,248,0.75))' },
      bannerActions: { display: 'flex', gap: '8px', flexShrink: 0 },
      primary: {
        height: '30px',
        padding: '0 12px',
        fontSize: '12px',
        fontWeight: 500,
        color: '#ffffff',
        background: '#5e6ad2',
        border: '1px solid #5e69d1',
        borderRadius: '6px',
        cursor: 'pointer'
      },
      ghost: {
        height: '30px',
        padding: '0 12px',
        fontSize: '12px',
        color: 'inherit',
        background: 'transparent',
        border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.35))',
        borderRadius: '6px',
        cursor: 'pointer'
      },
      card: {
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
        boxSizing: 'border-box',
        width: '100%',
        maxWidth: '100%',
        padding: '18px 20px',
        background: 'transparent',
        border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.22))',
        borderRadius: '10px'
      },
      title: { margin: 0, fontSize: '15px', fontWeight: 600, color: 'var(--dsw-alias-label-primary, inherit)' },
      subtitle: { margin: 0, fontSize: '12px', lineHeight: 1.5, color: 'var(--dsw-alias-label-secondary, rgba(127,127,127,0.9))' },
      row: { display: 'flex', gap: '10px', alignItems: 'baseline', fontSize: '13px' },
      rowLabel: { minWidth: '96px', color: 'var(--dsw-alias-label-secondary, rgba(127,127,127,0.9))' },
      rowValue: { color: 'var(--dsw-alias-label-primary, inherit)' },
      hint: {
        margin: 0,
        padding: '10px 12px',
        fontSize: '12px',
        lineHeight: 1.5,
        color: 'var(--dsw-alias-label-primary, inherit)',
        background: 'rgba(94,106,210,0.12)',
        border: '1px solid rgba(94,106,210,0.4)',
        borderRadius: '8px'
      },
      status: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary, rgba(127,127,127,0.9))' },
      pre: {
        margin: 0,
        padding: '10px 12px',
        maxHeight: '260px',
        overflow: 'auto',
        fontSize: '11px',
        lineHeight: 1.5,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-all',
        color: 'var(--dsw-alias-label-secondary, rgba(127,127,127,0.9))',
        background: 'rgba(127,127,127,0.08)',
        border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.22))',
        borderRadius: '8px'
      }
    }

    const pretty = (value) => {
      try {
        return JSON.stringify(value, (_key, item) => (item instanceof Map ? Object.fromEntries(item) : item), 2)
      } catch {
        return String(value)
      }
    }

    /** The one-time banner; hidden once the browser recorded the dismissal. */
    const NoticeEntry = (props) => {
      const snapshot = props.useSnapshot()
      const [acknowledged, setAcknowledged] = react.useState(false)
      const dismissed = readDismissed() !== null
      if (snapshot.seen !== true || dismissed || acknowledged) return null
      const stamp = snapshot.seenKey ?? 'native'
      return h('div', { role: 'status', 'aria-live': 'polite', style: S.banner },
        h('div', { style: S.bannerText },
          h('strong', { style: S.bannerTitle }, props.t('noticeTitle')),
          h('span', { style: S.bannerBody }, props.t('noticeBody'))),
        h('div', { style: S.bannerActions },
          h('button', {
            type: 'button',
            style: S.primary,
            onClick: () => {
              props.dismiss(stamp)
            }
          }, props.t('noticeDismiss')),
          h('button', {
            type: 'button',
            style: S.ghost,
            onClick: () => {
              setAcknowledged(true)
            }
          }, props.t('noticeAck'))))
    }

    /** Human status for the inventory row, falling back to the form's presence. */
    const enabledState = (snapshot, t) => {
      if (snapshot.enabled === false) return t('statusEnabledOff')
      if (snapshot.phase === 'failed') return t('statusEnabledFailed')
      if (snapshot.phase === 'active') return t('statusEnabledOn')
      if (snapshot.phase === 'loading' || snapshot.phase === 'pending') return t('statusEnabledLoading')
      if (snapshot.phase === 'unloading') return t('statusUnloading')
      if (snapshot.phase === null) return t('statusNotLoaded')
      // A settings form only exists for an active fiber, so its presence is the
      // best evidence the plugin is mounted when the inventory is unavailable.
      return snapshot.status === 'ready' ? t('statusEnabledOn') : t('statusUnknown')
    }

    /** The durable status row; survives the dismissed banner. */
    const StatusSection = (props) => {
      const snapshot = props.useSnapshot()
      const [restored, setRestored] = react.useState(false)
      const value = (node, fallback) => (node === undefined || node === null ? fallback : String(node))
      const nativeText = snapshot.seen
        ? props.t('statusNativeYes') + (snapshot.seenKey === undefined ? '' : ' (' + snapshot.seenKey + ')')
        : (snapshot.status === 'missing' ? props.t('statusUnknown') : props.t('statusNativeNo'))
      const enabledText = enabledState(snapshot, props.t)
      // Opening the settings page is also a re-read: the inventory has no
      // change event, and a fiber failure would otherwise keep stale rows.
      react.useEffect(() => {
        props.refresh?.()
      }, [])
      return h('div', { style: S.card },
        h('h3', { style: S.title }, props.t('sectionTitle')),
        h('p', { style: S.subtitle }, props.t('sectionSubtitle')),
        h('div', { style: S.row },
          h('span', { style: S.rowLabel }, props.t('statusEnabled')),
          h('span', { style: S.rowValue }, enabledText)),
        h('div', { style: S.row },
          h('span', { style: S.rowLabel }, props.t('statusNative')),
          h('span', { style: S.rowValue }, nativeText)),
        h('div', { style: S.row },
          h('span', { style: S.rowLabel }, props.t('statusHeader')),
          h('span', { style: S.rowValue }, value(snapshot.header, props.t('statusUnknown')))),
        snapshot.status === 'missing' && snapshot.phase === undefined
          ? h('p', { style: S.status }, props.t('notRegistered'))
          : null,
        snapshot.status === 'error'
          ? h('p', { style: S.status }, props.t('readFailed', { message: String(snapshot.error) }))
          : null,
        snapshot.seen ? h('p', { style: S.hint }, props.t('uninstallHint')) : null,
        h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center' } },
          h('button', {
            type: 'button',
            style: S.ghost,
            onClick: () => {
              props.restore()
              setRestored(true)
            }
          }, props.t('showAgain')),
          restored ? h('span', { style: S.status }, props.t('shownAgain')) : null),
        h('details', { style: { paddingTop: '4px' } },
          h('summary', { style: S.status }, props.t('raw')),
          h('pre', { style: S.pre }, pretty(snapshot.raw))))
    }

    /** Services used by the browser companion. */
    const inject = ['slots', 'locale', 'remote', 'remote.settings']

    /**
     * Register both surfaces and keep the shared store current.
     * @param ctx - browser plugin context.
     */
    function apply(ctx) {
      let translate = (key, vars) => format(dictionaries[fallbackLocale()][key] ?? dictionaries.zh[key] ?? key, vars)
      try {
        ctx.effect(() => ctx.locale.register(LOCALE_NS, dictionaries))
        const bound = ctx.locale.bind(LOCALE_NS)
        if (typeof bound === 'function') {
          translate = (key, vars) => {
            try {
              const text = bound(key, vars)
              if (typeof text === 'string' && text.length > 0) return text
            } catch {
              /* fall back to the local dictionary */
            }
            return format(dictionaries[fallbackLocale()][key] ?? dictionaries.zh[key] ?? key, vars)
          }
        }
      } catch {
        /* no locale service: the local dictionary still renders both languages */
      }

      const store = createStore()
      const useSnapshot = makeUseSnapshot(store)
      let generation = 0
      let scheduled = false
      /** The optional inventory remote; resolved once the Host exposes it. */
      let inventory

      /** Read the host facts once; an answer overtaken by a newer read is dropped. */
      const refresh = () => {
        const mine = ++generation
        return Promise.resolve()
          .then(() => Promise.all([
            ctx.remote.settings.describe(),
            inventory === undefined ? undefined : inventoryOf(inventory)
          ]))
          .then(([raw, inventorySnapshot]) => {
            if (mine !== generation) return
            const entry = matchEntry(namespaceRows(raw))
            const inventoryEntry = matchInventoryEntry(inventorySnapshot)
            const fields = entry === undefined ? {} : fieldsOf(entry)
            const native = detectNative(fields)
            store.set({
              status: entry === undefined ? 'missing' : 'ready',
              ns: entry?.ns,
              seen: native.seen,
              seenKey: native.key,
              enabled: inventoryEntry !== undefined && typeof inventoryEntry.enabled === 'boolean'
                ? inventoryEntry.enabled
                : undefined,
              phase: inventoryEntry === undefined ? undefined : inventoryEntry.fiberPhase,
              header: typeof fields.header === 'string' ? fields.header : undefined,
              error: undefined,
              raw: { entry, inventory: inventoryEntry }
            })
          })
          .catch((error) => {
            if (mine !== generation) return
            store.set({ status: 'error', error: error?.message ?? error })
          })
      }

      /** Coalesce a burst of invalidations into one read. */
      const schedule = () => {
        if (scheduled) return
        scheduled = true
        Promise.resolve().then(() => {
          scheduled = false
          refresh()
        })
      }

      const dismiss = (stamp) => {
        writeDismissed(String(stamp))
        store.bump()
      }
      const restore = () => {
        clearDismissed()
        store.bump()
        schedule()
      }

      // Inventory is optional: without it the panel still shows the form data,
      // and a form row's presence still means the plugin's fiber is active.
      if (typeof ctx.inject === 'function') {
        ctx.inject(['remote.pluginInventory'], () => {
          inventory = ctx.remote?.pluginInventory
          schedule()
        })
      }

      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'dsh-session-header.native-notice',
        order: -100,
        label: () => translate('sectionLabel'),
        inject: () => ({ t: translate, dismiss, useSnapshot })
      }, NoticeEntry), 'dsh-session-header: native session header notice')

      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'dsh-session-header',
        order: 70,
        label: () => translate('sectionLabel'),
        inject: () => ({ t: translate, restore, refresh: schedule, useSnapshot })
      }, StatusSection), 'dsh-session-header: status section')

      ctx.effect(() => {
        const disposers = [
          ctx.remote.$on('settings/document-updated', () => {
            schedule()
          }),
          ctx.on('connection/reset', () => {
            schedule()
          })
        ]
        refresh()
        return () => {
          for (const dispose of disposers) {
            try {
              dispose?.()
            } catch {
              /* a listener disposed twice is already gone */
            }
          }
        }
      }, 'dsh-session-header: settings mirror invalidation')
    }

    return { apply, inject, name: 'dsh-session-header-client' }
  }
})
