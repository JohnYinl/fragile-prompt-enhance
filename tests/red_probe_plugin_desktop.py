"""Temporarily restore the three original defects and confirm the new tests FAIL.

Run from the project root. Restores the file in a `finally`, so an interruption
cannot leave the shipped source mutated. This is the RED half of red-then-green:
it proves the added tests actually bite the defects they name.
"""

import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PLUGIN = ROOT / "package" / "fragile-prompt-enhance" / "desktop" / "plugin.js"
BACKUP = ROOT / "tests" / ".harness" / "plugin.js.orig"

# The three defects this pass fixed, expressed as source-level reverts.
REVERTS = [
    (
        "item 3: showCompareOnSuccess defaulted ON",
        "showCompareOnSuccess: source.showCompareOnSuccess === true",
        "showCompareOnSuccess: source.showCompareOnSuccess !== false",
    ),
    (
        "item 2: ctx.llm only - no follow-session door",
        """  if (!context.sessionId) {
    return { path: 'global', source: 'global', reason: 'no-live-session' }
  }

  return { path: 'session', source: 'session', reason: 'follow-session' }""",
        """  return { path: 'global', reason: 'follow-session' }""",
    ),
    (
        "item 1: an HTTP status was never read",
        """  const status =
    error && typeof error.statusCode === 'number' && Number.isInteger(error.statusCode) && error.statusCode >= 400 && error.statusCode <= 599
      ? error.statusCode
      : match ? Number(match[1]) : null

  if (status !== null) {""",
        """  const status = null
  void match

  if (false) {""",
    ),
    (
        "item 1: a timeout was not told from an unreachable backend",
        "  if ((error && error.name) === 'AbortError' || /timed out|timeout/i.test(raw)) {",
        "  if (false) {",
    ),
    (
        "item 1: a dead bridge was not told from a dead socket",
        "  if (/bridge unavailable|gateway unavailable|not connected|gateway is not connected/i.test(raw)) {",
        "  if (false) {",
    ),
    (
        "item 1: a JSON-RPC code was not read",
        "  if (code === -32601) {",
        "  if (false) {",
    ),
    (
        "item 1: a failed one-shot was not told from a refused one",
        "  if (code === 5030) {",
        "  if (false) {",
    ),
    (
        "item 1: a gateway refusal was not distinguished",
        "  if (code === 4030 || code === 4031 || code === 4032) {",
        "  if (false) {",
    ),
]

# The tests added by this pass, which must go red against the reverted source.
NEW_TESTS = [
    "a backend refusal is classified from its status and own error code",
    "an upstream timeout and a rate limit are told apart",
    "a bare status with no usable body still names",
    'a failure with no statusCode is a transport problem',
    "a gateway RPC failure is classified by JSON-RPC code",
    "the shipped run path reports the backend reason",
    "a live chat is followed through llm.oneshot",
    "the draft reaches the model exactly once",
    "a composer with no live chat uses the global model",
    "planRun follows a live chat",
    "a successful run fills the draft back",
    "normalizeSettings defaults the compare-on-success switch to off",
]

# ── this pass: the fused Chinese templates + the model-choice control ─────────

