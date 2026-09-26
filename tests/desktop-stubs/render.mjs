/**
 * A contract-faithful walker over the descriptor tree the plugin builds.
 *
 * WHY THIS EXISTS
 * ---------------
 * The plugin's `jsx()` calls never run a component, so until now the SDK UI
 * stubs were opaque leaves: `jsx(ModelCatalogMenu, { … })` asserted nothing
 * about the component's own contract. A shipped crash got through the suite
 * that way — the whole `composer-action` area was replaced by an error
 * boundary with `` `MenuItem` must be used within `Menu` `` — because the
 * catalog was mounted inside a bare `<div>`.
 *
 * The contract enforced here is Radix's, read out of the installed sources
 * (<HERMES_HOME>/hermes-agent/node_modules):
 *
 *   @radix-ui/react-menu/dist/index.js
 *     MENU_NAME = "Menu"                                 (line 106)
 *     createMenuContext(MENU_NAME) → root + content ctx  (lines 108-116)
 *     MenuItem    → useMenuRootContext/useMenuContentContext(ITEM_NAME)
 *                   ITEM_NAME = "MenuItem"               (lines 433, 440-446)
 *     MenuContent → useMenuContext(CONTENT_NAME)         (lines 184-191)
 *     MenuSub     → useMenuContext(SUB_NAME)             (lines 648-652)
 *     MenuSubTrigger → useMenuContext(SUB_TRIGGER_NAME)  (lines 683-686)
 *     MenuGroup / MenuLabel / MenuSeparator take NO context (lines 421-437, 627-639)
 *   @radix-ui/react-context/dist/index.js:58
 *     `throw new Error(`\`${consumerName}\` must be used within \`${rootComponentName}\``)`
 *   @radix-ui/react-dropdown-menu/dist/index.js
 *     DROPDOWN_MENU_NAME = "DropdownMenu"                (line 82)
 *     DropdownMenuTrigger → useDropdownMenuContext(TRIGGER_NAME) (lines 122-127)
 *
 * `ModelCatalogMenu` requires the Menu context because its own top level renders
 * `DropdownMenuItem`s unconditionally: the loading skeletons
 * (apps/desktop/src/app/shell/model-catalog-menu.tsx:495-507) and the trailing
 * Add-custom / Edit-models rows (747-769). It is CONTENT, never a root — the
 * reference host is apps/desktop/src/plugins/kanban/model-override.tsx
 * (`DropdownMenu` → `DropdownMenuTrigger` → `DropdownMenuContent` →
 * `ModelMenuCloseContext.Provider` → `ModelCatalogMenu`).
 *
 * The walker calls function components (so a component's OWN children are seen,
 * not merely passed along as a prop) and tracks the provider contexts, throwing
 * the same error with the same message text Radix throws — so a red test here
 * reads exactly like the crash the user saw.
 */

import { Fragment } from './jsx-runtime.mjs'

/** Depth cap: a component that renders itself would otherwise spin forever. */
const MAX_DEPTH = 200

/**
 * Components that consume a Menu/DropdownMenu context, by the name the app
 * exports (`apps/desktop/src/components/ui/dropdown-menu.tsx`). `needs` is
 * checked in order; the first missing flag names the missing provider.
 */
const CONTRACT = {
  DropdownMenuContent: { consumer: 'MenuContent', needs: ['dropdown', 'menu'] },
  DropdownMenuItem: { consumer: 'MenuItem', needs: ['menu', 'menuContent'] },
  DropdownMenuTrigger: { consumer: 'DropdownMenuTrigger', needs: ['dropdown'] },
  ModelCatalogMenu: { consumer: 'MenuItem', needs: ['menu', 'menuContent'] }
}

/** The providers, as flags on the context the walker carries down. */
const PROVIDERS = {
  DropdownMenu: { dropdown: true, menu: true },
  DropdownMenuContent: { menuContent: true },
  'ModelMenuCloseContext.Provider': {}
}

const ROOT_NAME = { dropdown: 'DropdownMenu', menu: 'Menu', menuContent: 'Menu' }

const EMPTY_CONTEXT = { dropdown: false, menu: false, menuContent: false }

/**
 * Render descriptors and return the flattened node list.
 *
 * Each node is `{ kind, name, path, props }` where `path` is the chain of
 * component names from the root to that node (inclusive), so a test can assert
 * what a component is mounted INSIDE, not merely that it was passed along.
 */
export function renderTree(element, options = {}) {
  const nodes = []

  walk(element, EMPTY_CONTEXT, [], nodes, 0, options)

  return nodes
}

function walk(node, context, stack, out, depth, options) {
  if (node === null || node === undefined || node === false || node === true) {
    return
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      walk(item, context, stack, out, depth, options)
    }

    return
  }

  if (typeof node === 'string' || typeof node === 'number' || typeof node !== 'object') {
    return
  }

  if (depth > MAX_DEPTH) {
    throw new Error(`renderTree: component tree deeper than ${MAX_DEPTH} — a component renders itself`)
  }

  // A stub component's own output (`component(name)` in plugin-sdk.mjs). The
  // `__component` check comes FIRST: a descriptor carries the element's props,
  // which include `type` (e.g. Button's `type: 'button'`).
  if (node.__component !== undefined) {
    renderDescriptor(node, context, stack, out, depth, options)

    return
  }

  if (!('type' in node)) {
    return
  }

  const { props = {}, type } = node

  if (type === Fragment) {
    walk(props.children, context, stack, out, depth, options)

    return
  }

  if (typeof type === 'function') {
    // A function component: run it, then walk what it returned, with the
    // component's own name on the stack.
    const rendered = type(props)
    const name = type.name || '<anonymous>'

    if (rendered !== null && typeof rendered === 'object' && rendered.__component !== undefined) {
      renderDescriptor(rendered, context, [...stack, name], out, depth + 1, options)

      return
    }

    walk(rendered, context, [...stack, name], out, depth + 1, options)

    return
  }

  // A host element ('div', 'span', …): no context of its own.
  walk(props.children, context, stack, out, depth, options)
}

function renderDescriptor(node, context, stack, out, depth, options) {
  const name = node.__component
  const rule = CONTRACT[name]

  if (rule) {
    for (const need of rule.needs) {
      if (!context[need]) {
        throw new Error(`\`${rule.consumer}\` must be used within \`${ROOT_NAME[need]}\``)
      }
    }
  }

  const path = [...stack, name]

  out.push({ kind: 'component', name, path, props: node })

  const next = { ...context, ...(PROVIDERS[name] || {}) }

  walk(node.children, next, path, out, depth + 1, options)
}
