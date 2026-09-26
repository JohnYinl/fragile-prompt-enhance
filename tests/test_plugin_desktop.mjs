/**
 * Desktop-half tests: `node --test tests/test_plugin_desktop.mjs`
 *
 * Covers the contracts that live in the desktop half — the i18n bundles and
 * their resolution, the run/stop/discard lifecycle, the apply and undo guards,
 * the request the backend receives, and the score/protection projections.
 *
 * The harness rewrites only the three module specifiers the runtime loader
 * resolves; every other line is the shipped source.
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  __activeLocale,
  __registerBundles,
  __resetHost,
  __setActiveLocale,
  __translate,
  host,
  DropdownMenuItem,
  ModelCatalogMenu,
  usePluginI18n
} from './desktop-stubs/plugin-sdk.mjs'
import { jsx } from './desktop-stubs/jsx-runtime.mjs'
import { renderTree } from './desktop-stubs/render.mjs'
import { loadPlugin, makeCtx, readPluginSource, HARNESS_DIR, HARNESS_FILES, cleanupHarnessArtifacts } from './desktop-harness.mjs'

const PLUGIN_ID = 'fragile-prompt-enhance'
const HERE = dirname(fileURLToPath(import.meta.url))
/** The delivery project root: the package, the tests and the archives. */
const PROJECT_DIR = resolve(HERE, '..')

/** Load a fresh module + register it against a fresh ctx. */
async function boot(options = {}) {
  const mod = await loadPlugin()
  const ctx = makeCtx(options.ctx)

  if (options.rest) {
    ctx.rest = options.rest
  }

  __resetHost()
  mod.default.register(ctx)
  __registerBundles(PLUGIN_ID, mod.__testing.I18N)

  return { ctx, mod, t: mod.__testing, I18N: mod.__testing.I18N }
}

/** Flatten a nested message tree into `dot.path -> leaf`. */
function flatten(tree, prefix = '') {
  const out = {}

  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key

    if (value && typeof value === 'object') {
      Object.assign(out, flatten(value, path))
    } else {
      out[path] = value
    }
  }

  return out
}

// ── registration ────────────────────────────────────────────────────────────

test('registers one composer.actions contribution', async () => {
  const { ctx } = await boot()

  assert.equal(ctx.registrations.length, 1)
  assert.equal(ctx.registrations[0].area, 'composer.actions')
  assert.equal(typeof ctx.registrations[0].render, 'function')
})

test('registers its locale bundles through ctx.i18n, not a private store', async () => {
  const { ctx } = await boot()

  assert.equal(ctx.i18nRegistrations.length, 1)
  assert.deepEqual(Object.keys(ctx.i18nRegistrations[0]).sort(), ['en', 'zh'])
})

test('owns no language setting — the app locale is the only source', async () => {
  const { t, ctx } = await boot()

  // Persisted settings carry no language key...
  t.setMode('creative')

  const persisted = ctx.storage.get('settings.v1', null)

  assert.equal(persisted.language, undefined)
  assert.equal(persisted.locale, undefined)

  // ...and no contribution reads a plugin-owned locale.
  const source = readPluginSource()

  assert.equal(/language\s*:|setLanguage|pluginLocale/.test(source), false)
})

// ── i18n bundles ────────────────────────────────────────────────────────────

test('en and zh bundles cover exactly the same keys', async () => {
  const { I18N } = await boot()
  const en = Object.keys(flatten(I18N.en)).sort()
  const zh = Object.keys(flatten(I18N.zh)).sort()

  assert.deepEqual(zh, en)
})

test('no leaf leaks a raw parameter placeholder', async () => {
  const { I18N } = await boot()
  const allowed = new Set(['{{draft}}'])
  const problems = []

  for (const locale of ['en', 'zh']) {
    for (const [key, leaf] of Object.entries(flatten(I18N[locale]))) {
      if (typeof leaf !== 'string') {
        continue
      }

      for (const match of leaf.match(/\{\{?[^}]*\}?\}/g) || []) {
        if (!allowed.has(match)) {
          problems.push(`${locale}.${key} -> ${match}`)
        }
      }
    }
  }

  // The SDK returns a STRING leaf verbatim; only a FUNCTION leaf gets args.
  // A `{count}` in a string therefore reaches the user as literal braces.
  assert.deepEqual(problems, [], `literal placeholders in string leaves: ${problems.join(', ')}`)
})

test('parameterised leaves are interpolator functions', async () => {
  const { I18N } = await boot()
  const parameterised = [
    ['status.running', [7]],
    ['status.tooLong', [60000]],
    ['status.backendDown', ['boom']],
    ['compare.noScores', ['empty']],
    ['compare.protectionOk', [4]],
    ['compare.protectionMissing', [2]],
    ['compare.protectionAltered', [3]],
    ['compare.protectionTruncated', [8]],
    ['compare.resultMeta', ['p', 'm', 12, 'Precise']],
    ['errors.invalid_request', ['bad']],
    ['errors.llm_unavailable', ['off']],
    ['errors.upstream_error', ['500']]
  ]

  for (const locale of ['en', 'zh']) {
    for (const [path, args] of parameterised) {
      const leaf = path.split('.').reduce((node, part) => node[part], I18N[locale])

      assert.equal(typeof leaf, 'function', `${locale}.${path} must be a function leaf`)
      const rendered = leaf(...args)

      assert.equal(typeof rendered, 'string')
      assert.ok(rendered.length > 0)
      assert.equal(/\{|\}/.test(rendered), false, `${locale}.${path} still contains braces`)
    }
  }
})

test('interpolators actually substitute their argument', async () => {
  const { I18N } = await boot()

  assert.match(I18N.en.status.running(7), /7/)
  assert.match(I18N.zh.status.running(7), /7/)
  assert.match(I18N.en.compare.protectionMissing(3), /3/)
  assert.match(I18N.zh.compare.protectionMissing(3), /3/)
  assert.match(I18N.en.compare.resultMeta('anthropic', 'claude', 42, 'Precise'), /anthropic/)
  assert.match(I18N.zh.compare.resultMeta('anthropic', 'claude', 42, '精准'), /42/)
})

test('resolves zh UI to Chinese and en UI to English', async () => {
  const { I18N } = await boot()

  __setActiveLocale('zh')
  assert.equal(__translate(PLUGIN_ID, 'zh', 'button.run'), I18N.zh.button.run)
  assert.notEqual(__translate(PLUGIN_ID, 'zh', 'button.run'), I18N.en.button.run)

  __setActiveLocale('en')
  assert.equal(__translate(PLUGIN_ID, 'en', 'button.run'), I18N.en.button.run)
})

test('an unshipped locale falls back to the English bundle, then the key', async () => {
  const { I18N } = await boot()

  // `zh-hant` / `ja` have no bundle, so the SDK renders English — the plugin
  // must not pretend to translate them.
  for (const locale of ['zh-hant', 'ja', 'fr', 'de', 'ar', 'ru', 'es']) {
    assert.equal(__translate(PLUGIN_ID, locale, 'button.run'), I18N.en.button.run)
  }

  assert.equal(__translate(PLUGIN_ID, 'en', 'nope.missing'), 'nope.missing')
})

test('a late bundle registration resolves for both locales', async () => {
  await boot()
  __registerBundles(PLUGIN_ID, { en: { lateProbe: 'late' }, zh: { lateProbe: '迟到' } })

  assert.equal(__translate(PLUGIN_ID, 'en', 'lateProbe'), 'late')
  assert.equal(__translate(PLUGIN_ID, 'zh', 'lateProbe'), '迟到')
})

test('covers every surface the UI language requirement names', async () => {
  const { I18N } = await boot()
  const en = flatten(I18N.en)

  // buttons / menus
  for (const key of ['button.run', 'button.stop', 'button.menu', 'menu.modeSection', 'menu.compare', 'menu.undo', 'menu.settings']) {
    assert.ok(en[key], `missing ${key}`)
  }

  // settings
  for (const key of ['settings.title', 'settings.tabsMode', 'settings.tabsModel', 'settings.tabsTemplates', 'settings.tabsDiagnostics', 'settings.tabsAbout']) {
    assert.ok(en[key], `missing ${key}`)
  }

  // the five scoring dimensions
  for (const key of ['goal_clarity', 'info_sufficiency', 'constraints', 'deliverable', 'expression_efficiency']) {
    assert.ok(en[`compare.dimensions.${key}`], `missing dimension ${key}`)
  }

  // disclaimer / errors / progress / empty states
  assert.ok(en['compare.selfAssessed'])
  assert.ok(en['compare.noScores'])
  assert.ok(en['status.noResult'])
  assert.ok(en['status.running'])
  for (const code of ['invalid_request', 'model_override_denied', 'provider_override_denied', 'llm_unavailable', 'upstream_error', 'upstream_timeout', 'empty_response', 'network']) {
    assert.ok(en[`errors.${code}`], `missing error ${code}`)
  }
})

test('every literal key used in the source exists in both bundles', async () => {
  const { I18N, t } = await boot()
  const source = readPluginSource()
  const en = flatten(I18N.en)
  const zh = flatten(I18N.zh)
  const keys = new Set()
  // Storage keys share the `section.` shape but are not messages; and a
  // concatenation prefix ('mode.' + m) is a family, covered by the dedicated
  // dynamic-family test rather than here.
  const storageKeys = new Set(Object.values(t.STORAGE_KEYS))

  // translate('x') / t('x') / tr('x')
  for (const match of source.matchAll(/\b(?:translate|tr|t)\('([A-Za-z][\w.]*)'/g)) {
    keys.add(match[1])
  }

  // Quoted keys inside lookup tables (scoreErrorKey, etc.).
  for (const match of source.matchAll(/'(?:compare|status|errors|settings|button|menu|mode|diag\w*)\.\w+'/g)) {
    keys.add(match[0].slice(1, -1))
  }

  const missing = [...keys].filter(
    key => !key.endsWith('.') && !storageKeys.has(key) && (!en[key] || !zh[key])
  )

  assert.deepEqual(missing, [], `keys missing from a bundle: ${missing.join(', ')}`)
})

test('dynamic key families are fully covered', async () => {
  const { I18N } = await boot()
  const en = flatten(I18N.en)

  for (const mode of ['precise', 'creative']) {
    assert.ok(en[`mode.${mode}`], `missing mode.${mode}`)
    assert.ok(en[`mode.${mode}Hint`], `missing mode.${mode}Hint`)
  }

  for (const dim of ['goal_clarity', 'info_sufficiency', 'constraints', 'deliverable', 'expression_efficiency']) {
    assert.ok(en[`compare.dimensions.${dim}`])
  }

  for (const outcome of ['ok', 'failed', 'stopped', 'discarded', 'blocked']) {
    assert.ok(en[`diagnostics.${outcome}`], `missing diagnostics.${outcome}`)
  }

  for (const code of ['empty', 'unparseable', 'unrecognized', 'absent']) {
    assert.ok(en[`compare.reason${code[0].toUpperCase()}${code.slice(1)}`], `missing reason ${code}`)
  }
})

test('technical identifiers are not translated', async () => {
  const { I18N } = await boot()

  // The plugin id is a stable slug in both bundles' About copy and is rendered
  // from the constant, never from a translated string.
  assert.equal(I18N.en.name === I18N.zh.name, false)

  const source = readPluginSource()

  assert.match(source, /'settings\.aboutId'\)\s*\+\s*': '\s*\+\s*PLUGIN_ID/)
})

// ── ui_lang reaching the backend ────────────────────────────────────────────

test('sends the active app locale as ui_lang on the real run path', async () => {
  const sent = []
  const rest = async (path, opts) => {
    if (path === '/status') {
      return { protocol_version: 1, llm: { binding: 'ctx', trust: { allow_model_override: true } } }
    }

    sent.push(opts.body)

    return {
      ok: true,
      enhanced: 'E',
      scores: null,
      score_error: 'absent',
      protection: { total: 0, missing: [], altered_whitespace: [] },
      duration_ms: 1,
      provider: 'p',
      model: 'm'
    }
  }

  const { mod, t } = await boot({ rest })

  for (const locale of ['zh', 'en', 'ja', 'zh-hant']) {
    // `LocaleBeacon` mirrors the app locale in the real renderer; this harness
    // has no React, so drive the same slot directly.
    t.setActiveLocale(locale)
    host.__drafts.new = 'draft for ' + locale
    await mod.runEnhance({ mode: 'precise' })
    assert.equal(sent[sent.length - 1].ui_lang, locale)
  }

  // The draft travels with its OWN language; `ui_lang` never rewrites it.
  t.setActiveLocale('zh')
  host.__drafts.new = 'Write a weekly report'
  await mod.runEnhance({ mode: 'precise' })
  assert.equal(sent[sent.length - 1].draft, 'Write a weekly report')
  assert.equal(sent[sent.length - 1].ui_lang, 'zh')
})

// ── model selection ─────────────────────────────────────────────────────────

test('follow-session sends no model or provider', async () => {
  const { t } = await boot()
  const request = t.buildRequest({
    draft: 'x',
    mode: 'precise',
    settings: { modelMode: 'session' },
    trust: { allow_model_override: true }
  })

  assert.equal(request.body.model, null)
  assert.equal(request.body.provider, null)
})

test('a pinned model is sent as a real override', async () => {
  const { t } = await boot()
  const request = t.buildRequest({
    draft: 'x',
    mode: 'precise',
    settings: { modelMode: 'pinned', pinnedModel: { model: 'claude-x', provider: 'anthropic' } },
    trust: { allow_model_override: true }
  })

  assert.equal(request.body.model, 'claude-x')
  assert.equal(request.body.provider, 'anthropic')
})

test('a pinned model is refused up front when the gate is closed — never downgraded', async () => {
  const { t } = await boot()
  const request = t.buildRequest({
    draft: 'x',
    mode: 'precise',
    settings: { modelMode: 'pinned', pinnedModel: { model: 'claude-x', provider: 'anthropic' } },
    trust: { allow_model_override: false }
  })

  // Blocked locally: no body at all, so nothing can be sent with the override
  // stripped and quietly replaced by the session model.
  assert.equal(request.body, undefined)
  assert.equal(request.blocked, 'status.capabilityBlocked')
})

test('an empty draft and an oversized draft are refused locally', async () => {
  const { t } = await boot()

  assert.equal(t.buildRequest({ draft: '   ', mode: 'precise' }).blocked, 'status.empty')
  assert.equal(
    t.buildRequest({ draft: 'a'.repeat(60001), mode: 'precise' }).blocked,
    'status.tooLong'
  )
})

// ── guards ──────────────────────────────────────────────────────────────────

test('applyGuard allows only an unchanged, still-bound surface', async () => {
  const { t } = await boot()

  assert.equal(t.applyGuard({ runToken: 1, currentToken: 1, bindingKey: 'a', startedBindingKey: 'a', currentText: 'd', draftAtStart: 'd' }), null)
  assert.equal(t.applyGuard({ runToken: 1, currentToken: 2, bindingKey: 'a', startedBindingKey: 'a', currentText: 'd', draftAtStart: 'd' }), 'discarded')
  assert.equal(t.applyGuard({ runToken: 1, currentToken: 1, bindingKey: 'b', startedBindingKey: 'a', currentText: 'd', draftAtStart: 'd' }), 'bindingsMoved')
  assert.equal(t.applyGuard({ runToken: 1, currentToken: 1, bindingKey: 'a', startedBindingKey: 'a', currentText: 'edited', draftAtStart: 'd' }), 'draftChanged')
})

test('undoGuard refuses to overwrite a draft that moved on', async () => {
  const { t } = await boot()
  const undo = { address: 'new', applied: 'enhanced', bindingKey: 'k' }

  assert.equal(t.undoGuard({ undo, address: 'new', bindingKey: 'k', currentText: 'enhanced' }), null)
  assert.equal(t.undoGuard({ undo, address: 'new', bindingKey: 'k', currentText: 'hand-edited' }), 'status.undoMismatch')
  assert.equal(t.undoGuard({ undo, address: 'other', bindingKey: 'k', currentText: 'enhanced' }), 'status.nothingToUndo')
  assert.equal(t.undoGuard({ undo, address: 'new', bindingKey: 'other', currentText: 'enhanced' }), 'status.nothingToUndo')
  assert.equal(t.undoGuard({ undo: null, address: 'new', bindingKey: 'k', currentText: '' }), 'status.nothingToUndo')
})

test('bindingKey treats new, active and session addresses as distinct', async () => {
  const { t } = await boot()

  assert.notEqual(t.bindingKey({ profile: 'p', connectionId: 'c', address: 'new' }), t.bindingKey({ profile: 'p', connectionId: 'c', address: null }))
  assert.notEqual(t.bindingKey({ profile: 'p', connectionId: 'c', address: 's1' }), t.bindingKey({ profile: 'p', connectionId: 'c', address: 's2' }))
  assert.notEqual(t.bindingKey({ profile: 'p', connectionId: 'c1', address: 's1' }), t.bindingKey({ profile: 'p', connectionId: 'c2', address: 's1' }))
})

// ── the run lifecycle ───────────────────────────────────────────────────────

test('stop discards a late result instead of applying it', async () => {
  // Per-path resolvers: the plugin calls `/status` at register and `/enhance`
  // per run, so one shared `release` would resolve the wrong call.
  let releaseEnhance
  let markIssued
  const issued = new Promise(resolve => {
    markIssued = resolve
  })
  const rest = path => {
    if (path === '/status') {
      return Promise.resolve({ protocol_version: 1, llm: { binding: 'ctx', trust: { allow_model_override: true } } })
    }

    return new Promise(resolve => {
      releaseEnhance = resolve
      markIssued()
    })
  }

  const { mod, t } = await boot({ rest })

  host.__drafts.new = 'original draft'

  const running = mod.runEnhance({ mode: 'precise' })

  // Wait until the call is genuinely in flight, THEN stop: stopping before the
  // request is issued would not exercise the late-arrival path at all.
  await issued
  mod.stopRun()

  releaseEnhance({
    ok: true,
    enhanced: 'LATE ENHANCED TEXT',
    scores: null,
    score_error: 'absent',
    protection: { total: 0, missing: [], altered_whitespace: [] },
    duration_ms: 10,
    provider: 'p',
    model: 'm'
  })

  const outcome = await running

  assert.equal(outcome.outcome, 'discarded')
  // Nothing was written, and no late notification claimed success.
  assert.deepEqual(host.calls.setDraft, [])
  assert.equal(host.__drafts.new, 'original draft')
  assert.equal(host.calls.notify.some(call => /replaced|已回填/.test(String(call.message))), false)
  assert.equal(t.memory.lastResult, null)
})

test('a successful run writes the enhanced text and arms one undo', async () => {
  const { mod, t } = await boot({
    rest: async () => ({
      ok: true,
      enhanced: 'ENHANCED',
      scores: null,
      score_error: 'absent',
      protection: { total: 0, missing: [], altered_whitespace: [] },
      duration_ms: 5,
      provider: 'p',
      model: 'm'
    })
  })

  host.__drafts.new = 'original'

  const outcome = await mod.runEnhance({ mode: 'precise' })

  assert.equal(outcome.outcome, 'applied')
  assert.equal(host.__drafts.new, 'ENHANCED')
  assert.equal(t.memory.undo.original, 'original')
  assert.equal(t.memory.undo.applied, 'ENHANCED')
})

test('a draft edited mid-flight is never overwritten', async () => {
  let release
  let markIssued
  const issued = new Promise(resolve => {
    markIssued = resolve
  })
  const { mod, t } = await boot({
    rest: path => {
      if (path === '/status') {
        return Promise.resolve({ protocol_version: 1, llm: { binding: 'ctx', trust: { allow_model_override: true } } })
      }

      return new Promise(resolve => {
        release = resolve
        markIssued()
      })
    }
  })

  host.__drafts.new = 'original'

  const running = mod.runEnhance({ mode: 'precise' })

  // The draft the run captured is read BEFORE the call goes out; only then does
  // the user type, which is the race the guard exists for.
  await issued
  host.__drafts.new = 'original plus my edits'

  release({
    ok: true,
    enhanced: 'ENHANCED',
    scores: null,
    score_error: 'absent',
    protection: { total: 0, missing: [], altered_whitespace: [] },
    duration_ms: 5,
    provider: 'p',
    model: 'm'
  })

  const outcome = await running

  assert.equal(outcome.outcome, 'discarded')
  assert.equal(outcome.reason, 'draftChanged')
  assert.equal(host.__drafts.new, 'original plus my edits')
  assert.deepEqual(host.calls.setDraft, [])
  // The result is still offered in the compare view rather than thrown away.
  assert.equal(t.ui.get().compare.enhanced, 'ENHANCED')
})

test('missing exact content blocks the auto-write and asks instead', async () => {
  const { mod, t } = await boot({
    rest: async () => ({
      ok: true,
      enhanced: 'rewrite that dropped ./src/app.ts',
      scores: null,
      score_error: 'absent',
      protection: { total: 2, missing: [{ kind: 'path', text: './other/path.ts' }], altered_whitespace: [] },
      duration_ms: 5,
      provider: 'p',
      model: 'm'
    })
  })

  host.__drafts.new = 'see ./other/path.ts'

  const outcome = await mod.runEnhance({ mode: 'precise' })

  assert.equal(outcome.outcome, 'blocked')
  assert.equal(outcome.reason, 'protection')
  assert.equal(host.__drafts.new, 'see ./other/path.ts')
  assert.equal(t.ui.get().compareOpen, true)
})

test('undo restores the pre-enhancement draft, once', async () => {
  const { mod, t } = await boot({
    rest: async () => ({
      ok: true,
      enhanced: 'ENHANCED',
      scores: null,
      score_error: 'absent',
      protection: { total: 0, missing: [], altered_whitespace: [] },
      duration_ms: 5,
      provider: 'p',
      model: 'm'
    })
  })

  host.__drafts.new = 'original'

  await mod.runEnhance({ mode: 'precise' })
  const undone = await mod.runUndo()

  assert.equal(undone.outcome, 'undone')
  assert.equal(host.__drafts.new, 'original')

  // Single-level: a second undo has nothing to restore.
  const again = await mod.runUndo()

  assert.equal(again.outcome, 'no-undo')
})

test('undo is blocked when the draft was edited after applying', async () => {
  const { mod, t } = await boot({
    rest: async () => ({
      ok: true,
      enhanced: 'ENHANCED',
      scores: null,
      score_error: 'absent',
      protection: { total: 0, missing: [], altered_whitespace: [] },
      duration_ms: 5,
      provider: 'p',
      model: 'm'
    })
  })

  host.__drafts.new = 'original'

  await mod.runEnhance({ mode: 'precise' })
  host.__drafts.new = 'ENHANCED plus my edits'

  const outcome = await mod.runUndo()

  assert.equal(outcome.outcome, 'blocked')
  assert.equal(host.__drafts.new, 'ENHANCED plus my edits')
})

test('a failed write reports applyFailed rather than claiming success', async () => {
  const { mod } = await boot({
    rest: async () => ({
      ok: true,
      enhanced: 'ENHANCED',
      scores: null,
      score_error: 'absent',
      protection: { total: 0, missing: [], altered_whitespace: [] },
      duration_ms: 5,
      provider: 'p',
      model: 'm'
    })
  })

  host.__drafts.new = 'original'
  // No mounted surface accepts the write (e.g. the tile unmounted mid-run).
  host.__setDraftResult = false

  const outcome = await mod.runEnhance({ mode: 'precise' })

  assert.equal(outcome.outcome, 'not-applied')
  assert.equal(host.calls.notify.some(call => call.kind === 'error'), true)
})

// ── projections ─────────────────────────────────────────────────────────────

test('scoreRows yields the five dimensions plus an overall row', async () => {
  const { t } = await boot()
  const side = { goal_clarity: 10, info_sufficiency: 20, constraints: 30, deliverable: 40, expression_efficiency: 50, overall: 30 }
  const rows = t.scoreRows({ original: side, enhanced: side })

  assert.equal(rows.length, 6)
  assert.deepEqual(rows.map(row => row.key), [
    'goal_clarity',
    'info_sufficiency',
    'constraints',
    'deliverable',
    'expression_efficiency',
    'overall'
  ])
  assert.equal(t.scoreRows(null).length, 0)
})

test('protectionSummary grades block / warn / ok', async () => {
  const { t } = await boot()

  assert.equal(t.protectionSummary({ total: 3, missing: [], altered_whitespace: [] }).tone, 'ok')
  assert.equal(t.protectionSummary({ total: 3, missing: [], altered_whitespace: [{ kind: 'url', text: 'x' }] }).tone, 'warn')
  assert.equal(t.protectionSummary({ total: 3, missing: [{ kind: 'url', text: 'x' }], altered_whitespace: [] }).tone, 'block')
  assert.equal(t.protectionSummary(null).tone, 'ok')
})

test('scoreErrorKey maps every parser reason to a message key', async () => {
  const { t } = await boot()

  assert.equal(t.scoreErrorKey('empty'), 'compare.reasonEmpty')
  assert.equal(t.scoreErrorKey('unparseable'), 'compare.reasonUnparseable')
  assert.equal(t.scoreErrorKey('unrecognized'), 'compare.reasonUnrecognized')
  assert.equal(t.scoreErrorKey('absent'), 'compare.reasonAbsent')
  assert.equal(t.scoreErrorKey('wat'), 'compare.reasonAbsent')
})