REVERTS_THIS_PASS = [
    (
        "this pass: the model control read backwards again",
        "  return normalizeSettings(settings).modelMode === 'pinned' ? 'pinned' : 'session'",
        "  return normalizeSettings(settings).modelMode === 'pinned' ? 'session' : 'pinned'",
    ),
    (
        "this pass: the catalog was hidden whenever the gate was closed",
        """  return {
    showCatalog: normalizeSettings(settings).modelMode === 'pinned',
    gateOpen: Boolean(trust && trust.allow_model_override === true)
  }""",
        """  return {
    showCatalog:
      normalizeSettings(settings).modelMode === 'pinned' &&
      Boolean(trust && trust.allow_model_override !== false),
    gateOpen: Boolean(trust && trust.allow_model_override === true)
  }""",
    ),
    (
        "this pass: the panel gated the picker on the gate again",
        "  const panel = modelPanelState(trust, settings)",
        """  const blocked = Boolean(trust && trust.allow_model_override === false)
  const panel = Object.assign(modelPanelState(trust, settings), {
    showCatalog: settings.modelMode === 'pinned' && !blocked
  })""",
    ),
    (
        "this pass: the refusal stopped naming the model",
        "    return { blocked: 'status.capabilityBlocked', args: [pinned.model] }",
        "    return { blocked: 'status.capabilityBlocked' }",
    ),
    (
        "this pass: a stored legacy default was left in place",
        """  for (const mode of MODES) {
    const candidate = source[mode]
    const found = templateVersionOf(candidate, mode)

    if (found !== null && found < TEMPLATE_VERSION) {""",
        """  for (const mode of MODES) {
    const candidate = source[mode]
    const found = templateVersionOf(candidate, mode)

    if (false) {""",
    ),
    (
        "this pass: the precise default went back to the old two English sentences",
        r"""  precise: {
    system: [
      '你负责把用户当前的草稿改写成一个更清楚、更具体的提示词，交给一个 AI 助手执行。只改写，不回答问题，也不代替用户执行。',
      '',
      '一、解构原稿',
      '1. 找出核心意图、目标对象和期望的交付物。',
      '2. 标出含糊表述、缺失的上下文、相互冲突的要求，以及可能被误解的隐含假设。',
      '3. 识别原稿里的实体：文件、模块、接口、数据、术语与引用标识，保持它们的名称原样。',
      '4. 区分已经确认的事实、推测的原因和未知项；未知项保持可辨认。',
      '',
      '二、重构',
      '- 指令清晰、具体：把要做什么写明白，聚焦“做什么”，不解释“怎么做”。',
      '- 补齐必要的上下文、范围与约束；明确期望的输出形式与受众。',
      '- 结构服从内容：复杂需求按需分段或列点，单一话题保持连贯段落，不为了显得完整而制造小节。',
      '- 保持精炼：删掉重复和与目标无关的铺陈，但不要为了短而丢掉约束，也不设字数上限。',
      '- 保持原稿的尺度：小修改就小改，不把一个小请求扩成一个大工程，也不把一个完整任务压缩成最小可行版本。',
      '- 尊重用户已经选定的技术与格式；用户没有提到的技术栈、工具、流程、角色或章节不要自行添加。',
      '- 原文已经足够清晰、完整时，可以只做去重与顺序整理，甚至保持原样：“没有改动”本身就是合格结果，不需要为了显得有增强而扩写。',
      '- 不为了凑出改动而添加评审维度、检查清单、验收标准、评分表或“下一步”之类的章节；只补齐真正影响执行的部分。',
      '- 不主动索取教程、操作指南或代码片段，除非用户明确要求。',
      '- 只修正自然语言里明显的语音输入错误（同音或近音错别字、明显漏字），修正要基于上下文、不改变原意，无法确定时保持原样；代码、命令、路径、标识与错误原文一律不修正。',
      '- 只有当前草稿可用：没有聊天历史、附件、文件树或记忆，不要声称读过它们，也不要停下来要求用户补充资料。',
      '- 但下游执行者可能有它自己的上下文：草稿里的指代（“这个插件”“按刚才方案”“上次说的”“那个页面”）保持原样，不删掉、不猜含义，也不要写成“内容附下方”“见附件”这类并不存在的指向。',
      '',
      '三、复核',
      '- 给出结果前自查：意图是否改变、约束是否丢失、是否新增了事实或无关要求、句子是否完整。'
    ].join('\n'),
    user: [
      '把下面的草稿改写成一个意图清楚、范围明确、约束完整的提示词，保留草稿本来的语言（中文草稿保持中文，英文草稿保持英文，中英混排保持自然混排）。',
      '',
      '示例',
      '草稿：帮我看看这段代码',
      '改写：请阅读这段代码，说明它的主要功能、执行流程和关键逻辑，并指出可能出问题的边界情况。',
      '',
      '草稿：',
      '{{draft}}'
    ].join('\n')
  },""",
        r"""  precise: {
    system:
      "You are a prompt editor for an AI assistant. You rewrite the user's draft so its intent, scope and constraints are unambiguous.",
    user:
      "Rewrite the draft below.\n\n{{draft}}"
  },""",
    ),
]

