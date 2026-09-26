/**
 * Test harness for the desktop half.
 *
 * The Hermes runtime loader loads `plugin.js` uncompiled and resolves exactly
 * three bare specifiers (`@hermes/plugin-sdk`, `react`, `react/jsx-runtime`)
 * to app modules. Node cannot resolve those names, so the harness rewrites the
 * three import specifiers to these stubs and imports the REAL source text.
 * Only module resolution is substituted — every line of the plugin under test
 * is the shipped line.
 *
 * The i18n stub reimplements the SDK's resolution rules faithfully, because the
 * plugin's language behaviour is only meaningful against them:
 *   plugin-i18n.ts — registry keyed by plugin id, active locale → the plugin's
 *                    own `en` bundle → the raw key
 *   runtime.ts     — `render()` returns a STRING leaf verbatim and calls a
 *                    FUNCTION leaf with the spread args
 */

// ── i18n: the real resolution semantics ─────────────────────────────────────

const registry = new Map()
const versionListeners = new Set()

let activeLocale = 'en'
const localeListeners = new Set()

export function __setActiveLocale(locale) {
  if (locale === activeLocale) {
    return
  }

  activeLocale = locale

  for (const listener of localeListeners) {
    listener(locale)
  }
}

export function __activeLocale() {
  return activeLocale
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function resolvePath(source, key) {
  return key.split('.').reduce((current, part) => (isRecord(current) ? current[part] : undefined), source)
}

/** A string is returned as-is, a function is called with `args`, else null. */
function render(value, args) {
  if (typeof value === 'string') {
    return value
  }

  if (typeof value === 'function') {
    return value(...args)
  }

  return null
}

function mergeMessages(base, overrides) {
  const result = { ...base }

  for (const [key, value] of Object.entries(overrides)) {
    const prev = result[key]
    result[key] = isRecord(prev) && isRecord(value) ? mergeMessages(prev, value) : value
  }

  return result
}

function translate(pluginId, locale, key, args) {
  const byLocale = registry.get(pluginId)
  const active = render(resolvePath(byLocale?.get(locale), key), args)

  if (active !== null) {
    return active
  }

  if (locale !== 'en') {
    const fallback = render(resolvePath(byLocale?.get('en'), key), args)

    if (fallback !== null) {
      return fallback
    }
  }

  return key
}

export function __registerBundles(pluginId, bundles) {
  const byLocale = registry.get(pluginId) || new Map()
  registry.set(pluginId, byLocale)

  for (const [locale, messages] of Object.entries(bundles)) {
    const prev = byLocale.get(locale)
    byLocale.set(locale, prev ? mergeMessages(prev, messages) : messages)
  }

  for (const listener of versionListeners) {
    listener()
  }
}

export function __translate(pluginId, locale, key, args = []) {
  return translate(pluginId, locale, key, args)
}

/** Mirrors the app's `usePluginI18n(id)` translator (reactive in core). */
export function usePluginI18n(pluginId) {
  return (key, ...args) => translate(pluginId, activeLocale, key, args)
}

export function useI18n() {
  return { locale: activeLocale, setLocale: async next => __setActiveLocale(next), t: {} }
}

// ── host / ctx seams ────────────────────────────────────────────────────────

/** A controllable host: each door is a spy the tests can steer. */
export function makeHost() {
  const calls = { getDraft: [], setDraft: [], notify: [], focus: [], request: [], requestProfile: [] }

  return {
    calls,
    composer: {
      getDraft: async address => {
        calls.getDraft.push(address)

        return host.__drafts[addressKey(address)] ?? null
      },
      setDraft: async (address, text) => {
        calls.setDraft.push([address, text])

        if (host.__setDraftResult === false) {
          return false
        }

        host.__drafts[addressKey(address)] = text

        return true
      },
      focus: address => calls.focus.push(address)
    },
    getGateway: () => null,
    notify: payload => calls.notify.push(payload),
    state: {},

    // ── the gateway JSON-RPC doors (sdk/index.ts: `host.request`,
    // `host.requestProfile`, `host.profileRoutes`, `host.activeConnectionId`) ──
    /** Registry connection id the ambient `host.request` currently hits. */
    activeConnectionId: () => host.__activeConnectionId,
    /** Steerable route inventory; `null` means "the RPC probe threw". */
    profileRoutes: async () => {
      if (host.__profileRoutesError) {
        throw new Error('Hermes Desktop connection routing unavailable')
      }

      return host.__profileRoutes
    },
    /** Records every RPC and replays `host.__requestResult` / throws `__requestError`. */
    request: async (method, params, timeoutMs) => {
      calls.request.push({ method, params, timeoutMs })

      if (host.__requestError) {
        throw host.__requestError
      }

      return host.__requestResult
    },
    requestProfile: async (route, method, params, timeoutMs, options) => {
      calls.requestProfile.push({ route, method, params, timeoutMs, options })

      if (host.__requestError) {
        throw host.__requestError
      }

      return host.__requestResult
    }
  }
}

function addressKey(address) {
  return address === null || address === undefined ? 'active' : String(address)
}

export const host = makeHost()
host.__drafts = {}
host.__setDraftResult = null
/** The ambient connection the gateway RPCs are presumed to hit ('local'ish). */
host.__activeConnectionId = null
/** Route descriptors `host.profileRoutes()` answers with. */
host.__profileRoutes = []
host.__profileRoutesError = false
/** What `host.request` / `host.requestProfile` resolve to (or throw). */
host.__requestResult = { text: '' }
host.__requestError = null
// The real `host.state` is a map of readonly atoms; the plugin reads them with
// `.get()`. Populated here so `resolveAddress`/`bindingKey` see a real shape.
host.state = {
  activeSessionId: atom(null),
  connectionId: atom('local'),
  focusedSessionId: atom(null),
  focusedSessionOwner: atom(null),
  focusedSessionProfile: atom('default'),
  focusedStoredSessionId: atom(null),
  profile: atom('default')
}

export function __resetHost() {
  host.calls.getDraft.length = 0
  host.calls.setDraft.length = 0
  host.calls.notify.length = 0
  host.calls.request.length = 0
  host.calls.requestProfile.length = 0
  host.__drafts = {}
  host.__setDraftResult = null
  host.__activeConnectionId = null
  host.__profileRoutes = []
  host.__profileRoutesError = false
  host.__requestResult = { text: '' }
  host.__requestError = null
  host.state.activeSessionId.set(null)
  host.state.focusedSessionId.set(null)
  host.state.focusedStoredSessionId.set(null)
  host.state.focusedSessionOwner.set(null)
  host.state.focusedSessionProfile.set('default')
  host.state.connectionId.set('local')
}

/** Minimal atom with the `get`/`set`/`subscribe` shape `useValue` consumes. */
export function atom(initial) {
  let value = initial
  const listeners = new Set()

  return {
    get: () => value,
    set: next => {
      value = next

      for (const listener of listeners) {
        listener(value)
      }
    },
    subscribe: listener => {
      listeners.add(listener)

      return () => listeners.delete(listener)
    }
  }
}

/** The real hook subscribes to a nanostore; nothing renders in this harness. */
export function useValue(store) {
  return store.get()
}

export function cn(...parts) {
  return parts.filter(Boolean).join(' ')
}

/**
 * UI-kit components under test are the plugin's props, not core's rendering, so
 * each stub records what it was handed and renders a plain descriptor.
 */
function component(name) {
  return props => ({ __component: name, ...props })
}

/**
 * The real `ModelMenuCloseContext` (a React context). A host hands the catalog
 * a `() => void` that dismisses the menu a pick was made in
 * (apps/desktop/src/app/chat/composer/model-pill.tsx:232). Only `.Provider` is
 * ever rendered; `tests/desktop-stubs/render.mjs` treats it as a pass-through
 * provider and records it in the node path.
 */
export const ModelMenuCloseContext = {
  Provider: props => ({ __component: 'ModelMenuCloseContext.Provider', ...props })
}

export const Button = component('Button')
export const Codicon = component('Codicon')
export const GlyphSpinner = component('GlyphSpinner')
export const Dialog = component('Dialog')
export const DialogContent = component('DialogContent')
export const DialogHeader = component('DialogHeader')
export const DialogTitle = component('DialogTitle')
export const DialogFooter = component('DialogFooter')
export const DropdownMenu = component('DropdownMenu')
export const DropdownMenuTrigger = component('DropdownMenuTrigger')
export const DropdownMenuContent = component('DropdownMenuContent')
export const DropdownMenuItem = component('DropdownMenuItem')
export const DropdownMenuSeparator = component('DropdownMenuSeparator')
export const Textarea = component('Textarea')
export const Switch = component('Switch')
export const Separator = component('Separator')
export const Badge = component('Badge')
export const SegmentedControl = component('SegmentedControl')
export const ModelCatalogMenu = component('ModelCatalogMenu')
// The two host components the result page's disclosure is built from. Both
// are real SDK exports (`apps/desktop/src/sdk/index.ts` re-exports
// `components/ui/disclosure-caret` and `components/ui/row-button`), and both
// carry trivial contracts: `DisclosureCaret` takes `open`, and `RowButton` is
// a real `<button>` — so nothing about them has to be simulated.
export const DisclosureCaret = component('DisclosureCaret')
export const RowButton = component('RowButton')
