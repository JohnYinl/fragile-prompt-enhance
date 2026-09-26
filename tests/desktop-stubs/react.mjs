/**
 * `react` stub.
 *
 * The plugin's *pure* logic is what this harness exercises (guards, request
 * building, i18n bundles, score rows). Hooks are stubbed to their first-render
 * values so the module can be imported and its non-React exports driven
 * directly; hook composition itself is verified by the parent's review against
 * the real renderer, not here.
 */

export function useState(initial) {
  return [typeof initial === 'function' ? initial() : initial, () => {}]
}

export function useEffect() {}

export function useMemo(factory) {
  return factory()
}