NEW_TESTS_THIS_PASS = [
    "the model control names the state it sets",
    "the catalog is offered whether or not the override is granted",
    "the model panel writes nothing but plugin settings",
    "an unauthorized run is refused by name",
    "an untouched legacy default is migrated to the new default",
    "register() migrates a stored legacy default and persists the new one",
    "a customized template is preserved verbatim",
    "ships a complete Chinese template pair for both modes",
    "the shipped templates keep the language-follow rule",
    "the shipped templates carry the source method",
    "the shipped templates carry exact-content protection",
]

# ── this crash: the picker's Menu context ────────────────────────────────────
#
# `ModelCatalogMenu` is menu CONTENT: its own top level renders Radix Menu.Items
# (the loading skeletons and the trailing Add/Edit rows), so mounting it in a
# bare element throws `` `MenuItem` must be used within `Menu` `` — inside the
# composer-action error boundary, which is why the whole toolbar disappeared.
# The two reverts below restore that shape, at the crash site and (for the
# area-level guard) at the composer's own menu.

REVERTS_THIS_CRASH = [
    (
        "this crash: the catalog went back to a bare block",
        """          jsxs(DropdownMenu, {
            onOpenChange: setMenuOpen,
            open: menuOpen,
            children: [
              jsx(DropdownMenuTrigger, {
                asChild: true,
                children: jsxs(Button, {
                  'aria-label': translate('settings.modelPickAction'),
                  'data-fpe': 'model-trigger',
                  className: 'w-full justify-between gap-2 px-2 text-[0.75rem] font-normal',
                  type: 'button',
                  variant: 'outline',
                  children: [
                    jsx('span', {
                      className: cn('min-w-0 truncate', !pinned && 'text-(--ui-text-tertiary)'),
                      children: pinned
                        ? pinned.provider
                          ? pinned.provider + ': ' + pinned.model
                          : pinned.model
                        : translate('settings.modelPickAction')
                    }),
                    jsx(Codicon, { className: 'shrink-0 opacity-50', name: 'chevron-down', size: 12 })
                  ]
                })
              }),
              jsx(DropdownMenuContent, {
                'data-fpe': 'model-menu',
                align: 'start',
                className: 'w-72 p-0',
                children: jsx(ModelMenuCloseContext.Provider, {
                  // A pick closes the menu the pick was made in. Without this the
                  // catalog falls back to the context's default no-op closer and
                  // the menu would stay open on top of the settings dialog.
                  value: () => setMenuOpen(false),
                  children: jsx(ModelCatalogMenu, {
                    controller,
                    // A live gateway handle plus the connection-qualified owner: the
                    // menu must query the SESSION OWNER's backend, so a catalog
                    // opened from a tile does not read chrome's.
                    gateway: host.getGateway() || undefined,
                    ownerConnectionId: readState().connectionId || undefined,
                    profile: readState().profile || 'default',
                    sessionId: readState().focusedRuntimeId || null
                  })
                })
              })
            ]
          }),""",
        """          jsx(ModelCatalogMenu, {
            controller,
            // A live gateway handle plus the connection-qualified owner: the
            // menu must query the SESSION OWNER's backend, so a catalog
            // opened from a tile does not read chrome's.
            gateway: host.getGateway() || undefined,
            ownerConnectionId: readState().connectionId || undefined,
            profile: readState().profile || 'default',
            sessionId: readState().focusedRuntimeId || null
          }),""",
    ),
    (
        "this crash (area level): the composer's menu rows lost their content provider",
        """          jsxs(DropdownMenuContent, {
            align: 'end',
            className: 'w-64',
            'data-fpe': 'menu',
            children: [
              jsx('div', {
                className: 'px-2 py-1 text-[0.68rem] text-(--ui-text-quaternary)',
                children: translate('menu.modeSection')
              }),""",
        """          jsx(Fragment, {
            children: [
              jsx('div', {
                className: 'px-2 py-1 text-[0.68rem] text-(--ui-text-quaternary)',
                children: translate('menu.modeSection')
              }),""",
    ),
]

# The tests this crash added which must go red under the reverts above.
# `the Menu contract checker reproduces the shipped crash` is deliberately NOT
# here: it mounts the catalog by hand and asserts the checker throws, so it is
# green in every state — it is the control that says the walker still bites.
NEW_TESTS_THIS_CRASH = [
    "the model picker mounts inside a real Menu, not a bare block",
    "a pick can dismiss the menu it was made in",
    "the picker has a trigger and stays available whatever the gate says",
    "the whole composer-action area renders top to bottom",
]


