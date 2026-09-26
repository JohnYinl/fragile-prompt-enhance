/**
 * Loads the shipped `desktop/plugin.js` for tests.
 *
 * The Hermes runtime loader loads the file uncompiled and resolves exactly
 * three bare specifiers to app modules. Node cannot resolve those names, so
 * this harness rewrites ONLY the three import specifiers to the stubs in
 * `desktop-stubs/` and imports the real source text — every other line is the
 * shipped line, byte for byte.
 *
 * The transformed copy lands under `tests/.harness/` (inside the project, so a
 * run is reproducible and leaves nothing in a system temp dir).
 *
 * FOOTPRINT: exactly ONE transformed copy per PROCESS. The suite loads the
 * module ~a hundred times per run and each load must be its own instance (the
 * plugin keeps module-level state by design, and that state IS under test) —
 * which used to mean a new file per load and left 12k+ files behind. A distinct
 * IMPORT QUERY keeps the instances apart while the file stays the same. What
 * this process wrote is removed by :func:`cleanupHarnessArtifacts`, called at
 * process exit and available to a test that wants to assert on it; nothing else
 * in the directory is touched (earlier runs are not this process's to delete).
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const PACKAGE_DIR = resolve(HERE, '..', 'package', 'fragile-prompt-enhance')
export const PLUGIN_SOURCE = join(PACKAGE_DIR, 'desktop', 'plugin.js')
export const HARNESS_DIR = join(HERE, '.harness')

/** The ONE transformed copy this process owns; `plugin.js` is never edited. */
export const HARNESS_FILE = join(HARNESS_DIR, `plugin.harness-${process.pid}.mjs`)

/** Every file THIS process created. The only thing cleanup may delete. */
export const HARNESS_FILES = []

/** The three specifiers the runtime loader allows, mapped to the stubs. */
const STUB_MAP = {
  '@hermes/plugin-sdk': join(HERE, 'desktop-stubs', 'plugin-sdk.mjs'),
  'react/jsx-runtime': join(HERE, 'desktop-stubs', 'jsx-runtime.mjs'),
  react: join(HERE, 'desktop-stubs', 'react.mjs')
}

export function readPluginSource() {
  return readFileSync(PLUGIN_SOURCE, 'utf8')
}

/** Rewrite the three allowed specifiers to absolute stub URLs. */
export function rewriteSpecifiers(source) {
  let out = source

  for (const [specifier, target] of Object.entries(STUB_MAP)) {
    const url = pathToFileURL(target).href
    // `from 'x'` in a static import — the loader has no dynamic imports here.
    out = out.split(`from '${specifier}'`).join(`from '${url}'`)
    out = out.split(`from "${specifier}"`).join(`from "${url}"`)
  }

  return out
}

/**
 * Import a fresh instance of the plugin module.
 *
 * `stamp` busts the ESM cache so a test can re-register from scratch (the
 * plugin keeps module-level state by design — that state IS under test). Only
 * the import URL changes: the transformed copy on disk is the same file for the
 * whole process, so a hundred loads cost one file, not a hundred.
 */
export async function loadPlugin(stamp = String(Date.now()) + Math.random()) {
  const target = ensureHarnessCopy()

  return import(pathToFileURL(target).href + '?load=' + encodeURIComponent(String(stamp).replace(/[^\w.-]/g, '')))
}

/**
 * Write this process's ONE transformed copy, if it is not already there.
 *
 * Never touches another process's file: the name carries this pid, and only
 * that name is ever created.
 */
function ensureHarnessCopy() {
  mkdirSync(HARNESS_DIR, { recursive: true })

  if (!existsSync(HARNESS_FILE)) {
    writeFileSync(HARNESS_FILE, rewriteSpecifiers(readPluginSource()), 'utf8')
  }

  if (!HARNESS_FILES.includes(HARNESS_FILE)) {
    HARNESS_FILES.push(HARNESS_FILE)
  }

  return HARNESS_FILE
}

/**
 * Delete exactly what THIS process created; anything already gone is fine.
 *
 * Returns how many files were removed. A file another run left behind is not
 * this process's to delete — and is not deleted, at any time.
 */
export function cleanupHarnessArtifacts() {
  let removed = 0

  for (const path of HARNESS_FILES.splice(0)) {
    try {
      if (!existsSync(path)) {
        continue
      }

      rmSync(path, { force: true })
      removed += 1
    } catch {
      // Held open elsewhere (Windows) or removed by someone else: the file
      // already fails to persist as OUR artifact, and losing a test to a
      // cleanup race would be worse than one leftover file.
    }
  }

  return removed
}

// The suite can die on an early assertion; the footprint still stays at one
// file per run instead of growing with every load.
process.once('exit', () => {
  cleanupHarnessArtifacts()
})

/**
 * A `ctx` shaped like the real `PluginContext`, recording what the plugin
 * registers so a test can assert on the contribution surface.
 */
export function makeCtx(overrides = {}) {
  const registrations = []
  const i18nRegistrations = []
  const disposers = []
  const storage = new Map()

  const ctx = {
    source: 'plugin:fragile-prompt-enhance',
    register: contribution => {
      registrations.push(contribution)

      return () => {}
    },
    registerMany: contributions => {
      registrations.push(...contributions)

      return () => {}
    },
    onDispose: fn => disposers.push(fn),
    onEvent: () => () => {},
    setTimeout: () => () => {},
    setInterval: () => () => {},
    addEventListener: () => () => {},
    rest: async () => ({ ok: false, error: { code: 'network', message: 'not stubbed' } }),
    socket: () => () => {},
    os: {},
    storage: {
      get: (key, fallback) => (storage.has(key) ? storage.get(key) : fallback),
      set: (key, value) => storage.set(key, value),
      remove: key => storage.delete(key)
    },
    i18n: {
      register: bundles => {
        i18nRegistrations.push(bundles)

        return () => {}
      },
      onLocaleChange: () => () => {},
      t: (key, ...args) => key + (args.length ? ':' + args.join(',') : '')
    },
    registrations,
    i18nRegistrations,
    disposers,
    storage,
    ...overrides
  }

  return ctx
}