// ── settings & templates ────────────────────────────────────────────────────

test('normalizeSettings falls back sanely and never invents a model', async () => {
  const { t } = await boot()

  assert.deepEqual(t.normalizeSettings(null).mode, 'precise')
  assert.deepEqual(t.normalizeSettings({ mode: 'professional' }).mode, 'precise')
  assert.deepEqual(t.normalizeSettings({ mode: 'creative' }).mode, 'creative')
  assert.equal(t.normalizeSettings({ modelMode: 'pinned' }).pinnedModel, null)
  assert.equal(t.normalizeSettings({ modelMode: 'pinned', pinnedModel: { model: 'm', provider: 'p' } }).pinnedModel.model, 'm')
})

test('templates round-trip, validate and reset', async () => {
  const { t, ctx } = await boot()

  // A user template without {{draft}} is refused.
  const bad = t.saveTemplatesFromDraft({
    precise: { system: 's', user: 'no placeholder' },
    creative: { system: 's', user: '{{draft}}' }
  })

  assert.equal(bad.ok, false)
  assert.equal(t.ui.get().templateError, true)

  const good = t.saveTemplatesFromDraft({
    precise: { system: 'sys-z', user: 'pre {{draft}}' },
    creative: { system: 'sys-c', user: 'cre {{draft}}' }
  })

  assert.equal(good.ok, true)
  assert.equal(t.currentTemplates().precise.system, 'sys-z')
  assert.equal(ctx.storage.get('templates.v1', null).precise.user, 'pre {{draft}}')

  t.resetTemplatesToDefault()
  assert.equal(t.currentTemplates().precise.system, t.DEFAULT_TEMPLATES.precise.system)
})