REVERTS_THIS_RESULT = [
    (
        'this round (leak): a dedicated pick was labelled as the global model',
        """  if (source === 'dedicated') {
    return 'compare.sourceDedicated'
  }""",
        """  if (source === 'dedicated') {
    return 'compare.sourceGlobalNew'
  }""",
    ),
    (
        'this round (leak): the request was reported as if the host had confirmed it',
        """    receipt: provider || model ? { provider: provider || '—', model: model || '—' } : null,""",
        """    receipt: provider || model ? { provider: provider || '—', model: model || '—' } : requestedModel || requestedProvider ? { provider: requestedProvider || '—', model: requestedModel || '—' } : null,""",
    ),
    (
        'this round (leak): the rationale the same call returned was not rendered',
        """                    result.scores ? jsx(RationalePanel, { scores: result.scores, t: translate }) : null,""",
        """                    null,""",
    ),
    (
        'this round (leak): the optional change note was not rendered',
        """                jsx(ChangeNote, { note: result.changeNote, t: translate }),""",
        """                null,""",
    ),
    (
        'this round (leak): the highlight was switched off for every text',
        """export const DIFF_LIMITS = { maxLines: 400, maxCells: 120000 }""",
        """export const DIFF_LIMITS = { maxLines: 0, maxCells: 120000 }""",
    ),
]

# The tests this round added which must go red under the reverts above.
NEW_TESTS_THIS_RESULT = [
    "the three model sources are distinct, named, and translated",
    "a run records the source it took, and the dialog shows that source",
    "the requested model is shown as a request, and the receipt as unconfirmed",
    "modelAttribution never invents a receipt from a request",
    "the rationale the same call already returned is displayed",
    "the change note rides along, labelled as the model own account",
    "the highlight marks added and removed lines and keeps the text exact",
    "a mixed CN/EN body keeps its code, paths and blank lines in the diff",
    "a long mixed rewrite keeps every code and path byte in the highlight",
]

# ── the compare-view layout and the dedicated model's thinking level ─────────

REVERTS_THIS_LAYOUT = [
    (
        'this round (layout): the dialog went back to a max-width the cascade overrides',
        "className: 'min-w-[min(48rem,90vw)]',",
        "className: 'max-w-4xl',",
    ),
    (
        'this round (layout): the draft box went back to flex-1 + overflow inside an auto-height parent',
        "          'min-h-24 rounded-md border border-(--ui-stroke-secondary) bg-(--ui-bg-secondary) p-2 text-[0.75rem] whitespace-pre-wrap break-words',",
        "          'min-h-0 flex-1 overflow-auto rounded-md border border-(--ui-stroke-secondary) bg-(--ui-bg-secondary) p-2 text-[0.75rem] whitespace-pre-wrap',",
    ),
    (
        'this round (layout): the scores went back to per-row flex instead of one table',
        "  return jsx('table', {\n    'data-fpe': 'scores',",
        "  return jsx('div', {\n    'data-fpe': 'scores',",
    ),
    (
        'this round (layout): the score header lost its aligned, tabular score columns',
        "  const headScore = cn(head, 'text-right tabular-nums')",
        "  const headScore = cn(head, 'text-right')",
    ),
    (
        'this round (layout): a class with no compiled rule went back into the table',
        "  const cell = 'px-1 pb-1 align-top'",
        "  const cell = 'px-1 pb-1 align-bottom'",
    ),
    (
        'this round (copy): zero protected items was reported as a check that passed',
        "      children: nothing ? tr('compare.protectionNone') : tr('compare.protectionOk', report.total)",
        "      children: tr('compare.protectionOk', report.total)",
    ),
]

NEW_TESTS_THIS_LAYOUT = [
    "every utility class the desktop half ships has a compiled rule in the real host stylesheet",
    "the compare dialog asks for a width the real cascade can actually apply",
    "the full-text view gives each draft a readable block instead of a collapsing bar",
    "the score section is an independent three-column table with aligned cells",
    "zero protected items is reported as nothing to protect, not as everything preserved",
]


REVERTS_THIS_EFFORT = [
    (
        'this round (effort): a pick was accepted and stored again instead of refused',
        """      setOptions: (next, row) => {
        if (!next || next.effort === undefined || next.effort === null) {
          return
        }

        notify('warn', translate(EFFORT_TRANSPORT.pickRejectedKey))

        void row
      },""",
        """      setOptions: (next, row) => {
        if (!next || next.effort === undefined || next.effort === null) {
          return
        }

        settings = normalizeSettings(Object.assign({}, settings, { pinnedEffort: next.effort }))
        persistSettings()
        patch()
      },""",
    ),
    (
        'this round (effort): the active row reported the inert stored level as its own',
        """        // selection that took effect.
        effort: '',""",
        """        // selection that took effect.
        effort: settings.pinnedEffort || '',""",
    ),
    (
        'this round (effort): every row preset claimed a level the build cannot carry',
        "      presetFor: () => ({}),",
        """      presetFor: (provider, model) => {
        const known = normalizeSettings(settings)

        return known.pinnedModel && known.pinnedModel.model === model && known.pinnedEffort
          ? { effort: known.pinnedEffort }
          : {}
      },""",
    ),
    (
        'this round (effort): selecting a model stored the preset level as the user choice',
        """        settings = applyModelSelection(settings, row.model, row.provider)
        persistSettings()
        patch()

        void preset""",
        """        settings = normalizeSettings(
          Object.assign({}, settings, { pinnedEffort: normalizeEffort(preset && preset.effort) })
        )
        settings = applyModelSelection(settings, row.model, row.provider)
        persistSettings()
        patch()""",
    ),
    (
        'this round (effort): the panel stopped saying the level is blocked on this build',
        """            'data-fpe': 'model-effort-blocked',""",
        """            'data-fpe': 'model-effort-notice-removed',""",
    ),
    (
        'this round (effort): the stored level went back to being drawn as the current value',
        """          settings.pinnedEffort
            ? jsx('div', {
                'data-effort': settings.pinnedEffort,
                'data-fpe': 'model-effort-stored',
                className: 'text-[0.7rem] text-(--ui-text-quaternary)',
                // The levels are host identifiers (`high`, `xhigh`, …), not
                // prose, so they are shown as they are — inside a sentence that
                // says they are not applied.
                children: translate('settings.effortStored', settings.pinnedEffort)
              })
            : null""",
        """          jsx('div', {
            'data-effort': settings.pinnedEffort || '',
            'data-fpe': 'model-effort-value',
            className: 'text-[0.72rem] text-(--ui-text-secondary)',
            children: settings.pinnedEffort
          })""",
    ),
    (
        'this round (effort): the audit of the host catalog menu was left to go stale',
        """  catalogMenuProps: [
    'controller',
    'footer',
    'gateway',
    'includeMoa',
    'ownerConnectionId',
    'profile',
    'request',
    'sessionId'
  ],""",
        """  catalogMenuProps: ['controller', 'footer', 'gateway', 'includeMoa', 'ownerConnectionId', 'profile', 'request'],""",
    ),
    (
        'this round (effort): an undeclared level was passed through instead of refused',
        "  return REASONING_EFFORTS.indexOf(raw) >= 0 ? raw : ''",
        "  return raw",
    ),
    (
        'this round (effort): the plugin claimed a transport the official doors do not have',
        "export const EFFORT_TRANSPORT = {\n  supported: false,",
        "export const EFFORT_TRANSPORT = {\n  supported: true,",
    ),
]

NEW_TESTS_THIS_EFFORT = [
    "the official plugin LLM doors carry no reasoning parameter — and the plugin says so",
    "the catalog menu exposes no prop that could hide or disable its thinking submenu",
    "a thinking-level pick is refused — not recorded, not persisted, and said out loud",
    "a level stored by an earlier build is kept on file, but never drawn as the selection",
    "the thinking level is surfaced as blocked on this build, never as applied",
]

# ── this round: the version record ──────────────────────────────────────────
#
# The real defect was that an export read the stored RECORD instead of the bytes
# it was about to pack, so an install that had never stored templates (and any
# import that copied an archive's own claim) exported `template_version: null`.
# The reverts below restore each half of that: the record-based read, the null
# fallback, the copied claim (which needs the derivation guard removed too, or
# the claim is ignored and the defect cannot appear), and no first-run settle.