test('persists only settings and templates, and nothing draft-shaped', async () => {
  const { ctx, t } = await boot()

  t.setMode('creative')

  // `templates.meta.v1` is the template bookkeeping (which shipped default the
  // live bytes are), settled at boot even before anything is stored — it holds
  // no draft either. Nothing else is written.
  assert.deepEqual([...ctx.storage.keys()].sort(), ['settings.v1', 'templates.meta.v1'])
  assert.equal(ctx.storage.get('settings.v1', null).mode, 'creative')

  // Results, scores and diagnostics are module-memory only.
  const source = readPluginSource()

  assert.equal(/storage\.set\((?!STORAGE_KEYS)/.test(source), false)
  assert.match(source, /memory\.lastResult = result/)
})

test('diagnostics clear drops results and errors from memory', async () => {
  const { t } = await boot()

  t.memory.lastError = { at: 1, code: 'x', message: 'y' }
  t.memory.lastResult = { original: 'a', enhanced: 'b' }
  t.memory.runs = [{ at: 1 }]

  t.clearDiagnostics()

  assert.equal(t.memory.lastError, null)
  assert.equal(t.memory.lastResult, null)
  assert.deepEqual(t.memory.runs, [])
})

// ── status / capability ─────────────────────────────────────────────────────

test('a closed model gate is surfaced from the backend status', async () => {
  const { mod, t } = await boot({
    rest: async path => {
      assert.equal(path, '/status')

      return {
        protocol_version: 1,
        llm: { binding: 'ctx', trust: { allow_model_override: false, unlock_hint: 'hint-line' } }
      }
    }
  })

  await mod.loadCapability()

  const ui = t.ui.get()

  assert.equal(ui.binding, 'ctx')
  assert.equal(ui.trust.allow_model_override, false)
  assert.equal(ui.protocolVersion, 1)
})

test('an unreachable backend is reported, not hidden', async () => {
  const { mod, t } = await boot({
    rest: async () => {
      throw new Error('connection refused')
    }
  })

  await mod.loadCapability()

  assert.match(t.ui.get().capabilityError, /connection refused/)
})

test('the running badge counts seconds via a scoped timer', async () => {
  const { mod, t } = await boot()

  t.setUiState({ running: true, startedAt: Date.now() })
  assert.equal(t.ui.get().running, true)

  const before = t.memory.runToken
  mod.stopRun()

  assert.equal(t.ui.get().running, false)
  // Bumping the token is what makes an in-flight answer droppable.
  assert.equal(t.memory.runToken, before + 1)
})

// ── transport fidelity: a failed call says WHY it failed ─────────────────────
//
// The rejection shapes below are the live ones: `pluginRest` → `hermesApi` →
// Electron's `hermes:api` throws an Error with `statusCode` and the message
// "<status>: <body>" for an HTTP >= 400 (apps/desktop/electron/api-transport.ts
// `httpStatusError`), and a plain Error when no response ever arrived.

/** Build the Error Electron's `httpStatusError` produces for a non-2xx answer. */
function httpFailure(status, body) {
  // Electron ipcRenderer.invoke reconstructs Error; custom properties are lost.
  return new Error("Error invoking remote method 'hermes:api': Error: " + status + ': ' + (typeof body === 'string' ? body : JSON.stringify(body)))
}

test('a backend refusal is classified from its status and own error code', async () => {
  const { t } = await boot()

  const denied = t.classifyRestFailure(
    httpFailure(403, { ok: false, error: { code: 'model_override_denied', message: 'gate closed' } })
  )

  assert.equal(denied.kind, 'http')
  assert.equal(denied.status, 403)
  assert.equal(denied.code, 'model_override_denied')
  assert.equal(denied.message, 'gate closed')
  assert.equal(t.failureMessageKey(denied), 'errors.model_override_denied')
})

test('an upstream timeout and a rate limit are told apart from each other and from a dead socket', async () => {
  const { t } = await boot()

  const timeout = t.classifyRestFailure(
    httpFailure(504, { ok: false, error: { code: 'upstream_timeout', message: 'the model call timed out' } })
  )
  const busy = t.classifyRestFailure(httpFailure(429, '<html>too many requests</html>'))
  const upstream = t.classifyRestFailure(
    httpFailure(502, { ok: false, error: { code: 'upstream_error', message: 'provider exploded', detail: 'ECONNRESET' } })
  )

  assert.equal(t.failureMessageKey(timeout), 'errors.upstream_timeout')
  assert.equal(busy.status, 429)
  assert.equal(busy.code, 'busy')
  assert.equal(t.failureMessageKey(busy), 'errors.busy')
  assert.equal(t.failureMessageKey(upstream), 'errors.upstream_error')
  // `detail` is what the user needs for a 502; it must survive classification.
  assert.equal(upstream.detail, 'ECONNRESET')
})

test('a bare status with no usable body still names the class of failure', async () => {
  const { t } = await boot()

  assert.equal(t.failureMessageKey(t.classifyRestFailure(httpFailure(401, 'unauthorized'))), 'errors.unauthorized')
  assert.equal(t.failureMessageKey(t.classifyRestFailure(httpFailure(404, '<html>not found</html>'))), 'errors.not_found')
  assert.equal(t.failureMessageKey(t.classifyRestFailure(httpFailure(405, ''))), 'errors.method_not_allowed')
  assert.equal(t.failureMessageKey(t.classifyRestFailure(httpFailure(413, ''))), 'errors.too_large')
  assert.equal(t.failureMessageKey(t.classifyRestFailure(httpFailure(500, 'boom'))), 'errors.server')
})

test('a failure with no statusCode is a transport problem, and only that is "network"', async () => {
  const { t } = await boot()

  const aborted = Object.assign(new Error('Aborted'), { name: 'AbortError' })
  const timedOut = new Error('request timed out after 30s: llm.oneshot')
  const bridge = new Error('Hermes desktop bridge unavailable')
  const socket = new Error('socket hang up')

  assert.equal(t.failureMessageKey(t.classifyRestFailure(aborted)), 'errors.timeout')
  assert.equal(t.failureMessageKey(t.classifyRestFailure(timedOut)), 'errors.timeout')
  assert.equal(t.failureMessageKey(t.classifyRestFailure(bridge)), 'errors.gateway')
  assert.equal(t.failureMessageKey(t.classifyRestFailure(socket)), 'errors.network')
  assert.equal(t.classifyRestFailure(bridge).status, null)
})

test('a gateway RPC failure is classified by JSON-RPC code, not by an invented HTTP status', async () => {
  const { t } = await boot()

  const missing = Object.assign(new Error('no such method'), { code: -32601 })
  const refused = Object.assign(new Error('titles need a prompt'), { code: 4032 })
  const generated = Object.assign(new Error('one-shot generation failed: 429'), { code: 5030 })

  assert.equal(t.failureMessageKey(t.classifyGatewayFailure(missing)), 'errors.gateway_method_missing')
  assert.equal(t.failureMessageKey(t.classifyGatewayFailure(refused)), 'errors.gateway_refused')
  assert.equal(t.failureMessageKey(t.classifyGatewayFailure(generated)), 'errors.gateway_generation')
  assert.equal(t.classifyGatewayFailure(generated).status, null)
  assert.equal(t.failureMessageKey(t.classifyFailure(new Error('gateway not connected'), 'session')), 'errors.gateway')
})

test('the shipped run path reports the backend reason instead of blaming the network', async () => {
  const { mod, t } = await boot({
    rest: async path => {
      if (path === '/status') {
        return { protocol_version: 1, llm: { binding: 'ctx', trust: {} } }
      }

      throw httpFailure(403, { ok: false, error: { code: 'llm_unavailable', message: 'no live plugin context' } })
    }
  })

  host.__drafts.new = 'draft'
  const outcome = await mod.runEnhance({ mode: 'precise' })

  assert.equal(outcome.outcome, 'failed')
  assert.equal(outcome.failure.code, 'llm_unavailable')
  assert.equal(t.memory.lastError.status, 403)
  assert.equal(t.memory.lastError.kind, 'http')

  const said = host.calls.notify.map(entry => entry.message).join(' | ')
  assert.doesNotMatch(said, /Could not reach the plugin backend/)
  assert.match(said, /no live plugin context/)
})

// ── following the chat's model (the official llm.oneshot door) ───────────────
//
// `ctx.llm` resolves the PROFILE GLOBAL model — it has no session to borrow.
// Following a live chat therefore goes through the official stateless RPC
// `llm.oneshot` with the session id, which lends that session's model via
// `main_runtime`. The body is rendered by `/prepare` and parsed by `/parse` so
// scoring and exact-content protection cannot drift between the two doors.

function sessionRest(seen, answer) {
  return async (path, opts) => {
    const entry = { path, body: opts && opts.body, result: null }

    seen.push(entry)

    if (path === '/status') {
      entry.result = { protocol_version: 1, llm: { binding: 'ctx', trust: {} } }

      return entry.result
    }

    if (path === '/prepare') {
      entry.result = {
        ok: true,
        protocol_version: 1,
        mode: opts.body.mode,
        instructions: 'SYSTEM\n\n' + opts.body.system_template,
        input: 'USER\n\n<<<DRAFT>>>\n' + opts.body.draft + '\n<<<DRAFT>>>\n\nnote',
        draft_chars: opts.body.draft.length,
        draft_fence: '<<<DRAFT>>>',
        max_tokens: 8192
      }

      return entry.result
    }

    if (path === '/parse') {
      entry.result = {
        ok: true,
        enhanced: 'ENHANCED(' + opts.body.model_text + ')',
        scores: null,
        score_error: 'absent',
        text_shape: null,
        protection: { total: 0, missing: [], altered_whitespace: [] },
        mode: opts.body.mode
      }

      return entry.result
    }

    if (path === '/enhance') {
      entry.result = {
        ok: true,
        enhanced: 'GLOBAL',
        scores: null,
        score_error: 'absent',
        text_shape: null,
        protection: { total: 0, missing: [], altered_whitespace: [] },
        provider: 'p',
        model: 'm',
        duration_ms: 1,
        llm_binding: 'ctx'
      }

      return entry.result
    }

    void answer

    entry.result = { ok: false, error: { code: 'unexpected_route', message: path } }

    return entry.result
  }
}

test('真实运行分支保留 JSON-RPC 错误类别', async () => {
  const { mod } = await boot({ rest: sessionRest([], 'unused') })
  host.state.focusedSessionId.set('sess-1')
  host.__drafts['sess-1'] = 'rewrite me'
  const original = host.request
  host.request = async () => { throw Object.assign(new Error('generation failed'), { code: 5030 }) }
  try {
    const outcome = await mod.runEnhance({ mode: 'precise' })
    assert.equal(outcome.failure.code, 'gateway_generation')
    assert.equal(host.__drafts['sess-1'], 'rewrite me')
  } finally { host.request = original }
})

test('会话流程 prepare 的 IPC 失败仍按 REST 分类', async () => {
  const { mod } = await boot({ rest: async path => {
    if (path === '/status') return { protocol_version: 1, llm: { binding: 'ctx', trust: {} } }
    throw httpFailure(400, { ok: false, error: { code: 'invalid_request', message: 'bad template' } })
  } })
  host.state.focusedSessionId.set('sess-1')
  host.__drafts['sess-1'] = 'rewrite me'
  const outcome = await mod.runEnhance({ mode: 'precise' })
  assert.equal(outcome.failure.code, 'invalid_request')
})

test('a live chat is followed through llm.oneshot with its session id', async () => {
  const seen = []
  const { mod, t } = await boot({ rest: sessionRest(seen, 'ANSWER') })

  host.state.focusedSessionId.set('sess-1')
  host.__requestResult = { text: 'ANSWER' }
  host.__drafts['sess-1'] = 'rewrite me'

  const outcome = await mod.runEnhance({ mode: 'precise' })

  // 1. The editorial half was rendered by the backend, not hand-built here.
  const prepare = seen.find(entry => entry.path === '/prepare')
  assert.ok(prepare, 'the follow-session path must prepare through the backend')
  assert.equal(prepare.body.draft, 'rewrite me')
  assert.equal(prepare.body.model, undefined)
  assert.equal(prepare.body.provider, undefined)
  // The FRONTEND never fences: the fence is applied in exactly one place.
  assert.equal(prepare.body.draft.includes('<<<DRAFT>>>'), false)

  // 2. The model call is the real gateway RPC, addressed to THIS session.
  assert.equal(host.calls.request.length, 1)
  assert.equal(host.calls.request[0].method, 'llm.oneshot')
  assert.equal(host.calls.request[0].params.session_id, 'sess-1')
  assert.equal(host.calls.request[0].params.instructions, prepare.result.instructions)
  assert.equal(host.calls.request[0].params.input, prepare.result.input)

  // 3. The answer came back through the shared parser, so protection/scoring
  //    are identical to the /enhance path.
  const parse = seen.find(entry => entry.path === '/parse')
  assert.equal(parse.body.model_text, 'ANSWER')
  assert.equal(parse.body.draft, 'rewrite me')

  // 4. `/enhance` was NOT used — that door would have run the global model.
  assert.equal(seen.some(entry => entry.path === '/enhance'), false)

  assert.equal(outcome.result.path, 'session')
  assert.equal(t.ui.get().compareOpen, false)
})

test('the draft reaches the model exactly once on the follow-session path', async () => {
  const seen = []
  const { mod } = await boot({ rest: sessionRest(seen, 'ANSWER') })

  host.state.focusedSessionId.set('sess-1')
  host.__requestResult = { text: 'ANSWER' }
  host.__drafts['sess-1'] = 'ONLY-COPY'

  await mod.runEnhance({ mode: 'precise' })

  const params = host.calls.request[0].params

  // One occurrence in the prepared input, and nothing appended beside it.
  assert.equal(params.input.split('ONLY-COPY').length - 1, 1)
  assert.equal(params.instructions.includes('ONLY-COPY'), false)
})

test('a composer with no live chat uses the global model and says so — it never creates one', async () => {
  const seen = []
  const { mod } = await boot({ rest: sessionRest(seen, 'ANSWER') })

  host.__drafts.new = 'draft'

  const outcome = await mod.runEnhance({ mode: 'precise' })

  assert.equal(seen.some(entry => entry.path === '/prepare'), false)
  assert.equal(host.calls.request.length, 0)
  assert.equal(host.calls.requestProfile.length, 0)
  assert.equal(outcome.result.path, 'global')

  const said = host.calls.notify.map(entry => entry.message).join(' | ')
  // The harness i18n stub renders the raw key, so the assertion is on the KEY:
  // the point is that the downgrade is a distinct, stated event rather than a
  // silent swap of models.
  assert.match(said, /status\.noLiveSession/)
})

test('a pinned model still goes to the backend door and never borrows a session', async () => {
  const seen = []
  const { mod } = await boot({ rest: sessionRest(seen, 'ANSWER') })

  host.state.focusedSessionId.set('sess-1')
  host.__drafts['sess-1'] = 'draft'
  await mod.setMode('precise')

  const outcome = await mod.runEnhance({ mode: 'precise' })

  // No override configured, so this run must have stayed on the session door.
  assert.equal(outcome.result.path, 'session')
  assert.equal(host.calls.request.length, 1)
})

test('planRun follows a live chat and falls back to the global model only when there is none', async () => {
  const { t } = await boot()

  assert.equal(t.planRun({ settings: { modelMode: 'session' }, sessionId: 'sess-1' }).path, 'session')
  assert.equal(t.planRun({ settings: { modelMode: 'session' }, sessionId: null }).path, 'global')
  assert.equal(t.planRun({ settings: { modelMode: 'session' }, sessionId: null }).reason, 'no-live-session')

  const pinned = t.planRun({
    settings: { modelMode: 'pinned', pinnedModel: { model: 'claude-x' } },
    sessionId: 'sess-1',
    trust: { allow_model_override: true }
  })

  assert.equal(pinned.path, 'global')
  assert.equal(pinned.reason, 'pinned-model')

  const gated = t.planRun({
    settings: { modelMode: 'pinned', pinnedModel: { model: 'claude-x' } },
    sessionId: 'sess-1',
    trust: { allow_model_override: false }
  })

  assert.equal(gated.blocked, 'status.capabilityBlocked')
})

test('a run owned by another connection is refused rather than misrouted', async () => {
  const seen = []
  const { mod, t } = await boot({ rest: sessionRest(seen, 'ANSWER') })

  host.state.focusedSessionId.set('sess-1')
  host.state.focusedSessionOwner.set({ connectionId: 'remote-a', profile: 'default' })
  host.__activeConnectionId = 'local'
  host.__profileRoutes = []
  host.__drafts['sess-1'] = 'draft'

  const route = await t.resolveRunRoute({ host, connectionId: 'remote-a', profile: 'default' })

  assert.equal(route.blocked, 'status.routeUnavailable')

  const outcome = await mod.runEnhance({ mode: 'precise' })

  assert.equal(outcome.reason, 'routeUnavailable')
  assert.equal(host.calls.request.length, 0)
  assert.equal(host.calls.requestProfile.length, 0)
  assert.equal(seen.some(entry => entry.path === '/prepare'), false)
})

test('a routed owner is reached through its own route descriptor', async () => {
  const descriptor = { connectionId: 'remote-a', mode: 'remote', profile: 'default', targetProfile: 'default' }
  const seen = []
  const { mod, t } = await boot({ rest: sessionRest(seen, 'ANSWER') })

  host.state.focusedSessionId.set('sess-1')
  host.state.focusedSessionOwner.set({ connectionId: 'remote-a', profile: 'default' })
  host.__activeConnectionId = 'local'
  host.__profileRoutes = [descriptor]
  host.__requestResult = { text: 'ANSWER' }
  host.__drafts['sess-1'] = 'draft'

  assert.equal((await t.resolveRunRoute({ host, connectionId: 'remote-a', profile: 'default' })).mode, 'route')

  const outcome = await mod.runEnhance({ mode: 'precise' })

  assert.equal(outcome.result.path, 'session')
  assert.equal(host.calls.request.length, 0)
  assert.equal(host.calls.requestProfile.length, 1)
  assert.deepEqual(host.calls.requestProfile[0].route, descriptor)
  assert.equal(host.calls.requestProfile[0].options.spawnPriority, 'foreground')
})

test('the ambient path is kept when the owner is this machine', async () => {
  const { t } = await boot()

  host.__activeConnectionId = 'local'
  assert.equal((await t.resolveRunRoute({ host, connectionId: 'local', profile: 'default' })).mode, 'ambient')
  assert.equal((await t.resolveRunRoute({ host, connectionId: '', profile: 'default' })).mode, 'ambient')
})

// ── success fills the draft back; the compare view is manual ─────────────────

test('a successful run fills the draft back and does NOT open the compare view by default', async () => {
  const { mod, t } = await boot({
    rest: async path => {
      if (path === '/status') {
        return { protocol_version: 1, llm: { binding: 'ctx', trust: {} } }
      }

      return {
        ok: true,
        enhanced: 'ENHANCED',
        scores: null,
        score_error: 'absent',
        text_shape: null,
        protection: { total: 0, missing: [], altered_whitespace: [] },
        provider: 'p',
        model: 'm',
        duration_ms: 1
      }
    }
  })

  host.__drafts.new = 'original'
  await mod.runEnhance({ mode: 'precise' })

  assert.equal(host.__drafts.new, 'ENHANCED')
  assert.equal(t.currentSettings().showCompareOnSuccess, false)
  assert.equal(t.ui.get().compareOpen, false)
  // The result is still kept, so the manual compare view has something to show.
  assert.equal(t.memory.lastResult.enhanced, 'ENHANCED')
  assert.equal(t.ui.get().compare, null)
})

test('opting into the compare view on success still works', async () => {
  const { mod, t } = await boot({
    rest: async path => {
      if (path === '/status') {
        return { protocol_version: 1, llm: { binding: 'ctx', trust: {} } }
      }

      return {
        ok: true,
        enhanced: 'ENHANCED',
        scores: null,
        score_error: 'absent',
        text_shape: null,
        protection: { total: 0, missing: [], altered_whitespace: [] }
      }
    }
  })

  t.setUiState({})
  t.setSettings({ showCompareOnSuccess: true })
  host.__drafts.new = 'original'
  await mod.runEnhance({ mode: 'precise' })

  assert.equal(t.ui.get().compareOpen, true)
})

test('normalizeSettings defaults the compare-on-success switch to off', async () => {
  const { t } = await boot()

  assert.equal(t.normalizeSettings(null).showCompareOnSuccess, false)
  assert.equal(t.normalizeSettings({}).showCompareOnSuccess, false)
  assert.equal(t.normalizeSettings({ showCompareOnSuccess: true }).showCompareOnSuccess, true)
  // Anything that is not an explicit opt-in stays off.
  assert.equal(t.normalizeSettings({ showCompareOnSuccess: 'yes' }).showCompareOnSuccess, false)
})

// ── the UI language vocabulary is the app's, not a private dialect ───────────

test('the bundles are keyed by the app Locale macros, so en/zh follow Hermes', async () => {
  const { I18N } = await boot()

  // The app's Locale union (apps/desktop/src/i18n/types.ts). A bundle keyed
  // 'zh-CN' or 'zh-Hans' would never resolve — the plugin would silently render
  // English for a Simplified-Chinese Hermes.
  const appLocales = ['en', 'zh', 'zh-hant', 'ja', 'ar', 'ru', 'fr', 'de', 'es']

  assert.deepEqual(Object.keys(I18N).sort(), ['en', 'zh'])

  for (const locale of Object.keys(I18N)) {
    assert.ok(appLocales.includes(locale), `${locale} is not an app locale`)
  }

  // Both shipped locales must actually differ — a copy-pasted bundle would look
  // translated while showing English.
  assert.notEqual(I18N.zh.button.run, I18N.en.button.run)
  assert.match(I18N.zh.button.run, /[\u4e00-\u9fff]/)
})

test('each shipped default template carries exactly one {{draft}}', async () => {
  const { t } = await boot()

  // Two placeholders would send the draft twice: once fenced at each site.
  // The doubled delivery this pass fixed lived in the assembly step, and this
  // keeps it from coming back through the shipped defaults.
  for (const mode of t.MODES) {
    const template = t.DEFAULT_TEMPLATES[mode]
    const count = (template.user.match(/\{\{draft\}\}/g) || []).length

    assert.equal(count, 1, `${mode} must carry the placeholder once`)
    assert.equal(template.system.includes('{{draft}}'), false, `${mode} system must not carry it`)
  }
})

// ── shipped default templates: fused from the source prompt plugins ──────────

const CJK = /[\u4e00-\u9fff]/

test('ships a complete Chinese template pair for both modes', async () => {
  const { t } = await boot()

  for (const mode of t.MODES) {
    const pair = t.DEFAULT_TEMPLATES[mode]

    assert.ok(CJK.test(pair.system), `${mode}.system must be Chinese`)
    assert.ok(CJK.test(pair.user), `${mode}.user must be Chinese`)
    // The two generic English sentences this replaced were 176 / 145 chars in
    // the system half; a paraphrase standing in for a fusion stays short.
    assert.ok(pair.system.length > 400, `${mode}.system is still a paraphrase (${pair.system.length} chars)`)
    assert.ok(pair.user.length > 90, `${mode}.user is still a paraphrase (${pair.user.length} chars)`)
  }
})

test('the shipped templates keep the language-follow rule and drop the hard length quota', async () => {
  const { t } = await boot()

  for (const mode of t.MODES) {
    const text = `${t.DEFAULT_TEMPLATES[mode].system}\n${t.DEFAULT_TEMPLATES[mode].user}`

    assert.match(text, /语言/, `${mode} lost the language-follow rule`)
    // Both source plugins (WB WorkBuddy original, Heybinshao) capped the result
    // at ~800 characters. The project contract forbids a length quota, so the
    // cap is the one thing that had to go.
    assert.equal(/\b800\b/.test(text), false, `${mode} still carries the 800-character cap`)
    assert.equal(/\d+\s*字符/.test(text), false, `${mode} still carries a numeric character cap`)
  }
})

test('the shipped templates carry the source method, not a role frame', async () => {
  const { t } = await boot()
  const precise = t.DEFAULT_TEMPLATES.precise.system
  const creative = t.DEFAULT_TEMPLATES.creative.system
  const both = `${precise}\n${creative}`

  // The user's own expert method: 解构 → 重构 → 复核 → 只输出.
  assert.match(precise, /解构/, 'precise lost the deconstruct step')
  assert.match(precise, /复核/, 'precise lost the review step')
  assert.match(creative, /解构/, 'creative lost the deconstruct step')
  assert.match(creative, /复核/, 'creative lost the review step')

  // WB's "no technologies it did not mention" rule and its no-guides/no-snippets
  // constraints.
  assert.match(precise, /没有提到|未提及|没有提到过/)
  assert.match(precise, /教程|操作指南/)
  assert.match(precise, /代码片段/)

  // The role/title framing both sources opened with is dropped (no title, no
  // Skills/Rules/Workflows block).
  assert.equal(/提示词工程专家|Prompt Engineering Expert/.test(both), false, 'role title came back')
  assert.equal(/^#|Skills:|Rules:/m.test(both), false, 'a role/skills frame came back')
})

test('the shipped templates carry exact-content protection for entities, not for evidence', async () => {
  const { t } = await boot()

  for (const mode of t.MODES) {
    const text = `${t.DEFAULT_TEMPLATES[mode].system}\n${t.DEFAULT_TEMPLATES[mode].user}`

    assert.match(text, /路径|代码|命令/, `${mode} lost the protected-content clause`)
  }
})

// ── legacy default template migration ───────────────────────────────────────

test('an untouched legacy default is migrated to the new default', async () => {
  const { t } = await boot()
  const out = t.migrateTemplates({
    precise: { ...t.LEGACY_DEFAULT_TEMPLATES.precise },
    creative: { ...t.LEGACY_DEFAULT_TEMPLATES.creative }
  })

  assert.equal(out.migrated, true)
  assert.deepEqual(out.templates.precise, t.DEFAULT_TEMPLATES.precise)
  assert.deepEqual(out.templates.creative, t.DEFAULT_TEMPLATES.creative)
})

test('a customized template is preserved verbatim — never rewritten', async () => {
  const { t } = await boot()
  const mine = { system: '我自己的系统提示词', user: '把我自己的用户提示词\n\n{{draft}}' }
  const out = t.migrateTemplates({
    precise: mine,
    creative: { ...t.LEGACY_DEFAULT_TEMPLATES.creative }
  })

  // Identity, not equality: a custom entry must not be cloned or normalised.
  assert.equal(out.templates.precise, mine)
  assert.deepEqual(out.templates.creative, t.DEFAULT_TEMPLATES.creative)
  assert.equal(out.migrated, true)
})

test('a partial legacy match is preserved, never migrated on a guess', async () => {
  const { t } = await boot()
  const half = {
    system: t.LEGACY_DEFAULT_TEMPLATES.precise.system,
    user: '我自己的用户提示词\n\n{{draft}}'
  }
  const out = t.migrateTemplates({ precise: half })

  assert.equal(out.templates.precise, half)
  assert.equal(out.migrated, false)
})

test('register() migrates a stored legacy default and persists the new one', async () => {
  const mod = await loadPlugin()
  const ctx = makeCtx()

  ctx.storage.set('templates.v1', {
    precise: { ...mod.LEGACY_DEFAULT_TEMPLATES.precise },
    creative: { ...mod.LEGACY_DEFAULT_TEMPLATES.creative }
  })

  __resetHost()
  mod.default.register(ctx)

  const stored = ctx.storage.get('templates.v1', null)

  assert.deepEqual(stored.precise, mod.DEFAULT_TEMPLATES.precise)
  assert.deepEqual(stored.creative, mod.DEFAULT_TEMPLATES.creative)
  assert.deepEqual(mod.__testing.currentTemplates().precise, mod.DEFAULT_TEMPLATES.precise)
})

test('register() leaves a user-authored template alone', async () => {
  const mod = await loadPlugin()
  const ctx = makeCtx()
  const mine = { system: '自定系统提示词', user: '自定用户提示词\n\n{{draft}}' }

  ctx.storage.set('templates.v1', { precise: mine, creative: mine })

  __resetHost()
  mod.default.register(ctx)

  const templates = mod.__testing.currentTemplates()

  assert.equal(templates.precise.system, '自定系统提示词')
  assert.equal(templates.creative.system, '自定系统提示词')
  assert.equal(ctx.storage.get('templates.v1', null).precise.system, '自定系统提示词')
})

test('restoring defaults yields the new templates, not the legacy ones', async () => {
  const { t } = await boot()

  t.resetTemplatesToDefault()

  assert.deepEqual(t.currentTemplates().precise, t.DEFAULT_TEMPLATES.precise)
  assert.deepEqual(t.currentTemplates().creative, t.DEFAULT_TEMPLATES.creative)
  assert.notDeepEqual(t.currentTemplates().precise, t.LEGACY_DEFAULT_TEMPLATES.precise)
})

// ── every default this plugin has SHIPPED, recorded exactly ─────────────────
//
// Three pairs have been published by this project: the pre-fusion English
// sample, the Chinese pair the fusion shipped, and the Chinese pair after the
// wording fix. Only the LAST one is the live default. The middle one is gone
// from the source tree — the only surviving copies are the pre-sync archives —
// so it is read back out of those archives rather than retyped, and the tests
// below compare the recorded pair against the archived bytes.

/** Evaluate `export const <name> = {…}` out of an archived plugin.js. */
function archivedTemplates(backup, relative, name = 'DEFAULT_TEMPLATES') {
  const source = readFileSync(resolve(PROJECT_DIR, 'backups', backup, relative), 'utf8')
  const start = source.indexOf('export const ' + name + ' = {')

  assert.ok(start >= 0, `${backup}/${relative} carries no ${name}`)

  let depth = 0

  for (let index = source.indexOf('{', start); index < source.length; index += 1) {
    if (source[index] === '{') {
      depth += 1
    } else if (source[index] === '}') {
      depth -= 1

      if (depth === 0) {
        // Test-only evaluation of an archived OBJECT LITERAL of strings and
        // `.join('\n')` calls — no imports, no side effects, no plugin code.
        return new Function('return ' + source.slice(source.indexOf('{', start), index + 1))()
      }
    }
  }

  throw new Error(`${backup}/${relative}: unterminated ${name}`)
}

/** The two installed halves of one release: the app copy and the profile copy. */
const ARCHIVED_HALVES = [
  'app-desktop-plugins/fragile-prompt-enhance/plugin.js',
  'profile-plugins/fragile-prompt-enhance/desktop/plugin.js'
]

test('the recorded default versions are ordered, identified, and end at the live default', async () => {
  const { t } = await boot()

  assert.deepEqual(
    t.TEMPLATE_DEFAULT_VERSIONS.map(entry => entry.version),
    [1, 2, 3]
  )
  assert.equal(t.TEMPLATE_VERSION, 3)
  assert.deepEqual(
    t.TEMPLATE_DEFAULT_VERSIONS.map(entry => entry.id),
    ['v1-english-pre-fusion', 'v2-chinese-intermediate', 'v3-chinese-current']
  )

  const live = t.TEMPLATE_DEFAULT_VERSIONS[2]

  assert.deepEqual(live.precise, t.DEFAULT_TEMPLATES.precise)
  assert.deepEqual(live.creative, t.DEFAULT_TEMPLATES.creative)

  // v1 is still the pair the older migration named, exported under its old name
  // so nothing that already refers to it has to move.
  assert.deepEqual(t.TEMPLATE_DEFAULT_VERSIONS[0].precise, t.LEGACY_DEFAULT_TEMPLATES.precise)
  assert.deepEqual(t.TEMPLATE_DEFAULT_VERSIONS[0].creative, t.LEGACY_DEFAULT_TEMPLATES.creative)
})

test('the recorded pre-fusion English default is the archived shipped text', async () => {
  const { t } = await boot()

  for (const half of ARCHIVED_HALVES) {
    const archived = archivedTemplates('pre-sync-260926T1305+0800', half)

    assert.deepEqual(t.TEMPLATE_DEFAULT_VERSIONS[0].precise, archived.precise, half)
    assert.deepEqual(t.TEMPLATE_DEFAULT_VERSIONS[0].creative, archived.creative, half)
  }
})

test('the recorded intermediate Chinese default is the archived shipped text, not a paraphrase', async () => {
  const { t } = await boot()
  const seen = []

  // Two releases shipped it (13:35 and 15:00); both archives must agree with the
  // recorded pair, or the fingerprint describes something that never shipped.
  for (const backup of ['pre-sync-260926T1335+0800', 'pre-sync-260926T1500+0800']) {
    for (const half of ARCHIVED_HALVES) {
      const archived = archivedTemplates(backup, half)

      assert.deepEqual(t.TEMPLATE_DEFAULT_VERSIONS[1].precise, archived.precise, `${backup} ${half}`)
      assert.deepEqual(t.TEMPLATE_DEFAULT_VERSIONS[1].creative, archived.creative, `${backup} ${half}`)
      seen.push(archived)
    }
  }

  assert.equal(seen.length, 4)
  // ...and it is genuinely a DIFFERENT pair from today's default: a fingerprint
  // that matched the live default would migrate nothing and prove nothing.
  assert.notDeepEqual(t.TEMPLATE_DEFAULT_VERSIONS[1].precise, t.DEFAULT_TEMPLATES.precise)
  assert.notDeepEqual(t.TEMPLATE_DEFAULT_VERSIONS[1].creative, t.DEFAULT_TEMPLATES.creative)
  // The USER halves were unchanged between v2 and v3: only the methods moved.
  assert.deepEqual(t.TEMPLATE_DEFAULT_VERSIONS[1].precise.user, t.DEFAULT_TEMPLATES.precise.user)
  assert.deepEqual(t.TEMPLATE_DEFAULT_VERSIONS[1].creative.user, t.DEFAULT_TEMPLATES.creative.user)
})

test('a stored intermediate Chinese default is migrated to the current default', async () => {
  const { t } = await boot()
  const v2 = t.TEMPLATE_DEFAULT_VERSIONS[1]
  const out = t.migrateTemplates({
    precise: { system: v2.precise.system, user: v2.precise.user },
    creative: { system: v2.creative.system, user: v2.creative.user }
  })

  assert.equal(out.migrated, true)
  assert.deepEqual(out.fromVersions, [2])
  assert.equal(out.to, 3)
  assert.deepEqual(out.templates.precise, t.DEFAULT_TEMPLATES.precise)
  assert.deepEqual(out.templates.creative, t.DEFAULT_TEMPLATES.creative)
})

test('a stored default that is already current is left alone, not counted as migrated', async () => {
  const { t } = await boot()
  const mine = { precise: { ...t.DEFAULT_TEMPLATES.precise }, creative: { ...t.DEFAULT_TEMPLATES.creative } }
  const out = t.migrateTemplates(mine)

  assert.equal(out.migrated, false)
  assert.deepEqual(out.fromVersions, [])
  // Identity: nothing normalised, cloned or re-serialised on the way through.
  assert.equal(out.templates.precise, mine.precise)
  assert.equal(out.templates.creative, mine.creative)
})

test('one mode on an older default and one custom mode migrates only the older one', async () => {
  const { t } = await boot()
  const v2 = t.TEMPLATE_DEFAULT_VERSIONS[1]
  const mine = { system: '我自己的系统提示词', user: '我自己的用户提示词\n\n{{draft}}' }
  const out = t.migrateTemplates({
    precise: { system: v2.precise.system, user: v2.precise.user },
    creative: mine
  })

  assert.equal(out.migrated, true)
  assert.deepEqual(out.fromVersions, [2])
  assert.deepEqual(out.templates.precise, t.DEFAULT_TEMPLATES.precise)
  assert.equal(out.templates.creative, mine)
})

test('a pair from two different shipped versions is reported as mixed, not as one version', async () => {
  const { t } = await boot()
  const out = t.migrateTemplates({
    precise: {
      system: t.TEMPLATE_DEFAULT_VERSIONS[0].precise.system,
      user: t.TEMPLATE_DEFAULT_VERSIONS[0].precise.user
    },
    creative: {
      system: t.TEMPLATE_DEFAULT_VERSIONS[1].creative.system,
      user: t.TEMPLATE_DEFAULT_VERSIONS[1].creative.user
    }
  })

  assert.equal(out.migrated, true)
  assert.deepEqual(out.fromVersions, [1, 2])
})

test('register() migrates a stored intermediate default and records the version it came from', async () => {
  const mod = await loadPlugin()
  const ctx = makeCtx()
  const v2 = mod.TEMPLATE_DEFAULT_VERSIONS[1]

  ctx.storage.set('templates.v1', {
    precise: { system: v2.precise.system, user: v2.precise.user },
    creative: { system: v2.creative.system, user: v2.creative.user }
  })

  __resetHost()
  mod.default.register(ctx)

  const stored = ctx.storage.get('templates.v1', null)
  const meta = ctx.storage.get('templates.meta.v1', null)

  assert.deepEqual(stored.precise, mod.DEFAULT_TEMPLATES.precise)
  assert.deepEqual(stored.creative, mod.DEFAULT_TEMPLATES.creative)

  assert.equal(meta.schema, mod.TEMPLATE_META_SCHEMA)
  assert.equal(meta.state, 'default')
  assert.equal(meta.version, 3)
  assert.equal(meta.fromVersion, 2)
  assert.equal(meta.source, 'migration')
  assert.equal(typeof meta.updatedAt, 'number')
})

test('a boot that changed nothing leaves an existing version record alone', async () => {
  const mod = await loadPlugin()
  const ctx = makeCtx()

  // A custom pair stored by hand, with the record an import would have left.
  ctx.storage.set('templates.v1', {
    precise: { system: '自定系统', user: '自定用户\n\n{{draft}}' },
    creative: { system: '自定系统', user: '自定用户\n\n{{draft}}' }
  })
  ctx.storage.set('templates.meta.v1', { schema: 1, state: 'imported', version: null, fromVersion: null, source: 'import-file', updatedAt: 7 })

  __resetHost()
  mod.default.register(ctx)

  const meta = ctx.storage.get('templates.meta.v1', null)

  // Clearing it would erase the only record of where this content came from.
  assert.equal(meta.state, 'imported')
  assert.equal(meta.source, 'import-file')
  assert.equal(meta.updatedAt, 7)
})

// ── one previous version, kept for a single-step rollback ───────────────────

test('the previous version is kept when a change replaces the live templates', async () => {
  const { t } = await boot()
  const before = t.currentTemplates()

  const saved = t.saveTemplatesFromDraft({
    precise: { system: '新系统', user: '新用户\n\n{{draft}}' },
    creative: { system: '新系统2', user: '新用户2\n\n{{draft}}' }
  })

  assert.equal(saved.ok, true)

  const previous = t.previousTemplates()

  assert.equal(previous.precise.system, before.precise.system)
  assert.equal(previous.creative.system, before.creative.system)
  assert.equal(typeof previous.savedAt, 'number')
})

test('only ONE previous version is kept — it is a rollback slot, not a history', async () => {
  const { t } = await boot()

  t.saveTemplatesFromDraft({
    precise: { system: '第一版', user: '第一版\n\n{{draft}}' },
    creative: { system: '第一版', user: '第一版\n\n{{draft}}' }
  })
  t.saveTemplatesFromDraft({
    precise: { system: '第二版', user: '第二版\n\n{{draft}}' },
    creative: { system: '第二版', user: '第二版\n\n{{draft}}' }
  })

  const previous = t.previousTemplates()

  assert.equal(previous.precise.system, '第一版')
  // The slot holds a pair and a record — never a list of versions.
  assert.equal(Array.isArray(previous), false)
  assert.deepEqual(Object.keys(previous).sort(), ['creative', 'meta', 'precise', 'savedAt'])
})

test('the previous version can be restored, and the rollback is itself undoable', async () => {
  const { t } = await boot()

  t.saveTemplatesFromDraft({
    precise: { system: '第一版', user: '第一版\n\n{{draft}}' },
    creative: { system: '第一版', user: '第一版\n\n{{draft}}' }
  })
  t.saveTemplatesFromDraft({
    precise: { system: '第二版', user: '第二版\n\n{{draft}}' },
    creative: { system: '第二版', user: '第二版\n\n{{draft}}' }
  })

  const outcome = t.restorePreviousTemplates()

  assert.equal(outcome.ok, true)
  assert.equal(t.currentTemplates().precise.system, '第一版')

  const meta = t.templateMeta()

  assert.equal(meta.state, 'rolled-back')
  assert.equal(meta.source, 'rollback')

  // The slot now holds what we rolled back FROM, so the move can be reversed.
  assert.equal(t.previousTemplates().precise.system, '第二版')

  const back = t.restorePreviousTemplates()

  assert.equal(back.ok, true)
  assert.equal(t.currentTemplates().precise.system, '第二版')
  assert.equal(t.previousTemplates().precise.system, '第一版')
})

test('a rollback with nothing to restore refuses and changes nothing', async () => {
  const { t } = await boot()
  const mod = await loadPlugin()

  assert.equal(mod.previousTemplates(), null)

  const before = t.currentTemplates()
  const outcome = t.restorePreviousTemplates()

  assert.equal(outcome.ok, false)
  assert.equal(outcome.reason, 'empty')
  assert.equal(t.currentTemplates().precise, before.precise)
  assert.equal(t.currentTemplates().creative, before.creative)
})

test('a corrupt previous-version slot is refused instead of being written into the draft path', async () => {
  const mod = await loadPlugin()
  const ctx = makeCtx()

  ctx.storage.set('templates.previous.v1', {
    savedAt: 1,
    meta: null,
    precise: { system: 'no placeholder', user: 'no placeholder at all' },
    creative: { system: 'x', user: 'x' }
  })

  __resetHost()
  mod.default.register(ctx)

  const before = mod.__testing.currentTemplates()
  const outcome = mod.__testing.restorePreviousTemplates()

  assert.equal(outcome.ok, false)
  assert.equal(outcome.reason, 'unusable')
  assert.deepEqual(mod.__testing.currentTemplates(), before)
})

// ── the enhancement-model control ───────────────────────────────────────────

test('the model control names the state it sets — label and value agree', async () => {
  const { t } = await boot()

  // The remembered defect: one row labelled "follow the session model" whose
  // `checked` value was `modelMode === 'pinned'` — the control read backwards.
  assert.deepEqual(t.MODEL_CHOICES.map(choice => choice.id), ['session', 'pinned'])
  assert.equal(t.MODEL_CHOICES[0].labelKey, 'settings.modelFollowOption')
  assert.equal(t.MODEL_CHOICES[1].labelKey, 'settings.modelDedicatedOption')

  assert.equal(t.modelChoiceValue({ modelMode: 'session' }), 'session')
  assert.equal(t.modelChoiceValue({ modelMode: 'pinned' }), 'pinned')
  assert.equal(t.modelChoiceValue({}), 'session')
})

test('choosing the dedicated model only changes plugin settings', async () => {
  const { t } = await boot()
  const before = { mode: 'creative', modelMode: 'session', pinnedModel: null, showCompareOnSuccess: true }
  const after = t.applyModelChoice(before, 'pinned')

  assert.equal(after.modelMode, 'pinned')
  assert.equal(after.mode, 'creative')
  assert.equal(after.showCompareOnSuccess, true)
  assert.equal(after.pinnedModel, null)

  const picked = t.applyModelSelection(after, 'claude-x', 'anthropic')

  assert.deepEqual(picked.pinnedModel, { model: 'claude-x', provider: 'anthropic' })
  assert.equal(picked.modelMode, 'pinned')
  assert.equal(picked.mode, 'creative')
})

test('switching back to follow-session keeps the remembered model', async () => {
  const { t } = await boot()
  const pinned = t.applyModelSelection({ modelMode: 'session' }, 'claude-x', 'anthropic')
  const back = t.applyModelChoice(pinned, 'session')

  assert.equal(back.modelMode, 'session')
  assert.deepEqual(back.pinnedModel, { model: 'claude-x', provider: 'anthropic' })

  // Follow-session sends nothing, so the remembered pick cannot leak into a run.
  const request = t.buildRequest({ draft: 'x', mode: 'precise', settings: back, trust: {} })

  assert.equal(request.body.model, null)
  assert.equal(request.body.provider, null)
})

test('the catalog is offered whether or not the override is granted', async () => {
  const { t } = await boot()

  assert.equal(t.modelPanelState(null, { modelMode: 'pinned' }).showCatalog, true)
  assert.equal(t.modelPanelState({ allow_model_override: false }, { modelMode: 'pinned' }).showCatalog, true)
  assert.equal(t.modelPanelState({ allow_model_override: true }, { modelMode: 'pinned' }).showCatalog, true)
  assert.equal(t.modelPanelState({}, { modelMode: 'session' }).showCatalog, false)
})

test('a closed gate is its own state, never a reason to hide the picker', async () => {
  const { t } = await boot()

  assert.equal(t.modelPanelState(null, { modelMode: 'pinned' }).gateOpen, false)
  assert.equal(t.modelPanelState({ allow_model_override: false }, { modelMode: 'pinned' }).gateOpen, false)
  assert.equal(t.modelPanelState({ allow_model_override: true }, { modelMode: 'pinned' }).gateOpen, true)
})

test('an unauthorized run is refused by name, never downgraded', async () => {
  const { t } = await boot()
  const request = t.buildRequest({
    draft: 'x',
    mode: 'precise',
    settings: { modelMode: 'pinned', pinnedModel: { model: 'claude-x', provider: 'anthropic' } },
    trust: { allow_model_override: false }
  })

  assert.equal(request.body, undefined)
  assert.equal(request.blocked, 'status.capabilityBlocked')
  // The refusal names the model that was picked, so the user knows what the
  // grant would enable.
  assert.deepEqual(request.args, ['claude-x'])
})

test('the model panel writes nothing but plugin settings', async () => {
  const source = readPluginSource()
  const start = source.indexOf('function ModelPanel(')
  const end = source.indexOf('\nexport function openSettings(')
  const panel = source.slice(start, end)

  assert.ok(start > 0 && end > start, 'ModelPanel not found')
  // A model pick is a plugin preference only: it must never reach the gateway,
  // the chat session or the composer.
  assert.equal(panel.includes('host.request'), false, 'the model panel calls the gateway')
  assert.equal(panel.includes('requestProfile'), false, 'the model panel calls the gateway')
  assert.equal(panel.includes('setDraft'), false, 'the model panel touches the composer')
  // The inverted switch and the gate-hidden picker are gone.
  assert.equal(panel.includes('pinned-switch'), false, 'the inverted switch came back')
  assert.equal(panel.includes("modelMode === 'pinned' && !blocked"), false, 'the picker is gated again')
  assert.equal(panel.includes('disabled: blocked'), false, 'a control is disabled by the gate again')
})

// ── the Menu contract of the shipped picker ─────────────────────────────────
//
// The desktop half used to assert only that `jsx(ModelCatalogMenu, {…})` was
// HANDED the right props — never that the panel mounted it where the component
// can actually render. `ModelCatalogMenu` is MENU CONTENT: its own top level
// renders Radix `Menu.Item`s (the loading skeletons at
// model-catalog-menu.tsx:495-507 and the trailing Add/Edit rows at 747-769),
// and Radix's `MenuItem` throws `` `MenuItem` must be used within `Menu` ``
// without a `DropdownMenu` root + `DropdownMenuContent` ancestor. Mounted in a
// bare `<div>` it took the whole `composer-action` area down with it.
//
// `desktop-stubs/render.mjs` therefore walks the real element tree and enforces
// Radix's own scope rules with Radix's own message. Its rules are quoted from
// the installed @radix-ui sources in the file header.

const PINNED_SETTINGS = { modelMode: 'pinned', pinnedModel: { model: 'claude-x', provider: 'anthropic' } }

/** Render the shipped `ModelPanel` exactly as `SettingsDialog` mounts it. */
function renderModelPanel(t, mod, trust = { allow_model_override: true }) {
  t.setSettings(PINNED_SETTINGS)

  return renderTree(
    jsx(mod.__testing.ModelPanel, {
      patch: () => {},
      translate: usePluginI18n(PLUGIN_ID),
      ui: { trust }
    })
  )
}

/**
 * The same panel, walked with `nodeTree` instead.
 *
 * `renderTree` enforces the Radix Menu contract and records only stub
 * components; a settings seam that lives on a plain `<div>` — the thinking-level
 * block, its value, its unsupported notice — is invisible to it. These seams
 * need `nodeTree`, which keeps host elements. The Menu contract is still
 * enforced by every test that uses `renderModelPanel`.
 */
function renderModelPanelNodes(t, mod, trust = { allow_model_override: true }, settings = PINNED_SETTINGS) {
  t.setSettings(settings)

  return nodeTree(
    jsx(mod.__testing.ModelPanel, {
      patch: () => {},
      translate: usePluginI18n(PLUGIN_ID),
      ui: { trust }
    })
  )
}

test('the Menu contract checker reproduces the shipped crash', () => {
  // The control for every test below: a bare catalog must go red with the exact
  // error the user saw. If this ever stops throwing, the walker went blind.
  assert.throws(
    () => renderTree(jsx('div', { children: jsx(ModelCatalogMenu, {}) })),
    /`MenuItem` must be used within `Menu`/
  )
  // ...and so must a bare menu item: the rule is the component's, not the
  // catalog's, so a future surface cannot slip past it either.
  assert.throws(
    () => renderTree(jsx('div', { children: jsx(DropdownMenuItem, {}) })),
    /`MenuItem` must be used within `Menu`/
  )
})

test('the model picker mounts inside a real Menu, not a bare block', async () => {
  const { mod, t } = await boot()
  const nodes = renderModelPanel(t, mod)
  const catalog = nodes.find(node => node.name === 'ModelCatalogMenu')

  assert.ok(catalog, 'the catalog did not render at all')

  // The catalog is content: it needs the Menu root AND the content provider, in
  // that order, above it.
  const root = catalog.path.indexOf('DropdownMenu')
  const content = catalog.path.indexOf('DropdownMenuContent')

  assert.ok(
    root >= 0,
    `the catalog is not inside a DropdownMenu root: ${catalog.path.join(' > ')}`
  )
  assert.ok(
    content > root,
    `the catalog is not inside a DropdownMenuContent: ${catalog.path.join(' > ')}`
  )
})

test('a pick can dismiss the menu it was made in', async () => {
  const { mod, t } = await boot()
  const nodes = renderModelPanel(t, mod)
  const catalog = nodes.find(node => node.name === 'ModelCatalogMenu')
  const menu = nodes.find(node => node.name === 'DropdownMenu')

  assert.ok(catalog && menu, 'the picker did not render')
  // The catalog asks its host to close on commit (`closeMenu()`), so the host
  // must hand it a real closer — not the context's default no-op.
  assert.ok(
    catalog.path.includes('ModelMenuCloseContext.Provider'),
    `the catalog has no close seam: ${catalog.path.join(' > ')}`
  )
  // ...which means the menu is CONTROLLED: an uncontrolled Radix root could not
  // be closed from a context value.
  assert.equal(menu.props.open, false, 'the menu is not controlled by panel state')
  assert.equal(typeof menu.props.onOpenChange, 'function', 'onOpenChange is not wired')
})

test('the picker has a trigger and stays available whatever the gate says', async () => {
  const { mod, t } = await boot()
  const nodes = renderModelPanel(t, mod, { allow_model_override: false })
  const trigger = nodes.find(node => node.name === 'DropdownMenuTrigger')
  const catalog = nodes.find(node => node.name === 'ModelCatalogMenu')

  assert.ok(trigger, 'the picker has no trigger — there is no way to open it')
  assert.equal(trigger.props.asChild, true, 'the trigger is not rendered as the panel button')
  // Authorisation is reported on its own row; it never removes the picker.
  assert.ok(catalog, 'a closed gate removed the picker')
  assert.ok(
    nodes.some(node => node.name === 'Button' && node.props['data-fpe'] === 'model-trigger'),
    'the trigger is not the labelled panel button'
  )
  assert.ok(
    nodes.some(node => node.name === 'Button' && node.props['data-fpe'] === 'model-clear'),
    'the picked model cannot be cleared'
  )
})

test('the whole composer-action area renders top to bottom', async () => {
  const { ctx } = await boot()
  const nodes = renderTree(ctx.registrations[0].render())

  // The contribution mounts the button, the compare dialog and the settings
  // dialog in one pass; the checker walks all of it.
  assert.ok(nodes.some(node => node.name === 'Button' && node.props['data-fpe'] === 'run'), 'the run button is gone')
  assert.ok(nodes.some(node => node.name === 'Dialog'), 'the dialogs are gone')

  // The composer's own mode menu is the working reference for this contract: it
  // was always inside a DropdownMenu + DropdownMenuContent.
  const modeRow = nodes.find(node => node.name === 'DropdownMenuItem' && node.props['data-fpe'] === 'mode-precise')

  assert.ok(modeRow, 'the mode menu row is gone')
  assert.ok(modeRow.path.includes('DropdownMenuContent'), modeRow.path.join(' > '))

  // Settings are closed by default, so the catalog is not mounted yet.
  assert.equal(nodes.some(node => node.name === 'ModelCatalogMenu'), false, 'the catalog mounted unopened')
})

// ── the authorization surface ───────────────────────────────────────────────
//
// The model picker is native and always available; whether a pinned model is
// AUTHORIZED is a separate fact about this installation, decided by the HOST.
// The desktop half can only report it: the shipped consent screen
// (`hermes_cli/plugins_cmd_capabilities.py`) is TTY-gated and fails closed off a
// terminal, `plugins.manage` has no capability action, and the plugin SDK has
// no consent door. So the section is a read-back plus the operator's exact
// commands — never a control that pretends to grant or revoke.

const PLUGIN_SOURCE = readPluginSource()

/** The row shape `/status` reports verbatim (plugin_api.capability_rows). */
function capabilityRow(overrides = {}) {
  return {
    capability: 'llm.model_override',
    kind: 'model',
    legacy_key: `plugins.entries.${PLUGIN_ID}.llm.allow_model_override`,
    enforced: false,
    consent: false,
    enforced_by: 'host',
    divergence: null,
    ...overrides
  }
}

const TRUST_CLOSED = {
  allow_model_override: false,
  allow_provider_override: false,
  granted_capabilities: [],
  enforced_by: 'host',
  capabilities: [
    capabilityRow(),
    capabilityRow({ capability: 'llm.provider_override', kind: 'provider' })
  ],
  unlock_hint: 'grant-hint-text',
  revoke_hint: 'revoke-hint-text'
}

/** The granted state: one capability enforced AND consented. */
const TRUST_GRANTED = {
  ...TRUST_CLOSED,
  allow_model_override: true,
  granted_capabilities: ['llm.model_override'],
  capabilities: [capabilityRow({ enforced: true, consent: true }), capabilityRow({ capability: 'llm.provider_override', kind: 'provider' })]
}

/** The permission-section source, isolated from the rest of the panel. */
function permissionSectionSource() {
  const start = PLUGIN_SOURCE.indexOf('function PermissionSection(')
  const end = PLUGIN_SOURCE.indexOf('function ModelPanel(')

  assert.ok(start > 0 && end > start, 'PermissionSection not found')

  return PLUGIN_SOURCE.slice(start, end)
}

test('the permission rows report the enforcing layer and the consent record separately', async () => {
  const { mod, t } = await boot()
  const nodes = renderModelPanel(t, mod, {
    ...TRUST_CLOSED,
    allow_model_override: true,
    granted_capabilities: ['llm.model_override'],
    capabilities: [
      capabilityRow({ enforced: true, consent: true }),
      capabilityRow({ capability: 'llm.provider_override', kind: 'provider' })
    ]
  })

  const rows = nodes.filter(node => node.props['data-fpe'] === 'capability-row')

  assert.equal(rows.length, 2, 'one row per declared capability')

  const model = rows.find(node => node.props['data-capability'] === 'llm.model_override')
  const provider = rows.find(node => node.props['data-capability'] === 'llm.provider_override')

  assert.ok(model && provider, 'both declared capabilities must be reported')
  assert.equal(model.props['data-enforced'], 'true')
  assert.equal(model.props['data-consent'], 'true')
  assert.equal(provider.props['data-enforced'], 'false')
  assert.equal(provider.props['data-consent'], 'false')
})

test('a divergence between the two layers is surfaced, not smoothed over', async () => {
  const { mod, t } = await boot()
  const nodes = renderModelPanel(t, mod, {
    ...TRUST_CLOSED,
    allow_model_override: true,
    capabilities: [
      capabilityRow({ enforced: true, consent: false, divergence: 'gate-without-consent' }),
      capabilityRow({ capability: 'llm.provider_override', kind: 'provider' })
    ]
  })

  const flagged = nodes.filter(node => node.props['data-fpe'] === 'capability-divergence')

  assert.equal(flagged.length, 1, 'only the diverging row carries a warning')
  assert.equal(flagged[0].props['data-divergence'], 'gate-without-consent')
})

test('the section refuses to invent rows the backend did not report', async () => {
  const { mod, t } = await boot()
  const bare = renderModelPanel(t, mod, { allow_model_override: true })
  const reported = renderModelPanel(t, mod, TRUST_CLOSED)

  assert.equal(bare.some(node => node.props['data-fpe'] === 'capability-row'), false, 'rows invented')
  assert.ok(bare.some(node => node.props['data-fpe'] === 'permission-unknown'), 'the gap is not stated')
  assert.equal(reported.some(node => node.props['data-fpe'] === 'permission-unknown'), false)
})

test('the operator hints follow the state, per capability', async () => {
  const { t } = await boot()

  // Everything closed: the grant steps are the only useful text.
  const closed = t.permissionPanel(TRUST_CLOSED)

  assert.equal(closed.showGrant, true)
  assert.equal(closed.showRevoke, false)

  // Everything granted and enforced: there is nothing left to grant, and there
  // is something to revoke.
  const all = t.permissionPanel({
    ...TRUST_CLOSED,
    allow_model_override: true,
    allow_provider_override: true,
    granted_capabilities: ['llm.model_override', 'llm.provider_override'],
    capabilities: [
      capabilityRow({ enforced: true, consent: true }),
      capabilityRow({ capability: 'llm.provider_override', kind: 'provider', enforced: true, consent: true })
    ]
  })

  assert.equal(all.showGrant, false)
  assert.equal(all.showRevoke, true)

  // One of two granted: the operator still needs BOTH texts, and hiding one
  // behind the other's state is exactly how a capability gets stranded.
  const mixed = t.permissionPanel({
    ...TRUST_CLOSED,
    allow_model_override: true,
    granted_capabilities: ['llm.model_override'],
    capabilities: [capabilityRow({ enforced: true, consent: true }), capabilityRow({ capability: 'llm.provider_override', kind: 'provider' })]
  })

  assert.equal(mixed.showGrant, true)
  assert.equal(mixed.showRevoke, true)

  // A record without the enforcing key still has something to clean up.
  const divergent = t.permissionPanel({
    ...TRUST_CLOSED,
    granted_capabilities: ['llm.model_override'],
    capabilities: [capabilityRow({ consent: true, divergence: 'consent-without-gate' })]
  })

  assert.equal(divergent.showRevoke, true, 'a stale record must still offer the revoke steps')
})

test('a hint-less backend still yields a usable panel', async () => {
  const { t } = await boot()
  const panel = t.permissionPanel(null)

  assert.equal(panel.showGrant, true)
  assert.equal(panel.showRevoke, false)
  assert.deepEqual(panel.rows, [])
})

test('the refresh button re-reads the real permission from the backend', async () => {
  const paths = []
  const { mod, t } = await boot({
    rest: async path => {
      paths.push(path)

      return { protocol_version: 1, llm: { binding: 'ctx', trust: TRUST_CLOSED } }
    }
  })

  const nodes = renderModelPanel(t, mod, { allow_model_override: false })
  const refresh = nodes.find(node => node.name === 'Button' && node.props['data-fpe'] === 'permission-refresh')

  assert.ok(refresh, 'the re-read button is gone')

  await refresh.props.onClick()

  // The read goes through the plugin's OWN backend, on the same door the
  // register-time read uses.
  assert.equal(paths.at(-1), '/status')
  assert.deepEqual(t.ui.get().trust, TRUST_CLOSED)
})

test('the panel repaints in the active language without another read', async () => {
  const copied = []
  const paths = []
  const { mod, t } = await boot({
    ctx: { os: { writeClipboard: async text => (copied.push(text), true) } },
    rest: async path => {
      paths.push(path)

      // What the backend actually reports: both shipped locales in one payload.
      return {
        protocol_version: 1,
        llm: {
          binding: 'ctx',
          trust: {
            ...TRUST_GRANTED,
            unlock_hint: 'EN-GRANT',
            revoke_hint: 'EN-REVOKE',
            hints: { en: { unlock_hint: 'EN-GRANT', revoke_hint: 'EN-REVOKE' }, zh: { unlock_hint: 'ZH-GRANT', revoke_hint: 'ZH-REVOKE' } }
          }
        }
      }
    }
  })

  await mod.loadCapability()
  const reads = paths.length

  __setActiveLocale('zh')

  try {
    const nodes = renderModelPanel(t, mod, t.ui.get().trust)
    const revoke = nodes.find(node => node.name === 'Button' && node.props['data-fpe'] === 'permission-copy-revoke')

    assert.ok(revoke, 'the revoke steps must be offered for a granted capability')

    await revoke.props.onClick()

    assert.deepEqual(copied, ['ZH-REVOKE'], 'the copied steps must be the ones the UI shows')
    assert.equal(paths.length, reads, 'a language switch must not trigger another read')
  } finally {
    __setActiveLocale('en')
  }
})

test('the copy buttons copy the operator commands through ctx.os', async () => {
  const copied = []
  const { mod, t } = await boot({
    ctx: { os: { writeClipboard: async text => (copied.push(text), true) } }
  })

  // One granted, one not: both texts are on screen at once.
  const mixed = {
    ...TRUST_CLOSED,
    allow_model_override: true,
    granted_capabilities: ['llm.model_override'],
    capabilities: [capabilityRow({ enforced: true, consent: true }), capabilityRow({ capability: 'llm.provider_override', kind: 'provider' })],
    unlock_hint: 'GRANT-HINT',
    revoke_hint: 'REVOKE-HINT'
  }
  const nodes = renderModelPanel(t, mod, mixed)

  const grant = nodes.find(node => node.name === 'Button' && node.props['data-fpe'] === 'permission-copy-grant')
  const revoke = nodes.find(node => node.name === 'Button' && node.props['data-fpe'] === 'permission-copy-revoke')

  assert.ok(grant && revoke, 'both copy buttons must exist')

  await grant.props.onClick()
  await revoke.props.onClick()

  assert.deepEqual(copied, ['GRANT-HINT', 'REVOKE-HINT'])
})

test('a refused clipboard is reported, never silently swallowed', async () => {
  const { mod, t } = await boot({
    ctx: { os: { writeClipboard: async () => false } }
  })

  const nodes = renderModelPanel(t, mod, TRUST_GRANTED)
  const revoke = nodes.find(node => node.name === 'Button' && node.props['data-fpe'] === 'permission-copy-revoke')

  assert.ok(revoke, 'the revoke button is gone')

  await revoke.props.onClick()

  const told = host.calls.notify.at(-1)

  assert.ok(told, 'a refused copy must not pass silently')
  assert.notEqual(told.kind, 'info')
  assert.match(told.message, /permissionCopyFailed/)
})

test('the permission section has no grant and no revoke of its own', async () => {
  const section = permissionSectionSource()

  // No write door of any kind: not the host config, not the plugin manager, not
  // the consent recorder.
  for (const door of ['config.set', 'plugins.manage', 'record_consent', 'save_config', 'host.request', 'requestProfile']) {
    assert.equal(section.includes(door), false, `the permission section reaches ${door}`)
  }

  // The only two outbound doors it uses are the read-back and the clipboard,
  // and the read-back is the plugin's own loadCapability (the spec above pins
  // the exact path it hits) — never a host RPC.
  assert.ok(section.includes('loadCapability('), 'the read-back goes through the plugin backend')
  assert.ok(section.includes('writeClipboard'), 'the copy door is ctx.os.writeClipboard')
})

test('every permission string ships in both locales', async () => {
  const { I18N } = await boot()
  const en = flatten(I18N.en.settings)
  const zh = flatten(I18N.zh.settings)

  const keys = Object.keys(en).filter(key => key.startsWith('permission'))

  assert.ok(keys.length >= 8, `too few permission strings: ${keys.length}`)

  for (const key of keys) {
    assert.ok(zh[key], `settings.${key} is missing from zh`)
    assert.equal(typeof zh[key], typeof en[key], `settings.${key} has a different shape in zh`)
  }

  // The Chinese bundle is really Chinese: a copy-pasted English tree would pass
  // a key-parity check and still ship a half-translated panel.
  const literal = keys.filter(key => typeof en[key] === 'string')
  const translated = literal.filter(key => /[\u3000-\u9fff]/.test(zh[key]))

  assert.equal(translated.length, literal.length, 'a permission string was not translated')
})

// ── which model answered: three reasons, and a request is not a receipt ─────
//
// The screenshot bug: a pinned DeepSeek pick and a Kimi run both came back
// labelled "global model", so a deliberate choice looked like the plugin had
// ignored it. Two things were wrong and both are pinned below — the door
// (`path`) was the only thing recorded, and the REQUESTED model was presented as
// if the provider had confirmed it.

/** The result body the backend answers with when nothing else is stubbed. */
const BACKEND_OK = {
  ok: true,
  enhanced: 'ENHANCED',
  scores: null,
  score_error: 'absent',
  protection: { total: 0, missing: [], altered_whitespace: [] },
  duration_ms: 3,
  provider: 'deepseek',
  model: 'deepseek-chat'
}

/**
 * The text a component ACTUALLY renders, by running it.
 *
 * `renderTree` records only stub components (`component(name)` in plugin-sdk)
 * and walks past host elements without recording them, so a `data-fpe` seam that
 * lives on a plain `<div>` is invisible to it. The user-visible contract of the
 * compare dialog is its TEXT, so this walks the same tree, calls every function
 * component and collects the strings a reader would see.
 */
function renderedText(element) {
  const out = []
  const collect = value => {
    if (typeof value === 'string' || typeof value === 'number') {
      out.push(String(value))

      return
    }

    if (typeof value !== 'object' || value === null) {
      return
    }

    if (Array.isArray(value)) {
      value.forEach(collect)

      return
    }

    // A stub component instance (`{ __component, ...props }`).
    if (value.__component !== undefined) {
      collect(value.children)

      return
    }

    if (!('type' in value)) {
      return
    }

    if (typeof value.type === 'function') {
      collect(value.type(value.props || {}))

      return
    }

    collect((value.props || {}).children)
  }

  collect(element)

  return out.join('')
}

/** The rendered compare dialog for the CURRENT ui state. */
function compareText(mod) {
  return renderedText(jsx(mod.__testing.CompareDialog, {}))
}

/** Resolve a bundle key in the locale the dialog itself renders in. */
function tr(key, ...args) {
  return __translate(PLUGIN_ID, __activeLocale(), key, args)
}

/** Run one enhancement with a stubbed backend; returns the compare state. */
async function runWithBackend(t, mod, reply, options = {}) {
  t.setSettings(options.settings || { modelMode: 'pinned', pinnedModel: { model: 'kimi-k2', provider: 'moonshot' } })
  host.__drafts.new = options.draft || 'draft for the pinned model'

  const outcome = await mod.runEnhance({ mode: options.mode || 'precise' })

  return { compare: t.ui.get().compare, outcome }
}

test('the three model sources are distinct, named, and translated', async () => {
  const { t, I18N } = await boot()

  assert.deepEqual(t.RUN_SOURCES, ['dedicated', 'session', 'global'])

  const labels = t.RUN_SOURCES.map(source => t.sourceLabelKey(source))

  for (const [index, key] of labels.entries()) {
    assert.ok(key, `no label key for ${t.RUN_SOURCES[index]}`)

    const en = key.split('.').reduce((node, part) => (node ? node[part] : null), I18N.en)
    const zh = key.split('.').reduce((node, part) => (node ? node[part] : null), I18N.zh)

    assert.equal(typeof en, 'string', `${key} is missing from en`)
    assert.equal(typeof zh, 'string', `${key} is missing from zh`)
  }

  // A shared label is the original bug: two different choices read the same.
  assert.equal(new Set(labels).size, 3, `the three sources share a label: ${labels.join(' / ')}`)
  assert.notEqual(tr('compare.sourceDedicated'), tr('compare.sourceGlobalNew'))
  // An unknown source is never guessed into one of the three.
  assert.equal(t.sourceLabelKey(''), '')
  assert.equal(t.sourceLabelKey('gateway'), '')
  assert.equal(t.sourceLabelKey('global '), '')
})

test('a pinned model is classified by its own source, not by the transport', async () => {
  const { t } = await boot()

  t.setSettings({ modelMode: 'pinned', pinnedModel: { model: 'deepseek-chat', provider: 'deepseek' } })

  const pinned = t.planRun({
    settings: t.currentSettings(),
    sessionId: 's-live',
    trust: { allow_model_override: true }
  })

  // The door IS the global channel (ctx.llm), but the reason is the pick.
  assert.equal(pinned.path, 'global')
  assert.equal(pinned.source, 'dedicated')
  assert.equal(pinned.reason, 'pinned-model')
})

test('a chat-less composer is the new-global case, a live chat follows the session', async () => {
  const { t } = await boot()

  const fresh = t.planRun({ settings: t.currentSettings(), sessionId: null, trust: {} })

  assert.equal(fresh.path, 'global')
  assert.equal(fresh.source, 'global')
  assert.equal(fresh.reason, 'no-live-session')

  const followed = t.planRun({ settings: t.currentSettings(), sessionId: 's-live', trust: {} })

  assert.equal(followed.path, 'session')
  assert.equal(followed.source, 'session')
  assert.equal(followed.reason, 'follow-session')
})

test('a run records the source it took, and the dialog shows that source', async () => {
  // The draft carries a path the rewrite drops, so the auto-write is refused and
  // the compare dialog stays open — the surface the user actually reads.
  const rest = async path => {
    if (path === '/status') {
      return { protocol_version: 1, llm: { binding: 'ctx', trust: { allow_model_override: true } } }
    }

    return Object.assign({}, BACKEND_OK, {
      enhanced: 'ENHANCED without the path',
      protection: { total: 1, missing: [{ kind: 'path', text: './src/app.ts' }], altered_whitespace: [] }
    })
  }
  const { mod, t } = await boot({ rest })

  const { compare, outcome } = await runWithBackend(t, mod, null, { draft: '看 ./src/app.ts' })

  assert.equal(outcome.outcome, 'blocked')
  assert.equal(outcome.reason, 'protection')
  assert.ok(compare, 'the compare state was dropped')

  // The transport door IS the global channel; the SOURCE is the pick.
  assert.equal(compare.path, 'global')
  assert.equal(compare.source, 'dedicated')
  assert.deepEqual(compare.requestedModel, { model: 'kimi-k2', provider: 'moonshot' })

  const text = compareText(mod)

  assert.ok(text.includes(tr('compare.sourceDedicated')), 'the dedicated source was not stated')
  assert.equal(text.includes(tr('compare.sourceGlobalNew')), false, 'it was labelled as the global model')
})

// ── the result page's two layers ───────────────────────────────────────────
//
// ONE short line on the main surface (source, model, duration, and whether that
// model is the host's receipt or only this plugin's request), and everything
// that explains how the result was produced behind a disclosure. The tests below
// pin BOTH halves: what the main surface says, what it deliberately no longer
// says, and that an expanded disclosure still says all of it.

/** The main surface's summary line, as the dialog renders it. */
function summaryLine(mod) {
  return nodeTree(jsx(mod.__testing.CompareDialog, {})).find(
    node => node.props['data-fpe'] === 'result-summary'
  )
}

test('the main surface states the source, the model and the duration in one line', async () => {
  const { mod, t } = await boot()

  t.setUiState({
    compareOpen: true,
    compare: compareResult(t, {
      source: 'dedicated',
      requestedModel: { model: 'kimi-k2', provider: 'moonshot' },
      provider: 'moonshot',
      model: 'kimi-k2',
      durationMs: 1234
    })
  })

  const line = summaryLine(mod)

  assert.ok(line, 'the main line is gone')
  assert.equal(line.props['data-source'], 'dedicated')
  assert.equal(line.props['data-confirmed'], 'true')
  assert.equal(
    line.props.children,
    tr('compare.summary', tr('compare.sourceDedicated'), 'kimi-k2', 1234)
  )

  // The provenance prose is NOT on the main surface any more — that is the point
  // of the split, and it is what keeps the line short.
  const text = compareText(mod)

  assert.equal(text.includes(tr('compare.requestedNote')), false, 'the explanation is still on the main surface')
  assert.equal(text.includes(tr('compare.receiptNotCarried')), false)
})

test('the main line is short even when nothing is known about the model', async () => {
  const { mod, t } = await boot()

  t.setUiState({ compareOpen: true, compare: compareResult(t, { provider: '', model: '', durationMs: null }) })

  const line = summaryLine(mod)

  // No name is invented, and no duration is fabricated: the line says so.
  assert.match(line.props.children, new RegExp(tr('compare.summaryUnknownModel')))
  assert.equal(line.props['data-confirmed'], 'false')
  assert.ok(line.props.children.includes(tr('compare.summaryUnconfirmed')))
})

test('a requested model is never printed where a confirmed one goes', async () => {
  const { mod, t } = await boot()

  // Exactly the screenshot: a dedicated Kimi pick, riding the global channel,
  // with the host reporting no model at all.
  t.setUiState({
    compareOpen: true,
    compare: compareResult(t, {
      source: 'dedicated',
      requestedModel: { model: 'kimi-k2', provider: 'moonshot' },
      provider: '',
      model: ''
    })
  })

  const line = summaryLine(mod)
  const text = compareText(mod)

  // The name the user asked for IS shown — they did ask — and the marker that
  // says it is not a confirmation is on the line with it.
  assert.ok(line.props.children.includes('kimi-k2'))
  assert.equal(line.props['data-confirmed'], 'false')
  assert.ok(
    line.props.children.includes(tr('compare.summaryUnconfirmed')),
    'a requested model was left looking confirmed'
  )
  // Collapsed, the request is stated exactly once, and never in receipt form.
  assert.equal((text.match(/kimi-k2/g) || []).length, 1, 'the requested model was reported as confirmed')
})

test('opening the details reveals the request, the receipt and the channel note', async () => {
  const { mod, t } = await boot()

  t.setUiState({
    compareOpen: true,
    resultDetails: true,
    compare: compareResult(t, {
      source: 'dedicated',
      requestedModel: { model: 'kimi-k2', provider: 'moonshot' },
      provider: '',
      model: ''
    })
  })

  const text = compareText(mod)

  assert.ok(text.includes(tr('compare.requestedLabel', 'moonshot: kimi-k2')), 'the request was not stated')
  assert.ok(text.includes(tr('compare.receiptNone')), 'the missing receipt was not stated')
  assert.equal(text.includes(tr('compare.receiptNotCarried')), false)

  const nodes = nodeTree(jsx(mod.__testing.CompareDialog, {}))

  assert.ok(nodes.some(node => node.props['data-fpe'] === 'result-details'), 'the details never rendered')
  assert.ok(nodes.some(node => node.props['data-fpe'] === 'model-receipt'), 'the receipt row is missing')
})

test('the details toggle is a real button that states its own expanded state', async () => {
  const { mod, t } = await boot()

  t.setUiState({ compareOpen: true, compare: compareResult(t) })

  const nodes = nodeTree(jsx(mod.__testing.CompareDialog, {}))
  // The host's own full-row button plus its own caret: nothing hand-rolled.
  const toggle = nodes.find(
    node => node.props['data-fpe'] === 'result-details-toggle' && node.name === 'RowButton'
  )

  assert.ok(toggle, 'the toggle is not a RowButton')
  assert.ok(nodes.some(node => node.name === 'DisclosureCaret'), 'the disclosure has no caret')
  assert.equal(toggle.props['aria-expanded'], 'false')

  // It drives the real ui state, so this is the path a click takes.
  toggle.props.onClick()
  assert.equal(t.ui.get().resultDetails, true)
  assert.equal(t.ui.get().compareOpen, true, 'toggling the details closed the dialog')
})

test('an error is never moved into the disclosure', async () => {
  const { mod, t } = await boot()

  t.setUiState({
    compareOpen: true,
    resultDetails: false,
    compare: compareResult(t, {
      model: 'kimi-k2',
      requestedModel: { model: 'kimi-k2', provider: 'moonshot' },
      scoreError: 'unparseable',
      protection: t.protectionSummary({ missing: [{ kind: 'path', text: 'src/app.ts' }], total: 1 })
    })
  })

  const text = compareText(mod)

  // Collapsed, the failure and the block are STILL on screen in their own words.
  assert.ok(text.includes(tr('compare.reasonUnparseable')), 'the score error was hidden with the details')
  assert.ok(text.includes(tr('compare.protectionMissing', 1)), 'the protection block was hidden')

  const nodes = nodeTree(jsx(mod.__testing.CompareDialog, {}))

  assert.ok(nodes.some(node => node.props['data-fpe'] === 'no-scores'), 'the score error surface is gone')
  // ...and the exit is still reachable without expanding anything.
  assert.ok(
    nodes.some(node => node.props['data-fpe'] === 'apply-anyway'),
    'the "write it anyway" exit was hidden behind the disclosure'
  )
})

test('an unreported model on the session door says the host does not carry it', async () => {
  const { mod, t } = await boot()

  t.setUiState({
    compareOpen: true,
    resultDetails: true,
    compare: compareResult(t, {
      path: 'session',
      source: 'session',
      route: 'session',
      provider: '',
      model: ''
    })
  })

  const text = compareText(mod)

  // `llm.oneshot` returns `{text}` with no model name, so "this door does not
  // carry one" is the honest statement — different from "the host returned none".
  assert.ok(text.includes(tr('compare.receiptNotCarried')))
  assert.equal(text.includes(tr('compare.receiptNone')), false)
})

test('an unreported model on the plugin door says none came back', async () => {
  const { mod, t } = await boot()

  t.setUiState({
    compareOpen: true,
    resultDetails: true,
    compare: compareResult(t, { source: 'global', provider: '', model: '' })
  })

  const text = compareText(mod)

  assert.ok(text.includes(tr('compare.receiptNone')))
  assert.equal(text.includes(tr('compare.receiptNotCarried')), false)
})

test('a receipt that DID come back is reported as the host saw it', async () => {
  const { mod, t } = await boot()

  t.setUiState({
    compareOpen: true,
    resultDetails: true,
    compare: compareResult(t, {
      source: 'dedicated',
      requestedModel: { model: 'kimi-k2', provider: 'moonshot' },
      provider: 'moonshot',
      model: 'kimi-k2'
    })
  })

  const text = compareText(mod)

  assert.ok(text.includes(tr('compare.receipt', 'moonshot', 'kimi-k2')))

  // Collapsed, the same result names the model exactly once — on the main line,
  // as a confirmation. The request line only exists once it is asked for.
  t.setUiState({ resultDetails: false })

  const collapsed = compareText(mod)

  assert.equal((collapsed.match(/kimi-k2/g) || []).length, 1)
  assert.equal(collapsed.includes(tr('compare.requestedLabel', 'moonshot: kimi-k2')), false)
})

test('an unknown source renders as unknown rather than as one of the three', async () => {
  const { mod, t } = await boot()

  t.setUiState({ compareOpen: true, resultDetails: true, compare: compareResult(t, { source: '' }) })

  const text = compareText(mod)

  // The line is still rendered (the user is never left guessing) and it does not
  // borrow one of the three real labels.
  assert.ok(text.includes(tr('compare.pathLabel', '—')))
  for (const key of ['compare.sourceDedicated', 'compare.sourceSession', 'compare.sourceGlobalNew']) {
    assert.equal(text.includes(tr(key)), false, `an unknown source borrowed ${key}`)
  }

  // The main line keeps the honest placeholder too.
  t.setUiState({ resultDetails: false })

  assert.equal(summaryLine(mod).props['data-source'], 'unknown')
})

test('a new result collapses the disclosure that belonged to the old one', async () => {
  const { mod, t } = await boot()

  t.setUiState({ compareOpen: true, resultDetails: true, compare: compareResult(t, { source: 'global' }) })
  assert.equal(t.ui.get().resultDetails, true)

  // The two projections are pure, so this is checkable without a run.
  assert.deepEqual(
    t.resultDetails(compareResult(t, {})).map(row => row.kind),
    ['source', 'receipt']
  )
  assert.deepEqual(
    t.resultDetails(compareResult(t, { requestedModel: { model: 'kimi-k2', provider: 'moonshot' } })).map(row => row.kind),
    ['source', 'requested', 'requestedNote', 'receipt']
  )
})

test('modelAttribution never invents a receipt from a request', async () => {
  const { t } = await boot()

  // A request alone is not a receipt, on either door.
  const session = t.modelAttribution({
    path: 'session',
    source: 'session',
    requestedModel: { model: 'kimi-k2', provider: 'moonshot' }
  })

  assert.equal(session.receipt, null)
  assert.equal(session.receiptExpected, false)
  assert.deepEqual(session.requested, { model: 'kimi-k2', provider: 'moonshot' })

  const pluginDoor = t.modelAttribution({ path: 'global', source: 'dedicated', requestedModel: { model: 'kimi-k2' } })

  assert.equal(pluginDoor.receipt, null)
  assert.equal(pluginDoor.receiptExpected, true)

  const reported = t.modelAttribution({ path: 'global', source: 'dedicated', provider: 'p', model: 'm' })

  assert.deepEqual(reported.receipt, { provider: 'p', model: 'm' })
  // A half receipt is still a receipt, with the absent half marked, not filled in
  // from the request.
  assert.deepEqual(
    t.modelAttribution({ path: 'global', model: 'm', requestedModel: { provider: 'moonshot' } }).receipt,
    { provider: '—', model: 'm' }
  )
  assert.deepEqual(t.modelAttribution({ path: 'global', provider: 'p' }).receipt, { provider: 'p', model: '—' })
  // Whitespace is nothing.
  assert.equal(t.modelAttribution({ path: 'global', model: '   ' }).receipt, null)
  // An unrecognised source is reported as no source at all, never coerced.
  assert.equal(t.modelAttribution({ source: 'gateway' }).source, '')
  // And nothing at all must not throw.
  assert.equal(t.modelAttribution(null).receipt, null)
})

// ── the compare view: rationale, the optional note, and the line highlight ──

const SCORES_WITH_RATIONALES = {
  scale: '0-100',
  basis: 'self_assessed',
  original: { overall: 40, rationale: '原文只有一句话，缺少受众与交付形式。' },
  enhanced: { overall: 75, rationale: '补齐了受众、交付形式与验证方式。' }
}

/** A compare result as the run path builds it. */
function compareResult(t, patch = {}) {
  return Object.assign(
    {
      original: 'draft one\nsecond line',
      enhanced: 'draft one\nsecond line changed',
      scores: null,
      scoreError: null,
      changeNote: '',
      textShape: 'markers',
      protection: t.protectionSummary(null),
      provider: 'p',
      model: 'm',
      usage: null,
      durationMs: 4,
      mode: 'precise',
      path: 'global',
      source: 'global',
      requestedModel: null,
      route: 'ctx',
      at: 1
    },
    patch
  )
}

test('the rationale the same call already returned is displayed', async () => {
  const { mod, t } = await boot()

  t.setUiState({ compareOpen: true, compare: compareResult(t, { scores: SCORES_WITH_RATIONALES }) })

  const text = compareText(mod)

  // The reasons were in the payload all along and simply never rendered.
  assert.ok(text.includes('原文只有一句话，缺少受众与交付形式。'), 'the original rationale never rendered')
  assert.ok(text.includes('补齐了受众、交付形式与验证方式。'), 'the enhanced rationale never rendered')
  // Labelled, so a reader knows which side each reason belongs to.
  assert.ok(text.includes(tr('compare.rationaleTitle')))
  assert.ok(text.includes(tr('compare.rationaleOriginal')))
  assert.ok(text.includes(tr('compare.rationaleEnhanced')))
})

test('no rationale is displayed as absent rather than as an empty box', async () => {
  const { mod, t } = await boot()

  t.setUiState({
    compareOpen: true,
    compare: compareResult(t, {
      scores: {
        scale: '0-100',
        basis: 'self_assessed',
        original: { overall: 40, rationale: '' },
        enhanced: { overall: 75, rationale: '   ' }
      }
    })
  })

  const text = compareText(mod)

  assert.equal(text.includes(tr('compare.rationaleTitle')), false)
  // The scores themselves still render: a missing reason is not a missing score.
  assert.ok(text.includes(tr('compare.scores')))
})

test('the change note rides along, labelled as the model own account', async () => {
  const { mod, t } = await boot()

  t.setUiState({ compareOpen: true, compare: compareResult(t, { changeNote: '删去重复要求，补上验收方式。' }) })

  const text = compareText(mod)

  assert.ok(text.includes('删去重复要求，补上验收方式。'), 'the note never rendered')
  assert.ok(text.includes(tr('compare.changesTitle')))
  // Same call, same note — it is prose from the model, never a verified diff.
  assert.ok(text.includes(tr('compare.changesUnverified')))
  assert.equal(text.includes(tr('compare.changesNone')), false)
})

test('a missing change note costs nothing and still renders the section', async () => {
  const { mod, t } = await boot()

  t.setUiState({ compareOpen: true, compare: compareResult(t, { changeNote: '' }) })

  const text = compareText(mod)

  // Stated as absent, with the caveat still shown, and the body untouched.
  assert.ok(text.includes(tr('compare.changesNone')))
  assert.ok(text.includes(tr('compare.changesUnverified')))
  assert.ok(text.includes('draft one'), 'the draft vanished with the missing note')
})

test('the highlight marks added and removed lines and keeps the text exact', async () => {
  const { t } = await boot()
  const report = t.diffDrafts('line one\nline two\nline three', 'line one\nline two changed\nline three\nline four')

  assert.equal(report.ok, true)
  assert.ok(report.added >= 2)
  assert.ok(report.removed >= 1)

  const kinds = report.rows.map(row => row.kind)

  assert.ok(kinds.includes('add'))
  assert.ok(kinds.includes('remove'))
  // Common lines are neither added nor removed, and are not decorated.
  const common = report.rows.filter(row => row.kind === 'same').map(row => row.text)

  assert.ok(common.includes('line one'))
  assert.ok(common.includes('line three'))
  // The text itself is carried verbatim — no markers are injected into it.
  for (const row of report.rows) {
    assert.equal(typeof row.text, 'string')
    assert.doesNotMatch(row.text, /^[+-](?= )/)
  }
})

test('a mixed CN/EN body keeps its code, paths and blank lines in the diff', async () => {
  const { t } = await boot()
  const original = [
    '背景：src/app.ts 的 main() 在 CI 上偶发失败（flaky）。',
    '',
    '```ts',
    'export function main(): number {',
    '  return 0',
    '}',
    '```',
    '',
    '要求：跑 `make test`，看 https://example.com/logs 的输出。'
  ].join('\n')
  const enhanced = original.replace('  return 0', '  // 修复点\n  return 1')
  const report = t.diffDrafts(original, enhanced)

  assert.equal(report.ok, true)

  const texts = report.rows.map(row => row.text)

  // Every original line is still present, byte for byte, somewhere in the diff.
  for (const line of original.split('\n')) {
    assert.ok(texts.includes(line), `a line was mangled or dropped: ${line}`)
  }

  assert.ok(texts.includes('  // 修复点'))
  assert.ok(texts.includes('  return 1'))
})

test('the view falls back to full text when the highlight would be too big', async () => {
  const { t } = await boot()
  const huge = Array.from({ length: t.DIFF_LIMITS.maxLines + 5 }, (_, index) => 'line ' + index).join('\n')
  const composed = t.compareView({ original: huge, enhanced: huge + '\nmore' }, 'diff')

  assert.equal(composed.view, 'full')
  assert.equal(composed.fallback, true)
  assert.equal(composed.diff.ok, false)
  assert.ok(composed.diff.lines > t.DIFF_LIMITS.maxLines)

  // The user can still ask for the highlight, and the pick is what shows.
  assert.equal(t.compareView({ original: huge, enhanced: huge }, 'full').view, 'full')
  assert.equal(t.compareView({ original: 'a', enhanced: 'b' }, 'diff').view, 'diff')
})

test('the dialog says why the highlight was skipped instead of silently changing', async () => {
  const { mod, t } = await boot()
  const huge = Array.from({ length: t.DIFF_LIMITS.maxLines + 5 }, (_, index) => 'line ' + index).join('\n')

  t.setUiState({ compareOpen: true, compare: compareResult(t, { original: huge, enhanced: huge + '\nx' }) })

  const composed = t.compareView(t.ui.get().compare, 'diff')
  const text = compareText(mod)

  assert.equal(composed.fallback, true)
  // The fallback is stated, with the reason and the real line count.
  assert.ok(text.includes(tr('compare.diffTooLarge', composed.diff.lines)))
  // Not a silent switch: the full text is what is on screen.
  assert.ok(text.includes('line 0'))
  assert.ok(text.includes('line ' + (t.DIFF_LIMITS.maxLines + 4)))
})

test('the full-text view shows both sides verbatim, code included', async () => {
  const { mod, t } = await boot()
  const original = '```py\nprint("hi")\n```'

  t.setUiState({
    compareOpen: true,
    compare: compareResult(t, { original, enhanced: '```py\nprint("hi")\nprint("bye")\n```', scores: null })
  })

  const composed = t.compareView(t.ui.get().compare, 'full')

  assert.equal(composed.view, 'full')
  // Verbatim: the fences and the code bytes are exactly what the user will send.
  assert.equal(t.ui.get().compare.original, original)
  assert.ok(compareText(mod).includes('print("hi")'))
})

// ── what the templates must keep saying (items 3, 4) ───────────────────────

test('precise mode treats "no change" as a valid result and forbids padding', async () => {
  const { t } = await boot()
  const system = t.DEFAULT_TEMPLATES.precise.system

  // Dedupe-only / unchanged is allowed...
  assert.match(system, /只做去重与顺序整理/)
  assert.match(system, /“没有改动”本身就是合格结果/)
  // ...and the forced review scaffolding is explicitly ruled out.
  assert.match(system, /不为了凑出改动而添加评审维度、检查清单、验收标准/)
  // The WB rule that no unrequested technology gets invented survives.
  assert.match(system, /用户没有提到的技术栈、工具、流程、角色或章节不要自行添加/)
})

test('both templates keep the three-source Chinese method and the WB rules', async () => {
  const { t } = await boot()
  const precise = t.DEFAULT_TEMPLATES.precise.system
  const creative = t.DEFAULT_TEMPLATES.creative.system

  for (const [mode, system] of [['precise', precise], ['creative', creative]]) {
    // The author's own method: deconstruct → rebuild → review, output only.
    assert.match(system, /一、解构原稿/, `${mode} lost the deconstruct section`)
    assert.match(system, /二、重构/, `${mode} lost the rebuild section`)
    assert.match(system, /三、复核/, `${mode} lost the review section`)
    // WB: intent & scope, what not how, exact content.
    assert.match(system, /意图/, `${mode} lost the intent rule`)
    assert.match(system, /只改写|只输出|不代替用户执行/, `${mode} no longer says rewrite-only`)
    // The entities rule (WB + the AI-expert method) is what keeps names intact.
    assert.match(system, /保持它们的名称原样/, `${mode} lost the entity rule`)
  }

  assert.match(precise, /聚焦“做什么”，不解释“怎么做”/)
  assert.match(creative, /把原稿中的代码、命令、路径、URL、错误原文和配置值原样保留/)
})

test('precise keeps the author language rule and the downstream-context rule', async () => {
  const { t } = await boot()
  const system = t.DEFAULT_TEMPLATES.precise.system
  const user = t.DEFAULT_TEMPLATES.precise.user

  // The enhancer has no history — and that is NOT the same as the下游 having none.
  assert.match(system, /只有当前草稿可用：没有聊天历史/)
  assert.match(system, /下游执行者可能有它自己的上下文/)
  assert.match(system, /“这个插件”“按刚才方案”/)
  assert.match(system, /不要写成“内容附下方”/)
  // ...and it must not stall the run asking the user for materials.
  assert.match(system, /不要停下来要求用户补充资料/)

  // The language rule lives on the user half for both modes.
  assert.match(user, /保留草稿本来的语言/)
  assert.match(user, /中英混排保持自然混排/)
  assert.match(user, /\{\{draft\}\}/)
})

test('creative extends inside the freedom the draft grants and changes no intent', async () => {
  const { t } = await boot()
  const creative = t.DEFAULT_TEMPLATES.creative
  const system = creative.system

  // Expansion is bounded by the draft's own freedom, not by a template quota.
  assert.match(system, /鼓励合理展开，但不编造事实/)
  assert.match(system, /按任务规模展开/)
  assert.match(system, /保持原稿的目标、范围、约束、明确排除项与要求的交付物/)
  assert.match(system, /不要把设想写成已经确认的项目决定/)
  assert.match(system, /不要变成强制清单/)
  // The open-authorization rule: "没有限制" becomes concrete dimensions, and
  // nothing is auto-appended beyond the scope.
  assert.match(system, /开放授权/)
  assert.match(system, /不要说成它们已经是项目决定/)
  // The user half carries the freedom clause and the required/optional split.
  assert.match(creative.user, /在草稿允许的自由度内/)
  assert.match(creative.user, /明确区分必需项与可选方向/)
  assert.match(creative.user, /保留草稿本来的语言/)
})

test('both modes still refuse to fabricate and to touch code identities', async () => {
  const { t } = await boot()
  const precise = t.DEFAULT_TEMPLATES.precise.system
  const creative = t.DEFAULT_TEMPLATES.creative.system

  for (const [mode, system] of [['precise', precise], ['creative', creative]]) {
    // The self-check names invented facts as a failure in both modes.
    assert.match(system, /是否新增了事实|不编造事实|不要凭空写出/, `${mode} may now invent facts`)
    assert.match(system, /保持它们的名称原样/, `${mode} may now rename entities`)
  }

  // Exact content: code, commands, paths, identifiers and error text are data.
  assert.match(precise, /代码、命令、路径、标识与错误原文一律不修正/)
  assert.match(creative, /把原稿中的代码、命令、路径、URL、错误原文和配置值原样保留/)
  assert.match(creative, /请求修复或解释代码不等于允许改写这段代码/)
})

test('the shipped templates still declare no review rubric of their own', async () => {
  const { t } = await boot()

  for (const mode of ['precise', 'creative']) {
    const system = t.DEFAULT_TEMPLATES[mode].system

    // No dimension names from the score contract may leak into the editorial
    // instructions: the editor must not be told to grade its own output.
    for (const dimension of t.DIMENSIONS) {
      assert.equal(
        system.includes(dimension),
        false,
        `${mode} template mentions the scoring dimension ${dimension}`
      )
    }
  }
})

// ── long, mixed-language drafts through the real code paths ────────────────
//
// A CN/EN paste with code, paths and URLs is the case where a "helpful" string
// transform does the most damage: whole-file rewrites, entity renames, dropped
// code. These drive the actual request builder, the apply/undo guards and the
// highlight with that payload rather than an ASCII toy.

/** A long CN/EN draft: prose, a code block, a path, a URL, an inline command. */
function longMixedDraft() {
  const lines = [
    '背景：src/app.ts 的 main() 在 CI 上偶发失败，报错 "TypeError: x is not a function"。',
    '',
    '请按下面步骤排查（不要改代码）：',
    ''
  ]

  for (let index = 1; index <= 60; index += 1) {
    lines.push(`${index}. 检查 step_${index}() 的返回值，参考 https://example.com/guide/${index}#part-${index}`)
  }

  lines.push(
    '',
    '```ts',
    'export function main(): number {',
    '  const token = process.env.API_TOKEN',
    '  return token ? 1 : 0',
    '}',
    '```',
    '',
    '跑 `make test` 与 `npx tsc --noEmit`，把 ./logs/ci.txt 的尾部贴回来。',
    '不要动 node_modules/，也不要重命名 那个页面。'
  )

  return lines.join('\n')
}

test('a long mixed draft travels to the backend unchanged', async () => {
  const sent = []
  const rest = async (path, opts) => {
    if (path === '/status') {
      return { protocol_version: 1, llm: { binding: 'ctx', trust: { allow_model_override: true } } }
    }

    sent.push(opts.body)

    return BACKEND_OK
  }
  const { mod, t } = await boot({ rest })
  const draft = longMixedDraft()

  t.setSettings({ modelMode: 'pinned', pinnedModel: { model: 'kimi-k2', provider: 'moonshot' } })
  host.__drafts.new = draft

  await mod.runEnhance({ mode: 'precise' })

  assert.equal(sent.length, 1)
  // Byte for byte: the draft is the model's input, never rewritten on the way out.
  assert.equal(sent[0].draft, draft)
  // It travels ONCE, through the placeholder — the system half must not carry a
  // copy of the author's text.
  assert.ok(sent[0].user_template.includes('{{draft}}'), 'the draft placeholder is gone')
  assert.equal(sent[0].system_template.includes('process.env.API_TOKEN'), false)
  assert.equal(sent[0].model, 'kimi-k2')
  assert.equal(sent[0].provider, 'moonshot')
})

test('a long mixed draft is refused when it exceeds the limit, with the count', async () => {
  const { t } = await boot()
  const request = t.buildRequest({
    draft: 'a'.repeat(t.LIMITS.maxDraftChars + 1),
    mode: 'precise',
    settings: { modelMode: 'session' },
    trust: { allow_model_override: true }
  })

  assert.equal(request.body, undefined)
  assert.equal(request.blocked, 'status.tooLong')
  assert.deepEqual(request.args, [t.LIMITS.maxDraftChars])

  // One character under is accepted, unchanged.
  const ok = t.buildRequest({
    draft: 'a'.repeat(t.LIMITS.maxDraftChars),
    mode: 'precise',
    settings: { modelMode: 'session' },
    trust: { allow_model_override: true }
  })

  assert.equal(ok.body.draft.length, t.LIMITS.maxDraftChars)
})

test('the apply and undo guards read long mixed text without mangling it', async () => {
  const { t } = await boot()
  const draft = longMixedDraft()
  const applied = draft + '\n\n补充：先只做排查，不要提交。'

  // Nothing was applied yet: no undo.
  assert.equal(t.undoGuard({ undo: null }), 'status.nothingToUndo')

  // A clean apply: the undo is offered, and it fires only while the composer
  // still holds exactly what was written.
  const undo = { bindingKey: 'k1', address: 'new', applied }

  assert.equal(t.undoGuard({ undo, bindingKey: 'k1', address: 'new', currentText: applied }), null)
  // The user edited the long mixed text by hand: the undo is refused, not forced.
  assert.equal(
    t.undoGuard({ undo, bindingKey: 'k1', address: 'new', currentText: applied + ' 我改了' }),
    'status.undoMismatch'
  )

  // And an arriving result may only land while the draft is untouched.
  assert.equal(
    t.applyGuard({ runToken: 1, currentToken: 1, bindingKey: 'k1', startedBindingKey: 'k1', currentText: draft, draftAtStart: draft }),
    null
  )
  assert.equal(
    t.applyGuard({ runToken: 1, currentToken: 1, bindingKey: 'k1', startedBindingKey: 'k1', currentText: draft + 'x', draftAtStart: draft }),
    'draftChanged'
  )
})

test('a long mixed rewrite keeps every code and path byte in the highlight', async () => {
  const { t } = await boot()
  const draft = longMixedDraft()
  // A realistic rewrite: one sentence added, one line tightened. Nothing else.
  const enhanced = draft.replace('请按下面步骤排查（不要改代码）：', '请在给出结论前按下面步骤排查（不要改代码）：')

  const report = t.diffDrafts(draft, enhanced)

  assert.equal(report.ok, true)

  const texts = report.rows.map(row => row.text)

  for (const line of draft.split('\n')) {
    assert.ok(texts.includes(line), `a line was mangled or dropped: ${line}`)
  }

  assert.ok(texts.includes('请在给出结论前按下面步骤排查（不要改代码）：'))
  assert.ok(report.added >= 1 && report.removed >= 1)
})

// ─────────────────────────────────────────────────────────────────────────────
// The compare dialog's LAYOUT and the dedicated model's THINKING LEVEL are both
// contracts with the INSTALLED HOST, not with these stubs.
//
// A Tailwind class the host stylesheet never compiled a rule for renders
// nothing at all — the element silently falls back to the stylesheet's own
// default. Asserting a class string against a stub therefore proves nothing
// about what the user sees; these tests read the real Hermes desktop bundle
// (`apps/desktop/dist/assets/*.css`, `components/ui/dialog.tsx`) and the real
// Python host (`agent/plugin_llm.py`, `tui_gateway/contracts/sessions.py`).
//
// They need `HERMES_REPO` — the same variable the Python manifest tests use.
// With it unset they SKIP with the reason stated, so the bare `node --test` run
// the project documents stays usable; the deployment run sets it.
// ─────────────────────────────────────────────────────────────────────────────

const HOST_REPO = (process.env.HERMES_REPO || '').replace(/[\\/]+$/, '')
const NO_HOST = 'HERMES_REPO is unset — the installed host cannot be read'

function hostRead(relative) {
  return readFileSync(join(HOST_REPO, relative), 'utf8')
}

/** The host's compiled desktop stylesheet: the largest `.css` in the bundle. */
function hostStylesheet() {
  const dir = join(HOST_REPO, 'apps', 'desktop', 'dist', 'assets')
  let best = ''

  for (const name of readdirSync(dir).filter(entry => entry.endsWith('.css'))) {
    const text = readFileSync(join(dir, name), 'utf8')

    if (text.length > best.length) {
      best = text
    }
  }

  return best
}

/**
 * The stylesheet with every backslash removed.
 *
 * Tailwind escapes a selector's punctuation (`.bg-\(--ui-bg-secondary\)`), and
 * the bundle escapes it inconsistently — some rules carry one backslash, some
 * two. Reading class names out of the raw text therefore misses half the
 * utilities; flattening first sidesteps the escaping entirely.
 */
function flattenStylesheet(css) {
  return css.replace(/\\/g, '')
}

/**
 * Whether the flattened stylesheet carries a rule for exactly this class.
 *
 * The lookahead matters: `min-h-24` must not be satisfied by a rule for
 * `min-h-240`, and the comma in an arbitrary value (`min-w-[min(48rem,90vw)]`)
 * means a "split the sheet into a token set" pass cannot see the whole name.
 */
function hasCompiledRule(flat, token) {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

  return new RegExp('(?:^|[{},>\\s&])\\.' + escaped + '(?![\\w-])').test(flat)
}

/**
 * Strip what is NOT code before looking for classes.
 *
 * The scan below matches single-quoted literals, and a comment containing an
 * apostrophe ("the host's dialog body") opens a phantom literal that runs on
 * until the next quote — swallowing whole lines of prose AND the real code
 * between them. Those phantom literals then yielded words like `strip` or
 * `basis` as "classes". Comments are not shipped UI, so they are removed first;
 * the literal patterns additionally refuse to span a newline.
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map(line => line.replace(/(^|[^:'"`])\/\/.*$/, '$1'))
    .join('\n')
}

function sourceClassTokens(source) {
  const code = stripComments(source)
  const literals = []
  // A Tailwind-shaped token. `[a-z0-9-]*` before the `:` keeps a variant like
  // `md:flex` in and stops `note:` from counting as a utility.
  const utility =
    /^(?:@|!|\[)?[a-z0-9-]*:?(?:flex|grid|hidden|inline|block|table|relative|absolute|sticky|fixed|overflow|truncate|whitespace|break|rounded|border|tabular|font|text|bg|p|px|py|pt|pb|pl|pr|mx|my|mt|mb|ml|mr|w|h|min-w|min-h|max-w|max-h|gap|items|justify|self|shrink|grow|basis|opacity|uppercase|lowercase|tracking|select|order|col|row|align|list|z|inset|size|aspect|cursor|pointer|divide)(?:-|$)/

  const isClassList = text => {
    const tokens = text.split(/\s+/).filter(Boolean)

    // Two or more tokens, ALL utility-shaped. The length floor matters: a lone
    // word like `diff-row`, `new`, `high` or `http` is a seam value or a data
    // attribute, not a class list, and treating it as one cries wolf.
    return tokens.length >= 2 && tokens.every(token => utility.test(token))
  }

  for (const match of code.matchAll(/className:\s*'([^'\n]*)'/g)) {
    literals.push(match[1])
  }

  for (const match of code.matchAll(/cn\(([^)]*)\)/gs)) {
    for (const inner of match[1].matchAll(/'([^'\n]*)'/g)) {
      literals.push(inner[1])
    }
  }

  // Class lists held in a `const` and composed later — `const cell = 'px-1 pb-1
  // align-bottom'` — are the ones a `className:`-only scan cannot see, and that
  // omission is how `align-bottom` (no compiled rule) shipped unnoticed. Any
  // literal whose every token is utility-shaped is a class list; prose never is.
  for (const match of code.matchAll(/'([^'\n]+)'/g)) {
    if (isClassList(match[1])) {
      literals.push(match[1])
    }
  }

  const tokens = new Set()

  for (const literal of literals) {
    for (const token of literal.split(/\s+/)) {
      if (utility.test(token)) {
        tokens.add(token)
      }
    }
  }

  return tokens
}

/**
 * Classes the host stylesheet has no rule for AND that are not fixed here.
 * Each entry carries why it is left alone — a dead class is a finding, not a
 * licence to keep shipping one.
 */
const DEAD_CLASS_ALLOWLIST = new Map([
  [
    '@[26rem]/composer:inline',
    'the host stylesheet compiles no container-query `inline` variant, so the composer button never shows its mode label. Fixing it changes the composer toolbar, which is outside this round\'s fix and must be the user\'s call.'
  ]
])

/**
 * Every node under `element`, running function components: stub components,
 * plain host elements and their props. Unlike `renderTree` this keeps plain
 * elements, because a layout seam lives on a `<div>`, not on a stub.
 */
function nodeTree(element) {
  const out = []

  const visit = (value, depth) => {
    if (value === null || value === undefined || typeof value !== 'object' || depth > 300) {
      return
    }

    if (Array.isArray(value)) {
      value.forEach(item => visit(item, depth))

      return
    }

    const isStub = value.__component !== undefined
    const isElement = 'type' in value

    if (!isStub && !isElement) {
      return
    }

    const props = isStub ? value : value.props || {}
    const name = isStub
      ? value.__component
      : typeof value.type === 'function'
        ? value.type.name || '<anonymous>'
        : value.type

    out.push({ name, props })

    if (!isStub && typeof value.type === 'function') {
      visit(value.type(props), depth + 1)
    } else {
      visit(props.children, depth + 1)
    }
  }

  visit(element, 0)

  return out
}

/** Utilities the stylesheet compiled, keyed by the class a node carries. */
function classesOf(node) {
  const raw = node.props.className || node.props.class || ''

  return typeof raw === 'string' ? raw.split(/\s+/).filter(Boolean) : []
}

/** The compare dialog rendered with an oversized draft, i.e. in its FULL view. */
function renderCompareFullView(t, mod) {
  // Past DIFF_LIMITS the highlight is refused and the full text is shown, which
  // is the view the layout bug was reported on. The default view is driven by
  // the shipped `compareView`, not by a test-only shortcut.
  const huge = Array.from({ length: t.DIFF_LIMITS.maxLines + 5 }, (_, index) => 'line ' + index).join('\n')

  t.setUiState({
    compareOpen: true,
    compare: compareResult(t, { original: huge, enhanced: huge + '\nchanged line' })
  })

  assert.equal(t.compareView(t.ui.get().compare, 'diff').view, 'full', 'the fixture did not reach the full view')

  return nodeTree(jsx(mod.__testing.CompareDialog, {}))
}

// ── 1. the layout, against the real stylesheet and the real dialog ──────────

test('every utility class the desktop half ships has a compiled rule in the real host stylesheet', async t => {
  if (!HOST_REPO) {
    return t.skip(NO_HOST)
  }

  const flat = flattenStylesheet(hostStylesheet())
  const dead = []

  for (const token of sourceClassTokens(PLUGIN_SOURCE)) {
    if (!hasCompiledRule(flat, token) && !DEAD_CLASS_ALLOWLIST.has(token)) {
      dead.push(token)
    }
  }

  // A class with no rule is a layout instruction the user never receives.
  assert.deepEqual(dead.sort(), [], `these classes render nothing on the real host: ${dead.join(', ')}`)
})

test('the real DialogContent body is a single, self-scrolling grid the compare view must fit', async t => {
  if (!HOST_REPO) {
    return t.skip(NO_HOST)
  }

  const dialog = hostRead(join('apps', 'desktop', 'src', 'components', 'ui', 'dialog.tsx'))

  // The SHELL: bounded by the viewport, a column flex, and deliberately free of
  // `overflow` so popovers opened inside it are not clipped.
  assert.match(dialog, /fixed[^']*max-h-\[85vh\][^']*flex-col/, 'the shell is no longer a viewport-bounded flex column')

  // The BODY: the one and only scroll region. `min-h-0` is what lets it shrink
  // inside the shell's max-height instead of pushing the shell past the viewport.
  assert.match(
    dialog,
    /grid min-h-0 grid-cols-\[minmax\(0,1fr\)\][^']*overflow-y-auto/,
    'the dialog body is no longer the single scrolling grid region'
  )
})

test('the compare dialog asks for a width the real cascade can actually apply', async t => {
  if (!HOST_REPO) {
    return t.skip(NO_HOST)
  }

  const { mod } = await boot()
  const dialog = nodeTree(jsx(mod.__testing.CompareDialog, {})).find(node => node.name === 'DialogContent')

  assert.ok(dialog, 'the compare dialog has no DialogContent')

  const classes = classesOf(dialog)

  // The host shell ships `w-full max-w-lg`. A plain `max-w-*` this plugin adds
  // loses that fight for every scale whose rule the bundle orders BEFORE
  // `max-w-lg` — `max-w-4xl` has no rule at all, so the dialog stayed 32rem
  // wide and the two full-text columns were crushed. A MIN-width wins over
  // max-width regardless of order, which is what makes it the right lever.
  const minWidth = classes.find(name => name.startsWith('min-w-'))

  assert.ok(minWidth, `the dialog still relies on a max-width override: ${classes.join(' ')}`)
  assert.equal(classes.some(name => name.startsWith('max-w-')), false, 'a max-width override is still being set')

  const flat = flattenStylesheet(hostStylesheet())

  assert.ok(hasCompiledRule(flat, minWidth), `the dialog's own width class ${minWidth} has no compiled rule`)
  // 48rem at minimum, viewport-relative below that: readable on a small screen,
  // wide enough for two columns on a large one.
  assert.equal(minWidth, 'min-w-[min(48rem,90vw)]')
})

test('the full-text view gives each draft a readable block instead of a collapsing bar', async () => {
  const { mod, t } = await boot()
  const nodes = renderCompareFullView(t, mod)
  const panels = nodes.filter(node => node.props['data-fpe'] === 'original' || node.props['data-fpe'] === 'enhanced')

  assert.equal(panels.length, 2, 'the full-text view does not show both drafts')

  for (const panel of panels) {
    const box = nodeTree(panel.props.children)
      .flatMap(node => classesOf(node))
      .join(' ')

    // `flex-1` is `flex: 1 1 0%`. Inside an auto-height ancestor that basis
    // resolves to zero and the box collapses to its own padding — the ~39px
    // strip that clipped the text — with `overflow-auto` hiding the rest.
    assert.equal(/flex-1/.test(box), false, `the draft box is still a flex-1 bar: ${box}`)
    assert.equal(/min-h-0/.test(box), false, `the draft box can still collapse to zero height: ${box}`)
    assert.equal(/overflow-auto/.test(box), false, `the draft box still scrolls inside the page scroll: ${box}`)
    // A real floor, and one the stylesheet actually compiled.
    assert.match(box, /min-h-24/, `the draft box has no readable floor: ${box}`)
    assert.match(box, /whitespace-pre-wrap/, 'the draft text would lose its line breaks')
  }

  // The two columns share one row, so neither is squeezed by the other.
  const row = nodes.find(node => node.props['data-fpe'] === 'original')?.props?.children
  const rowNodes = nodeTree(row)

  assert.ok(rowNodes.length >= 2, 'the full-text view is not a two-column row')
})

test('the score section is an independent three-column table with aligned cells', async () => {
  const { mod, t } = await boot()

  t.setUiState({ compareOpen: true, compare: compareResult(t, { scores: SCORES_WITH_RATIONALES }) })

  const nodes = nodeTree(jsx(mod.__testing.CompareDialog, {}))
  const table = nodes.find(node => node.name === 'table')

  assert.ok(table, 'the scores are not rendered as a table')
  // Independent of the draft panels: its own block, after them.
  assert.ok(nodes.some(node => node.props['data-fpe'] === 'scores'), 'the score block lost its seam')

  const rows = nodeTree(table.props.children).filter(node => node.name === 'tr')

  assert.equal(rows.length, 1 + t.DIMENSIONS.length + 1, 'the table is not one header + five dimensions + overall')

  for (const row of rows) {
    const cells = nodeTree(row.props.children).filter(node => node.name === 'td')

    // The alignment bug: per-row `justify-between` put the split wherever the
    // text happened to land, so the label column and the score column never
    // lined up. A real table has one column count for every row.
    assert.equal(cells.length, 3, `a score row does not have three columns: ${cells.length}`)

    const classes = cells.map(cell => classesOf(cell).join(' '))

    assert.match(classes[0], /text-left/, 'the label column is not left-aligned')
    assert.match(classes[1], /text-right/, 'the original score is not right-aligned')
    assert.match(classes[2], /text-right/, 'the enhanced score is not right-aligned')
    assert.match(classes[1], /tabular-nums/, 'the original score is not in tabular figures')
    assert.match(classes[2], /tabular-nums/, 'the enhanced score is not in tabular figures')
  }
})

test('zero protected items is reported as nothing to protect, not as everything preserved', async () => {
  const { mod, t, I18N } = await boot()

  // The bug: "0 items preserved" reads as a check that passed. It is a check
  // that had nothing to do, and the two facts must not share a sentence.
  assert.equal(typeof I18N.zh.compare.protectionNone, 'string', 'zh has no zero-item copy')
  assert.equal(typeof I18N.en.compare.protectionNone, 'string', 'en has no zero-item copy')

  assert.ok(I18N.zh.compare.protectionNone.includes('未检测到需逐字保护内容'), 'the zh copy does not say what was detected')
  assert.notEqual(I18N.zh.compare.protectionNone, I18N.zh.compare.protectionOk(0))
  assert.notEqual(I18N.en.compare.protectionNone, I18N.en.compare.protectionOk(0))

  // …and the panel has to USE it, with a seam a reader can find.
  t.setUiState({
    compareOpen: true,
    compare: compareResult(t, { protection: t.protectionSummary({ total: 0, missing: [], altered_whitespace: [] }) })
  })

  const text = compareText(mod)

  assert.ok(compareText(mod).includes(tr('compare.protectionNone')), 'the zero-item case still claims preservation')
  assert.equal(text.includes(tr('compare.protectionOk', 0)), false, 'the zero-item case still renders the "all preserved" line')
})

// ── 2. the dedicated model's thinking level ─────────────────────────────────
//
// This whole section is about ONE contract: the host's model menu offers a
// thinking-level submenu, and this build CANNOT honour a level picked in it.
//   * no official plugin LLM door carries a reasoning parameter
//     (`agent/plugin_llm.PluginLlm`, `tui_gateway/contracts/sessions.py`
//     `LlmOneshotParams`), so the level could never be SENT;
//   * `ModelCatalogMenu` exposes no prop that hides or disables that submenu —
//     the menu mounts it itself and gates its rows on catalog data — so the
//     control cannot be REMOVED from a plugin surface either.
// What is left is the thing these tests pin down: a pick is REFUSED (nothing
// stored, nothing persisted) and the user is told why. Accepting the pick,
// storing it, and drawing it back as the selected level is what shipped once
// and is the bug this section exists to keep out.

test('the plugin declares the host\'s own reasoning levels, not an invented scale', async tc => {
  if (!HOST_REPO) {
    return tc.skip(NO_HOST)
  }

  const shared = hostRead(join('apps', 'shared', 'src', 'reasoning-effort.ts'))
  const list = shared.match(/REASONING_EFFORTS\s*=\s*\[([^\]]*)\]/)

  assert.ok(list, 'the host no longer declares REASONING_EFFORTS where this test looks')

  const official = [...list[1].matchAll(/'([^']+)'/g)].map(match => match[1])
  const dflt = shared.match(/DEFAULT_REASONING_EFFORT[^=]*=\s*'([^']+)'/)

  const { t } = await boot()

  assert.deepEqual(t.REASONING_EFFORTS, official, 'the plugin ships a different scale than the host')
  assert.equal(t.DEFAULT_REASONING_EFFORT, dflt[1])
  assert.ok(t.REASONING_EFFORTS.includes(t.DEFAULT_REASONING_EFFORT))
})

test('the official plugin LLM doors carry no reasoning parameter — and the plugin says so', async tc => {
  if (!HOST_REPO) {
    return tc.skip(NO_HOST)
  }

  const llm = hostRead(join('agent', 'plugin_llm.py'))
  const contracts = hostRead(join('tui_gateway', 'contracts', 'sessions.py'))

  // `ctx.llm`: the ONLY door that can carry a model. Its public completions
  // take temperature/max_tokens/timeout — and nothing that names reasoning.
  const completions = [...llm.matchAll(/def (a?complete(?:_structured)?)\(([\s\S]*?)\)\s*->/g)]

  assert.ok(completions.length >= 4, 'the plugin LLM completions were not found')

  for (const [, name, signature] of completions) {
    assert.equal(
      /reasoning|effort/i.test(signature),
      false,
      `ctx.llm.${name} now takes a reasoning parameter — this boundary can be revisited`
    )
  }

  // The gateway's stateless one-shot, i.e. the follow-session door.
  const params = contracts.match(/class LlmOneshotParams\([\s\S]*?\):\s*\n([\s\S]*?)\n\nclass/)

  assert.ok(params, 'LlmOneshotParams was not found')
  assert.equal(/reasoning|effort/i.test(params[1]), false, 'llm.oneshot now carries an effort field')

  // The host DOES support reasoning one layer down; the plugin door is what is
  // missing it. So the plugin must report a boundary, not a capability — and
  // both halves of that boundary need a user-facing sentence.
  const { t } = await boot()

  assert.equal(t.EFFORT_TRANSPORT.supported, false, 'the plugin claims a transport it does not have')
  assert.match(t.EFFORT_TRANSPORT.seam, /plugin_llm|ctx\.llm/, 'the boundary does not name the seam it was checked on')
  assert.ok(t.EFFORT_TRANSPORT.reasonKey, 'the boundary has no user-facing reason')
  assert.ok(t.EFFORT_TRANSPORT.pickRejectedKey, 'the boundary has no user-facing refusal')
})

test('the catalog menu exposes no prop that could hide or disable its thinking submenu', async tc => {
  if (!HOST_REPO) {
    return tc.skip(NO_HOST)
  }

  const menu = hostRead(join('apps', 'desktop', 'src', 'app', 'shell', 'model-catalog-menu.tsx'))
  const body = menu.match(/interface ModelCatalogMenuProps \{([\s\S]*?)\n\}/)

  assert.ok(body, 'ModelCatalogMenuProps was not found where this test looks')

  const props = [...body[1].matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\??\s*:/gm)].map(match => match[1]).sort()
  const { t } = await boot()
  const recorded = [...t.EFFORT_TRANSPORT.catalogMenuProps].sort()

  // The plugin's recorded audit must BE the host's prop surface: a prop added
  // or removed upstream is the moment to re-check whether the pick can finally
  // be hidden — or honoured.
  assert.deepEqual(props, recorded, 'the catalog menu changed its props — re-check EFFORT_TRANSPORT')

  // And none of them is about the thinking level at all: the submenu is the
  // menu's OWN, mounted unconditionally, and no caller prop reaches it.
  assert.equal(
    props.some(name => /effort|reason|think|hide|disable|submenu/i.test(name)),
    false,
    'a prop now exists that could hide the thinking submenu — this boundary can be revisited'
  )
  assert.equal(t.EFFORT_TRANSPORT.catalogMenuHidesEffort, false, 'the plugin claims it can hide the submenu')

  // The gate that decides whether those rows render is CATALOG DATA handed to
  // the submenu (`reasoning={caps?.reasoning ?? true}`), not a prop of ours.
  assert.match(menu, /<ModelEditSubmenu/, 'the menu no longer mounts its own options submenu')
  assert.match(menu, /reasoning=\{caps\?\.reasoning/, 'the reasoning gate is no longer catalog data')

  const submenu = hostRead(join('apps', 'desktop', 'src', 'app', 'shell', 'model-edit-submenu.tsx'))

  assert.match(submenu, /reasoning: boolean/, 'the submenu no longer takes the reasoning gate as a prop')
})

test('a thinking-level pick is refused — not recorded, not persisted, and said out loud', async () => {
  __setActiveLocale('zh')

  try {
    const { I18N, ctx, mod, t } = await boot()
    const nodes = renderModelPanel(t, mod)
    const catalog = nodes.find(node => node.name === 'ModelCatalogMenu')

    assert.ok(catalog, 'the catalog did not render')
    assert.equal(t.currentSettings().pinnedEffort, '', 'a fresh install starts on no level')

    host.calls.notify.length = 0

    // Exactly what the shipped reasoning submenu hands its host on a pick.
    catalog.props.controller.setOptions(
      { effort: 'high' },
      { isActive: true, model: 'claude-x', provider: 'anthropic' }
    )

    // Nothing recorded...
    assert.equal(t.currentSettings().pinnedEffort, '', 'the pick was stored although it cannot be applied')

    // ...and nothing written to the settings file. (The previous build stored
    // the level here, which is what made an inert value read as a setting.)
    const persisted = ctx.storage.get('settings.v1', null)

    assert.equal(
      persisted && persisted.pinnedEffort ? persisted.pinnedEffort : '',
      '',
      'a level reached the settings file'
    )

    // The menu ALSO reports an effort on every model SELECTION
    // (`applyPreset({effort: defaultEffort})`). That is a preset, not a user
    // pick, and must not become a stored level either — while the selection
    // itself still lands.
    catalog.props.controller.applyPreset(
      { effort: 'high', fast: false },
      { model: 'claude-x', provider: 'anthropic' }
    )

    assert.equal(t.currentSettings().pinnedEffort, '', 'a selection preset stored a level')
    assert.equal(t.currentSettings().pinnedModel.model, 'claude-x', 'the selection itself was dropped')

    // ...and the user is TOLD, in the app's language, not left with a radio
    // that moved and a setting that did nothing.
    const said = host.calls.notify.map(entry => entry.message)

    assert.ok(
      said.includes(I18N.zh.settings.effortPickRejected),
      `the refused pick was not explained: ${said.join(' | ') || '(nothing was said)'}`
    )
    assert.equal(CJK.test(I18N.zh.settings.effortPickRejected), true, 'the refusal notice is not localized')
    assert.equal(host.calls.notify.at(-1).kind, 'warn', 'the refusal was announced as a normal message')

    // A patch that carries NO effort is not a thinking-level pick: the fast
    // axis this file never implemented stays as quiet as it was (unchanged by
    // this round, and deliberately not dressed up as a refusal).
    host.calls.notify.length = 0
    catalog.props.controller.setOptions({ fast: true }, { isActive: true, model: 'claude-x', provider: 'anthropic' })
    assert.equal(host.calls.notify.length, 0, 'a fast-only edit was answered as if it were a thinking level')
  } finally {
    __setActiveLocale('en')
  }
})

test('a level stored by an earlier build is kept on file, but never drawn as the selection', async () => {
  const { mod, t } = await boot()

  // Migration: a value an earlier build stored is still readable after a
  // reload, and one this build cannot express is dropped rather than carried
  // forward as if it meant something.
  assert.equal(t.normalizeSettings({ pinnedEffort: 'xhigh' }).pinnedEffort, 'xhigh')
  assert.equal(t.normalizeSettings({ pinnedEffort: 'NONE' }).pinnedEffort, 'none')

  for (const bad of ['   ', 'HIGHEST', 'gpt-5', 7, null, {}, ['high']]) {
    assert.equal(t.normalizeSettings({ pinnedEffort: bad }).pinnedEffort, '', `accepted ${JSON.stringify(bad)}`)
  }

  // Re-selecting a model keeps it; clearing the model clears it — a level with
  // no model behind it is a value the user never chose.
  assert.equal(t.applyModelSelection({ pinnedEffort: 'low' }, 'claude-x', 'anthropic').pinnedEffort, 'low')
  assert.equal(t.applyModelSelection({ pinnedEffort: 'low' }, null, '').pinnedEffort, '')

  // The stored level is NOT handed back to the catalog: `current.effort` and
  // every row preset report no level, so no radio and no badge can draw an
  // inert value as the selection that took effect.
  const legacy = Object.assign({}, PINNED_SETTINGS, { pinnedEffort: 'high' })
  const nodes = renderModelPanelNodes(t, mod, { allow_model_override: true }, legacy)
  const catalog = nodes.find(node => node.name === 'ModelCatalogMenu')

  assert.ok(catalog, 'the catalog did not render')
  assert.equal(catalog.props.controller.current.effort, '', 'the inert level is reported as the active selection')
  assert.deepEqual(catalog.props.controller.presetFor('anthropic', 'claude-x'), {}, 'a row preset reports the level')
  assert.deepEqual(catalog.props.controller.presetFor('openai', 'gpt-5'), {})
})

test('the thinking level is surfaced as blocked on this build, never as applied', async () => {
  const { mod, t } = await boot()
  const legacy = Object.assign({}, PINNED_SETTINGS, { pinnedEffort: 'high' })
  const nodes = renderModelPanelNodes(t, mod, { allow_model_override: true }, legacy)
  const block = nodes.find(node => node.props['data-fpe'] === 'model-effort')

  assert.ok(block, 'the model panel says nothing about the thinking level')
  assert.equal(block.props['data-supported'], 'false', 'the level is presented as supported')

  // The boundary itself, in the app's language.
  const notice = nodes.find(node => node.props['data-fpe'] === 'model-effort-blocked')

  assert.ok(notice, 'the blocked state is not spelled out')
  assert.equal(notice.props.children, tr('settings.effortUnsupported'), 'the notice is not the shipped boundary text')

  // A value left over from an earlier build is NAMED — never silently deleted —
  // and only ever inside the sentence that says it is not applied.
  const stored = nodes.find(node => node.props['data-fpe'] === 'model-effort-stored')

  assert.ok(stored, 'a stored level vanished without a word')
  assert.equal(stored.props['data-effort'], 'high')
  assert.equal(stored.props.children, tr('settings.effortStored', 'high'))
  assert.match(String(stored.props.children), /high/)
  assert.notEqual(stored.props.children, 'high', 'the stored level is drawn as a current value')

  // With nothing on file there is nothing to label.
  const fresh = renderModelPanelNodes(t, mod)

  assert.equal(
    fresh.find(node => node.props['data-fpe'] === 'model-effort-stored'),
    undefined,
    'a level that was never picked is shown'
  )

  const text = compareText(mod) // smoke: the compare surface still renders

  assert.ok(typeof text === 'string')

  // The run path must not put an unsupported field on the wire: a field the
  // backend ignores would be the same lie the refused control avoids.
  const request = t.buildRequest({
    mode: 'precise',
    draft: 'hello',
    settings: { modelMode: 'pinned', pinnedModel: { model: 'claude-x', provider: 'anthropic' }, pinnedEffort: 'high' },
    templates: t.currentTemplates(),
    trust: { allow_model_override: true }
  })

  assert.equal(
    Object.keys(request.body).some(key => /effort|reasoning/i.test(key)),
    false,
    'an effort field was sent on a door that cannot carry one'
  )
})

// ── the harness's own footprint ─────────────────────────────────────────────
//
// The suite loads the module on the order of a hundred times per run (the
// plugin keeps module-level state by design, and that state IS under test).
// Writing a transformed copy PER LOAD left 12k+ files in `tests/.harness/`.
// One copy per PROCESS, busted with an import query, keeps the same module
// isolation and a bounded footprint; whatever this process wrote is removed by
// `cleanupHarnessArtifacts()`, which refuses to touch anything else.

test('the harness keeps ONE transformed copy per process, not one per load', async () => {
  await loadPlugin()
  await loadPlugin()
  await loadPlugin()

  assert.equal(
    HARNESS_FILES.length,
    1,
    `the harness wrote ${HARNESS_FILES.length} copies for this process`
  )
  assert.equal(dirname(HARNESS_FILES[0]), HARNESS_DIR, 'the copy escaped the project harness dir')
  assert.match(basename(HARNESS_FILES[0]), new RegExp(`^plugin\\.harness-${process.pid}\\.mjs$`))
  assert.ok(existsSync(HARNESS_FILES[0]), 'the owned copy is not on disk')
})

test('two loads are still two independent module instances', async () => {
  const first = await loadPlugin('instance-a')
  const second = await loadPlugin('instance-b')

  assert.notEqual(first, second, 'both loads resolved to the same module state')
  assert.equal(typeof first.__testing, 'object')
  assert.equal(typeof second.__testing, 'object')
})

test('cleanup removes this process own copy and leaves every earlier run alone', async () => {
  await loadPlugin('before-cleanup')

  const own = HARNESS_FILES.slice()
  const residue = readdirSync(HARNESS_DIR).filter(name => !own.some(path => basename(path) === name))

  assert.ok(own.length > 0, 'nothing to clean up — the test is vacuous')
  assert.ok(existsSync(own[0]))

  const removed = cleanupHarnessArtifacts()

  assert.equal(removed, own.length)

  for (const path of own) {
    assert.equal(existsSync(path), false, `${basename(path)} survived cleanup`)
  }

  // Anything else in the directory belongs to an earlier run: not this process's
  // to delete, and deleting it is what the user never authorised.
  for (const name of residue) {
    assert.ok(existsSync(join(HARNESS_DIR, name)), `cleanup deleted someone else's file: ${name}`)
  }

  assert.deepEqual(HARNESS_FILES, [])

  // ...and the harness still works afterwards.
  const reloaded = await loadPlugin('after-cleanup')

  assert.equal(typeof reloaded.__testing, 'object')
  assert.equal(HARNESS_FILES.length, 1)
})



// ── template archives: export, import, and the one rollback ────────────────
//
// The renderer cannot write a file. The file routes are: pick a path with the
// host's native dialog, hand that path to the backend, and report what the
// backend said. The clipboard route is separate and separately labelled. None of
// these tests ever reach a real filesystem or a real clipboard: the OS door and
// the plugin's own `rest` are both stubbed, so a passing test proves the contract
// between them, not that some machine happened to have a disk.

const PRECISE_PAIR = { system: '导出的精确系统', user: '导出的精确用户\n\n{{draft}}' }
const CREATIVE_PAIR = { system: '导出的创意系统', user: '导出的创意用户\n\n{{draft}}' }

const ARCHIVE_TEXT = '{\n  "schema": "fragile-prompt-enhance.templates"\n}\n'

/** A backend that answers both template doors; `calls` records every request. */
function templateBackend(outcomes = {}) {
  const calls = []

  const rest = async (path, options) => {
    calls.push({ path, options })

    if (outcomes.throwOn) {
      throw outcomes.throwOn
    }

    if (path === '/templates/export') {
      return Object.assign(
        {
          ok: true,
          json: ARCHIVE_TEXT,
          filename: 'fragile-prompt-enhance-templates.json',
          bytes: ARCHIVE_TEXT.length,
          sha256: 'sha-export',
          written: false,
          path: null
        },
        outcomes.export || {}
      )
    }

    if (path === '/templates/import/inspect') {
      return inspected(outcomes.inspect)
    }

    throw new Error('unexpected door ' + path)
  }

  return { calls, rest }
}

/** What `/templates/import/inspect` answers for a usable archive. */
function inspected(overrides = {}) {
  return Object.assign(
    {
      ok: true,
      source: 'file',
      path: 'C:\\picked\\templates.json',
      bytes: 42,
      sha256: 'sha-import',
      scope: 'both',
      format_version: 1,
      template_version: 3,
      templates: { precise: { ...PRECISE_PAIR }, creative: { ...CREATIVE_PAIR } },
      errors: [],
      warnings: [],
      summary: {}
    },
    overrides
  )
}

/**
 * Only the template doors. The plugin also reads `/status` on register, so an
 * unfiltered call list would count the boot read as a transfer.
 */
function doorCalls(backend) {
  return backend.calls.filter(call => String(call.path).startsWith('/templates/'))
}

/**
 * The message KEY the last toast was raised with.
 *
 * The plugin's own `t()` resolves through the host's i18n; the harness stub
 * returns the key (plus its arguments), so the key is what a test can assert
 * on — and which message was chosen is the decision under test anyway. That
 * every key exists in BOTH bundles is covered by the bundle test above.
 */
function notifyKey() {
  const last = lastNotify()

  return last ? String(last.message).split(':')[0] : null
}

/** The last in-app toast the plugin raised. */
function lastNotify() {
  const calls = host.calls.notify

  return calls.length ? calls[calls.length - 1] : null
}

test('the export request carries the live templates, the scope and no draft', async () => {
  const { t } = await boot()
  const body = t.exportRequestBody(t.currentTemplates(), { mode: 'both', scope: 'both', version: 3 })

  assert.deepEqual(body.templates, t.currentTemplates())
  assert.equal(body.mode, 'both')
  assert.equal(body.scope, 'both')
  assert.equal(body.template_version, 3)
  // A request body, not a draft carrier: the plugin's own copy of the user's
  // draft is never part of an archive.
  assert.equal('draft' in body, false)
  assert.equal('path' in body, false)
  assert.deepEqual(Object.keys(body).sort(), ['mode', 'scope', 'template_version', 'templates'])
})

test('the import request names exactly one input door', async () => {
  const { t } = await boot()

  assert.deepEqual(t.importRequestBody({ path: 'C:\\x.json' }), { path: 'C:\\x.json' })
  assert.deepEqual(t.importRequestBody({ json: '{}' }), { json: '{}' })
  // Neither, or both: nothing is sent rather than a guess being sent.
  assert.equal(t.importRequestBody({}), null)
  assert.equal(t.importRequestBody({ path: '', json: '' }), null)
})

test('exporting to a file hands the picked path to the backend', async () => {
  const backend = templateBackend()
  const clipboard = []
  const { t } = await boot({
    rest: backend.rest,
    ctx: {
      os: {
        pickSavePath: async options => {
          assert.equal(options.defaultPath, 'fragile-prompt-enhance-templates.json')
          assert.deepEqual(options.filters, [{ extensions: ['json'], name: 'Fragile Prompt Enhance templates' }])

          return 'C:/tmp/picked.json'
        },
        writeClipboard: async text => {
          clipboard.push(text)

          return true
        }
      }
    }
  })

  const outcome = await t.exportTemplatesToFile()

  assert.equal(outcome.ok, true)
  assert.equal(outcome.path, 'C:/tmp/picked.json')
  assert.equal(doorCalls(backend).length, 1)
  assert.equal(doorCalls(backend)[0].path, '/templates/export')
  assert.equal(doorCalls(backend)[0].options.method, 'POST')
  assert.equal(doorCalls(backend)[0].options.body.path, 'C:/tmp/picked.json')
  // The renderer never claims to have written the bytes...
  assert.deepEqual(clipboard, [])
  // ...and says where they landed, from the backend's own answer.
  assert.equal(lastNotify().kind, 'info')
  assert.match(lastNotify().message, /C:\/tmp\/picked\.json/)
})

test('a cancelled save says nothing was written, and does not quietly copy instead', async () => {
  const backend = templateBackend()
  const clipboard = []
  const { t } = await boot({
    rest: backend.rest,
    ctx: {
      os: {
        pickSavePath: async () => null,
        writeClipboard: async text => {
          clipboard.push(text)

          return true
        }
      }
    }
  })

  const outcome = await t.exportTemplatesToFile()

  assert.equal(outcome.ok, false)
  assert.equal(outcome.reason, 'no-path')
  assert.deepEqual(doorCalls(backend), [], 'the clipboard route was taken without being asked for')
  assert.deepEqual(clipboard, [])
  assert.equal(lastNotify().kind, 'info')
  assert.equal(notifyKey(), 'settings.transferExportNoPath')
})

test('the same refusal covers a surface where the native dialog does not exist', async () => {
  const backend = templateBackend()
  const { t } = await boot({ rest: backend.rest, ctx: { os: {} } })

  const outcome = await t.exportTemplatesToFile()

  // The official door resolves null BOTH for a cancel and for "no Electron
  // shell", so one honest message covers both instead of guessing which it was.
  assert.equal(outcome.ok, false)
  assert.equal(outcome.reason, 'no-path')
  assert.deepEqual(doorCalls(backend), [])
  assert.equal(notifyKey(), 'settings.transferExportNoPath')
})

test('the clipboard export is its own labelled action, and copies what the backend packed', async () => {
  const backend = templateBackend()
  const clipboard = []
  const { t } = await boot({
    rest: backend.rest,
    ctx: {
      os: {
        writeClipboard: async text => {
          clipboard.push(text)

          return true
        }
      }
    }
  })

  const outcome = await t.exportTemplatesToClipboard()

  assert.equal(outcome.ok, true)
  assert.equal(doorCalls(backend).length, 1)
  assert.equal(doorCalls(backend)[0].options.body.path, undefined, 'the clipboard route must not name a path')
  assert.deepEqual(clipboard, [ARCHIVE_TEXT])
  assert.equal(lastNotify().kind, 'info')
  assert.equal(notifyKey(), 'settings.transferExportCopied')
})

test('a clipboard that refuses is reported as a failure, not as a success', async () => {
  const backend = templateBackend()
  const { t } = await boot({ rest: backend.rest, ctx: { os: { writeClipboard: async () => false } } })

  const outcome = await t.exportTemplatesToClipboard()

  assert.equal(outcome.ok, false)
  assert.equal(outcome.reason, 'clipboard')
  assert.equal(lastNotify().kind, 'error')
  assert.equal(notifyKey(), 'settings.transferExportClipboardFailed')
})

test('a backend refusal on export reaches the user as an error', async () => {
  const backend = templateBackend()
  const clipboard = []
  const thrown = new Error('Error invoking remote method: 400: templates_invalid')

  // The throw happens on the request, so the path is the one a real failure takes.
  const { t } = await boot({
    rest: async () => {
      throw thrown
    },
    ctx: {
      os: {
        pickSavePath: async () => 'C:/tmp/picked.json',
        writeClipboard: async text => {
          clipboard.push(text)

          return true
        }
      }
    }
  })

  const outcome = await t.exportTemplatesToFile()

  assert.equal(outcome.ok, false)
  assert.equal(outcome.reason, 'failed')
  assert.equal(lastNotify().kind, 'error')
  assert.match(lastNotify().message, /templates_invalid/)
  // A failed write never falls back to the clipboard behind the user's back.
  assert.deepEqual(clipboard, [])
  assert.equal(doorCalls(backend).length, 0)
})

// ── import: inspect, preview, confirm — and apply nothing before that ───────

test('inspecting a picked file opens a preview and leaves the templates untouched', async () => {
  const backend = templateBackend()
  const { t } = await boot({
    rest: backend.rest,
    ctx: { os: { pickOpenPath: async () => 'C:\\picked\\templates.json' } }
  })
  const live = JSON.parse(JSON.stringify(t.currentTemplates()))

  const outcome = await t.importTemplatesFromFile()

  assert.equal(outcome.ok, true)
  assert.equal(doorCalls(backend)[0].path, '/templates/import/inspect')
  assert.deepEqual(doorCalls(backend)[0].options.body, { path: 'C:\\picked\\templates.json' })

  const preview = t.ui.get().importPreview

  assert.ok(preview, 'no preview was staged')
  assert.equal(t.ui.get().importOpen, true)
  assert.equal(preview.scope, 'both')
  assert.deepEqual(preview.modes, ['precise', 'creative'])
  // Nothing was applied by inspecting.
  assert.deepEqual(t.currentTemplates(), live)
})

test('the preview names which fields change, in a stable order, without being an editor', async () => {
  const { t } = await boot()
  const current = t.currentTemplates()
  const preview = t.importPreview(current, inspected({ templates: { precise: { ...PRECISE_PAIR } }, scope: 'both' }))

  const changed = preview.changes.filter(entry => entry.changed)

  assert.deepEqual(changed.map(entry => entry.mode + '.' + entry.field), ['precise.system', 'precise.user'])
  assert.equal(changed[0].incomingChars, PRECISE_PAIR.system.length)
  assert.equal(changed[0].currentChars, current.precise.system.length)
  // Only the modes the archive carries are previewed.
  assert.deepEqual(preview.modes, ['precise'])
  // ...and it applies exactly what the previewed archive carries.
  assert.deepEqual(preview.applies, { precise: { ...PRECISE_PAIR } })
})

test('an archive identical to the live templates is previewed as no change', async () => {
  const { t } = await boot()
  const preview = t.importPreview(
    t.currentTemplates(),
    inspected({ templates: JSON.parse(JSON.stringify(t.currentTemplates())) })
  )

  assert.equal(preview.changes.every(entry => !entry.changed), true)
  assert.equal(preview.identical, true)
  // The archive still names what it would apply — "no change" is not "nothing".
  assert.deepEqual(preview.modes, ['precise', 'creative'])
})

test('a system-only archive previews and applies only the system fields', async () => {
  const { t } = await boot()
  const live = JSON.parse(JSON.stringify(t.currentTemplates()))
  const preview = t.importPreview(
    live,
    inspected({
      scope: 'system',
      templates: { precise: { system: PRECISE_PAIR.system }, creative: { system: CREATIVE_PAIR.system } }
    })
  )

  assert.deepEqual(preview.changes.map(entry => entry.mode + '.' + entry.field), ['precise.system', 'creative.system'])

  t.setUiState({ importPreview: preview })

  const applied = t.applyImportPreview()

  assert.equal(applied.ok, true)
  assert.equal(t.currentTemplates().precise.system, PRECISE_PAIR.system)
  // The user's own user-half is NOT overwritten by a system-only archive.
  assert.equal(t.currentTemplates().precise.user, live.precise.user)
  assert.equal(t.currentTemplates().creative.user, live.creative.user)
})

test('confirming an import writes the pair, records where it came from, and keeps the previous one', async () => {
  const { t } = await boot()
  const before = JSON.parse(JSON.stringify(t.currentTemplates()))
  // An archive whose BYTES are a shipped default: the fixture's own pairs are
  // custom text, so this one carries the shipped default version it claims.
  const shipped = {
    precise: { ...t.DEFAULT_TEMPLATES.precise },
    creative: { ...t.DEFAULT_TEMPLATES.creative }
  }

  t.setUiState({ importPreview: t.importPreview(before, inspected({ templates: shipped })) })

  const applied = t.applyImportPreview()

  assert.equal(applied.ok, true)
  assert.equal(t.currentTemplates().precise.system, t.DEFAULT_TEMPLATES.precise.system)
  assert.equal(t.currentTemplates().creative.system, t.DEFAULT_TEMPLATES.creative.system)

  const meta = t.templateMeta()

  assert.equal(meta.state, 'imported')
  assert.equal(meta.source, 'import-file')
  // The version describes the BYTES the import applied — 3, because they ARE
  // the shipped default 3 (not because the file said so).
  assert.equal(meta.version, 3)
  assert.equal(typeof meta.updatedAt, 'number')

  // One rollback slot, holding what the import replaced.
  assert.equal(t.previousTemplates().precise.system, before.precise.system)
  // ...and the preview is cleared, so confirming twice cannot double-apply.
  assert.equal(t.ui.get().importPreview, null)
  assert.equal(t.ui.get().importOpen, false)
  assert.equal(t.applyImportPreview().ok, false, 'a second confirm applied the archive twice')
  assert.equal(t.templateMeta().source, 'import-file')
})

test('a pasted archive is inspected through the same door and recorded as a paste', async () => {
  const backend = templateBackend({ inspect: { source: 'paste', path: null } })
  const { t } = await boot({ rest: backend.rest, ctx: { os: {} } })

  const outcome = await t.importTemplatesFromPaste(ARCHIVE_TEXT)

  assert.equal(outcome.ok, true)
  assert.deepEqual(doorCalls(backend)[0].options.body, { json: ARCHIVE_TEXT })
  assert.equal(t.ui.get().importPreview.source, 'paste')

  t.applyImportPreview()

  assert.equal(t.templateMeta().source, 'import-paste')
})

test('the paste door says an empty box is empty instead of asking the backend', async () => {
  const backend = templateBackend()
  const { t } = await boot({ rest: backend.rest, ctx: { os: {} } })

  for (const empty of ['', '   ', null, undefined]) {
    const outcome = await t.importTemplatesFromPaste(empty)

    assert.equal(outcome.ok, false)
    assert.equal(outcome.reason, 'empty')
  }

  assert.deepEqual(doorCalls(backend), [])
  assert.equal(notifyKey(), 'settings.transferImportPasteEmpty')
})

test('cancelling the preview applies nothing and forgets it', async () => {
  const { t } = await boot()
  const live = JSON.parse(JSON.stringify(t.currentTemplates()))

  t.setUiState({ importPreview: t.importPreview(live, inspected()), importOpen: true })
  t.cancelImport()

  assert.equal(t.ui.get().importPreview, null)
  assert.equal(t.ui.get().importOpen, false)
  assert.deepEqual(t.currentTemplates(), live)
  // Nothing was written, so there is no "previous version" either.
  assert.equal(t.previousTemplates(), null)
})

test('an archive the backend rejected is shown with its reasons and cannot be applied', async () => {
  const backend = templateBackend({
    inspect: {
      ok: false,
      templates: null,
      errors: [
        { code: 'placeholder', field: 'precise.user', detail: 'precise.user must contain the {{draft}} placeholder' },
        { code: 'schema', field: 'schema', detail: 'expected schema …' }
      ]
    }
  })
  const { t } = await boot({
    rest: backend.rest,
    ctx: { os: { pickOpenPath: async () => 'C:\\picked\\bad.json' } }
  })
  const live = JSON.parse(JSON.stringify(t.currentTemplates()))
  const metaBefore = t.templateMeta()

  const outcome = await t.importTemplatesFromFile()

  assert.equal(outcome.ok, false)
  assert.equal(outcome.reason, 'invalid')
  // The reasons are on the surface, not swallowed.
  assert.deepEqual(t.ui.get().importErrors.map(entry => entry.code), ['placeholder', 'schema'])
  assert.equal(t.applyImportPreview().ok, false)
  assert.deepEqual(t.currentTemplates(), live)
  // A refused archive leaves the template record exactly as it was — no write,
  // and no `imported` state for content that was never applied.
  assert.deepEqual(t.templateMeta(), metaBefore)
  assert.equal(t.templateMeta().state, 'default')
})

test('a cancelled open dialog makes no request at all', async () => {
  const backend = templateBackend()
  const { t } = await boot({ rest: backend.rest, ctx: { os: { pickOpenPath: async () => null } } })

  const outcome = await t.importTemplatesFromFile()

  assert.equal(outcome.ok, false)
  assert.equal(outcome.reason, 'no-path')
  assert.deepEqual(doorCalls(backend), [])
  assert.equal(lastNotify().kind, 'info')
  assert.equal(notifyKey(), 'settings.transferImportNoPath')
})

test('a transport failure on inspect is reported as an error, with no preview staged', async () => {
  const { t } = await boot({
    rest: async () => {
      throw new Error('Error invoking remote method: 400: unreadable_file')
    },
    ctx: { os: { pickOpenPath: async () => 'C:\\picked\\gone.json' } }
  })

  const outcome = await t.importTemplatesFromFile()

  assert.equal(outcome.ok, false)
  assert.equal(outcome.reason, 'failed')
  assert.equal(t.ui.get().importPreview, null)
  assert.equal(lastNotify().kind, 'error')
  assert.match(lastNotify().message, /unreadable_file/)
})

test('an import that would smuggle in a pair a run could not send is refused', async () => {
  const { t } = await boot()
  const live = JSON.parse(JSON.stringify(t.currentTemplates()))

  // The backend's own check is the first line; this is the second, and it is the
  // SAME rule the editor uses — so a backend that let one through still cannot
  // put an unrunnable pair into storage.
  t.setUiState({
    importPreview: {
      source: 'file',
      path: 'C:\\picked\\x.json',
      scope: 'both',
      version: 1,
      warnings: [],
      modes: ['precise', 'creative'],
      applies: { precise: { user: 'no placeholder here' }, creative: { user: 'fine {{draft}}' } },
      changes: [],
      identical: false
    }
  })

  const applied = t.applyImportPreview()

  assert.equal(applied.ok, false)
  assert.equal(applied.reason, 'invalid')
  assert.deepEqual(t.currentTemplates(), live)
  assert.equal(t.ui.get().importErrors[0].code, 'placeholder')
})

// ── the preview shows the CHANGE, not only its size ────────────────────────

test('the preview shows the real content difference, not only a character count', async () => {
  const { mod, t } = await boot()
  const current = t.currentTemplates()

  // A live field whose middle line was swapped: the two character counts alone
  // can be satisfied by any text of the same length, so the assertion is on the
  // LINES — which is the thing the user has to decide about.
  const live = {
    ...current,
    precise: { system: '第一行\n第二行\n第三行', user: '用户\n\n{{draft}}' }
  }
  const incoming = { templates: { precise: { system: '第一行\n第三行\n新的一行' } } }

  const preview = t.importPreview(live, inspected(incoming))
  const entry = preview.changes.find(item => item.mode === 'precise' && item.field === 'system')

  assert.ok(entry, 'the changed field is not previewed')
  assert.equal(entry.diff.ok, true)
  assert.equal(entry.diff.identical, false)

  const added = entry.diff.rows.filter(row => row.kind === 'add').map(row => row.text)
  const removed = entry.diff.rows.filter(row => row.kind === 'remove').map(row => row.text)

  assert.deepEqual(removed, ['第二行'])
  assert.deepEqual(added, ['新的一行'])
  // The lines that stay are not part of the difference: a preview that lists
  // everything is a second editor, not a comparison.
  assert.equal(entry.diff.rows.some(row => row.text === '第三行'), false)
  assert.equal(entry.diff.added, 1)
  assert.equal(entry.diff.removed, 1)

  // ...and the SAME text reaches the surface, with no more than the marker
  // added by the renderer — the archived bytes are never rewritten.
  t.setUiState({ settingsOpen: true, importOpen: true, importPreview: preview, importErrors: [] })

  const nodes = nodeTree(
    jsx(mod.__testing.ImportPreview, { patch: () => {}, translate: usePluginI18n(PLUGIN_ID), ui: t.ui.get() })
  )

  const block = nodes.find(node => node.props['data-fpe'] === 'import-diff-precise-system')
  const addRow = nodes.find(node => node.props['data-fpe'] === 'import-diff-precise-system-add')
  const removeRow = nodes.find(node => node.props['data-fpe'] === 'import-diff-precise-system-remove')

  assert.ok(block, 'the changed field renders no difference block')
  assert.equal(block.props['data-diff'], 'ok')
  assert.ok(addRow, 'the arriving line is not shown')
  assert.ok(removeRow, 'the departing line is not shown')
  assert.equal(String(addRow.props.children).replace(/^\+ /, ''), '新的一行')
  assert.equal(String(removeRow.props.children).replace(/^- /, ''), '第二行')

  // Readable and non-clipping: it keeps its line breaks and does not grow a
  // private scroller inside the dialog's own scroll region.
  const classes = String(addRow.props.className)

  assert.match(classes, /whitespace-pre-wrap/)
  assert.equal(/overflow-(?:auto|scroll|hidden)/.test(classes), false, `the diff grew a scroller: ${classes}`)

  // A field the archive leaves alone gets no difference block at all.
  assert.equal(
    nodes.some(node => node.props['data-fpe'] === 'import-diff-precise-user'),
    false,
    'an unchanged field rendered a difference'
  )
})

test('a difference too long to show says how many lines it is not showing', async () => {
  const { mod, t } = await boot()
  const current = t.currentTemplates()
  const live = { ...current, precise: { system: '旧的一行', user: '用户\n\n{{draft}}' } }

  const many = Array.from({ length: t.PREVIEW_DIFF_ROWS + 4 }, (_, index) => '新增行 ' + index).join('\n')
  const preview = t.importPreview(live, inspected({ templates: { precise: { system: many } } }))
  const entry = preview.changes.find(item => item.field === 'system')

  assert.equal(entry.diff.rows.length, t.PREVIEW_DIFF_ROWS)
  assert.equal(entry.diff.truncated, true)
  assert.equal(entry.diff.changed > entry.diff.shown, true)

  t.setUiState({ settingsOpen: true, importOpen: true, importPreview: preview, importErrors: [] })

  const nodes = nodeTree(
    jsx(mod.__testing.ImportPreview, { patch: () => {}, translate: usePluginI18n(PLUGIN_ID), ui: t.ui.get() })
  )
  const more = nodes.find(node => node.props['data-fpe'] === 'import-diff-precise-system-more')

  assert.ok(more, 'the truncation is silent')
  assert.match(String(more.props.children), new RegExp(String(entry.diff.changed - entry.diff.shown)))

  // Past the diff's own bounds the surface says it cannot compare line by line,
  // instead of showing a character count and calling it a preview.
  const huge = Array.from({ length: t.DIFF_LIMITS.maxLines + 1 }, (_, index) => '行 ' + index).join('\n')
  const bigPreview = t.importPreview(live, inspected({ templates: { precise: { system: huge } } }))
  const bigEntry = bigPreview.changes.find(item => item.field === 'system')

  assert.equal(bigEntry.diff.ok, false)
  assert.equal(bigEntry.diff.reason, 'too-large')
  assert.deepEqual(bigEntry.diff.rows, [])

  t.setUiState({ settingsOpen: true, importOpen: true, importPreview: bigPreview, importErrors: [] })

  const bigNodes = nodeTree(
    jsx(mod.__testing.ImportPreview, { patch: () => {}, translate: usePluginI18n(PLUGIN_ID), ui: t.ui.get() })
  )
  const block = bigNodes.find(node => node.props['data-fpe'] === 'import-diff-precise-system')

  assert.ok(block, 'a field too large to diff renders nothing at all')
  assert.equal(block.props['data-diff'], 'too-large')
  assert.match(String(block.props.children), new RegExp(String(bigEntry.diff.lines)))
})

test('cancelling an export leaves the clipboard exactly as it was', async () => {
  const backend = templateBackend()
  // The clipboard already holds something the USER put there. Cancelling a save
  // must neither empty it nor put an archive over it: "cancel" means the state
  // before the click, not a cleaned-up version of it.
  const original = '用户原本就在剪贴板里的内容'
  const writes = []
  let clipboard = original

  const { t } = await boot({
    rest: backend.rest,
    ctx: {
      os: {
        pickSavePath: async () => null,
        writeClipboard: async text => {
          writes.push(text)
          clipboard = text

          return true
        }
      }
    }
  })

  const outcome = await t.exportTemplatesToFile()

  assert.equal(outcome.ok, false)
  assert.equal(outcome.reason, 'no-path')
  assert.deepEqual(writes, [], 'a cancelled save wrote to the clipboard')
  assert.equal(clipboard, original, 'a cancelled save changed what is on the clipboard')
  assert.deepEqual(doorCalls(backend), [], 'a cancelled save still asked the backend for an archive')
  assert.equal(notifyKey(), 'settings.transferExportNoPath')
})

// ── the rollback control ────────────────────────────────────────────────────

test('the rollback control reports its own availability instead of faking one', async () => {
  const { t } = await boot()

  // Nothing to restore yet: the control says so and the click changes nothing.
  assert.deepEqual(t.previousVersionPanel(), { available: false, savedAt: null, state: null })
  assert.equal(t.ui.get().previousAvailable, false)

  t.saveTemplatesFromDraft({
    precise: { system: '第一版', user: '第一版\n\n{{draft}}' },
    creative: { system: '第一版', user: '第一版\n\n{{draft}}' }
  })

  const panel = t.previousVersionPanel()

  assert.equal(panel.available, true)
  assert.equal(typeof panel.savedAt, 'number')
  assert.equal(t.ui.get().previousAvailable, true)
})

test('restoring from the settings surface reports success and leaves the move reversible', async () => {
  const { t } = await boot()

  t.saveTemplatesFromDraft({
    precise: { system: '第一版', user: '第一版\n\n{{draft}}' },
    creative: { system: '第一版', user: '第一版\n\n{{draft}}' }
  })

  const outcome = t.restorePreviousVersionFromSettings()

  assert.equal(outcome.ok, true)
  assert.equal(lastNotify().kind, 'info')
  assert.equal(notifyKey(), 'settings.templatePreviousRestored')
  // A swap, not a pop: there is still something to go back to.
  assert.equal(t.previousVersionPanel().available, true)
})

test('a rollback with an empty slot is refused on the surface, not silently ignored', async () => {
  const { t } = await boot()

  const outcome = t.restorePreviousVersionFromSettings()

  assert.equal(outcome.ok, false)
  assert.equal(outcome.reason, 'empty')
  assert.equal(lastNotify().kind, 'info')
  assert.equal(notifyKey(), 'settings.transferRollbackNone')
})

// ── the templates tab renders those controls ───────────────────────────────

test('the templates tab offers file and clipboard export as two named actions', async () => {
  const { mod, t } = await boot()

  t.setUiState({ settingsOpen: true, templateDraft: null })

  // `nodeTree`, not `renderTree`: half of these seams are host elements (the
  // wrapper and the notes), and `renderTree` records components only.
  const nodes = nodeTree(
    jsx(mod.__testing.TemplatePanel, { patch: () => {}, translate: usePluginI18n(PLUGIN_ID), ui: t.ui.get() })
  )

  for (const seam of [
    'template-export-file',
    'template-export-clipboard',
    'template-import-file',
    'template-import-paste',
    'template-restore-previous'
  ]) {
    assert.ok(nodes.some(node => node.props['data-fpe'] === seam), `${seam} is missing from the templates tab`)
  }

  // The rollback control is disabled while there is nothing to restore, and says
  // why rather than looking broken.
  const restore = nodes.find(node => node.props['data-fpe'] === 'template-restore-previous' && node.name === 'Button')

  assert.equal(restore.props.disabled, true)
  assert.ok(nodes.some(node => node.props['data-fpe'] === 'template-rollback-note'))
})

test('the two export actions are labelled so neither can be mistaken for the other', async () => {
  const { I18N } = await boot()

  const file = I18N.en.settings.transferExportFile
  const clipboard = I18N.en.settings.transferExportClipboard

  assert.notEqual(file, clipboard)
  assert.match(file, /file/i)
  assert.match(clipboard, /clipboard/i)
  // The Chinese pair must be just as distinct.
  assert.notEqual(I18N.zh.settings.transferExportFile, I18N.zh.settings.transferExportClipboard)
})

test('the templates tab renders the staged archive, and refuses to offer apply for a broken one', async () => {
  const { mod, t } = await boot()
  const preview = t.importPreview(t.currentTemplates(), inspected())

  t.setUiState({ settingsOpen: true, importOpen: true, importPreview: preview, importErrors: [] })

  const nodes = nodeTree(
    jsx(mod.__testing.ImportPreview, { patch: () => {}, translate: usePluginI18n(PLUGIN_ID), ui: t.ui.get() })
  )
  const seams = nodes.map(node => node.props['data-fpe'])

  assert.ok(seams.includes('import-preview'), 'the preview is not rendered')
  assert.ok(seams.includes('import-scope'))
  assert.ok(seams.includes('import-apply'))
  assert.ok(seams.includes('import-cancel'))
  assert.ok(seams.includes('import-field-precise-system'), 'a changed field is not listed')
  // Every field the archive carries, not only the changed ones.
  assert.ok(seams.includes('import-field-creative-user'))

  // With errors, the same panel lists them and refuses to offer the apply.
  t.setUiState({ importErrors: [{ code: 'placeholder', field: 'precise.user', detail: 'x' }] })

  const withErrors = nodeTree(
    jsx(mod.__testing.ImportPreview, { patch: () => {}, translate: usePluginI18n(PLUGIN_ID), ui: t.ui.get() })
  )
  const errorSeams = withErrors.map(node => node.props['data-fpe'])

  assert.ok(errorSeams.includes('import-errors'))
  assert.ok(errorSeams.includes('import-error-placeholder'))
  assert.equal(
    withErrors.some(node => node.props['data-fpe'] === 'import-apply' && node.props.disabled === true),
    true,
    'apply is still offered for an archive that cannot be applied'
  )
})

test('the paste door is offered where there is no filesystem at all', async () => {
  const { mod, t } = await boot()

  t.setUiState({ settingsOpen: true, importOpen: true, importPreview: null, importErrors: [], importPaste: '' })

  const nodes = nodeTree(
    jsx(mod.__testing.ImportPreview, { patch: () => {}, translate: usePluginI18n(PLUGIN_ID), ui: t.ui.get() })
  )
  const seams = nodes.map(node => node.props['data-fpe'])

  assert.ok(seams.includes('import-paste'))
  assert.ok(seams.includes('import-paste-text'))
  assert.ok(seams.includes('import-paste-inspect'))
  // Nothing is applied before the user inspects the text, so the confirm is off.
  assert.equal(
    nodes.some(node => node.props['data-fpe'] === 'import-apply' && node.props.disabled === true),
    true
  )
})

// ── the new surfaces under the constraints that were already fixed ─────────
//
// A layout fix that a new panel can undo is not a fix. These pin the properties
// the earlier round established (truncate rather than wrap, one scroll region,
// wrapping control rows) against the surfaces added here, and pin that reading
// the templates cannot change them.

test('a long draft keeps the result page short and the header from wrapping', async () => {
  const { mod, t } = await boot()
  const long = Array.from({ length: 160 }, (_, index) => '第 ' + index + ' 行：' + 'x'.repeat(60)).join('\n')

  t.setUiState({
    compareOpen: true,
    resultDetails: true,
    compare: compareResult(t, {
      original: long,
      enhanced: long + '\n最后一行',
      provider: 'moonshot',
      model: 'kimi-k2',
      durationMs: 9876
    })
  })

  const nodes = nodeTree(jsx(mod.__testing.CompareDialog, {}))
  const line = nodes.find(node => node.props['data-fpe'] === 'result-summary')

  assert.ok(line, 'the main line is gone')
  // One line, whatever the draft: ellipsised instead of wrapped into a paragraph
  // that pushes the drafts off screen.
  assert.match(classesOf(line).join(' '), /truncate/)

  const detailsBlock = nodes.find(node => node.props['data-fpe'] === 'result-details')

  assert.ok(detailsBlock, 'the details did not render for a long draft')

  const details = classesOf(detailsBlock).join(' ')

  // A column, not a row: the disclosure cannot widen a narrow dialog.
  assert.match(details, /flex-col/)
  // And it carries no scroller of its own — the host body is the ONE scroll
  // region, which is what the earlier round fixed and this panel must not undo.
  assert.equal(/overflow-(?:auto|scroll|hidden)/.test(details), false, `the details grew a private scroller: ${details}`)

  // The view controls the drafts depend on are still both offered, and the
  // highlight is still what the dialog opens on.
  const view = nodes.find(node => node.props['data-fpe'] === 'compare-view-choice')

  assert.ok(view, 'the view control is gone')
  assert.deepEqual(
    view.props.options.map(option => option.label),
    [tr('compare.viewHighlight'), tr('compare.viewFull')]
  )
})

test('the transfer controls wrap instead of squeezing a narrow dialog', async () => {
  const { mod, t } = await boot()

  t.setUiState({ settingsOpen: true, importOpen: true, importPreview: null, importErrors: [], importPaste: '' })

  const nodes = nodeTree(
    jsx(mod.__testing.TemplatePanel, { patch: () => {}, translate: usePluginI18n(PLUGIN_ID), ui: t.ui.get() })
  )
  const row = nodes.find(node => node.props['data-fpe'] === 'template-transfer-actions')

  assert.ok(row, 'the transfer actions are not in an addressable row')
  assert.match(classesOf(row).join(' '), /flex-wrap/)

  // The paste box keeps a readable height instead of collapsing to its padding.
  const box = nodes.find(node => node.props['data-fpe'] === 'import-paste-text' && node.name === 'Textarea')

  assert.ok(box, 'the paste box is missing')
  assert.match(classesOf(box).join(' '), /min-h-(?:\d|\[)/)
})

test('reading the templates changes nothing: export and inspect have no side effects', async () => {
  const backend = templateBackend()
  const { t } = await boot({
    rest: backend.rest,
    ctx: { os: { pickSavePath: async () => 'C:/tmp/picked.json', pickOpenPath: async () => 'C:\\picked\\x.json', writeClipboard: async () => true } }
  })

  // A CUSTOM pair, not a shipped default: the export must carry it, and nothing
  // about exporting may rewrite it.
  t.saveTemplatesFromDraft({
    precise: { system: '我的精确系统', user: '我的精确用户\n\n{{draft}}' },
    creative: { system: '我的创意系统', user: '我的创意用户\n\n{{draft}}' }
  })

  const custom = JSON.parse(JSON.stringify(t.currentTemplates()))
  const slot = JSON.parse(JSON.stringify(t.previousTemplates()))

  await t.exportTemplatesToFile()
  await t.exportTemplatesToClipboard()
  await t.importTemplatesFromFile()

  assert.deepEqual(t.currentTemplates(), custom, 'a read rewrote the templates')
  assert.deepEqual(t.previousTemplates(), slot, 'a read moved the rollback slot')
  // The export carried the custom pair verbatim.
  assert.deepEqual(doorCalls(backend)[0].options.body.templates, custom)
  // And inspecting staged a preview without applying it.
  assert.ok(t.ui.get().importPreview, 'nothing was staged')
  assert.deepEqual(t.currentTemplates(), custom, 'inspecting applied the archive')
})

test('a custom pair is never replaced by anything but an explicit apply', async () => {
  const { t } = await boot()
  const shipped = JSON.parse(JSON.stringify(t.currentTemplates()))

  t.saveTemplatesFromDraft({
    precise: { system: '我的精确系统', user: '我的精确用户\n\n{{draft}}' },
    creative: { system: '我的创意系统', user: '我的创意用户\n\n{{draft}}' }
  })

  const custom = JSON.parse(JSON.stringify(t.currentTemplates()))

  // A staged archive the user then discards leaves the custom pair exactly as it
  // was — including the user half a system-only archive would not have touched.
  t.setUiState({
    importPreview: t.importPreview(
      custom,
      inspected({ scope: 'user', templates: { precise: { user: '别人的用户\n\n{{draft}}' } } })
    ),
    importOpen: true
  })
  t.cancelImport()

  assert.deepEqual(t.currentTemplates(), custom)

  // Rollback is a SWAP, not a reset to the shipped defaults: the slot held the
  // pair the custom save replaced, so that is what comes back — and the custom
  // pair takes the slot, making the move reversible in the other direction.
  const outcome = t.restorePreviousVersionFromSettings()

  assert.equal(outcome.ok, true)
  assert.equal(t.currentTemplates().precise.system, shipped.precise.system)
  assert.equal(t.currentTemplates().creative.user, shipped.creative.user)
  assert.equal(t.previousTemplates().precise.system, custom.precise.system)
  assert.equal(t.templateMeta().state, 'rolled-back')
  // Restoring again returns the custom pair: nothing was lost.
  assert.equal(t.restorePreviousVersionFromSettings().ok, true)
  assert.deepEqual(t.currentTemplates(), custom)
})

// ── the version record: the BYTES are the authority ─────────────────────────
//
// A real export carried `template_version: null` while its content WAS the
// shipped default version 3. The record was simply absent (a first run stores
// no templates) and the export read the record instead of the bytes. These
// tests pin the rule that replaces it: what the live bytes ARE decides the
// version, an unrecognised pair is the explicit `custom` marker, and a claim
// that does not match the bytes never reaches the record.

test('a first run records the version of the templates it is actually serving', async () => {
  const { ctx, t } = await boot()

  // Nothing was ever stored: `templates.v1` is absent while the plugin already
  // serves the shipped default — so the honest record is 3, not silence.
  assert.equal(ctx.storage.has(t.STORAGE_KEYS.templates), false)
  assert.deepEqual(t.currentTemplates(), t.DEFAULT_TEMPLATES)

  const meta = t.templateMeta()

  assert.equal(meta.version, t.TEMPLATE_VERSION)
  assert.equal(meta.state, 'default')
  assert.equal(ctx.storage.has(t.STORAGE_KEYS.templateMeta), true)
  // The record is bookkeeping: the bytes and the rollback slot are untouched.
  assert.equal(ctx.storage.has(t.STORAGE_KEYS.templates), false)
  assert.equal(t.previousTemplates(), null)
})

test('an untouched install exports the version its bytes ARE, not an absent record', async () => {
  const backend = templateBackend()
  const { t } = await boot({
    rest: backend.rest,
    ctx: { os: { pickSavePath: async () => 'C:/tmp/first-run.json' } }
  })

  const outcome = await t.exportTemplatesToFile()
  const body = doorCalls(backend)[0].options.body

  assert.equal(outcome.ok, true)
  assert.equal(body.template_version, t.TEMPLATE_VERSION)
  assert.equal(typeof body.template_version, 'number')
  assert.notEqual(body.template_version, null)
})

test('the bytes decide the version, never the record left by an earlier write', async () => {
  const { t } = await boot()

  t.saveTemplatesFromDraft({
    precise: { system: '改过的精确系统', user: '改过的精确用户\n\n{{draft}}' },
    creative: { system: '改过的创意系统', user: '改过的创意用户\n\n{{draft}}' }
  })

  const meta = t.templateMeta()

  assert.equal(meta.version, null, 'an edited pair is not any shipped default version')
  assert.equal(meta.state, 'edited')
  assert.equal(t.defaultVersionOf(t.currentTemplates()), null)
})

test('custom templates export the explicit custom marker, never a version number', async () => {
  const backend = templateBackend()
  const { t } = await boot({
    rest: backend.rest,
    ctx: { os: { pickSavePath: async () => 'C:/tmp/custom.json' } }
  })

  t.saveTemplatesFromDraft({
    precise: { system: '改过的精确系统', user: '改过的精确用户\n\n{{draft}}' },
    creative: { system: '改过的创意系统', user: '改过的创意用户\n\n{{draft}}' }
  })

  const outcome = await t.exportTemplatesToFile()
  const body = doorCalls(backend)[0].options.body

  assert.equal(outcome.ok, true)
  assert.equal(body.template_version, t.TEMPLATE_VERSION_CUSTOM)
  assert.equal(body.template_version, 'custom')
  // The one thing this field must never do for custom content: claim the
  // shipped default it is not.
  assert.notEqual(body.template_version, t.TEMPLATE_VERSION)
  assert.equal(typeof body.template_version, 'string')
})

test('an archive never carries a null version: a default version or the custom marker', async () => {
  const { t } = await boot()

  // Stated by the caller.
  assert.equal(
    t.exportRequestBody(t.currentTemplates(), { version: t.TEMPLATE_VERSION }).template_version,
    t.TEMPLATE_VERSION
  )
  // Left out entirely: derived from the bytes that are being packed.
  assert.equal(t.exportRequestBody(t.currentTemplates(), {}).template_version, t.TEMPLATE_VERSION)
  // An unusable claim is not echoed as null.
  for (const version of [null, 'three', 0, 2.5, true]) {
    assert.equal(
      t.exportRequestBody(t.currentTemplates(), { version }).template_version,
      t.TEMPLATE_VERSION_CUSTOM,
      String(version)
    )
  }
})

test('a version an archive claims is not stamped onto bytes that are not that version', async () => {
  const { t } = await boot()
  const claiming = inspected({ template_version: t.TEMPLATE_VERSION })

  t.setUiState({ importPreview: t.importPreview(t.currentTemplates(), claiming) })

  const applied = t.applyImportPreview()

  assert.equal(applied.ok, true)
  // The archive's bytes really were applied...
  assert.equal(t.currentTemplates().precise.system, PRECISE_PAIR.system)
  assert.equal(t.currentTemplates().creative.user, CREATIVE_PAIR.user)
  // ...so the record must describe them, not copy the file's claim.
  assert.equal(t.templateMeta().state, 'imported')
  assert.equal(t.templateMeta().source, 'import-file')
  assert.equal(t.templateMeta().version, null)
})

test('an archive whose bytes ARE a shipped default records that version even when the file states none', async () => {
  const { t } = await boot()

  // The older, ambiguous form a real export of this project produced: version 1
  // layout, `template_version: null`, and bytes that are exactly default 3.
  const unstated = inspected({
    format_version: 1,
    template_version: null,
    templates: {
      precise: { ...t.DEFAULT_TEMPLATES.precise },
      creative: { ...t.DEFAULT_TEMPLATES.creative }
    }
  })

  t.setUiState({ importPreview: t.importPreview(t.currentTemplates(), unstated) })

  assert.equal(t.applyImportPreview().ok, true)
  assert.equal(t.templateMeta().version, t.TEMPLATE_VERSION)
})

test('the exported version survives a round trip instead of decaying to null', async () => {
  const backend = templateBackend()
  const { t } = await boot({
    rest: backend.rest,
    ctx: { os: { pickSavePath: async () => 'C:/tmp/round-trip.json' } }
  })

  await t.exportTemplatesToFile()

  const first = doorCalls(backend)[0].options.body

  assert.equal(first.template_version, t.TEMPLATE_VERSION)

  t.setUiState({ importPreview: t.importPreview(t.currentTemplates(), inspected({ templates: first.templates })) })

  assert.equal(t.applyImportPreview().ok, true)

  backend.calls.length = 0

  await t.exportTemplatesToFile()

  assert.equal(doorCalls(backend)[0].options.body.template_version, t.TEMPLATE_VERSION)
})