REVERTS_THIS_VERSION = [
    (
        "this round (version): the export read the stored record instead of the bytes",
        "  return exportRequestBody(templates, options)",
        "  return exportRequestBody(templates, Object.assign({ version: templateMeta().version }, options))",
    ),
    (
        "this round (version): an unusable version went back to being written as null",
        "  const version = Number.isInteger(stated) && stated >= 1 ? stated : TEMPLATE_VERSION_CUSTOM",
        "  const version = Number.isInteger(stated) ? stated : null",
    ),
    (
        "this round (version): an import copied the archive's claimed version",
        """  commitTemplates(next, {
    state: 'imported',
    fromVersion: null,""",
        """  commitTemplates(next, {
    state: 'imported',
    version: preview.version,
    fromVersion: null,""",
    ),
    (
        "this round (version): the record stopped deriving its version from the bytes",
        """  const patch = Object.assign({}, metaPatch)

  delete patch.version
""",
        "  const patch = Object.assign({}, metaPatch)\n",
    ),
    (
        "this round (version): a first run went back to leaving no record at all",
        """      templates = normalizeTemplates(stored)
      }

      // ...but the VERSION record is settled from the bytes that are now live,
      // including the first run where no record exists at all. It writes only
      // the record: the templates and the rollback slot are untouched.
      settleTemplateVersion()
""",
        """      templates = normalizeTemplates(stored)
      }
""",
    ),
]

NEW_TESTS_THIS_VERSION = [
    "a first run records the version of the templates it is actually serving",
    "an untouched install exports the version its bytes ARE, not an absent record",
    "custom templates export the explicit custom marker, never a version number",
    "an archive never carries a null version: a default version or the custom marker",
    "a version an archive claims is not stamped onto bytes that are not that version",
    "an archive whose bytes ARE a shipped default records that version even when the file states none",
    "the exported version survives a round trip instead of decaying to null",
]


def main() -> int:
    source = PLUGIN.read_text(encoding="utf-8")
    BACKUP.parent.mkdir(parents=True, exist_ok=True)
    BACKUP.write_text(source, encoding="utf-8")
    mutated = source
    applied = []
    reverts = (
        REVERTS
        + REVERTS_THIS_PASS
        + REVERTS_THIS_CRASH
        + REVERTS_THIS_RESULT
        + REVERTS_THIS_LAYOUT
        + REVERTS_THIS_EFFORT
        + REVERTS_THIS_VERSION
    )
    expected = (
        NEW_TESTS
        + NEW_TESTS_THIS_PASS
        + NEW_TESTS_THIS_CRASH
        + NEW_TESTS_THIS_RESULT
        + NEW_TESTS_THIS_LAYOUT
        + NEW_TESTS_THIS_EFFORT
        + NEW_TESTS_THIS_VERSION
    )

    try:
        for label, old, new in reverts:
            if old not in mutated:
                print("SKIP (pattern absent): %s" % label)
                continue

            mutated = mutated.replace(old, new, 1)
            applied.append(label)
            print("reverted: %s" % label)

        if len(applied) != len(reverts):
            print("!! not every revert applied; aborting to avoid a false RED")
            return 2

        PLUGIN.write_text(mutated, encoding="utf-8")

        result = subprocess.run(
            ["node", "--test", "tests/test_plugin_desktop.mjs"],
            cwd=str(ROOT), capture_output=True, text=True, encoding="utf-8", errors="replace",
        )
        output = result.stdout + result.stderr
        failed = sorted({name for name in expected if re.search(r"^\u2716 " + re.escape(name), output, re.M)})
        passed_still = re.search(r"\u2139 pass (\d+)", output)
        failed_still = re.search(r"\u2139 fail (\d+)", output)

        print("\n--- RED RUN ---")
        print("new tests that went red: %d / %d" % (len(failed), len(expected)))

        for name in failed:
            print("  RED: %s" % name)

        missing = [name for name in expected if name not in failed]

        for name in missing:
            print("  STILL GREEN (test does not bite): %s" % name)

        print("suite: pass=%s fail=%s" % (passed_still.group(1) if passed_still else "?",
                                          failed_still.group(1) if failed_still else "?"))
        print("exit=%s" % result.returncode)

        return 0 if not missing else 1
    finally:
        shutil.copyfile(BACKUP, PLUGIN)
        print("\nrestored the shipped source from %s" % BACKUP)


if __name__ == "__main__":
    sys.exit(main())
