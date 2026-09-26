/**
 * Fragile Prompt Enhance / 芙拉吉尔·提示词增强 — desktop half.
 *
 * A native composer button (split: run + settings dropdown) that rewrites the
 * CURRENT draft through the plugin's own Python backend, which calls the
 * host-owned `ctx.llm`. It never reaches into the editor DOM, never inspects
 * ProseMirror/React internals, and never talks to a provider directly.
 *
 * Hard rules this file implements:
 *  - Draft text moves ONLY through `host.composer.getDraft` / `setDraft`.
 *  - Runs are bound to (profile, connection, composer address); a result whose
 *    binding, draft, or mounted surface moved on is DISCARDED, never applied.
 *  - Stop invalidates the run so a late answer is dropped.
 *  - Undo is single-level, in-memory, and only fires when the live draft still
 *    matches the text we applied.
 *  - Persistence is non-sensitive settings + templates only. Drafts, results,
 *    scores and diagnostics live in memory and die with the plugin.
 *  - UI language follows the app's active locale (`usePluginI18n`); the
 *    rewritten prompt always keeps the DRAFT's own language.
 *
 * The file is loaded uncompiled and may import exactly three specifiers
 * (`@hermes/plugin-sdk`, `react`, `react/jsx-runtime`) — relative imports are
 * refused by the runtime loader, so everything lives in this one file.
 * The named exports below are the pure halves, exported so they can be tested
 * directly; the loader only reads `default`.
 */

import { host, useValue, usePluginI18n, useI18n, atom, cn, Button, Codicon, GlyphSpinner,
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
  Textarea, Switch, Separator, Badge, SegmentedControl, ModelCatalogMenu,
  DisclosureCaret, RowButton,
  ModelMenuCloseContext } from '@hermes/plugin-sdk'
import { jsx, jsxs, Fragment } from 'react/jsx-runtime'
import { useEffect, useMemo, useState } from 'react'

export const PLUGIN_ID = 'fragile-prompt-enhance'
export const DISPLAY_NAME = 'Fragile Prompt Enhance'

export const MODES = ['precise', 'creative']
export const DIMENSIONS = [
  'goal_clarity',
  'info_sufficiency',
  'constraints',
  'deliverable',
  'expression_efficiency'
]

export const STORAGE_KEYS = {
  settings: 'settings.v1',
  templates: 'templates.v1',
  templateMeta: 'templates.meta.v1',
  /**
   * ONE rollback slot: the pair that was live before the current one.
   *
   * One previous version, not a list — a rollback is a single step the user can
   * take back again, not a history to browse. Nothing is appended here, and no
   * other file, draft, result or model setting is ever written.
   */
  templatePrevious: 'templates.previous.v1'
}

/**
 * Schema tag of the stored template record (`templates.meta.v1`). Bumped only
 * if that record's shape changes incompatibly; the templates themselves are
 * versioned separately by :data:`TEMPLATE_VERSION`.
 */
export const TEMPLATE_META_SCHEMA = 1

/**
 * The explicit marker an archive carries when its content is not one of the
 * recorded shipped defaults.
 *
 * `null` could not say this: it is indistinguishable from an exporter that kept
 * no record, and a real export of this build said `null` for content that WAS
 * the shipped default 3 (the record was simply absent — a first run stores no
 * templates). The format therefore states the answer instead of leaving a gap.
 * Mirrors `fpe_templates.CUSTOM_TEMPLATE_VERSION` on the Python half.
 */
export const TEMPLATE_VERSION_CUSTOM = 'custom'

/**
 * What the stored templates ARE, as far as this install can honestly say.
 *
 * `version` is the shipped default version the content IS (only when it still
 * matches one exactly), `fromVersion` the version a migration replaced, and
 * `source` what caused the content to be written. A record left behind by an
 * earlier boot is never cleared by a later one — the user's content may have
 * come from an import, and that is exactly the fact worth keeping.
 */
export const TEMPLATE_META_STATES = ['default', 'edited', 'imported', 'rolled-back']

/** Where a template write came from. Storage bookkeeping, never a draft. */
export const TEMPLATE_WRITE_SOURCES = ['migration', 'edit', 'restore-defaults', 'import-file', 'import-paste', 'rollback']

/** Backend limits, mirrored for client-side guards and for the About panel. */
export const LIMITS = {
  maxDraftChars: 60000,
  defaultTimeoutMs: 130000
}

/** How many missing exact-content items the compare view lists by name. */
export const MAX_REPORTED_MISSING = 8

/**
 * The host's OWN reasoning levels, copied rather than invented.
 *
 * Source of truth: `apps/shared/src/reasoning-effort.ts` (`REASONING_EFFORTS`,
 * `DEFAULT_REASONING_EFFORT`). `''` is the fourth state on the wire — "inherit
 * whatever the profile is set to" — and `'none'` (thinking off) belongs to the
 * host's Thinking switch, not to this scale (the host keeps it out of the
 * radios for the same reason). A level this list does not name is not a level
 * the host can express, so it is refused here instead of being forwarded.
 */
export const REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']
export const DEFAULT_REASONING_EFFORT = 'medium'

/**
 * Whether the OFFICIAL plugin LLM doors can carry a reasoning level.
 *
 * Checked against the installed host, not assumed:
 *   - `agent/plugin_llm.py` `PluginLlm.complete` / `acomplete` /
 *     `complete_structured` / `acomplete_structured` take `provider`, `model`,
 *     `temperature`, `max_tokens`, `timeout`, `agent_id`, `profile`, `purpose`
 *     and `task` — and nothing that names reasoning. `_host_kwargs` builds the
 *     `call_llm` kwargs from that same closed set, so even `reasoning_config`,
 *     which `agent/auxiliary_client.call_llm` DOES accept, is unreachable.
 *   - `tui_gateway/contracts/sessions.py` `LlmOneshotParams` carries
 *     `template`/`instructions`/`input`/`variables`/`task`/`temperature`/
 *     `max_tokens`/`session_id` — no effort field — and its handler never
 *     forwards one either.
 *
 * So the host supports reasoning one layer DOWN while neither plugin door
 * exposes it, AND the surface that offers the pick cannot be closed by a
 * plugin either:
 *   - `ModelCatalogMenu` (`apps/desktop/src/app/shell/model-catalog-menu.tsx`)
 *     accepts `controller`, `footer`, `gateway`, `includeMoa`,
 *     `ownerConnectionId`, `profile`, `request`, `sessionId` — none of them
 *     hides or disables the per-row thinking submenu. The submenu is rendered
 *     unconditionally (`<ModelEditSubmenu …/>`, line 650) and gates its own
 *     rows on CATALOG DATA passed back to it (`reasoning={caps?.reasoning ??
 *     true}`, `canDisableReasoning={caps?.can_disable_reasoning}`), not on a
 *     caller prop. There is therefore NO official way to remove or grey those
 *     radios out from a plugin surface.
 *   - Rewriting the catalog through the `request` prop was considered and
 *     REJECTED: blanking a real model capability to hide a control misreports
 *     the MODEL instead of stating the PLUGIN's boundary — and would not make
 *     the level any more transmissible.
 *   - Nor is it done by CSS or by poking at the host menu's DOM.
 *
 * So the pick can neither be carried nor hidden. What must not happen is the
 * third thing: take the pick, store it, and let the user believe it took. A
 * pick therefore writes nothing, persists nothing, and is answered by a notice
 * naming this boundary (`pickRejectedKey`).
 */
export const EFFORT_TRANSPORT = {
  supported: false,
  seam: 'ctx.llm (agent/plugin_llm.PluginLlm) · llm.oneshot (tui_gateway/contracts/sessions.py LlmOneshotParams)',
  reasonKey: 'settings.effortUnsupported',
  pickRejectedKey: 'settings.effortPickRejected',
  /** The catalog menu's WHOLE prop surface, read off the installed host. */
  catalogMenuProps: [
    'controller',
    'footer',
    'gateway',
    'includeMoa',
    'ownerConnectionId',
    'profile',
    'request',
    'sessionId'
  ],
  /** Whether ANY of those props can hide/disable the thinking submenu. */
  catalogMenuHidesEffort: false,
  catalogMenuSource: 'apps/desktop/src/app/shell/model-catalog-menu.tsx',
  submenuSource: 'apps/desktop/src/app/shell/model-edit-submenu.tsx'
}

/**
 * Temperature for the follow-session one-shot. The gateway's own default for
 * `llm.oneshot` is 0.3; naming it here keeps the two delivery paths comparable
 * instead of leaving a silently different sampling temperature on one of them.
 */
export const ONESHOT_TEMPERATURE = 0.3

/**
 * Editorial half of the prompt — the *method* the model is asked to apply.
 *
 * The output protocol (markers, score schema, behavioural limits) is appended by
 * the Python backend (`fpe_core.protocol_block`), so an edit here can never
 * desynchronise the parser. This half carries what the protocol does NOT: the
 * per-mode working method.
 *
 * Fused from the prompt plugins the user supplied. Per-clause provenance and the
 * licence status of each source are recorded in `docs/来源映射与许可.md`:
 *   - WB-Enhance-Prompt 1.5.5 — `WorkBuddy` original (the analysis process; the
 *     no-unmentioned-technologies / no-guides / no-code-snippets constraints;
 *     "focus on WHAT, not HOW") and the creative half (ENHANCEMENT PROCESS,
 *     INTENT AND SCOPE, EVIDENCE AND MISSING CONTEXT, EXACT CONTENT, the
 *     FINAL CHECK).
 *   - Heybinshao/prompt-enhancer v1.3.0 (MIT) — the Chinese wording of the
 *     rewrite principles, of the hard constraints, and of the voice-input typo
 *     correction rule.
 *   - The user's own Chinese "AI 提示词优化专家" method: 解构 → 重构 → 复核 → 只输出.
 *
 * Both modes are Chinese, matching the plugin's product language; the rewritten
 * prompt itself always keeps the DRAFT's own language (stated in both halves and
 * enforced again by the protocol block).
 *
 * Deliberate deviations — contract conflicts only:
 *   - WB's and Heybinshao's "~800 characters" cap is DROPPED (no length quota).
 *   - The "Prompt Engineering Expert" role title both opened with is DROPPED
 *     (no role frame; the method carries the professionalism).
 *   - WB's worked example prescribed Next.js, contradicting its own
 *     "no unmentioned technologies" rule; the shipped example is technology-free.
 */
export const DEFAULT_TEMPLATES = {
  precise: {
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
  },
  creative: {
    system: [
      '你负责把用户当前的草稿拓展成一个更完整、更可执行的提示词，交给一个 AI 助手执行。只改写，不回答问题，不代替用户执行，也不与用户展开对话。',
      '',
      '一、解构原稿',
      '1. 找出核心意图、目标对象、期望的交付物，以及用户想要达到的质量水准。',
      '2. 标出含糊之处、缺失的上下文、已经写明的约束与排除项。',
      '3. 识别原稿里的实体：文件、模块、接口、数据、术语与引用标识，保持它们的名称原样。',
      '4. 区分已经确认的事实、推测的原因和未知项。',
      '',
      '二、重构与拓展',
      '- 保持原稿的目标、范围、约束、明确排除项与要求的交付物。',
      '- 保持任务阶段：解释、评审、规划、实施、验收是不同阶段；不要把“实施”改成“只做计划”，也不要把“先分析”当成可以直接动手。',
      '- 鼓励合理展开，但不编造事实：可以补充服务于目标的要求与设计方向，但不要把设想写成已经确认的项目决定。',
      '- 原稿写明“没有限制”“尽量做好”这类开放授权时，把它落实为完整度、视觉质量、交互、可用性、健壮性等具体维度；开放式的应用或游戏要把端到端体验补齐（可用功能、核心循环、状态与反馈、完成标准），但不要自动附加账号、支付、后端、部署或每一屏功能。',
      '- 范围很窄的修复或评审，就在该范围内充实诊断、期望行为、边界情况与验证方式，不要附带无关功能或大重构。',
      '- 尊重用户明确选定的技术；选择开放时，可以给出少量可选方向，但不要说成它们已经是项目决定。',
      '- 区分必需项与可选的创意方向：可选方向给出少量连贯的选项，不要变成强制清单，也不要覆盖用户明确的约束。',
      '- 按任务规模展开：开放式的想法充分展开；小修复、解释，或已经写得很细的需求，只补重要的缺口，不要凭空制造范围。',
      '- 删除重复与空泛的赞美，不删除有价值的要求；不设字数上限。',
      '- 按复杂度组织成易读的段落、小节或列表；不要为了分段而加空标题或重复清单。',
      '- 不推断原稿之外的事实，也不声称读过它们：只有当前草稿可用，没有聊天历史、仓库内容、附件内容或工具结果；不要因此停下来要求用户补资料。',
      '- 但下游执行者可能有它自己的上下文：草稿里的指代要保持原样，不要删除、不要猜含义，也不要写成“内容附下方”“见附件”这类并不存在的指向。',
      '- 原稿里没有的文件路径、接口、签名、业务规则、原始产品细节或既有约定不要凭空写出；确实缺失的信息可以转成下游助手的发现或验证目标。',
      '- 遇到“那个页面”“上次说的”这类未解析的指代，保持它可以辨认，不要猜测它的含义。',
      '- 把原稿中的代码、命令、路径、URL、错误原文和配置值原样保留，包括它们的语言和有意义空白；请求修复或解释代码不等于允许改写这段代码。',
      '',
      '三、复核',
      '- 给出结果前自查：意图是否改变、约束是否丢失、是否编造了事实、是否加入了无关内容、句子是否完整；并确认确实把用户的目标展开得更充分，而不是仅仅缩短或重新排版。'
    ].join('\n'),
    user: [
      '把下面的草稿拓展成一个更完整、更可执行的提示词：在草稿允许的自由度内补充有用的要求、约束与验证方式，明确区分必需项与可选方向，保留草稿本来的语言（中文草稿保持中文，英文草稿保持英文，中英混排保持自然混排）。',
      '',
      '草稿：',
      '{{draft}}'
    ].join('\n')
  }
}

/**
 * The exact editorial half shipped BEFORE the fusion, recorded byte-for-byte.
 *
 * A stored `templates.v1` still holding this is what the upgrade is allowed to
 * replace; anything else belongs to the user. Kept as data (not a diff) so the
 * comparison is exact rather than approximate.
 */
export const LEGACY_DEFAULT_TEMPLATES = {
  precise: {
    system:
      "You are a prompt editor for an AI assistant. You rewrite the user's draft so its intent, scope and constraints are unambiguous. You are faithful: you sharpen what is there and you never add scope the draft does not carry.",
    user:
      "Rewrite the draft below so that its goal, scope and constraints are unambiguous, staying as close to the original intent as clarity allows.\n\n{{draft}}"
  },
  creative: {
    system:
      "You are a prompt editor for an AI assistant. You develop the user's idea into a richer, better specified request without leaving the intent they expressed.",
    user:
      "Develop the draft below into a more complete request: make the useful requirements and constraints explicit and organise the expected result. Stay inside what the draft asks for.\n\n{{draft}}"
  }
}

/**
 * v2 — the Chinese pair the FUSION shipped (the first Chinese defaults).
 *
 * This pair no longer exists in the source tree; it shipped for one iteration
 * and was replaced by a wording fix. The two surviving copies are the pre-sync
 * archives (`backups/pre-sync-260926T1335+0800/` and `…T1500+0800/`), and this
 * table is generated FROM those files rather than retyped — the suite re-reads
 * the archives and compares, so a paraphrase cannot pass for the shipped text.
 *
 * Its USER half is byte-identical to the live default; only the method (the
 * system half) moved on. A stored v2 therefore matches the current user text
 * with an older system text, which is exactly the partial-match shape that must
 * NOT be migrated field by field.
 */
const V2_DEFAULT_TEMPLATES = {
    precise: {
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
      '- 原文已经足够清晰时只做轻度润色；不要在原文已经说明的地方重复要求。',
      '- 不主动索取教程、操作指南或代码片段，除非用户明确要求。',
      '- 只修正自然语言里明显的语音输入错误（同音或近音错别字、明显漏字），修正要基于上下文、不改变原意，无法确定时保持原样；代码、命令、路径、标识与错误原文一律不修正。',
      '',
      '三、复核',
      '- 给出结果前自查：意图是否改变、约束是否丢失、是否新增了事实或无关要求、句子是否完整。',
    ].join('\n'),
      user: [
      '把下面的草稿改写成一个意图清楚、范围明确、约束完整的提示词，保留草稿本来的语言（中文草稿保持中文，英文草稿保持英文，中英混排保持自然混排）。',
      '',
      '示例',
      '草稿：帮我看看这段代码',
      '改写：请阅读这段代码，说明它的主要功能、执行流程和关键逻辑，并指出可能出问题的边界情况。',
      '',
      '草稿：',
      '{{draft}}',
    ].join('\n')
    },
    creative: {
      system: [
      '你负责把用户当前的草稿拓展成一个更完整、更可执行的提示词，交给一个 AI 助手执行。只改写，不回答问题，不代替用户执行，也不与用户展开对话。',
      '',
      '一、解构原稿',
      '1. 找出核心意图、目标对象、期望的交付物，以及用户想要达到的质量水准。',
      '2. 标出含糊之处、缺失的上下文、已经写明的约束与排除项。',
      '3. 识别原稿里的实体：文件、模块、接口、数据、术语与引用标识，保持它们的名称原样。',
      '4. 区分已经确认的事实、推测的原因和未知项。',
      '',
      '二、重构与拓展',
      '- 保持原稿的目标、范围、约束、明确排除项与要求的交付物。',
      '- 保持任务阶段：解释、评审、规划、实施、验收是不同阶段；不要把“实施”改成“只做计划”，也不要把“先分析”当成可以直接动手。',
      '- 鼓励合理展开，但不编造事实：可以补充服务于目标的要求与设计方向，但不要把设想写成已经确认的项目决定。',
      '- 原稿写明“没有限制”“尽量做好”这类开放授权时，把它落实为完整度、视觉质量、交互、可用性、健壮性等具体维度；开放式的应用或游戏要把端到端体验补齐（可用功能、核心循环、状态与反馈、完成标准），但不要自动附加账号、支付、后端、部署或每一屏功能。',
      '- 范围很窄的修复或评审，就在该范围内充实诊断、期望行为、边界情况与验证方式，不要附带无关功能或大重构。',
      '- 尊重用户明确选定的技术；选择开放时，可以给出少量可选方向，但不要说成它们已经是项目决定。',
      '- 区分必需项与可选的创意方向：可选方向给出少量连贯的选项，不要变成强制清单，也不要覆盖用户明确的约束。',
      '- 按任务规模展开：开放式的想法充分展开；小修复、解释，或已经写得很细的需求，只补重要的缺口，不要凭空制造范围。',
      '- 删除重复与空泛的赞美，不删除有价值的要求；不设字数上限。',
      '- 按复杂度组织成易读的段落、小节或列表；不要为了分段而加空标题或重复清单。',
      '- 不推断原稿之外的事实，也不声称读过它们：只有当前草稿可用，没有聊天历史、仓库内容、附件内容或工具结果。',
      '- 原稿里没有的文件路径、接口、签名、业务规则、原始产品细节或既有约定不要凭空写出；确实缺失的信息可以转成下游助手的发现或验证目标。',
      '- 遇到“那个页面”“上次说的”这类未解析的指代，保持它可以辨认，不要猜测它的含义。',
      '- 把原稿中的代码、命令、路径、URL、错误原文和配置值原样保留，包括它们的语言和有意义空白；请求修复或解释代码不等于允许改写这段代码。',
      '',
      '三、复核',
      '- 给出结果前自查：意图是否改变、约束是否丢失、是否编造了事实、是否加入了无关内容、句子是否完整；并确认确实把用户的目标展开得更充分，而不是仅仅缩短或重新排版。',
    ].join('\n'),
      user: [
      '把下面的草稿拓展成一个更完整、更可执行的提示词：在草稿允许的自由度内补充有用的要求、约束与验证方式，明确区分必需项与可选方向，保留草稿本来的语言（中文草稿保持中文，英文草稿保持英文，中英混排保持自然混排）。',
      '',
      '草稿：',
      '{{draft}}',
    ].join('\n')
    },
}

/**
 * EVERY default pair this plugin has shipped, oldest first, plus the live one.
 *
 * `version` is the order they were published in — not a storage format, and not
 * a claim that an installation has ever seen every step. A stored pair is
 * upgraded only when BOTH of its fields match one of these entries EXACTLY,
 * which is what makes "the user never touched it" a fact rather than a guess:
 * a half-edited pair matches nothing here and is left alone.
 *
 * `LEGACY_DEFAULT_TEMPLATES` (v1) and `DEFAULT_TEMPLATES` (v3) stay the names
 * the rest of this file uses; the table only adds the versions between them.
 */
export const TEMPLATE_DEFAULT_VERSIONS = [
  {
    version: 1,
    id: 'v1-english-pre-fusion',
    precise: LEGACY_DEFAULT_TEMPLATES.precise,
    creative: LEGACY_DEFAULT_TEMPLATES.creative
  },
  {
    version: 2,
    id: 'v2-chinese-intermediate',
    precise: V2_DEFAULT_TEMPLATES.precise,
    creative: V2_DEFAULT_TEMPLATES.creative
  },
  {
    version: 3,
    id: 'v3-chinese-current',
    precise: DEFAULT_TEMPLATES.precise,
    creative: DEFAULT_TEMPLATES.creative
  }
]

/** The version `DEFAULT_TEMPLATES` currently IS — the last row of the table. */
export const TEMPLATE_VERSION = TEMPLATE_DEFAULT_VERSIONS[TEMPLATE_DEFAULT_VERSIONS.length - 1].version

/** Exact two-field match — the only shape that licenses replacing a stored pair. */
function sameTemplate(candidate, reference) {
  return (
    Boolean(candidate) &&
    typeof candidate === 'object' &&
    candidate.system === reference.system &&
    candidate.user === reference.user
  )
}

/**
 * Which recorded default version a stored pair IS, or `null` for "not one of
 * ours".
 *
 * BOTH fields must match one and the same version. A pair carrying the current
 * user text with an older system text is a half-edited template — the exact
 * shape a per-field comparison would migrate field by field — so it matches
 * nothing here and is left alone.
 */
export function templateVersionOf(candidate, mode) {
  if (!candidate || typeof candidate !== 'object') {
    return null
  }

  for (const entry of TEMPLATE_DEFAULT_VERSIONS) {
    if (sameTemplate(candidate, entry[mode])) {
      return entry.version
    }
  }

  return null
}

/**
 * Migrate a stored template map onto the CURRENT default version.
 *
 * Pure and conservative, in three parts:
 *   * a mode is replaced only when it matches ONE recorded version EXACTLY —
 *     the evidence that the user never touched it;
 *   * a pair already on the current version is passed through BY REFERENCE and
 *     is not reported as a migration (so a reload cannot re-decide it, and the
 *     stored bytes are not rewritten behind the user);
 *   * anything else — the user's own text, a half-edited pair, a pair from two
 *     different shipped versions — is passed through by reference too.
 *
 * `fromVersions` lists the versions actually replaced (ascending, unique), so
 * the caller records what happened instead of assuming a single step.
 */
export function migrateTemplates(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const next = {}
  const fromVersions = []
  let migrated = false

  for (const mode of MODES) {
    const candidate = source[mode]
    const found = templateVersionOf(candidate, mode)

    if (found !== null && found < TEMPLATE_VERSION) {
      next[mode] = { system: DEFAULT_TEMPLATES[mode].system, user: DEFAULT_TEMPLATES[mode].user }
      migrated = true

      if (fromVersions.indexOf(found) < 0) {
        fromVersions.push(found)
      }
    } else {
      next[mode] = candidate
    }
  }

  return {
    migrated,
    fromVersions: fromVersions.sort((left, right) => left - right),
    to: TEMPLATE_VERSION,
    templates: next
  }
}

export const I18N = {
  en: {
    name: 'Fragile Prompt Enhance',
    /** Shown in About: the plugin follows the app locale, it has no switch. */
    languageNote: 'The interface follows Hermes\'s display language. The rewritten prompt always keeps the draft\'s own language.',
    button: {
      run: 'Enhance prompt',
      stop: 'Stop and discard',
      menu: 'Enhance options',
      running: 'Enhancing…'
    },
    menu: {
      modeSection: 'Mode',
      actionSection: 'This draft',
      compare: 'Compare original and enhanced',
      undo: 'Undo this enhancement',
      settings: 'Settings…'
    },
    mode: {
      precise: 'Precise',
      preciseHint: 'Faithful rewrite. No added scope.',
      creative: 'Creative',
      creativeHint: 'Develops the idea. Still no invented facts.'
    },
    status: {
      // Parameterised leaves are FUNCTIONS: the SDK returns a string leaf
      // verbatim and only passes args to a function, so `{count}`-style
      // placeholders in a string would reach the user as literal braces.
      running: seconds => 'Enhancing… ' + seconds + 's',
      stopping: 'Stopping…',
      stopped: 'Stopped — the late answer was discarded.',
      empty: 'Write a draft first, then enhance it.',
      tooLong: max => 'The draft is longer than ' + max + ' characters.',
      backendDown: detail => 'The plugin backend is not reachable: ' + detail,
      applied: 'Draft replaced. Undo is available in the enhance menu.',
      undoDone: 'Restored the draft from before this enhancement.',
      nothingToUndo: 'There is nothing to undo.',
      bindingsMoved: 'The chat or connection changed, so the result was discarded.',
      draftChanged: 'The draft changed while enhancing, so nothing was overwritten. The result is kept in the compare view.',
      undoMismatch: 'The draft no longer matches the enhanced text, so undo is blocked to avoid overwriting your edits.',
      undoNoSurface: 'That composer is no longer mounted; undo was not attempted.',
      applyFailed: 'No mounted composer accepted the text; nothing was written.',
      compareKept: 'The result is kept here; it was not written into the draft.',
      noResult: 'No enhancement yet.',
      memoryOnly: 'Diagnostics live in this session\'s memory only and are cleared when the plugin reloads.',
      capabilityBlocked: model =>
        'A dedicated enhancement model (' +
        model +
        ') is not permitted by this installation, so the run was not started.',
      routeUnavailable: 'This draft belongs to a chat on another Hermes connection, and no route to it could be resolved, so the run was refused rather than sent to a different connection.',
      noLiveSession: 'This composer has no live chat yet, so the run uses the global model. Send one message first to follow a chat\'s model.',
      cleared: 'Diagnostics cleared.'
    },
    compare: {
      title: 'Original and enhanced draft',
      original: 'Original',
      enhanced: 'Enhanced',
      scores: 'Reference scores',
      selfAssessed: 'Self-assessed by the model in the same call. This is a reference, not a measurement of real effect.',
      scale: 'Scale 0-100',
      originalSide: 'Original',
      enhancedSide: 'Enhanced',
      overall: 'Overall',
      noScores: reason => 'The model returned no usable score this time. The rewritten draft is unaffected: ' + reason,
      reasonEmpty: 'the score section was empty',
      reasonUnparseable: 'the score section was not valid JSON',
      reasonUnrecognized: 'the score section did not have the expected shape',
      reasonAbsent: 'no score section was returned',
      dimensions: {
        goal_clarity: 'Goal clarity',
        info_sufficiency: 'Information sufficiency',
        constraints: 'Explicit constraints',
        deliverable: 'Deliverable definition',
        expression_efficiency: 'Expression efficiency'
      },
      protectionTitle: 'Exact content',
      protectionOk: total => 'All ' + total + ' protected items survived.',
      // A check with nothing to check is not a check that passed. "All 0 items
      // survived" reads as a clean bill of health for a draft that simply held
      // no code, path, URL or reference id.
      protectionNone: 'No content needing verbatim protection was detected, so there was nothing to verify.',
      protectionMissing: count =>
        count + ' protected item(s) were not found in the rewrite. Applying is blocked until you confirm.',
      protectionAltered: count => count + ' protected item(s) came back with changed whitespace or line breaks.',
      protectionTruncated: max => 'The protection check covered the first ' + max + ' items only.',
      apply: 'Write it into the draft',
      applyAnyway: 'Write it anyway',
      cancel: 'Close',
      /*
       * WHICH model source produced the result — stated, never inferred.
       *
       * Three reasons, not two. `planRun().path` has two values because there
       * are two DOORS: `session` (borrowed the live chat's model through
       * `llm.oneshot`) and `global` (the profile's own `ctx.llm` binding). A
       * dedicated model and a composer with no live chat BOTH genuinely ride
       * the global channel — which is exactly how a pinned-model run came back
       * labelled "global model" and looked like the plugin had ignored the
       * pick. The door is the transport; the source is the reason.
       */
      pathLabel: path => 'model source: ' + path,
      sourceDedicated:
        'a dedicated model from the plugin settings (it runs through this profile\'s global channel — that is the only channel that carries a model)',
      sourceSession: 'this chat\'s model',
      sourceGlobalNew:
        'the global model — this composer has no live chat yet, so there is no session model to follow',
      requestedLabel: value => 'Pinned in the plugin settings: ' + value,
      requestedNote:
        'That is only what this plugin ASKED for. Whether it is the model that answered is stated on the next line, never assumed.',
      receipt: (provider, model) => 'The host reported the answer as: ' + provider + ' · ' + model,
      receiptNone: 'The host reported no model name for this result, so the model that answered cannot be confirmed here.',
      receiptNotCarried:
        'This door returns the text only (llm.oneshot carries no model name), so the model that answered cannot be confirmed here.',
      rationaleTitle: 'Why these scores',
      rationaleOriginal: 'Original',
      rationaleEnhanced: 'Enhanced',
      changesTitle: 'What the model says it changed',
      changesUnverified:
        'The model\'s own account from the same call. It is not verified against the two drafts — the comparison above is the evidence, this is only a claim.',
      changesNone: 'The model did not describe its changes this time.',
      viewTitle: 'View',
      viewHighlight: 'Highlight changes',
      viewFull: 'Full text',
      diffIdentical: 'The rewrite is the same text as the original draft.',
      diffTooLarge: lines =>
        'The draft is too long to highlight line by line (' + lines + ' lines), so the full text is shown instead.',
      /* The main line under the title: ONE short line, and the full
       * provenance moved into the disclosure below it. The model name shown
       * here is the host's receipt when there is one; with no receipt the
       * line says so rather than leaving a requested model looking
       * confirmed. */
      summary: (source, model, ms) =>
        source + ' · ' + model + (typeof ms === 'number' ? ' · ' + ms + 'ms' : ''),
      summaryUnconfirmed: 'unconfirmed',
      summaryUnknownModel: 'no model name',
      detailsShow: 'Details',
      detailsHide: 'Hide details',
      detailsHint: 'How this result was produced',
      resultMeta: (provider, model, ms, mode) => provider + ' · ' + model + ' · ' + ms + 'ms · ' + mode
    },
    settings: {
      title: 'Fragile Prompt Enhance settings',
      tabsMode: 'Modes',
      tabsModel: 'Model',
      tabsTemplates: 'Templates',
      tabsDiagnostics: 'Diagnostics',
      tabsAbout: 'About',
      modeTitle: 'Default mode',
      modeHint: 'The split button runs this mode; the dropdown switches it.',
      autoCompare: 'Open the comparison view after a successful enhancement',
      modelTitle: 'Enhancement model',
      modelFollowOption: 'Follow the session',
      modelDedicatedOption: 'Dedicated model',
      modelChoiceHint: 'Picking a model changes this plugin only — never the chat model.',
      modelChoiceHintClosed:
        'Picking a model changes this plugin only — never the chat model. This installation has not granted a dedicated model, so a run on one is refused by name.',
      modelPinnedHint: 'Used for enhancement only. It never changes the session model.',
      modelPinnedUnset: 'No model picked yet — pick one below.',
      modelPickAction: 'Choose a model…',
      modelClear: 'Clear the picked model',
      /*
       * The dedicated model's THINKING LEVEL — a capability this host's plugin
       * interface does NOT have.
       *
       * Not carried (neither official plugin LLM door takes a reasoning
       * parameter) and not hideable (the catalog menu exposes no prop that
       * removes its own thinking submenu). `EFFORT_TRANSPORT` records both
       * checks. The panel therefore states the boundary, and anything still on
       * file from an earlier build is labelled for what it is: inert.
       */
      effortTitle: 'Thinking level',
      effortUnsupported:
        'Not available on this build: the only two official plugin LLM doors (ctx.llm and llm.oneshot) take no reasoning parameter, so no plugin can send a level to the model — and the host model menu exposes no prop that would let this plugin hide its thinking submenu. Choosing a level there is therefore refused, and says so.',
      effortPickRejected:
        'Not applied. The current host plugin interface does not support a thinking level for the dedicated enhancement model, so this choice is neither stored nor sent.',
      effortStored: level => 'Value still on file from an earlier build: ' + level + '. It is NOT applied.',
      permissionTitle: 'Authorization',
      permissionIntro:
        'A dedicated model needs a grant from the HOST, and the host keeps that decision in two places: the override the model call is actually gated on, and the consent record the shipped CLI consent screen writes. The plugin can read both; it cannot change either.',
      permissionEnforcedBy: source => 'Reported by: ' + source,
      permissionSourceHost: 'the live host gate',
      permissionSourceMirror: 'a read-only copy of the config',
      permissionEnforcedYes: 'The model call is gated open.',
      permissionEnforcedNo: 'The model call is refused.',
      permissionConsentYes: 'Consent recorded.',
      permissionConsentNo: 'No consent recorded.',
      permissionDivergenceGateWithoutConsent:
        'The gate is open but no consent is recorded — someone set the override by hand, outside the consent screen.',
      permissionDivergenceConsentWithoutGate:
        'Consent is recorded but the gate is closed — every dedicated-model run is refused until the override is restored.',
      permissionUnknown: 'This backend did not report per-capability state.',
      permissionNameModel: 'Dedicated model (llm.model_override)',
      permissionNameProvider: 'Dedicated provider (llm.provider_override)',
      permissionRefresh: 'Re-read permission',
      permissionRefreshed: 'Permission re-read from the backend.',
      permissionRefreshFailed: 'Could not re-read the permission.',
      permissionCopyGrant: 'Copy the grant command',
      permissionCopyRevoke: 'Copy the revoke steps',
      permissionCopied: 'Copied. Run it in a terminal — it is the official entry.',
      permissionCopyFailed: 'The clipboard is unavailable; select the text below instead.',
      permissionNote:
        'These buttons only copy text. The plugin cannot grant or revoke its own trust: granting runs the host\'s interactive consent screen in a terminal, which fails closed anywhere else.',
      templateTitle: 'Editorial templates',
      templateHint: 'The output protocol is appended by the backend and is not editable here.',
      templateSystem: 'System prompt',
      templateUser: 'User prompt',
      templateDraftPlaceholder: 'Must contain the {{draft}} placeholder.',
      templateInvalid: 'The user prompt must contain the {{draft}} placeholder.',
      templateMigrated:
        'Your stored templates were still the old sample pair, so they were replaced with the new Chinese defaults. A template you had edited is never touched — use "Restore defaults" to move to the new ones yourself.',
      templateSave: 'Save',
      templateSaved: 'Templates saved.',
      templateReset: 'Restore defaults',
      templateResetDone: 'Defaults restored.',
      templatePreviousRestored:
        'The previous version is back. The one you just left took its place in the rollback slot, so this move can be reversed.',
      templateDirty: 'Unsaved changes',
      transferTitle: 'Import and export',
      transferHint:
        'An archive carries the two prompt pairs and nothing else — no draft, no result, no history, no model or provider setting, no credential.',
      transferExportFile: 'Export to a file…',
      transferExportClipboard: 'Copy the archive to the clipboard',
      transferImportFile: 'Import from a file…',
      transferImportPaste: 'Import pasted text',
      transferExportNoPath:
        'Nothing was exported: the save dialog was cancelled, or this build has no native dialog. Use “Copy the archive to the clipboard” for the same content without a file.',
      transferExportWritten: path => 'The archive was written to ' + path,
      transferExportCopied: chars => 'The archive is on the clipboard (' + chars + ' characters). Paste it into a file or a message.',
      transferExportClipboardFailed: 'The clipboard refused the archive, so nothing was exported.',
      transferExportFailed: detail => 'The archive was not exported: ' + detail,
      transferImportNoPath: 'No file was picked, so nothing was imported.',
      transferImportFailed: detail => 'The archive could not be read: ' + detail,
      transferImportInvalid: 'This file is not a usable template archive, so nothing was applied.',
      transferImportTitle: 'Preview this archive',
      transferImportScope: scope => 'Scope: ' + scope,
      transferImportSource: source => 'Read from: ' + source,
      transferImportIdentical: 'This archive is identical to the current templates.',
      transferImportDiffCount: (added, removed) => 'Lines that would change: +' + added + ' / −' + removed,
      transferImportDiffMore: count => count + ' more changed line(s) are not listed here.',
      transferImportDiffTooLarge: lines =>
        'This field has ' + lines + ' lines — too long to compare line by line here. Read the archive itself before applying it.',
      transferImportField: (mode, field, current, incoming) =>
        mode + ' · ' + field + ': ' + current + ' → ' + incoming + ' characters',
      transferImportFieldSame: (mode, field, current) =>
        mode + ' · ' + field + ': ' + current + ' characters, unchanged',
      transferImportWarnings: 'Notes',
      transferImportApply: 'Apply this archive',
      transferImportCancel: 'Discard',
      transferImportPastePrompt: 'Paste an archive below and inspect it before anything is applied.',
      transferImportPasteInspect: 'Inspect the pasted archive',
      transferImportPasteEmpty: 'Nothing to inspect: the box is empty.',
      transferRollbackTitle: 'Previous version',
      transferRollback: 'Restore the previous version',
      transferRollbackNone: 'There is no previous version to restore yet.',
      transferRollbackSavedAt: at => 'Kept from ' + at,
      transferRollbackState: state => 'Recorded as: ' + state,
      transferRollbackUndone: 'Nothing to restore.',
      diagnosticsTitle: 'Diagnostics',
      diagnosticsRuns: 'Recent runs',
      diagnosticsRunsEmpty: 'No runs yet.',
      diagnosticsLastError: 'Last error',
      diagnosticsLastResult: 'Last result',
      diagnosticsClear: 'Clear',
      aboutTitle: 'About',
      aboutBody: 'A composer button that rewrites the current draft and shows a reference self-score for both drafts. It only ever sends the current draft; it reads no history, attachments, files or memory, and it never sends for you.',
      aboutId: 'Plugin id',
      aboutBackend: 'Backend binding',
      aboutProtocol: 'Protocol version',
      aboutBoundCtx: 'host context (ctx.llm)',
      aboutBoundUnavailable: 'unavailable',
      aboutLimits: 'A stop discards the arriving result, but the gateway-side model call cannot be aborted; it may still finish and be billed.',
      aboutStorage: 'Persisted: modes, model choice, the dedicated model\'s thinking level, templates. Not persisted: drafts, results, scores, diagnostics.'
    },
    errors: {
      invalid_request: detail => 'The backend rejected the request: ' + detail,
      model_override_denied: 'A dedicated model is not permitted for this plugin.',
      provider_override_denied: 'A dedicated provider is not permitted for this plugin.',
      model_not_allowed: detail => 'That model is not on this plugin\'s allow-list: ' + detail,
      provider_not_allowed: detail => 'That provider is not on this plugin\'s allow-list: ' + detail,
      llm_unavailable: detail => 'The host LLM door is unavailable: ' + detail,
      upstream_error: detail => 'The model call failed: ' + detail,
      upstream_timeout: 'The model call timed out.',
      empty_response: 'The model returned no usable prompt text.',
      unauthorized: 'Hermes refused the request as unauthenticated.',
      forbidden: detail => 'Hermes refused the request (not authorized): ' + detail,
      not_found: 'The plugin backend route is not mounted on this Hermes build.',
      method_not_allowed: 'The plugin backend rejected the HTTP method for this route.',
      too_large: 'The draft is larger than the backend accepts.',
      busy: 'The backend or the model is rate limiting; try again shortly.',
      server: detail => 'The plugin backend failed while handling the request: ' + detail,
      rejected: detail => 'The plugin backend rejected the request: ' + detail,
      timeout: 'The plugin backend did not answer in time.',
      gateway: detail => 'Hermes\'s gateway is not connected: ' + detail,
      gateway_method_missing: 'This Hermes build has no llm.oneshot RPC, so the chat\'s model cannot be followed here.',
      gateway_refused: detail => 'The gateway refused the one-shot request: ' + detail,
      gateway_generation: detail => 'The one-shot generation failed on the chat\'s model: ' + detail,
      network: 'Could not reach the plugin backend.'
    },
    diagnostics: {
      ok: 'ok',
      failed: 'failed',
      stopped: 'stopped',
      discarded: 'discarded',
      blocked: 'blocked'
    }
  },
  zh: {
    name: '芙拉吉尔·提示词增强',
    languageNote: '界面跟随 Hermes 当前的显示语言。增强稿始终保留草稿本身的语言。',
    button: {
      run: '增强提示词',
      stop: '停止并丢弃',
      menu: '增强选项',
      running: '增强中…'
    },
    menu: {
      modeSection: '模式',
      actionSection: '当前草稿',
      compare: '查看原文/增强稿对比',
      undo: '撤销本轮增强',
      settings: '设置…'
    },
    mode: {
      precise: '精准',
      preciseHint: '忠实改写，不扩写范围。',
      creative: '创意',
      creativeHint: '充分展开想法，但不编造事实。'
    },
    status: {
      running: seconds => '增强中… ' + seconds + ' 秒',
      stopping: '正在停止…',
      stopped: '已停止，迟到的结果已丢弃。',
      empty: '请先写一段草稿，再点增强。',
      tooLong: max => '草稿超过 ' + max + ' 个字符。',
      backendDown: detail => '插件后端不可达：' + detail,
      applied: '已回填草稿。可在增强菜单中撤销。',
      undoDone: '已恢复本轮增强前的文案。',
      nothingToUndo: '没有可撤销的增强。',
      bindingsMoved: '会话或连接已变化，结果已丢弃。',
      draftChanged: '增强期间草稿已改变，没有覆盖你的内容；结果保留在对比视图里。',
      undoMismatch: '当前草稿与增强稿不一致，为避免覆盖你的修改，撤销已阻止。',
      undoNoSurface: '该输入框已不在挂载状态，未执行撤销。',
      applyFailed: '没有正在挂载的输入框接收文本，未写入任何内容。',
      compareKept: '结果只保留在这里，没有写回草稿。',
      noResult: '还没有增强结果。',
      memoryOnly: '诊断只存在于本次会话内存中，插件重新加载后清空。',
      capabilityBlocked: model => '本机未授权专用增强模型（' + model + '），因此没有发起本次增强。',
      routeUnavailable: '这段草稿属于另一个 Hermes 连接上的会话，且无法解析到它的路由；为避免误发到别的连接，本次运行被拒绝。',
      noLiveSession: '这个输入框还没有活跃会话，因此本次使用全局模型。先发送一条消息即可跟随该会话的模型。',
      cleared: '诊断已清空。'
    },
    compare: {
      title: '原文与增强稿',
      original: '原文',
      enhanced: '增强稿',
      scores: '参考评分',
      selfAssessed: '模型在同一次调用中的自评，仅供参考，不代表实际效果。',
      scale: '0-100 分',
      originalSide: '原文',
      enhancedSide: '增强稿',
      overall: '总评',
      noScores: reason => '本次没有可用的评分。增强正文不受影响：' + reason,
      reasonEmpty: '评分区为空',
      reasonUnparseable: '评分区不是有效 JSON',
      reasonUnrecognized: '评分区结构不符合约定',
      reasonAbsent: '没有返回评分区',
      dimensions: {
        goal_clarity: '目标清晰',
        info_sufficiency: '信息充分',
        constraints: '约束明确',
        deliverable: '交付明确',
        expression_efficiency: '表达效率'
      },
      protectionTitle: '精确内容',
      protectionOk: total => total + ' 项精确内容全部保留。',
      protectionNone: '未检测到需逐字保护内容，因此没有需要逐条核对的项目。',
      protectionMissing: count => '有 ' + count + ' 项精确内容没有出现在增强稿中。在你确认前不会回填。',
      protectionAltered: count => '有 ' + count + ' 项精确内容的空格或换行发生了变化。',
      protectionTruncated: max => '本次只核对了前 ' + max + ' 项。',
      apply: '回填到草稿',
      applyAnyway: '仍然回填',
      cancel: '关闭',
      /*
       * 结果由哪一类模型来源产生——如实标注，不靠推断。
       *
       * 是三种来由，不是两种。`planRun().path` 只有两个值，因为只有两扇门：
       * `session`（经 `llm.oneshot` 借用当前会话的模型）与 `global`（本 profile
       * 自己的 `ctx.llm` 绑定）。专用模型与“还没有活跃会话的新输入框”确实都走
       * 全局通道——截图里“固定了专用模型却显示全局模型”就是这么来的，看上去像
       * 插件忽略了选择。门是传输通道，来源才是原因。
       */
      pathLabel: path => '模型来源：' + path,
      sourceDedicated: '插件设置里指定的专用模型（它走本 profile 的全局通道——只有那条通道能携带模型）',
      sourceSession: '当前会话的模型',
      sourceGlobalNew: '全局模型——这个输入框还没有活跃会话，没有可跟随的会话模型',
      requestedLabel: value => '插件设置里固定为：' + value,
      requestedNote: '这只是本插件提出的请求；它是否就是实际作答的模型，由下一行说明，不做假设。',
      receipt: (provider, model) => '宿主回执的作答模型：' + provider + ' · ' + model,
      receiptNone: '宿主没有为这次结果回执模型名，因此无法在这里确认实际作答的模型。',
      receiptNotCarried: '这条通道只回正文（llm.oneshot 不携带模型名），因此无法在这里确认实际作答的模型。',
      rationaleTitle: '评分理由',
      rationaleOriginal: '原文',
      rationaleEnhanced: '增强稿',
      changesTitle: '模型自述的改动',
      changesUnverified: '模型在同一次调用里的自述，未经核对；上面的对照才是依据，这里只是它的说法。',
      changesNone: '本次模型没有说明自己改了什么。',
      viewTitle: '视图',
      viewHighlight: '高亮改动',
      viewFull: '完整原文',
      diffIdentical: '增强稿与原文完全相同。',
      diffTooLarge: lines => '文本过长（' + lines + ' 行），不适合逐行高亮，已改为显示完整文本。',
      summary: (source, model, ms) =>
        source + ' · ' + model + (typeof ms === 'number' ? ' · ' + ms + ' 毫秒' : ''),
      summaryUnconfirmed: '未确认',
      summaryUnknownModel: '无模型名',
      detailsShow: '详情',
      detailsHide: '收起详情',
      detailsHint: '这条结果是怎么产生的',
      resultMeta: (provider, model, ms, mode) => provider + ' · ' + model + ' · ' + ms + ' 毫秒 · ' + mode
    },
    settings: {
      title: '芙拉吉尔·提示词增强 设置',
      tabsMode: '模式',
      tabsModel: '模型',
      tabsTemplates: '模板',
      tabsDiagnostics: '诊断',
      tabsAbout: '关于',
      modeTitle: '默认模式',
      modeHint: 'split 按钮执行当前模式，下拉里可切换。',
      autoCompare: '增强成功后自动打开对比视图',
      modelTitle: '增强模型',
      modelFollowOption: '跟随会话',
      modelDedicatedOption: '使用专用模型',
      modelChoiceHint: '选择模型只改本插件，不会改变会话模型。',
      modelChoiceHintClosed:
        '选择模型只改本插件，不会改变会话模型。本机尚未授权专用模型，用它会按模型名明确拒绝本次增强。',
      modelPinnedHint: '只用于增强，不会改变会话模型。',
      modelPinnedUnset: '还没有选择模型，请在下方选择。',
      modelPickAction: '选择模型…',
      modelClear: '清除已选模型',
      effortTitle: '思考等级',
      effortUnsupported:
        '本构建不提供：插件可用的两扇官方 LLM 门（ctx.llm 与 llm.oneshot）都不带 reasoning 参数，插件无法把任何等级发给模型；同时宿主模型菜单也没有任何 prop 能让插件收起它自己的思考子菜单。因此在那里点选等级会被拒绝，并当场说明。',
      effortPickRejected:
        '不会应用。当前宿主插件接口不支持为专用增强模型设置思考等级，这个选择既不会被保存，也不会被发送。',
      effortStored: level => '本插件设置里仍留着此前版本记录的值：' + level + '。它不会被应用。',
      permissionTitle: '授权',
      permissionIntro:
        '专用模型需要宿主授权，而宿主把这个决定存在两处：模型调用真正被拦截所依据的 override，以及官方 CLI 同意流程写入的授权记录。插件只能读这两处，改不了任何一处。',
      permissionEnforcedBy: source => '读取来源：' + source,
      permissionSourceHost: '宿主实时的执行层',
      permissionSourceMirror: '配置的只读副本',
      permissionEnforcedYes: '模型调用已被放行。',
      permissionEnforcedNo: '模型调用会被拒绝。',
      permissionConsentYes: '已有授权记录。',
      permissionConsentNo: '没有授权记录。',
      permissionDivergenceGateWithoutConsent:
        '执行层已放行，但没有授权记录——这个 override 是绕开同意流程手改出来的。',
      permissionDivergenceConsentWithoutGate:
        '有授权记录，但执行层是关的——在恢复这个 override 之前，用专用模型的运行都会被拒绝。',
      permissionUnknown: '这个后端没有报告逐项能力状态。',
      permissionNameModel: '专用模型（llm.model_override）',
      permissionNameProvider: '专用 provider（llm.provider_override）',
      permissionRefresh: '重新读取权限',
      permissionRefreshed: '已从后端重新读取权限。',
      permissionRefreshFailed: '没能重新读取权限。',
      permissionCopyGrant: '复制授权命令',
      permissionCopyRevoke: '复制撤销步骤',
      permissionCopied: '已复制。请在终端里执行——那才是官方入口。',
      permissionCopyFailed: '剪贴板不可用；请手动选中下面的文本。',
      permissionNote:
        '这两个按钮只复制文本。插件无法给自己授权或撤销授权：授权要在终端里跑宿主的交互同意流程，终端之外一律 fail closed。',
      templateTitle: '编辑用模板',
      templateHint: '输出协议由后端追加，不在这里编辑。',
      templateSystem: '系统提示词',
      templateUser: '用户提示词',
      templateDraftPlaceholder: '必须包含 {{draft}} 占位符。',
      templateInvalid: '用户提示词必须包含 {{draft}} 占位符。',
      templateMigrated:
        '你保存的模板还是旧版示例，已替换为新的中文默认模板。你自己改过的模板不会被覆盖；如需主动切换到新版，可点击“恢复默认”。',
      templateSave: '保存',
      templateSaved: '模板已保存。',
      templateReset: '恢复默认',
      templateResetDone: '已恢复默认模板。',
      templatePreviousRestored: '已恢复上一个版本。刚才离开的那一版已放进撤回位，这一步还能再退回去。',
      templateDirty: '有未保存的修改',
      transferTitle: '导入与导出',
      transferHint:
        '归档文件只包含两组提示词，不含草稿、结果、历史、模型或提供方设置，也不含任何凭据。',
      transferExportFile: '导出到文件…',
      transferExportClipboard: '复制归档到剪贴板',
      transferImportFile: '从文件导入…',
      transferImportPaste: '导入粘贴的文本',
      transferExportNoPath:
        '没有导出任何内容：保存对话框被取消，或当前版本没有原生对话框。可用“复制归档到剪贴板”得到同样的内容，只是不落成文件。',
      transferExportWritten: path => '归档已写入 ' + path,
      transferExportCopied: chars => '归档已复制到剪贴板（' + chars + ' 字符）。粘贴到文件或消息里即可。',
      transferExportClipboardFailed: '剪贴板拒绝了这份归档，因此没有导出。',
      transferExportFailed: detail => '归档没有导出：' + detail,
      transferImportNoPath: '没有选择文件，因此没有导入。',
      transferImportFailed: detail => '归档读取失败：' + detail,
      transferImportInvalid: '这个文件不是可用的模板归档，因此没有应用任何改动。',
      transferImportTitle: '归档预览',
      transferImportScope: scope => '范围：' + scope,
      transferImportSource: source => '读取自：' + source,
      transferImportIdentical: '这份归档与当前模板完全一致。',
      transferImportDiffCount: (added, removed) => '会改动的行：+' + added + ' / −' + removed,
      transferImportDiffMore: count => '另有 ' + count + ' 行改动未在此列出。',
      transferImportDiffTooLarge: lines =>
        '这个字段有 ' + lines + ' 行，太长，无法在此逐行比较。应用前请自己看一遍归档。',
      transferImportField: (mode, field, current, incoming) =>
        mode + ' · ' + field + '：' + current + ' → ' + incoming + ' 字符',
      transferImportFieldSame: (mode, field, current) =>
        mode + ' · ' + field + '：' + current + ' 字符，无改动',
      transferImportWarnings: '说明',
      transferImportApply: '应用这份归档',
      transferImportCancel: '放弃',
      transferImportPastePrompt: '把归档粘贴到下面，确认之前不会应用任何改动。',
      transferImportPasteInspect: '检查粘贴的归档',
      transferImportPasteEmpty: '没有内容可检查：输入框是空的。',
      transferRollbackTitle: '上一个版本',
      transferRollback: '恢复上一个版本',
      transferRollbackNone: '还没有可恢复的上一个版本。',
      transferRollbackSavedAt: at => '留存自 ' + at,
      transferRollbackState: state => '记录为：' + state,
      transferRollbackUndone: '没有可恢复的版本。',
      diagnosticsTitle: '诊断',
      diagnosticsRuns: '最近运行',
      diagnosticsRunsEmpty: '还没有运行记录。',
      diagnosticsLastError: '最近错误',
      diagnosticsLastResult: '最近结果',
      diagnosticsClear: '清空',
      aboutTitle: '关于',
      aboutBody: '输入框里的一个按钮：改写当前草稿，并对前后两稿给出参考自评。只发送当前草稿，不读取历史、附件、文件或记忆，也不会替你发送。',
      aboutId: '插件 id',
      aboutBackend: '后端绑定',
      aboutProtocol: '协议版本',
      aboutBoundCtx: '宿主上下文（ctx.llm）',
      aboutBoundUnavailable: '不可用',
      aboutLimits: '“停止”会丢弃到达的结果，但网关侧已经发出的模型调用无法中断，它可能仍会跑完并计费。',
      aboutStorage: '持久化：模式、模型选择、专用模型的思考等级、模板。不持久化：草稿、结果、评分、诊断。'
    },
    errors: {
      invalid_request: detail => '后端拒绝了这次请求：' + detail,
      model_override_denied: '本机不允许该插件使用专用模型。',
      provider_override_denied: '本机不允许该插件使用专用 provider。',
      model_not_allowed: detail => '该模型不在本插件的允许清单里：' + detail,
      provider_not_allowed: detail => '该 provider 不在本插件的允许清单里：' + detail,
      llm_unavailable: detail => '宿主 LLM 通道不可用：' + detail,
      upstream_error: detail => '模型调用失败：' + detail,
      upstream_timeout: '模型调用超时。',
      empty_response: '模型没有返回可用的提示词正文。',
      unauthorized: 'Hermes 判定这次请求未通过身份验证。',
      forbidden: detail => 'Hermes 拒绝了这次请求（未获授权）：' + detail,
      not_found: '这个 Hermes 构建上没有挂载插件后端路由。',
      method_not_allowed: '插件后端不接受该路由的这种方法。',
      too_large: '草稿超过了后端可接收的大小。',
      busy: '后端或模型正在限流，请稍后再试。',
      server: detail => '插件后端在处理这次请求时失败了：' + detail,
      rejected: detail => '插件后端拒绝了这次请求：' + detail,
      timeout: '插件后端没有在限定时间内应答。',
      gateway: detail => 'Hermes 的 gateway 未连接：' + detail,
      gateway_method_missing: '这个 Hermes 构建没有 llm.oneshot 这个 RPC，因此无法在这里跟随会话模型。',
      gateway_refused: detail => 'gateway 拒绝了这个一次性请求：' + detail,
      gateway_generation: detail => '在会话模型上执行一次性生成失败：' + detail,
      network: '无法连接到插件后端。'
    },
    diagnostics: {
      ok: '成功',
      failed: '失败',
      stopped: '已停止',
      discarded: '已丢弃',
      blocked: '已阻止'
    }
  }
}

// ── pure helpers (exported for tests; the loader only reads `default`) ───────

/** The composer address a run is bound to, from a plain state snapshot. */
export function resolveAddress(snapshot) {
  const focused = snapshot && snapshot.focusedRuntimeId
  if (focused) {
    return { address: focused, kind: 'session' }
  }

  const stored = snapshot && snapshot.focusedStoredId
  if (stored) {
    return { address: stored, kind: 'session' }
  }

  if (!snapshot || !snapshot.activeSessionId) {
    return { address: 'new', kind: 'new' }
  }

  return { address: null, kind: 'active' }
}

/** A stable identity for "the surface this run belongs to". */
export function bindingKey(parts) {
  const profile = (parts && parts.profile) || ''
  const connection = (parts && parts.connectionId) || ''
  const address = parts && parts.address !== undefined ? parts.address : 'active'

  return [profile, connection, address === null ? 'active' : String(address)].join('|')
}

/**
 * A reasoning level this build can READ and that the host can express: `''`
 * (inherit), `'none'` (thinking off), or one of the host's own levels.
 *
 * Read-only on purpose. Nothing in this build WRITES a level any more: the
 * plugin cannot transmit one (`EFFORT_TRANSPORT.supported === false`), so a
 * pick is refused instead of stored. This normaliser exists to keep a value an
 * earlier build stored honest — an unexpressible one is dropped rather than
 * carried forward as if it meant something.
 */
export function normalizeEffort(value) {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : ''

  if (!raw) {
    return ''
  }

  if (raw === 'none') {
    return 'none'
  }

  return REASONING_EFFORTS.indexOf(raw) >= 0 ? raw : ''
}

export function normalizeSettings(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const mode = MODES.indexOf(source.mode) >= 0 ? source.mode : 'precise'
  const modelMode = source.modelMode === 'pinned' ? 'pinned' : 'session'
  const pinned = source.pinnedModel

  return {
    version: 1,
    mode,
    modelMode,
    pinnedModel:
      pinned && typeof pinned.model === 'string' && pinned.model
        ? { model: pinned.model, provider: typeof pinned.provider === 'string' ? pinned.provider : '' }
        : null,
    // Migration: a level stored by an earlier run of this build survives a
    // reload; one this build cannot express is dropped, not carried forward.
    pinnedEffort: normalizeEffort(source.pinnedEffort),
    showCompareOnSuccess: source.showCompareOnSuccess === true
  }
}

export function templatePlaceholders(text) {
  const out = []
  const pattern = /\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g
  let match = pattern.exec(typeof text === 'string' ? text : '')

  while (match) {
    if (out.indexOf(match[1]) < 0) {
      out.push(match[1])
    }

    match = pattern.exec(text)
  }

  return out
}

/** ``{ok, errors}`` for an edited template pair. ``errors`` are i18n keys. */
export function validateTemplatePair(pair) {
  const errors = []
  const source = pair && typeof pair === 'object' ? pair : {}

  for (const field of ['system', 'user']) {
    const value = source[field]
    if (typeof value !== 'string' || !value.trim()) {
      errors.push('settings.templateInvalid')
    }
  }

  if (typeof source.user === 'string' && templatePlaceholders(source.user).indexOf('draft') < 0) {
    errors.push('settings.templateInvalid')
  }

  return { ok: errors.length === 0, errors }
}

export function normalizeTemplates(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const out = {}

  for (const mode of MODES) {
    const candidate = source[mode]
    const fallback = DEFAULT_TEMPLATES[mode]
    const valid =
      candidate &&
      typeof candidate === 'object' &&
      typeof candidate.system === 'string' &&
      candidate.system.trim() &&
      typeof candidate.user === 'string' &&
      templatePlaceholders(candidate.user).indexOf('draft') >= 0

    out[mode] = valid
      ? { system: candidate.system, user: candidate.user }
      : { system: fallback.system, user: fallback.user }
  }

  return out
}

/**
 * The two mutually-exclusive sources for an enhancement run. `id` is the
 * persisted `modelMode` value, so a control labelled with `labelKey` can never
 * read backwards from the state it writes.
 */
export const MODEL_CHOICES = [
  { id: 'session', labelKey: 'settings.modelFollowOption' },
  { id: 'pinned', labelKey: 'settings.modelDedicatedOption' }
]

/** Which side of :data:`MODEL_CHOICES` the current settings are on. */
export function modelChoiceValue(settings) {
  return normalizeSettings(settings).modelMode === 'pinned' ? 'pinned' : 'session'
}

/**
 * Switch which model source is used. Only `modelMode` moves: the remembered
 * `pinnedModel` is kept, so flipping back and forth does not lose the pick, and
 * nothing outside this plugin's settings is touched.
 */
export function applyModelChoice(settings, choice) {
  return normalizeSettings(
    Object.assign({}, settings, { modelMode: choice === 'pinned' ? 'pinned' : 'session' })
  )
}

/**
 * Record a model pick from the catalog. A pick IS the "use a dedicated model"
 * choice, so the mode moves with it; the call has no other effect — it writes
 * plugin settings and nothing else (never the chat's model, never the gateway).
 *
 * It takes NO reasoning level, and that is deliberate: the host's catalog hands
 * one back on every selection (`controller.applyPreset({effort: …})`), but this
 * build cannot transmit it (`EFFORT_TRANSPORT`), so accepting it here would
 * store a setting that never has an effect. A level an earlier build stored is
 * preserved across a re-pick, and cleared when the model itself is cleared — a
 * level with no model behind it is a value the user never chose.
 */
export function applyModelSelection(settings, model, provider) {
  const base = normalizeSettings(settings)
  const pinned = model ? { model, provider: provider || '' } : null
  const level = pinned ? base.pinnedEffort : ''

  return normalizeSettings(
    Object.assign({}, settings, { modelMode: 'pinned', pinnedModel: pinned, pinnedEffort: level })
  )
}

/**
 * What the model panel shows for the current settings and trust policy.
 *
 * `showCatalog` is deliberately INDEPENDENT of `gateOpen`: the catalog is how
 * the user records WHICH model they want, and viewing or picking one is a plugin
 * preference with no authority behind it. Whether that pick is AUTHORIZED is a
 * separate fact, reported beside the picker. Hiding the picker whenever the gate
 * was closed left the user with nothing but a YAML snippet and no way to state
 * their intent — and, worse, made a closed gate look like a missing feature.
 */
export function modelPanelState(trust, settings) {
  return {
    showCatalog: normalizeSettings(settings).modelMode === 'pinned',
    gateOpen: Boolean(trust && trust.allow_model_override === true)
  }
}

/**
 * The authorization view-model: what the backend reported, verbatim.
 *
 * The rows come from the BACKEND (`plugin_api.capability_rows`), which reads
 * them out of the two host layers — the override `agent/plugin_llm` actually
 * enforces, and the `granted_capabilities` record the CLI consent screen writes.
 * This side never infers a row: a backend that reports none shows a stated gap
 * instead of a plausible-looking default.
 *
 * `showGrant` / `showRevoke` decide which operator text is worth showing. A
 * recorded-but-unenforced capability still offers the revoke steps, because
 * there IS a record left to clean up.
 */
export function permissionPanel(trust) {
  const data = trust && typeof trust === 'object' ? trust : {}
  const rows = Array.isArray(data.capabilities)
    ? data.capabilities
        .filter(row => row && typeof row === 'object' && typeof row.capability === 'string')
        .map(row => ({
          capability: row.capability,
          kind: typeof row.kind === 'string' ? row.kind : '',
          legacyKey: typeof row.legacy_key === 'string' ? row.legacy_key : '',
          enforced: row.enforced === true,
          consent: row.consent === true,
          divergence: typeof row.divergence === 'string' && row.divergence ? row.divergence : null
        }))
    : []

  const enforcedBy = data.enforced_by === 'host' ? 'host' : data.enforced_by === 'config-mirror' ? 'config-mirror' : ''
  const granted = rows.filter(row => row.enforced || row.consent)
  const open = rows.filter(row => !row.enforced && !row.consent)

  return {
    rows,
    enforcedBy,
    // Per capability, not per plugin: when one of two capabilities is still
    // ungranted the grant steps are still needed, and when one carries a record
    // the revoke steps are too. Keying both off a single "is anything granted"
    // flag is how a capability gets stranded — granted with no way to undo it,
    // or ungranted with the steps hidden behind the other one's state.
    showGrant: open.length > 0 || rows.length === 0,
    showRevoke: granted.length > 0,
    unknown: Array.isArray(data.capabilities) === false
  }
}

/**
 * The result page's MAIN line: one short statement of source, model and time.
 *
 * It answers the three questions a user actually asks about a finished run —
 * which choice ran, which model, how long — and nothing else. The provenance
 * prose (the request, the host receipt, the channel note) moved into the
 * disclosure below it, because it is explanation, not status.
 *
 * `confirmed` is the load-bearing field. `modelAttribution().receipt` is the
 * HOST's own report of what answered; `requested` is only what this plugin
 * asked for. The model name printed here is the receipt when there is one, and
 * the requested name with `confirmed: false` when there is not — so a request
 * is never rendered in the place a confirmation goes.
 */
export function resultSummary(result) {
  const attribution = modelAttribution(result)
  const receipt = attribution.receipt
  const requested = attribution.requested
  const chosen = receipt || requested

  return {
    source: attribution.source,
    sourceKey: sourceLabelKey(attribution.source),
    confirmed: Boolean(receipt),
    // Never invented: an unnamed model stays unnamed.
    model: chosen ? chosen.model || null : null,
    provider: chosen ? chosen.provider || null : null,
    requestedLabel: requested ? [requested.provider, requested.model].filter(Boolean).join(': ') : null,
    ms: result && typeof result.durationMs === 'number' ? result.durationMs : null,
    mode: (result && result.mode) || '',
    // Whether a receipt could be expected at all on the door this ran through.
    receiptExpected: Boolean(attribution.receiptExpected)
  }
}

/**
 * Everything the main line deliberately leaves out, in render order.
 *
 * Returned as data rather than as elements so the ORDER is testable: source,
 * then what was requested, then what the host actually confirmed. A request
 * before a confirmation, never the other way round.
 */
export function resultDetails(result) {
  const attribution = modelAttribution(result)
  const rows = [{ kind: 'source', source: attribution.source }]

  if (attribution.requested) {
    rows.push({ kind: 'requested', value: [attribution.requested.provider, attribution.requested.model].filter(Boolean).join(': ') })
    rows.push({ kind: 'requestedNote' })
  }

  rows.push({
    kind: 'receipt',
    confirmed: Boolean(attribution.receipt),
    provider: attribution.receipt ? attribution.receipt.provider : null,
    model: attribution.receipt ? attribution.receipt.model : null,
    reason: attribution.receipt ? null : attribution.receiptExpected ? 'none' : 'not-carried'
  })

  return rows
}

/**
 * One of the backend's operator hints, in the active UI language.
 *
 * The backend ships both locales in `trust.hints` (en + zh) so a language switch
 * repaints without another read; the flat `unlock_hint` / `revoke_hint` stay the
 * English ones for a backend that predates the map.
 */
export function permissionHint(trust, kind, locale) {
  const data = trust && typeof trust === 'object' ? trust : {}
  const key = kind === 'grant' ? 'unlock_hint' : 'revoke_hint'
  const byLang = data.hints && typeof data.hints === 'object' ? data.hints[locale] : null
  const localized = byLang && typeof byLang[key] === 'string' ? byLang[key] : ''

  return localized || (typeof data[key] === 'string' ? data[key] : '')
}

/**
 * The model source of a run, as the compare view must report it.
 *
 * `path` is the transport door; `source` is the reason, and there are THREE.
 * The distinction matters because a pinned dedicated model and a brand-new
 * composer with no live chat both ride the profile's global channel — the
 * screenshot case where a dedicated DeepSeek pick (and a Kimi run) came back
 * labelled "global model" and looked like the plugin had ignored the choice.
 */
export const RUN_SOURCES = ['dedicated', 'session', 'global']

/** i18n key for a run source; an unknown source has none (never guessed). */
export function sourceLabelKey(source) {
  if (source === 'dedicated') {
    return 'compare.sourceDedicated'
  }

  if (source === 'session') {
    return 'compare.sourceSession'
  }

  if (source === 'global') {
    return 'compare.sourceGlobalNew'
  }

  return ''
}

/**
 * What the compare view may state about the model that answered.
 *
 * The rule this enforces: a REQUEST is not a RECEIPT. `requested` is the value
 * this plugin put in the request (the pinned model in its own settings);
 * `receipt` is only ever what the HOST reported back. With no host receipt the
 * view says so instead of showing the requested model as if the provider had
 * confirmed it — which is precisely what the session door forces, because
 * `llm.oneshot` answers with `{text}` and no model name at all
 * (tui_gateway/contracts/sessions.py: `class LlmOneshotResult(Result): text: str`).
 */
export function modelAttribution(result) {
  const data = result && typeof result === 'object' ? result : {}
  const provider = typeof data.provider === 'string' ? data.provider.trim() : ''
  const model = typeof data.model === 'string' ? data.model.trim() : ''
  const raw = data.requestedModel && typeof data.requestedModel === 'object' ? data.requestedModel : null
  const requestedModel = raw && typeof raw.model === 'string' ? raw.model.trim() : ''
  const requestedProvider = raw && typeof raw.provider === 'string' ? raw.provider.trim() : ''

  return {
    source: RUN_SOURCES.indexOf(data.source) >= 0 ? data.source : '',
    requested:
      requestedModel || requestedProvider
        ? { model: requestedModel, provider: requestedProvider }
        : null,
    receipt: provider || model ? { provider: provider || '—', model: model || '—' } : null,
    // Whether a receipt could be expected AT ALL on this door. The follow-session
    // door cannot carry one, which is a different statement from "the host
    // returned none".
    receiptExpected: data.path !== 'session'
  }
}

/** Why an undo must not fire. ``null`` means it may. */
export function undoGuard(context) {
  const undo = context && context.undo

  if (!undo) {
    return 'status.nothingToUndo'
  }

  if (context.bindingKey !== undo.bindingKey || context.address !== undo.address) {
    return 'status.nothingToUndo'
  }

  if ((context.currentText || '') !== undo.applied) {
    return 'status.undoMismatch'
  }

  return null
}

/** May an arriving result still overwrite the composer? */
export function applyGuard(context) {
  if (context.runToken !== context.currentToken) {
    return 'discarded'
  }

  if (context.bindingKey !== context.startedBindingKey) {
    return 'bindingsMoved'
  }

  if ((context.currentText || '') !== context.draftAtStart) {
    return 'draftChanged'
  }

  return null
}

/**
 * The request body, or a local refusal. A pinned model is refused UP FRONT when
 * the backend already told us the gate is closed — it is never dropped from the
 * body and quietly replaced by the session model.
 */
export function buildRequest(context) {
  const draft = context.draft || ''

  if (!draft.trim()) {
    return { blocked: 'status.empty' }
  }

  if (draft.length > LIMITS.maxDraftChars) {
    // `args` is a positional list: `PluginTranslate` spreads them into a
    // function-valued leaf (`(max) => …`), it takes no options object.
    return { blocked: 'status.tooLong', args: [LIMITS.maxDraftChars] }
  }

  const templates = normalizeTemplates(context.templates)
  const settings = normalizeSettings(context.settings)
  const template = templates[context.mode] || templates.precise
  const pinned = settings.modelMode === 'pinned' ? settings.pinnedModel : null
  const gate = context.trust || null

  if (pinned && gate && gate.allow_model_override === false) {
    // Refused here, before any request exists, and the refusal names the model
    // so the user knows exactly which grant would enable it.
    return { blocked: 'status.capabilityBlocked', args: [pinned.model] }
  }

  return {
    body: {
      mode: context.mode,
      draft,
      system_template: template.system,
      user_template: template.user,
      ui_lang: context.uiLang || 'en',
      model: pinned ? pinned.model : null,
      provider: pinned && pinned.provider ? pinned.provider : null,
      timeout_s: (LIMITS.defaultTimeoutMs / 1000)
    }
  }
}

/**
 * The bodies for the two stateless doors, so the follow-session path renders the
 * SAME editorial half and output protocol as the backend path. `/prepare` takes
 * no model and no credential; `/parse` takes the answer back.
 */
export function buildPrepareBody(context) {
  const templates = normalizeTemplates(context.templates)
  const template = templates[context.mode] || templates.precise

  return {
    mode: context.mode,
    draft: context.draft || '',
    system_template: template.system,
    user_template: template.user,
    ui_lang: context.uiLang || 'en'
  }
}

export function buildParseBody(context, modelText) {
  return {
    mode: context.mode,
    draft: context.draft || '',
    model_text: typeof modelText === 'string' ? modelText : ''
  }
}

/**
 * Parameters for the official stateless RPC `llm.oneshot`
 * (tui_gateway/contracts/sessions.py: `LlmOneshotParams`).
 *
 * ``session_id`` is the whole point: the gateway looks the session up and
 * passes ``main_runtime=_main_runtime_from_agent(session['agent'])``, which is
 * how the call runs on the model the user is actually chatting with. It is
 * never omitted here — a missing/unknown ``session_id`` silently falls to the
 * `task` auxiliary lane, which is a THIRD model nobody chose.
 *
 * ``task`` is left to the backend default because it is only consulted when no
 * session lends a runtime, and this path always lends one.
 */
export function buildOneshotParams(context, prepared) {
  return {
    instructions: prepared.instructions,
    input: prepared.input,
    max_tokens: prepared.max_tokens,
    temperature: ONESHOT_TEMPERATURE,
    session_id: context.sessionId
  }
}

/**
 * Which door this run takes, and why.
 *
 * ``session`` — the live chat lends its model through `llm.oneshot`. Default.
 * ``global``  — the plugin's own `/enhance`, i.e. the host `ctx.llm` binding:
 *               the PROFILE GLOBAL model. Taken when the user pinned a model,
 *               and when the draft has no live chat yet.
 *
 * A composer with no live session deliberately reports ``global`` rather than
 * creating a chat to manufacture a session id: creating one would leave a shell
 * behind and would still not be the model the user is "following".
 *
 * ``source`` carries the REASON beside the transport, because the two global
 * cases are different choices the user made (a pinned model vs. no chat yet) and
 * a UI that only had the door called both of them "global model".
 */
export function planRun(context) {
  const settings = normalizeSettings(context.settings)
  const pinned = settings.modelMode === 'pinned' ? settings.pinnedModel : null

  if (pinned) {
    const gate = context.trust || null

    if (gate && gate.allow_model_override === false) {
      return { blocked: 'status.capabilityBlocked', args: [pinned.model], reason: 'model_override_denied' }
    }

    return { path: 'global', source: 'dedicated', reason: 'pinned-model' }
  }

  if (!context.sessionId) {
    return { path: 'global', source: 'global', reason: 'no-live-session' }
  }

  return { path: 'session', source: 'session', reason: 'follow-session' }
}

/**
 * How to reach the gateway for THIS run's owner.
 *
 * A profile name is not a machine-global name — two connections can both expose
 * a profile called ``default`` — so a run is addressed by the
 * (connectionId, profile) of the composer it started from.
 *
 * "Same backend" uses the SDK's own local-source equivalence
 * (api/client.ts `ambientOwnerConnectionId`): the local pool is spelled ``null``
 * on the ambient path and ``'local'`` on an explicit one, so those two are the
 * SAME source, while an explicit ``'local'`` against a remote ambient gateway is
 * NOT (that pin is the only way back to this machine). When the owner is a
 * different source, an explicit route descriptor is required — without one the
 * call is refused rather than quietly landing on another connection's backend.
 */
export async function resolveRunRoute(context) {
  const api = context.host || {}
  const ownerConnection = String(context.connectionId || '').trim()
  const ownerProfile = String(context.profile || '').trim() || 'default'
  const ambientRaw = typeof api.activeConnectionId === 'function' ? api.activeConnectionId() : null
  const ambientConnection = String(ambientRaw || '').trim()

  if (sameSource(ownerConnection, ambientConnection)) {
    return { mode: 'ambient' }
  }

  if (typeof api.requestProfile !== 'function' || typeof api.profileRoutes !== 'function') {
    return { mode: 'ambient', blocked: 'status.routeUnavailable' }
  }

  let routes = null

  try {
    routes = await api.profileRoutes()
  } catch (error) {
    void error

    return { mode: 'ambient', blocked: 'status.routeUnavailable' }
  }

  const match = (Array.isArray(routes) ? routes : []).find(
    route => route && sameSource(route.connectionId, ownerConnection) && route.profile === ownerProfile
  )

  return match ? { mode: 'route', route: match } : { mode: 'ambient', blocked: 'status.routeUnavailable' }
}

/** Do two connection labels name the same backend? (`null`/`''`/`'local'` = this machine.) */
function sameSource(left, right) {
  const local = value => !value || value === 'local'

  return local(left) && local(right) ? true : left === right
}

/**
 * The JSON error envelope our backend returns, recovered from the transport's
 * ``"<status>: <body>"`` message.
 *
 * Electron builds that message in `httpStatusError`
 * (apps/desktop/electron/api-transport.ts), so the backend's own
 * ``{ok:false, error:{code, message, detail}}`` is the tail of it. Recovering it
 * is what turns "403" into the plugin's actual refusal reason.
 */
export function readErrorEnvelope(message) {
  const text = typeof message === 'string' ? message : ''
  const start = text.indexOf('{')

  if (start < 0) {
    return null
  }

  try {
    const parsed = JSON.parse(text.slice(start))

    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch (error) {
    void error

    return null
  }
}

/**
 * Why a `ctx.rest` call failed, in the terms the transport actually uses.
 *
 * Verified against the live Hermes tree: `pluginRest` → `hermesApi` →
 * Electron's `hermes:api`, which rejects an HTTP >= 400 with an Error carrying
 * ``statusCode`` and the message ``"<status>: <body>"``; a failure with NO
 * ``statusCode`` never got a response at all (missing bridge, dead gateway
 * socket, deadline). Collapsing both into "network" is the fidelity bug — a 403
 * consent refusal, a 504 upstream timeout and a dropped socket have different
 * causes and different fixes.
 */
export function classifyRestFailure(error) {
  const raw = String((error && error.message) || error || '')
  // IPC preserves message but discards statusCode. Match only the transport prefix.
  const match = raw.match(/^(?:Error invoking remote method '[^']+':\s*)?(?:Error:\s*)?([45]\d{2}):(?:\s|$)/)
  const status =
    error && typeof error.statusCode === 'number' && Number.isInteger(error.statusCode) && error.statusCode >= 400 && error.statusCode <= 599
      ? error.statusCode
      : match ? Number(match[1]) : null

  if (status !== null) {
    const envelope = readErrorEnvelope(raw)
    const backend = envelope && envelope.error && typeof envelope.error === 'object' ? envelope.error : null
    const code = backend && typeof backend.code === 'string' && backend.code ? backend.code : statusCode(status)

    return {
      kind: 'http',
      status,
      code,
      message: (backend && typeof backend.message === 'string' && backend.message) || raw.slice(0, 200),
      detail: (backend && typeof backend.detail === 'string' && backend.detail) || ''
    }
  }

  if ((error && error.name) === 'AbortError' || /timed out|timeout/i.test(raw)) {
    return { kind: 'timeout', status: null, code: 'timeout', message: raw.slice(0, 200), detail: '' }
  }

  if (/bridge unavailable|gateway unavailable|not connected|gateway is not connected/i.test(raw)) {
    return { kind: 'offline', status: null, code: 'gateway', message: raw.slice(0, 200), detail: '' }
  }

  return { kind: 'transport', status: null, code: 'network', message: raw.slice(0, 200), detail: '' }
}

/** A code for a bare status when the body carried none. */
export function statusCode(status) {
  if (status === 401) return 'unauthorized'
  if (status === 403) return 'forbidden'
  if (status === 404) return 'not_found'
  if (status === 405) return 'method_not_allowed'
  if (status === 408 || status === 504) return 'timeout'
  if (status === 413) return 'too_large'
  if (status === 429) return 'busy'
  if (status >= 500) return 'server'

  return 'rejected'
}

/** The i18n key for a classified failure. Never collapses the kinds. */
export function failureMessageKey(failure) {
  const found = failure || {}

  if (found.kind === 'timeout') return 'errors.timeout'
  if (found.kind === 'offline') return 'errors.gateway'
  if (found.kind === 'transport') return 'errors.network'

  const byCode = {
    empty_response: 'errors.empty_response',
    invalid_request: 'errors.invalid_request',
    llm_unavailable: 'errors.llm_unavailable',
    model_not_allowed: 'errors.model_not_allowed',
    model_override_denied: 'errors.model_override_denied',
    provider_not_allowed: 'errors.provider_not_allowed',
    provider_override_denied: 'errors.provider_override_denied',
    upstream_error: 'errors.upstream_error',
    upstream_timeout: 'errors.upstream_timeout',
    gateway_method_missing: 'errors.gateway_method_missing',
    gateway_generation: 'errors.gateway_generation',
    gateway_refused: 'errors.gateway_refused'
  }

  if (byCode[found.code]) {
    return byCode[found.code]
  }

  return 'errors.' + statusCode(found.status)
}

/**
 * Why a gateway JSON-RPC call failed.
 *
 * `host.request` rejects with `JsonRpcGatewayError` (`code` + `message`) for a
 * server-side error, and a plain Error for "gateway not connected" / a timed-out
 * request (apps/shared/src/json-rpc-channel.ts). A JSON-RPC code is NOT an HTTP
 * status, so it gets its own classifier instead of being run through the REST
 * one and reported as a status that never existed.
 */
export function classifyGatewayFailure(error) {
  const raw = String((error && error.message) || error || '')
  const code = error && typeof error.code === 'number' ? error.code : null

  if ((error && error.name) === 'AbortError' || /timed out|timeout/i.test(raw)) {
    return { kind: 'timeout', status: null, code: 'timeout', message: raw.slice(0, 200), detail: '' }
  }

  if (/not connected|unavailable/i.test(raw)) {
    return { kind: 'offline', status: null, code: 'gateway', message: raw.slice(0, 200), detail: '' }
  }

  if (code === -32601) {
    return { kind: 'gateway', status: null, code: 'gateway_method_missing', message: raw.slice(0, 200), detail: '' }
  }

  if (code === 5030) {
    return { kind: 'gateway', status: null, code: 'gateway_generation', message: raw.slice(0, 200), detail: '' }
  }

  if (code === 4030 || code === 4031 || code === 4032) {
    return { kind: 'gateway', status: null, code: 'gateway_refused', message: raw.slice(0, 200), detail: '' }
  }

  return { kind: 'gateway', status: null, code: 'gateway', message: raw.slice(0, 200), detail: '' }
}

/** The classifier for whichever door this failure came through. */
export function classifyFailure(error, path) {
  // A session run also calls REST prepare/parse; route by the actual error shape.
  const raw = String(error?.message || '')
  if (typeof error?.statusCode === 'number' || /^(?:Error invoking remote method '[^']+':\s*)?(?:Error:\s*)?[45]\d{2}:/.test(raw)) {
    return classifyRestFailure(error)
  }
  return path === 'session' ? classifyGatewayFailure(error) : classifyRestFailure(error)
}

/** Rows for the comparison view; ``null`` scores are rendered as an em dash. */
export function scoreRows(scores) {
  if (!scores || !scores.original || !scores.enhanced) {
    return []
  }


  const rows = DIMENSIONS.map(key => ({
    key,
    original: scores.original[key],
    enhanced: scores.enhanced[key]
  }))

  rows.push({ key: 'overall', original: scores.original.overall, enhanced: scores.enhanced.overall })

  return rows
}

export function scoreErrorKey(scoreError) {
  const map = {
    empty: 'compare.reasonEmpty',
    unparseable: 'compare.reasonUnparseable',
    unrecognized: 'compare.reasonUnrecognized',
    absent: 'compare.reasonAbsent'
  }

  return map[scoreError] || 'compare.reasonAbsent'
}

export function protectionSummary(report) {
  if (!report || typeof report !== 'object') {
    return { tone: 'ok', total: 0, missing: [], altered: [], truncated: false }
  }

  return {
    tone: (report.missing || []).length ? 'block' : (report.altered_whitespace || []).length ? 'warn' : 'ok',
    total: report.total || 0,
    missing: report.missing || [],
    altered: report.altered_whitespace || [],
    truncated: Boolean(report.truncated)
  }
}

export function truncate(text, max) {
  const value = typeof text === 'string' ? text : ''

  return value.length <= max ? value : value.slice(0, max) + '…'
}

/**
 * Bounds on the comparison view's line diff.
 *
 * The point of the caps is that a huge paste must not turn opening the compare
 * view into a multi-second stall: past them the dialog states the reason and
 * shows the two full texts instead, which is the same information without the
 * cost.
 */
export const DIFF_LIMITS = { maxLines: 400, maxCells: 120000 }

/** Rows the diff view renders at most (unchanged context is collapsed visually). */
export const DIFF_MAX_ROWS = 1200

function diffLines(text) {
  return (typeof text === 'string' ? text : '').split('\n')
}

/** Suffix-length table for the two line arrays, built once (O(n·m), capped). */
function lcsTable(a, b) {
  const table = []

  for (let i = 0; i <= a.length; i += 1) {
    table.push(new Int32Array(b.length + 1))
  }

  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
    }
  }

  return table
}

/**
 * A line-level diff of the two drafts, computed once and purely.
 *
 * WHY LINE LEVEL: the requirement is a readable add/remove highlight that keeps
 * the exact text — code blocks and paths verbatim, Chinese/English mixed as
 * written. Indexing lines and rendering them unchanged does that without
 * altering a single character, and without a word-level pass that could quietly
 * "polish" the very code it is displaying.
 *
 * WHY NOT A DOM DIFF: the result is a plain array the renderer maps over, so
 * React never has to diff two large trees, and the LCS pass is bounded by
 * DIFF_LIMITS — past them the caller falls back to the full-text view with a
 * stated reason instead of spending seconds on a long paste.
 *
 * Rebuilding either side from the rows must return the input text exactly:
 * `same` + `remove` is the original, `same` + `add` is the enhanced draft.
 */
export function diffDrafts(original, enhanced) {
  const a = diffLines(original)
  const b = diffLines(enhanced)

  if (
    a.length > DIFF_LIMITS.maxLines ||
    b.length > DIFF_LIMITS.maxLines ||
    a.length * b.length > DIFF_LIMITS.maxCells
  ) {
    return { ok: false, reason: 'too-large', lines: Math.max(a.length, b.length) }
  }

  const table = lcsTable(a, b)
  const rows = []
  let i = 0
  let j = 0

  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      rows.push({ kind: 'same', text: a[i], originalLine: i + 1, enhancedLine: j + 1 })
      i += 1
      j += 1
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      rows.push({ kind: 'remove', text: a[i], originalLine: i + 1, enhancedLine: null })
      i += 1
    } else {
      rows.push({ kind: 'add', text: b[j], originalLine: null, enhancedLine: j + 1 })
      j += 1
    }
  }

  while (i < a.length) {
    rows.push({ kind: 'remove', text: a[i], originalLine: i + 1, enhancedLine: null })
    i += 1
  }

  while (j < b.length) {
    rows.push({ kind: 'add', text: b[j], originalLine: null, enhancedLine: j + 1 })
    j += 1
  }

  return {
    ok: true,
    rows,
    added: rows.filter(row => row.kind === 'add').length,
    removed: rows.filter(row => row.kind === 'remove').length,
    identical: rows.every(row => row.kind === 'same')
  }
}


// ── runtime + in-memory state ───────────────────────────────────────────────

const runtime = {
  ctx: null,
  rest: null,
  storage: null,
  setInterval: null,
  setMode: null,
  host: null
}

/** Non-sensitive, persisted (plugin storage). */
let settings = normalizeSettings(null)
let templates = normalizeTemplates(null)

/**
 * Set once when a stored template pair was still the pre-fusion sample and got
 * upgraded. Surfaced in the Templates tab so the change is visible rather than
 * silent, and cleared as soon as the user saves or restores.
 */
let templatesMigrated = false

/** Sensitive-ish, MEMORY ONLY. Never written to storage. */
const memory = {
  runToken: 0,
  undo: null,
  lastError: null,
  lastResult: null,
  runs: []
}

function initialUi() {
  return {
    running: false,
    startedAt: 0,
    settingsOpen: false,
    compareOpen: false,
    compare: null,
    /** The result page's detail disclosure. Collapsed by default: the
     *  main line already carries the source, the model and the duration. */
    resultDetails: false,
    /** A staged import: the archive's payload, the reasons it cannot be
     *  applied, and where it was read from. `null` means nothing staged. */
    importOpen: false,
    importPreview: null,
    importErrors: [],
    /** The paste door's text. Lives in ui state so the panel can be driven
     *  and inspected without a live React tree. */
    importPaste: '',
    /* The rollback slot, projected for the control that offers it. Kept in
     * the ui atom rather than read during render, so the panel repaints the
     * moment the slot changes (a save, an import, a rollback). */
    previousAvailable: false,
    previousSavedAt: null,
    previousState: null,
    trust: null,
    capabilityError: null,
    binding: 'unavailable',
    protocolVersion: null,
    templateDraft: null,
    templateError: false,
    templatesMigrated
  }
}

const $ui = atom(initialUi())

function setUi(patch) {
  $ui.set(Object.assign({}, $ui.get(), patch))
}

function rememberRun(entry) {
  memory.runs.unshift(entry)

  if (memory.runs.length > 8) {
    memory.runs.length = 8
  }

  setUi({})
}

/** Non-React translator. Args are SPREAD, matching `PluginTranslate`. */
function t(key, ...args) {
  const translate = runtime.ctx && runtime.ctx.i18n && runtime.ctx.i18n.t

  if (typeof translate !== 'function') {
    return key
  }

  return translate(key, ...args)
}

function notify(kind, message) {
  try {
    host.notify({ kind: kind === 'error' ? 'error' : kind === 'warn' ? 'warn' : 'info', message })
  } catch (error) {
    void error
  }
}

function readState() {
  const state = host.state || {}
  const read = key => {
    const node = state[key]

    return node && typeof node.get === 'function' ? node.get() : null
  }

  return {
    focusedRuntimeId: read('focusedSessionId'),
    focusedStoredId: read('focusedStoredSessionId'),
    activeSessionId: read('activeSessionId'),
    /*
     * `focusedSessionOwner` is the connection-qualified owner of the FOCUSED
     * chat — the atom core tells plugins to prefer "for any readout or mutation
     * where separate sources can share a profile name". A binding built from a
     * bare profile name would treat two same-named profiles on different
     * connections as one surface.
     */
    connectionId: (read('focusedSessionOwner') || {}).connectionId || read('connectionId') || '',
    profile:
      (read('focusedSessionOwner') || {}).profile || read('focusedSessionProfile') || read('profile') || ''
  }
}

function currentBindingKey(address) {
  const state = readState()

  return bindingKey({ address, connectionId: state.connectionId, profile: state.profile })
}

function safeGetDraft(address) {
  try {
    return Promise.resolve(host.composer.getDraft(address)).then(value => value || '')
  } catch (error) {
    void error

    return Promise.resolve('')
  }
}

async function safeSetDraft(address, text) {
  try {
    return Boolean(await host.composer.setDraft(address, text))
  } catch (error) {
    void error

    return false
  }
}

// ── actions ─────────────────────────────────────────────────────────────────

/**
 * Seconds the current run has been going, ticking once a second while running.
 *
 * Uses `ctx.setInterval`, so the tick is torn down with the plugin and cannot
 * outlive the surface the way a bare global timer would.
 */
function useElapsedSeconds(running, startedAt) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!running) {
      return undefined
    }

    setNow(Date.now())

    const stop = typeof runtime.setInterval === 'function' ? runtime.setInterval(() => setNow(Date.now()), 1000) : null

    return () => {
      if (typeof stop === 'function') {
        stop()
      }
    }
  }, [running])

  return running ? Math.max(0, Math.round((now - (startedAt || now)) / 1000)) : 0
}

export function setMode(mode) {
  if (MODES.indexOf(mode) < 0) {
    return
  }

  settings = normalizeSettings(Object.assign({}, settings, { mode }))
  persistSettings()
  setUi({})
}

export function persistSettings() {
  try {
    runtime.storage && runtime.storage.set(STORAGE_KEYS.settings, settings)
  } catch (error) {
    void error
  }
}

function persistTemplates() {
  try {
    runtime.storage && runtime.storage.set(STORAGE_KEYS.templates, templates)
  } catch (error) {
    void error
  }
}

/** Read one storage key; a missing slot or a throwing door both answer `null`. */
function readStored(key) {
  try {
    return runtime.storage ? runtime.storage.get(key, null) : null
  } catch (error) {
    void error

    return null
  }
}

/**
 * Where the stored templates came from, normalised to the shipped shape.
 *
 * Storage-only bookkeeping: no draft, result, score or model setting. An
 * unrecognised `state`/`source` normalises to `null` rather than being echoed —
 * a string this build does not know is not something it may report as fact.
 */
export function normalizeTemplateMeta(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}

  return {
    schema: TEMPLATE_META_SCHEMA,
    state: TEMPLATE_META_STATES.indexOf(source.state) >= 0 ? source.state : null,
    version: Number.isInteger(source.version) ? source.version : null,
    fromVersion: Number.isInteger(source.fromVersion) ? source.fromVersion : null,
    source: TEMPLATE_WRITE_SOURCES.indexOf(source.source) >= 0 ? source.source : null,
    updatedAt: typeof source.updatedAt === 'number' ? source.updatedAt : null
  }
}

/** The stored record of where the current templates came from. */
export function templateMeta() {
  return normalizeTemplateMeta(readStored(STORAGE_KEYS.templateMeta))
}

function persistTemplateMeta(meta) {
  try {
    if (runtime.storage) {
      runtime.storage.set(STORAGE_KEYS.templateMeta, meta)
    }
  } catch (error) {
    void error
  }
}

function persistSnapshot(snapshot) {
  try {
    if (runtime.storage) {
      runtime.storage.set(STORAGE_KEYS.templatePrevious, snapshot)
    }
  } catch (error) {
    void error
  }
}

/** A usable pair, or `null`: a slot is only usable if a run could send it. */
function usablePair(candidate) {
  const check = validateTemplatePair(candidate)

  return check.ok ? { system: candidate.system, user: candidate.user } : null
}

/**
 * The ONE previous version, or `null` when the slot is empty or unusable.
 *
 * Composed fresh on every read, so the caller can never mutate what is stored.
 */
export function previousTemplates() {
  return normalizeSnapshot(readStored(STORAGE_KEYS.templatePrevious))
}

function normalizeSnapshot(raw) {
  if (!raw || typeof raw !== 'object') {
    return null
  }

  const precise = usablePair(raw.precise)
  const creative = usablePair(raw.creative)

  if (!precise || !creative) {
    return null
  }

  return {
    precise,
    creative,
    meta: normalizeTemplateMeta(raw.meta),
    savedAt: typeof raw.savedAt === 'number' ? raw.savedAt : null
  }
}

/** The recorded version BOTH modes sit on, or `null` when they differ. */
export function defaultVersionOf(pair) {
  const versions = MODES.map(mode => templateVersionOf(pair ? pair[mode] : null, mode))

  return versions[0] !== null && versions.every(version => version === versions[0]) ? versions[0] : null
}

/**
 * Put `next` live, keep the outgoing pair in the rollback slot, record why.
 *
 * The single write path for every template change (migration, a hand edit,
 * restore-defaults, an import, a rollback), so the slot and the record can never
 * disagree with what is live. `outgoingSource` lets the boot pass the pair it
 * READ from storage — at that moment the module state is still the default pair,
 * not the stored one.
 *
 * The record's `version` is always DERIVED from the pair just written (see
 * `defaultVersionOf`), and a caller cannot state one: the bytes are checkable
 * and a claim is not, so an archive that claimed a version its content is not
 * can never reach the record through this door.
 */
function commitTemplates(next, metaPatch, outgoingSource) {
  const outgoing = outgoingSource && typeof outgoingSource === 'object' ? outgoingSource : templates

  persistSnapshot({
    precise: { system: outgoing.precise ? outgoing.precise.system : '', user: outgoing.precise ? outgoing.precise.user : '' },
    creative: {
      system: outgoing.creative ? outgoing.creative.system : '',
      user: outgoing.creative ? outgoing.creative.user : ''
    },
    meta: templateMeta(),
    savedAt: Date.now()
  })

  templates = normalizeTemplates(next)
  persistTemplates()

  const version = defaultVersionOf(templates)
  const patch = Object.assign({}, metaPatch)

  delete patch.version

  const fromVersions = (patch && patch.fromVersions) || []

  refreshRollback()

  persistTemplateMeta(
    Object.assign(
      {
        schema: TEMPLATE_META_SCHEMA,
        state: version === null ? 'edited' : 'default',
        version,
        fromVersion: fromVersions.length === 1 ? fromVersions[0] : null,
        source: null,
        updatedAt: Date.now()
      },
      patch
    )
  )
}

/**
 * Make the stored version record describe the pair that is live.
 *
 * The record is bookkeeping; the BYTES are the fact, and two ordinary paths left
 * them disagreeing:
 *
 *  * a first run stores no templates at all, so `templates.v1` is absent while
 *    the plugin already serves the shipped default — the record said nothing,
 *    and a real export therefore carried `template_version: null`;
 *  * a stored record can be stale or absent after an import, or after an older
 *    build wrote a pair this one recognises as a shipped default.
 *
 * It writes ONLY the record — never `templates.v1`, never the rollback slot, so
 * the user's bytes and the previous version stay exactly as they were — and it
 * only writes when the record actually disagrees, so an untouched install is not
 * rewritten on every boot. `state`/`source`/`fromVersion` are preserved: this
 * settles the version, it does not invent a new origin for the content.
 */
export function settleTemplateVersion() {
  const stored = readStored(STORAGE_KEYS.templateMeta)
  const meta = normalizeTemplateMeta(stored)
  const version = defaultVersionOf(templates)
  const absent = typeof stored !== 'object' || stored === null

  if (!absent && meta.version === version) {
    return { ok: true, changed: false, version }
  }

  persistTemplateMeta({
    schema: TEMPLATE_META_SCHEMA,
    state: meta.state || (version === null ? 'edited' : 'default'),
    version,
    fromVersion: meta.fromVersion,
    source: meta.source,
    updatedAt: Date.now()
  })

  return { ok: true, changed: true, version }
}

/**
 * Restore the ONE previous version — and make the move itself reversible.
 *
 * The rollout is a swap, not a pop: the pair being left behind takes the slot,
 * so a wrong rollback can be rolled back to where the user already was. It
 * refuses an empty slot and a slot whose content a run could not send, leaving
 * the live templates untouched in both cases.
 */
export function restorePreviousTemplates() {
  const stored = readStored(STORAGE_KEYS.templatePrevious)

  if (!stored || typeof stored !== 'object') {
    return { ok: false, reason: 'empty' }
  }

  const snapshot = normalizeSnapshot(stored)

  if (!snapshot) {
    return { ok: false, reason: 'unusable' }
  }

  commitTemplates(
    { precise: snapshot.precise, creative: snapshot.creative },
    { state: 'rolled-back', version: defaultVersionOf(snapshot), fromVersion: null, source: 'rollback' }
  )

  notify('info', t('settings.templatePreviousRestored'))

  return { ok: true, meta: templateMeta() }
}

/**
 * Project the rollback slot into the ui atom.
 *
 * Called from the one place the slot can change (the template write path) and
 * from the panel that offers the control, so "there is a previous version" can
 * never be stale in either direction.
 */
function refreshRollback() {
  const panel = previousVersionPanel()

  setUi({ previousAvailable: panel.available, previousSavedAt: panel.savedAt, previousState: panel.state })
}

/** Invalidate the in-flight run: its answer is dropped on arrival. */
export function stopRun() {
  memory.runToken += 1
  setUi({ running: false })
  notify('info', t('status.stopped'))
  rememberRun({ at: Date.now(), mode: settings.mode, outcome: 'stopped' })
}

/**
 * One gateway JSON-RPC call through the run's resolved route.
 *
 * `ctx.rest` cannot reach the gateway — it is scoped to
 * `/api/plugins/<id>` by construction — so the follow-session path goes through
 * `host.request` (or `host.requestProfile` for an explicitly-routed owner).
 */
async function gatewayRequest(route, method, params, timeoutMs) {
  if (!host || typeof host.request !== 'function') {
    throw new Error('Hermes gateway unavailable')
  }

  if (route && route.mode === 'route') {
    return host.requestProfile(route.route, method, params, timeoutMs, { spawnPriority: 'foreground' })
  }

  return host.request(method, params, timeoutMs)
}

/**
 * One run through the host's `ctx.llm` binding — the PROFILE GLOBAL model.
 *
 * This is the honest answer for a pinned model and for a draft with no live
 * chat. It is never used to stand in for "follow the session": `ctx.llm` has no
 * session to borrow, so claiming otherwise would be a silent model
 * substitution.
 */
async function runThroughBackend(prepared, timeoutMs) {
  const response = await runtime.rest('/enhance', {
    method: 'POST',
    body: Object.assign({}, prepared.body, { timeout_s: timeoutMs / 1000 }),
    timeoutMs
  })

  return response
}

/**
 * One run that FOLLOWS the live session's model.
 *
 * Three calls, one body: `/prepare` renders the two messages (pure — no model,
 * no credential, no state), `llm.oneshot` runs them on the session's own model
 * (the official stateless RPC: a live `session_id` lends `main_runtime`, and
 * nothing is appended to the conversation), `/parse` turns the answer into the
 * body `/enhance` would have produced, so scoring and exact-content protection
 * cannot drift between the two paths.
 *
 * The draft therefore reaches the MODEL exactly once — inside the fenced
 * `{{draft}}` block of the prepared user message.
 */
async function runThroughSession(sessionId, prepareBody, route, timeoutMs) {
  const preparation = await runtime.rest('/prepare', {
    method: 'POST',
    body: prepareBody,
    timeoutMs: LIMITS.defaultTimeoutMs
  })

  if (!preparation || preparation.ok !== true) {
    return { response: preparation }
  }

  const answer = await gatewayRequest(
    route,
    'llm.oneshot',
    buildOneshotParams({ sessionId }, preparation),
    timeoutMs
  )
  const modelText = answer && typeof answer.text === 'string' ? answer.text : ''
  const parsed = await runtime.rest('/parse', {
    method: 'POST',
    body: buildParseBody({ mode: prepareBody.mode, draft: prepareBody.draft }, modelText),
    timeoutMs: LIMITS.defaultTimeoutMs
  })

  return { response: parsed, modelText }
}

export async function runEnhance(options) {
  const requestedMode = (options && options.mode) || settings.mode
  const mode = MODES.indexOf(requestedMode) >= 0 ? requestedMode : 'precise'

  if ($ui.get().running) {
    stopRun()

    return { outcome: 'stopped' }
  }

  const snapshot = readState()
  const resolved = resolveAddress(snapshot)
  const draft = await safeGetDraft(resolved.address)
  const startedBinding = await currentBindingKey(resolved.address)
  const gate = $ui.get().trust
  const sessionId = snapshot.focusedRuntimeId || null

  const prepared = buildRequest({
    draft,
    mode,
    templates,
    settings: Object.assign({}, settings, { mode }),
    uiLang: uiLang(),
    trust: gate
  })

  if (prepared.blocked) {
    const message = t(prepared.blocked, ...(prepared.args || []))
    notify(prepared.blocked === 'status.capabilityBlocked' ? 'warn' : 'info', message)

    if (prepared.blocked === 'status.capabilityBlocked') {
      rememberRun({ at: Date.now(), mode, outcome: 'blocked', reason: 'model_override_denied' })
    }

    return { outcome: 'blocked', reason: prepared.blocked }
  }

  const plan = planRun({
    settings: Object.assign({}, settings, { mode }),
    trust: gate,
    sessionId
  })

  if (plan.blocked) {
    notify('warn', t(plan.blocked))
    rememberRun({ at: Date.now(), mode, outcome: 'blocked', reason: plan.reason })

    return { outcome: 'blocked', reason: plan.reason }
  }

  // The route is resolved BEFORE the run starts: an owner on another connection
  // with no descriptor is refused here, never sent to the wrong backend.
  const route = plan.path === 'session' ? await resolveRunRoute({ host, connectionId: snapshot.connectionId, profile: snapshot.profile }) : { mode: 'ambient' }

  if (route.blocked) {
    notify('warn', t(route.blocked))
    rememberRun({ at: Date.now(), mode, outcome: 'blocked', reason: 'routeUnavailable' })

    return { outcome: 'blocked', reason: 'routeUnavailable' }
  }

  if (plan.path === 'global' && plan.reason === 'no-live-session') {
    // Not an error — a stated downgrade. Say so instead of pretending the run
    // followed a chat that does not exist yet.
    notify('info', t('status.noLiveSession'))
  }

  const prepareBody = buildPrepareBody({ mode, draft, templates, uiLang: uiLang() })

  const token = memory.runToken + 1
  memory.runToken = token
  memory.startedAt = Date.now()
  setUi({ running: true, startedAt: memory.startedAt, path: plan.path })

  let response = null
  let failure = null

  try {
    response =
      plan.path === 'session'
        ? (await runThroughSession(sessionId, prepareBody, route, LIMITS.defaultTimeoutMs)).response
        : await runThroughBackend(prepared, LIMITS.defaultTimeoutMs)
  } catch (error) {
    failure = error
  }

  if (token !== memory.runToken) {
    // Stopped (or superseded) while the call was in flight: drop it silently,
    // never paint it, never write it.
    return { outcome: 'discarded' }
  }

  setUi({ running: false })

  if (failure) {
    const classified = classifyFailure(failure, plan.path)
    memory.lastError = {
      at: Date.now(),
      code: classified.code,
      kind: classified.kind,
      status: classified.status,
      message: classified.detail || classified.message || ''
    }
    setUi({})
    notify('error', t(failureMessageKey(classified), truncate(classified.detail || classified.message || '', 200)))

    const reason = classified.status ? String(classified.status) : classified.kind
    rememberRun({ at: Date.now(), mode, outcome: 'failed', reason: reason })

    return { outcome: 'failed', reason: reason, failure: classified }
  }

  if (!response || response.ok !== true) {
    const error = (response && response.error) || { code: 'unknown', message: '' }
    const key = 'errors.' + error.code
    const rendered = t(key, truncate(error.detail || error.message || '', 200))
    const message = rendered === key ? t('errors.upstream_error', truncate(error.message, 200)) : rendered

    memory.lastError = {
      at: Date.now(),
      code: error.code,
      kind: 'backend',
      status: null,
      message: error.detail || error.message || ''
    }
    setUi({})

    if (error.code !== 'empty_response') {
      notify('error', message)
    }

    rememberRun({ at: Date.now(), mode, outcome: 'failed', reason: error.code })

    return { outcome: 'failed', reason: error.code, error }
  }

  // What the REQUEST carried, frozen at start (the settings can change while a
  // run is in flight), then superseded by the host's own record of it when the
  // backend reported one. Kept apart from provider/model so a request can never
  // be shown as a receipt.
  const requestedAtStart =
    prepared.body && (prepared.body.model || prepared.body.provider)
      ? { model: prepared.body.model || '', provider: prepared.body.provider || '' }
      : null
  const reportedRequest =
    response.requested_model && typeof response.requested_model === 'object' ? response.requested_model : null
  const requestedModel = reportedRequest
    ? { model: reportedRequest.model || '', provider: reportedRequest.provider || '' }
    : requestedAtStart

  const result = {
    original: draft,
    enhanced: response.enhanced,
    scores: response.scores || null,
    scoreError: response.score_error || null,
    // The model's own same-call account of its edit. Absent is normal: it is
    // shown as unverified prose, never as a verified change list, and a missing
    // note never costs the body and never triggers a follow-up request.
    changeNote: typeof response.changes === 'string' ? response.changes.trim() : '',
    textShape: response.text_shape || null,
    protection: protectionSummary(response.protection),
    provider: response.provider || '',
    model: response.model || '',
    usage: response.usage || null,
    durationMs: typeof response.duration_ms === 'number' ? response.duration_ms : null,
    mode,
    // Which door produced this (`session` borrowed the live chat's model,
    // `global` used the profile's own binding) and, separately, WHY it did
    // (`source`): a dedicated model and a composer with no live chat both ride
    // the global channel but are different choices, and only the source tells
    // the user which one happened.
    path: plan.path,
    source: plan.source || '',
    requestedModel,
    route: response.llm_binding || (plan.path === 'session' ? sessionId ? 'session' : 'unknown' : 'unknown'),
    at: Date.now()
  }

  memory.lastResult = result

  const verdict = applyGuard({
    runToken: token,
    currentToken: memory.runToken,
    bindingKey: await currentBindingKey(resolveAddress(readState()).address),
    startedBindingKey: startedBinding,
    currentText: await safeGetDraft(resolved.address),
    draftAtStart: draft
  })

  if (verdict === 'bindingsMoved') {
    setUi({ compare: result, compareOpen: true, resultDetails: false })
    notify('warn', t('status.bindingsMoved'))
    rememberRun({ at: Date.now(), mode, outcome: 'discarded', reason: 'bindingsMoved' })

    return { outcome: 'discarded', reason: 'bindingsMoved', result }
  }

  if (verdict === 'draftChanged') {
    setUi({ compare: result, compareOpen: true, resultDetails: false })
    notify('warn', t('status.draftChanged'))
    rememberRun({ at: Date.now(), mode, outcome: 'discarded', reason: 'draftChanged' })

    return { outcome: 'discarded', reason: 'draftChanged', result }
  }

  if (result.protection.tone === 'block') {
    // Never overwrite silently when exact content went missing: show it and let
    // the user decide from the comparison view.
    setUi({ compare: result, compareOpen: true, resultDetails: false })
    notify('warn', t('compare.protectionMissing', result.protection.missing.length))
    rememberRun({ at: Date.now(), mode, outcome: 'blocked', reason: 'protection' })

    return { outcome: 'blocked', reason: 'protection', result }
  }

  const applied = await applyResult(result, { address: resolved.address, bindingKey: startedBinding, draft })

  return { outcome: applied ? 'applied' : 'not-applied', result }
}

/** Write a produced result into the composer and arm the single-level undo. */
/**
 * Write a result the user asked for from the compare view.
 *
 * The auto-apply path guards against a moved binding/draft; this is the same
 * guard for the SECOND, user-initiated write — the draft the result was built
 * from must still be what is in the composer, or the write is refused rather
 * than pasting the enhancement over edits made after the fact.
 */
export async function applyCompareResult(result) {
  if (!result) {
    return { outcome: 'blocked', reason: 'no-result' }
  }

  const resolved = resolveAddress(readState())
  const key = currentBindingKey(resolved.address)
  const live = await safeGetDraft(resolved.address)

  if ((live || '') !== (result.original || '')) {
    notify('warn', t('status.draftChanged'))

    return { outcome: 'blocked', reason: 'draftChanged' }
  }

  const applied = await applyResult(result, {
    address: resolved.address,
    bindingKey: key,
    draft: result.original
  })

  return { outcome: applied ? 'applied' : 'not-applied' }
}

export async function applyResult(result, context) {
  const written = await safeSetDraft(context.address, result.enhanced)

  if (!written) {
    setUi({ compare: result, compareOpen: true, resultDetails: false })
    notify('error', t('status.applyFailed'))
    rememberRun({ at: Date.now(), mode: result.mode, outcome: 'failed', reason: 'applyFailed' })

    return false
  }

  // Read back what the app actually painted: chips/normalisation can differ from
  // our string, and undo must match the LIVE text or it would refuse itself.
  const live = await safeGetDraft(context.address)

  memory.undo = {
    address: context.address,
    bindingKey: context.bindingKey,
    original: context.draft,
    applied: live,
    mode: result.mode,
    at: Date.now()
  }

  if (settings.showCompareOnSuccess) {
    setUi({ compare: result, compareOpen: true, resultDetails: false })
  } else {
    setUi({})
  }

  notify('info', t('status.applied'))
  rememberRun({ at: Date.now(), mode: result.mode, outcome: 'ok', reason: 'applied' })

  return true
}

export async function runUndo() {
  const undo = memory.undo

  if (!undo) {
    notify('info', t('status.nothingToUndo'))

    return { outcome: 'no-undo' }
  }

  const resolved = resolveAddress(readState())
  const key = currentBindingKey(resolved.address)
  const currentText = await safeGetDraft(undo.address)
  const blocked = undoGuard({
    undo,
    // Compare the composer the user is in NOW against the one we wrote to: an
    // undo that fired into a different composer would restore the wrong draft.
    address: resolved.address,
    bindingKey: key,
    currentText
  })

  if (blocked) {
    notify('warn', t(blocked))

    return { outcome: 'blocked', reason: blocked }
  }

  const written = await safeSetDraft(undo.address, undo.original)

  if (!written) {
    notify('error', t('status.undoNoSurface'))

    return { outcome: 'failed', reason: 'no-surface' }
  }

  memory.undo = null
  setUi({})
  notify('info', t('status.undoDone'))

  return { outcome: 'undone' }
}

export function clearDiagnostics() {
  memory.runs = []
  memory.lastError = null
  memory.lastResult = null
  setUi({})

  return memory
}

export async function loadCapability(rest) {
  try {
    const status = await (rest || runtime.rest)('/status')

    setUi({
      trust: (status && status.llm && status.llm.trust) || null,
      binding: (status && status.llm && status.llm.binding) || 'unavailable',
      protocolVersion: status ? status.protocol_version : null,
      capabilityError: null
    })

    return status
  } catch (error) {
    setUi({ capabilityError: truncate(String((error && error.message) || error), 160), trust: null })

    return null
  }
}

/**
 * The app's active locale, mirrored from React by `LocaleBeacon`.
 *
 * `host.state` exposes no locale atom, and a non-React handler cannot call
 * `useI18n()`. The backend only needs this to pick the RATIONALE language, so a
 * one-beacon mirror is enough; it falls back to English (the bundle the plugin
 * actually renders for an unmapped locale).
 */
let activeLocale = 'en'

function uiLang() {
  return activeLocale || 'en'
}

/**
 * Mirrors the app locale into module state and nothing else.
 *
 * Mounted with the composer action, so it follows every locale switch the user
 * makes (the same reactive signal `usePluginI18n` reads). Renders null.
 */
function LocaleBeacon() {
  const { locale } = useI18n()

  useEffect(() => {
    activeLocale = locale || 'en'
  }, [locale])

  return null
}

// ── components ──────────────────────────────────────────────────────────────

function useUi() {
  return useValue($ui)
}

function ModeMenuItem(props) {
  const { t: tr, mode, current, onPick } = props
  const active = mode === current

  return jsxs(DropdownMenuItem, {
    'data-fpe': 'mode-' + mode,
    onSelect: () => onPick(mode),
    children: [
      jsx(Codicon, { className: cn('mr-1.5', !active && 'opacity-0'), name: 'check', size: 12 }),
      jsxs('span', {
        className: 'flex min-w-0 flex-col',
        children: [
          jsx('span', { children: tr('mode.' + mode) }),
          jsx('span', {
            className: 'text-[0.68rem] text-(--ui-text-quaternary)',
            children: tr('mode.' + mode + 'Hint')
          })
        ]
      })
    ]
  })
}

function ComposerAction() {
  const ui = useUi()
  // `usePluginI18n` re-renders on a locale switch AND on a late bundle
  // registration, so the whole surface follows Hermes's language hot. Args are
  // spread — the SDK passes them straight to a function-valued leaf.
  const translate = usePluginI18n(PLUGIN_ID)

  const elapsed = useElapsedSeconds(ui.running, ui.startedAt)
  const label = ui.running ? translate('button.stop') : translate('button.run')
  const canUndo = Boolean(memory.undo)

  return jsxs('div', {
    'data-fpe': 'root',
    className: 'flex items-center gap-0.5',
    children: [
      // Mirrors the app locale into module state for the backend rationale
      // language. Renders nothing.
      jsx(LocaleBeacon, {}),
      jsxs(Button, {
        'data-fpe': 'run',
        'aria-label': label,
        'data-running': ui.running ? '1' : '0',
        className: 'h-7 gap-1 rounded-md px-2 text-[0.7rem]',
        onClick: () => {
          void runEnhance({ mode: settings.mode })
        },
        size: 'sm',
        // Progress lives in the tooltip: the button's own text is the ACTION
        // (stop), while this is the state the user is waiting on.
        title: ui.running ? translate('status.running', elapsed) : translate('button.run'),
        type: 'button',
        variant: ui.running ? 'secondary' : 'ghost',
        children: [
          ui.running
            ? jsx(GlyphSpinner, { ariaLabel: label, className: 'text-[0.75rem]', spinner: 'orbit' })
            : jsx(Codicon, { name: 'sparkle', size: 13 }),
          jsx('span', { className: 'hidden @[26rem]/composer:inline', children: translate('mode.' + settings.mode) })
        ]
      }),
      jsxs(DropdownMenu, {
        children: [
          jsx(DropdownMenuTrigger, {
            asChild: true,
            children: jsx(Button, {
              'data-fpe': 'menu-trigger',
              'aria-label': translate('button.menu'),
              className: 'h-7 w-5 rounded-md px-0',
              size: 'sm',
              title: translate('button.menu'),
              type: 'button',
              variant: 'ghost',
              children: jsx(Codicon, { name: 'chevron-down', size: 12 })
            })
          }),
          jsxs(DropdownMenuContent, {
            align: 'end',
            className: 'w-64',
            'data-fpe': 'menu',
            children: [
              jsx('div', {
                className: 'px-2 py-1 text-[0.68rem] text-(--ui-text-quaternary)',
                children: translate('menu.modeSection')
              }),
              jsx(ModeMenuItem, { current: settings.mode, mode: 'precise', onPick: setMode, t: translate }),
              jsx(ModeMenuItem, { current: settings.mode, mode: 'creative', onPick: setMode, t: translate }),
              jsx(DropdownMenuSeparator, {}),
              jsx('div', {
                className: 'px-2 py-1 text-[0.68rem] text-(--ui-text-quaternary)',
                children: translate('menu.actionSection')
              }),
              jsx(DropdownMenuItem, {
                'data-fpe': 'compare',
                disabled: !memory.lastResult,
                onSelect: () => setUi({ compare: memory.lastResult, compareOpen: Boolean(memory.lastResult) }),
                children: translate('menu.compare')
              }),
              jsx(DropdownMenuItem, {
                'data-fpe': 'undo',
                disabled: !canUndo,
                onSelect: () => {
                  void runUndo()
                },
                children: translate('menu.undo')
              }),
              jsx(DropdownMenuSeparator, {}),
              jsx(DropdownMenuItem, {
                'data-fpe': 'settings',
                onSelect: () => openSettings(),
                children: translate('menu.settings')
              })
            ]
          })
        ]
      })
    ]
  })
}

/**
 * The reference scores, as a real three-column table.
 *
 * Each row used to be its own `justify-between` flex, which put the label/score
 * split wherever that row's text happened to end — so "原文" scores and "增强稿"
 * scores never lined up under one another. A table gives every row the same
 * column count and one shared width per column, which is the alignment the
 * reader needs to compare the two sides at a glance. Numeric cells are
 * right-aligned in tabular figures so the digits stack too.
 */
function ScoreTable(props) {
  const tr = props.t
  const rows = scoreRows(props.scores)
  // `align-top`, not `align-bottom`: the host bundle compiles no `align-bottom`
  // rule (nothing in the host source uses it), so that class — which this table
  // shipped — rendered nothing at all.
  const cell = 'px-1 pb-1 align-top'
  const head = cn(cell, 'text-[0.68rem] font-normal text-(--ui-text-quaternary)')
  const headScore = cn(head, 'text-right tabular-nums')
  const score = cn(cell, 'text-right tabular-nums')
  const show = value => (value === null || value === undefined ? '—' : String(value))

  if (!rows.length) {
    return jsx('div', {
      'data-fpe': 'no-scores',
      className: 'text-[0.72rem] text-(--ui-text-tertiary)',
      children: tr('compare.noScores', tr(scoreErrorKey(props.scoreError)))
    })
  }

  return jsx('table', {
    'data-fpe': 'scores',
    className: 'w-full border-collapse text-[0.75rem]',
    children: jsxs('tbody', {
      children: [
        jsxs('tr', {
          'data-fpe': 'score-head',
          children: [
            jsx('td', { className: cn(head, 'text-left'), children: '' }),
            jsx('td', { className: headScore, children: tr('compare.originalSide') }),
            jsx('td', { className: headScore, children: tr('compare.enhancedSide') })
          ]
        }),
        ...rows.map(row =>
          jsxs('tr', {
            'data-fpe': 'score-' + row.key,
            children: [
              jsx('td', {
                className: cn(cell, 'text-left', row.key === 'overall' && 'font-medium'),
                children: row.key === 'overall' ? tr('compare.overall') : tr('compare.dimensions.' + row.key)
              }),
              jsx('td', { className: score, children: show(row.original) }),
              jsx('td', {
                className: cn(score, 'font-medium'),
                children: show(row.enhanced)
              })
            ]
          }, row.key)
        )
      ]
    })
  })
}

function ProtectionPanel(props) {
  const tr = props.t
  const report = props.report
  const parts = []

  if (report.tone === 'ok') {
    // Zero items is not a passing check — it is a draft with nothing to check.
    // The seams differ (`protection-none` vs `protection-ok`) so a reader can
    // tell the two apart without parsing the sentence.
    const nothing = report.total === 0

    parts.push(jsx('div', {
      'data-fpe': nothing ? 'protection-none' : 'protection-ok',
      className: 'text-(--ui-text-secondary)',
      children: nothing ? tr('compare.protectionNone') : tr('compare.protectionOk', report.total)
    }))
  }

  if (report.tone === 'block') {
    parts.push(jsx('div', {
      'data-fpe': 'protection-missing',
      className: 'text-(--ui-text-secondary)',
      children: tr('compare.protectionMissing', report.missing.length)
    }))
    parts.push(jsx('ul', {
      className: 'mt-1 flex flex-col gap-0.5',
      children: report.missing.slice(0, MAX_REPORTED_MISSING).map((entry, index) =>
        jsxs('li', {
          className: 'truncate font-mono text-[0.7rem]',
          children: ['[' + entry.kind + '] ' + escapeForDisplay(entry.text)]
        }, entry.kind + index)
      )
    }))
  }

  if (report.altered.length) {
    parts.push(jsx('div', {
      'data-fpe': 'protection-altered',
      className: 'mt-1 text-(--ui-text-tertiary)',
      children: tr('compare.protectionAltered', report.altered.length)
    }))
  }

  if (report.truncated) {
    parts.push(jsx('div', {
      className: 'mt-1 text-(--ui-text-quaternary)',
      children: tr('compare.protectionTruncated', MAX_REPORTED_MISSING)
    }))
  }

  return jsxs('div', { 'data-fpe': 'protection', className: 'text-[0.72rem]', children: parts })
}

function escapeForDisplay(text) {
  return String(text).replace(/\s+/g, ' ').slice(0, 120)
}

function DraftPanel(props) {
  return jsxs('div', {
    // The row shares its width between the two sides; the TEXT box carries no
    // `flex-1`. Inside an auto-height ancestor `flex: 1 1 0%` resolves its
    // basis to zero, so the box collapsed to its own padding — the ~39px strip
    // that clipped every long draft — while `overflow-auto` hid the rest. The
    // host's dialog body is the one scroll region (see `DialogContent`), so the
    // text keeps its natural height above a readable floor instead.
    className: 'flex min-w-0 flex-1 flex-col gap-1',
    'data-fpe': props.role,
    children: [
      jsx('div', {
        className: 'text-[0.68rem] tracking-wide text-(--ui-text-quaternary) uppercase',
        children: props.title
      }),
      jsx('div', {
        className:
          'min-h-24 rounded-md border border-(--ui-stroke-secondary) bg-(--ui-bg-secondary) p-2 text-[0.75rem] whitespace-pre-wrap break-words',
        children: props.text
      })
    ]
  })
}

/**
 * Which comparison view to show, and whether the line highlight had to fall back.
 *
 * Pure so the decision is testable: an oversized paste switches to the full-text
 * view WITH the reason stated, rather than rendering a highlight nobody asked to
 * wait for. The user can always pick either view by hand; this only chooses the
 * default and reports the fallback.
 */
export function compareView(result, view) {
  const diff = diffDrafts(result ? result.original : '', result ? result.enhanced : '')
  const wanted = view === 'full' ? 'full' : 'diff'
  const fallback = wanted === 'diff' && !diff.ok

  return { view: fallback ? 'full' : wanted, fallback, diff }
}

/** The line-level add/remove highlight. Renders the text verbatim. */
function DiffPanel(props) {
  const tr = props.t
  const report = props.report
  const rows = report.rows.slice(0, DIFF_MAX_ROWS)

  return jsxs('div', {
    'data-fpe': 'diff',
    'data-added': String(report.added),
    'data-removed': String(report.removed),
    className:
      'flex min-h-24 flex-col gap-0.5 rounded-md border border-(--ui-stroke-secondary) bg-(--ui-bg-secondary) p-2 font-mono text-[0.72rem] break-words',
    children: [
      report.identical
        ? jsx('div', {
            'data-fpe': 'diff-identical',
            className: 'text-(--ui-text-quaternary)',
            children: tr('compare.diffIdentical')
          })
        : null,
      ...rows.map((row, index) =>
        jsxs('div', {
          'data-fpe': 'diff-row',
          'data-kind': row.kind,
          className: cn(
            'flex gap-2 whitespace-pre-wrap',
            row.kind === 'add' && 'text-(--ui-accent)',
            row.kind === 'remove' && 'text-(--ui-text-quaternary)'
          ),
          children: [
            // The sign carries the add/remove meaning; the text itself is never
            // decorated, so code and paths stay exactly as written.
            jsx('span', {
              'data-fpe': 'diff-sign',
              className: 'shrink-0 select-none opacity-60',
              children: row.kind === 'add' ? '+' : row.kind === 'remove' ? '−' : ' '
            }),
            jsx('span', { children: row.text === '' ? ' ' : row.text })
          ]
        }, index)
      )
    ]
  })
}

/** The two rationale strings the same call already returned. */
function RationalePanel(props) {
  const tr = props.t
  const scores = props.scores
  const sides = [
    { key: 'original', labelKey: 'compare.rationaleOriginal', text: scores.original.rationale },
    { key: 'enhanced', labelKey: 'compare.rationaleEnhanced', text: scores.enhanced.rationale }
  ].filter(side => typeof side.text === 'string' && side.text.trim())

  if (!sides.length) {
    return null
  }

  return jsxs('div', {
    'data-fpe': 'rationale',
    className: 'flex flex-col gap-1',
    children: [
      jsx('div', {
        className: 'text-[0.68rem] tracking-wide text-(--ui-text-quaternary) uppercase',
        children: tr('compare.rationaleTitle')
      }),
      ...sides.map(side =>
        jsxs('div', {
          'data-fpe': 'rationale-' + side.key,
          className: 'text-[0.72rem] text-(--ui-text-secondary)',
          children: [
            jsx('span', {
              className: 'text-(--ui-text-quaternary)',
              children: tr(side.labelKey) + ': '
            }),
            jsx('span', { children: side.text })
          ]
        }, side.key)
      )
    ]
  })
}

/** The model's own same-call account of its edit — always labelled unverified. */
function ChangeNote(props) {
  const tr = props.t
  const note = props.note

  return jsxs('div', {
    'data-fpe': 'change-note',
    'data-has-note': note ? 'true' : 'false',
    className: 'flex flex-col gap-1 text-[0.72rem]',
    children: [
      jsx('div', {
        className: 'text-[0.68rem] tracking-wide text-(--ui-text-quaternary) uppercase',
        children: tr('compare.changesTitle')
      }),
      jsx('div', {
        'data-fpe': 'change-note-text',
        className: 'text-(--ui-text-secondary)',
        children: note || tr('compare.changesNone')
      }),
      jsx('div', {
        'data-fpe': 'change-note-caveat',
        className: 'text-[0.68rem] text-(--ui-text-quaternary)',
        children: tr('compare.changesUnverified')
      })
    ]
  })
}

/**
 * The model source / request / receipt lines, INSIDE the disclosure.
 *
 * One row per fact, in :func:`resultDetails` order: the source (the channel
 * this actually ran through), what was requested, and what the host
 * confirmed. A request is never rendered where a receipt goes.
 */
function ModelSource(props) {
  const tr = props.t
  const result = props.result
  const rows = resultDetails(result).map((row, index) => {
    if (row.kind === 'source') {
      return jsx('div', {
        'data-fpe': 'model-source',
        'data-source': row.source || 'unknown',
        className: 'text-[0.7rem] text-(--ui-text-quaternary)',
        children: tr('compare.pathLabel', row.source ? tr(sourceLabelKey(row.source) || row.source) : '—')
      }, index)
    }

    if (row.kind === 'requested') {
      return jsx('div', {
        'data-fpe': 'model-requested',
        className: 'text-[0.7rem] text-(--ui-text-quaternary)',
        children: tr('compare.requestedLabel', row.value)
      }, index)
    }

    if (row.kind === 'requestedNote') {
      return jsx('div', {
        className: 'text-[0.68rem] text-(--ui-text-quaternary)',
        children: tr('compare.requestedNote')
      }, index)
    }

    return jsx('div', {
      'data-fpe': 'model-receipt',
      'data-confirmed': row.confirmed ? 'true' : 'false',
      className: 'text-[0.7rem] text-(--ui-text-quaternary)',
      children: row.confirmed
        ? tr('compare.receipt', row.provider, row.model)
        : tr(row.reason === 'none' ? 'compare.receiptNone' : 'compare.receiptNotCarried')
    }, index)
  })

  return jsx('div', { className: 'flex flex-col gap-0.5', children: rows })
}

/**
 * The main line under the title, and the toggle that opens the rest.
 *
 * The line is deliberately short: source, model, duration. The `unconfirmed`
 * marker appears whenever there is no host receipt, so a requested model is
 * never read as a confirmed one, and it stays a single line either way. The
 * toggle is a real `<button>` (RowButton) with the host's own caret, so it is
 * keyboard reachable and announces its state.
 */
function ResultSummary(props) {
  const tr = props.t
  const result = props.result
  const summary = resultSummary(result)
  const open = Boolean(props.open)
  const model = summary.model || tr('compare.summaryUnknownModel')
  const parts = [tr('compare.summary', summary.sourceKey ? tr(summary.sourceKey) : summary.source || '—', model, summary.ms)]

  if (!summary.confirmed) {
    parts.push(tr('compare.summaryUnconfirmed'))
  }

  return jsxs('div', {
    className: 'flex min-w-0 flex-col gap-0.5',
    children: [
      jsx('div', {
        'data-fpe': 'result-summary',
        'data-source': summary.source || 'unknown',
        'data-confirmed': summary.confirmed ? 'true' : 'false',
        className: 'truncate text-[0.72rem] text-(--ui-text-tertiary)',
        children: parts.join(' · ')
      }),
      jsxs(RowButton, {
        'aria-expanded': open ? 'true' : 'false',
        'data-fpe': 'result-details-toggle',
        'data-open': open ? 'true' : 'false',
        className: 'flex cursor-pointer items-center gap-1 text-[0.7rem] text-(--ui-text-quaternary) hover:text-(--ui-text-secondary)',
        onClick: () => setUi({ resultDetails: !open }),
        children: [
          jsx(DisclosureCaret, { open }),
          jsx('span', { children: open ? tr('compare.detailsHide') : tr('compare.detailsShow') })
        ]
      })
    ]
  })
}

function CompareDialog() {
  const ui = useUi()
  // `usePluginI18n` re-renders on a locale switch AND on a late bundle
  // registration, so the whole surface follows Hermes's language hot. Args are
  // spread — the SDK passes them straight to a function-valued leaf.
  const translate = usePluginI18n(PLUGIN_ID)
  const result = ui.compare
  // 'diff' (line highlight) or 'full' (both texts side by side). In-memory view
  // state only; nothing about a draft is persisted.
  const [view, setView] = useState('diff')
  // Memoised: the highlight is an LCS over the two texts, and a re-render for an
  // unrelated reason (a locale switch, the meta line ticking) must not recompute
  // it. It is bounded anyway (DIFF_LIMITS), but only runs when the inputs change.
  const composed = useMemo(() => compareView(result, view), [result, view])

  const onApply = () => {
    if (!result) {
      return
    }

    void applyCompareResult(result)
  }

  return jsx(Dialog, {
    onOpenChange: open => setUi({ compareOpen: open }),
    open: ui.compareOpen,
    children: jsxs(DialogContent, {
      'data-fpe': 'compare-dialog',
      // `max-w-lg` (32rem) is the host shell's default and `max-w-*` is a lost
      // fight against it: every scale with a rule ordered before `.max-w-lg`
      // loses outright, and `max-w-4xl` has no rule at all — which is why the
      // dialog stayed 512px wide and crushed the two full-text columns into
      // strips. `min-width` beats `max-width` whatever the order, so a minimum
      // is the lever that actually works here; 90vw keeps it inside a small
      // screen, and the host's own wide dialogs use the same `min-w-[…]` shape
      // (app/capabilities/connectors/add-dialog.tsx).
      className: 'min-w-[min(48rem,90vw)]',
      children: [
        jsxs(DialogHeader, {
          children: [
            jsx(DialogTitle, { children: translate('compare.title') }),
            // ONE short line on the main surface; everything that explains
            // how the result was produced sits behind the toggle below it.
            result ? jsx(ResultSummary, { open: Boolean(ui.resultDetails), result, t: translate }) : null,
            result && ui.resultDetails
              ? jsxs('div', {
                  'data-fpe': 'result-details',
                  className: 'flex flex-col gap-1 rounded-md border border-(--ui-stroke-secondary) p-2',
                  children: [
                    jsx('div', {
                      className: 'text-[0.68rem] tracking-wide text-(--ui-text-quaternary) uppercase',
                      children: translate('compare.detailsHint')
                    }),
                    jsx(ModelSource, { result, t: translate }),
                    result.durationMs !== null
                      ? jsx('div', {
                          'data-fpe': 'result-meta',
                          className: 'text-[0.7rem] text-(--ui-text-quaternary)',
                          children: translate(
                            'compare.resultMeta',
                            result.provider || '—',
                            result.model || '—',
                            result.durationMs,
                            translate('mode.' + result.mode)
                          )
                        })
                      : null
                  ]
                })
              : null
          ]
        }),
        result
          ? jsxs('div', {
              // The host body (a `min-h-0 … overflow-y-auto` grid, bounded by
              // the shell's `max-h-[85vh]`) is the ONE scroll region. Nothing in
              // here carries a height of its own, so the panels grow to their
              // content instead of collapsing into a private, tiny scroller.
              className: 'flex min-w-0 flex-col gap-3',
              children: [
                jsxs('div', {
                  className: 'flex items-center gap-2',
                  children: [
                    jsx('span', {
                      className: 'text-[0.68rem] text-(--ui-text-quaternary)',
                      children: translate('compare.viewTitle')
                    }),
                    jsx(SegmentedControl, {
                      'data-fpe': 'compare-view-choice',
                      'data-view': composed.view,
                      onChange: setView,
                      options: [
                        { id: 'diff', label: translate('compare.viewHighlight') },
                        { id: 'full', label: translate('compare.viewFull') }
                      ],
                      value: composed.view
                    })
                  ]
                }),
                composed.view === 'diff'
                  ? jsx(DiffPanel, { report: composed.diff, t: translate })
                  : jsxs('div', {
                      className: 'flex min-w-0 gap-3',
                      children: [
                        jsx(DraftPanel, { role: 'original', text: result.original, title: translate('compare.original') }),
                        jsx(DraftPanel, { role: 'enhanced', text: result.enhanced, title: translate('compare.enhanced') })
                      ]
                    }),
                composed.fallback
                  ? jsx('div', {
                      'data-fpe': 'diff-fallback',
                      className: 'text-[0.7rem] text-(--ui-text-quaternary)',
                      children: translate('compare.diffTooLarge', composed.diff.lines)
                    })
                  : null,
                jsx(Separator, {}),
                jsxs('div', {
                  // Its own block below the drafts, with a separator above it:
                  // the score table reads as one section rather than as a line
                  // pressed onto the bottom of the text box.
                  className: 'flex min-w-0 flex-col gap-1 pt-1',
                  children: [
                    jsxs('div', {
                      className: 'flex items-center gap-2',
                      children: [
                        jsx(Badge, { children: translate('compare.scores') }),
                        jsx('span', {
                          className: 'text-[0.68rem] text-(--ui-text-quaternary)',
                          children: translate('compare.scale')
                        })
                      ]
                    }),
                    jsx(ScoreTable, { scoreError: result.scoreError, scores: result.scores, t: translate }),
                    // The rationale the same call already produced. It was
                    // returned all along and simply never rendered.
                    result.scores ? jsx(RationalePanel, { scores: result.scores, t: translate }) : null,
                    jsx('div', {
                      'data-fpe': 'score-disclaimer',
                      className: 'text-[0.68rem] text-(--ui-text-quaternary)',
                      children: translate('compare.selfAssessed')
                    })
                  ]
                }),
                jsx(Separator, {}),
                jsx(ChangeNote, { note: result.changeNote, t: translate }),
                jsx(Separator, {}),
                jsxs('div', {
                  className: 'flex flex-col gap-1',
                  children: [
                    jsx('div', {
                      className: 'text-[0.68rem] tracking-wide text-(--ui-text-quaternary) uppercase',
                      children: translate('compare.protectionTitle')
                    }),
                    jsx(ProtectionPanel, { report: result.protection, t: translate })
                  ]
                })
              ]
            })
          : jsx('div', {
              'data-fpe': 'no-result',
              className: 'text-[0.75rem] text-(--ui-text-tertiary)',
              children: translate('status.noResult')
            }),
        jsxs(DialogFooter, {
          children: [
            result && result.protection.tone === 'block'
              ? jsx(Button, {
                  'data-fpe': 'apply-anyway',
                  onClick: onApply,
                  type: 'button',
                  variant: 'destructive',
                  children: translate('compare.applyAnyway')
                })
              : null,
            jsx(Button, {
              'data-fpe': 'compare-close',
              onClick: () => setUi({ compareOpen: false }),
              type: 'button',
              variant: 'ghost',
              children: translate('compare.cancel')
            })
          ]
        })
      ]
    })
  })
}

// ── the authorization surface ───────────────────────────────────────────────

/** Capability id -> label key. An unmapped id is shown raw, never guessed at. */
const CAPABILITY_LABEL_KEYS = {
  'llm.model_override': 'settings.permissionNameModel',
  'llm.provider_override': 'settings.permissionNameProvider'
}

const DIVERGENCE_KEYS = {
  'gate-without-consent': 'settings.permissionDivergenceGateWithoutConsent',
  'consent-without-gate': 'settings.permissionDivergenceConsentWithoutGate'
}

function capabilityLabel(translate, capability) {
  const key = CAPABILITY_LABEL_KEYS[capability]

  return translate(key || capability)
}

/**
 * Authorization: what this installation has actually granted, and the official
 * entry for changing it.
 *
 * This is a READ-BACK. The two layers are reported separately because they are
 * separate facts — the override the model call is really gated on
 * (`agent/plugin_llm`), and the consent record the shipped consent screen
 * writes — and a panel that collapsed them would hide the one case that
 * matters: a gate someone opened by hand, or a record whose gate went away.
 *
 * The buttons only COPY the host's own commands. Nothing here can grant or
 * revoke: the shipped consent screen is TTY-gated (it fails closed anywhere
 * else), the plugin manager RPC carries no capability action, and the plugin
 * has no consent door of its own. A button that claimed otherwise would be a
 * lie the backend then refuses.
 */
function PermissionSection(props) {
  const { trust, translate, patch } = props
  const { locale } = useI18n()
  const panel = permissionPanel(trust)

  const copy = async kind => {
    const text = permissionHint(trust, kind, locale)
    let copied = false

    try {
      const write = runtime.ctx && runtime.ctx.os && runtime.ctx.os.writeClipboard

      copied = typeof write === 'function' ? (await write(text)) !== false : false
    } catch (error) {
      void error
    }

    notify(copied ? 'info' : 'error', t(copied ? 'settings.permissionCopied' : 'settings.permissionCopyFailed'))

    return copied
  }

  const body = [
    jsx('div', { children: translate('settings.permissionTitle') }),
    jsx('div', {
      className: 'text-[0.7rem] text-(--ui-text-quaternary)',
      children: translate('settings.permissionIntro')
    })
  ]

  // The backend reported no per-capability state: say so, and show no rows. An
  // empty list that silently rendered nothing would read as "nothing granted".
  if (panel.unknown) {
    body.push(
      jsxs('div', {
        className: 'flex items-start gap-1 text-[0.7rem] text-(--ui-text-quaternary)',
        children: [
          jsx(Codicon, { 'data-fpe': 'permission-unknown', name: 'info', size: 12 }),
          jsx('span', { children: translate('settings.permissionUnknown') })
        ]
      })
    )
  }

  for (const row of panel.rows) {
    const divergenceKey = DIVERGENCE_KEYS[row.divergence]

    body.push(
      jsxs('div', {
        className: 'flex flex-col gap-0.5 rounded-md border border-(--ui-stroke-secondary) p-2 text-[0.7rem]',
        children: [
          // One badge per capability: its name, and the two flags as data — the
          // state is a fact to read, not a control to press.
          jsx(Badge, {
            'data-capability': row.capability,
            'data-consent': row.consent ? 'true' : 'false',
            'data-enforced': row.enforced ? 'true' : 'false',
            'data-fpe': 'capability-row',
            className: 'self-start',
            variant: row.enforced ? 'default' : 'secondary',
            children: capabilityLabel(translate, row.capability)
          }),
          jsx('div', {
            className: 'text-(--ui-text-quaternary)',
            children: translate(row.enforced ? 'settings.permissionEnforcedYes' : 'settings.permissionEnforcedNo')
          }),
          jsx('div', {
            className: 'text-(--ui-text-quaternary)',
            children: translate(row.consent ? 'settings.permissionConsentYes' : 'settings.permissionConsentNo')
          }),
          divergenceKey
            ? jsxs('div', {
                className: 'flex items-start gap-1',
                children: [
                  jsx(Codicon, {
                    'data-divergence': row.divergence,
                    'data-fpe': 'capability-divergence',
                    name: 'warning',
                    size: 12
                  }),
                  jsx('span', { children: translate(divergenceKey) })
                ]
              })
            : null
        ]
      })
    )
  }

  if (panel.enforcedBy) {
    body.push(
      jsx('div', {
        'data-fpe': 'permission-source',
        className: 'text-[0.68rem] text-(--ui-text-quaternary)',
        children: translate(
          'settings.permissionEnforcedBy',
          translate(
            panel.enforcedBy === 'config-mirror' ? 'settings.permissionSourceMirror' : 'settings.permissionSourceHost'
          )
        )
      })
    )
  }

  const actions = [
    jsx(Button, {
      'data-fpe': 'permission-refresh',
      className: 'h-7 rounded-md px-2 text-[0.7rem]',
      onClick: async () => {
        const status = await loadCapability()
        const next = status && status.llm ? status.llm.trust : null

        notify(next ? 'info' : 'error', t(next ? 'settings.permissionRefreshed' : 'settings.permissionRefreshFailed'))
        patch()
      },
      size: 'sm',
      type: 'button',
      variant: 'ghost',
      children: translate('settings.permissionRefresh')
    })
  ]

  if (panel.showGrant) {
    actions.push(
      jsx(Button, {
        'data-fpe': 'permission-copy-grant',
        className: 'h-7 rounded-md px-2 text-[0.7rem]',
        onClick: () => copy('grant'),
        size: 'sm',
        type: 'button',
        variant: 'ghost',
        children: translate('settings.permissionCopyGrant')
      })
    )
  }

  if (panel.showRevoke) {
    actions.push(
      jsx(Button, {
        'data-fpe': 'permission-copy-revoke',
        className: 'h-7 rounded-md px-2 text-[0.7rem]',
        onClick: () => copy('revoke'),
        size: 'sm',
        type: 'button',
        variant: 'ghost',
        children: translate('settings.permissionCopyRevoke')
      })
    )
  }

  body.push(jsx('div', { className: 'flex flex-wrap items-center gap-1', children: actions }))

  // The text stays on screen: a clipboard the host refuses must leave the user
  // something to copy by hand.
  for (const [kind, flag] of [
    ['grant', panel.showGrant],
    ['revoke', panel.showRevoke]
  ]) {
    const text = flag ? permissionHint(trust, kind, locale) : ''

    if (text) {
      body.push(
        jsx('pre', {
          'data-fpe': 'permission-' + kind + '-text',
          className: 'overflow-auto rounded bg-(--ui-bg-tertiary) p-2 font-mono text-[0.68rem]',
          children: text
        })
      )
    }
  }

  body.push(
    jsx('div', {
      'data-fpe': 'permission-note',
      className: 'text-[0.68rem] text-(--ui-text-quaternary)',
      children: translate('settings.permissionNote')
    })
  )

  return jsx('div', {
    'data-fpe': 'permission-section',
    className: 'flex flex-col gap-1 rounded-md border border-(--ui-stroke-secondary) p-2 text-[0.72rem]',
    children: body
  })
}

/**
 * Which model an enhancement runs on.
 *
 * Two explicit choices rather than one on/off row: the old row was labelled
 * "follow the session model" while its `checked` value was `modelMode ===
 * 'pinned'`, so the control read backwards from what it wrote. A segmented
 * control names both states, and the value is the state.
 *
 * Picking a model is a PLUGIN PREFERENCE: it writes `settings` and nothing else
 * — not the chat's model, not the gateway, not the composer. Whether a dedicated
 * model is AUTHORIZED is a separate fact about the installation, and the
 * authorization section below reports it as its own block. The catalog therefore
 * stays available either way; only the RUN refuses, and it names the model it
 * refused.
 */
function ModelPanel(props) {
  const { ui, translate, patch } = props
  const trust = ui.trust
  const panel = modelPanelState(trust, settings)
  const pinned = settings.pinnedModel
  const [menuOpen, setMenuOpen] = useState(false)

  const controller = useMemo(
    () => ({
      current: {
        // `''` = no level pinned, which is the TRUTH here: the run carries no
        // reasoning parameter at all (`EFFORT_TRANSPORT`), so the model sits on
        // the route's own default. A level an earlier build stored is
        // deliberately NOT reported back: handing it to the catalog would light
        // up that level's radio and badge, i.e. draw an inert value as a
        // selection that took effect.
        effort: '',
        fast: false,
        model: pinned ? pinned.model : '',
        provider: pinned ? pinned.provider : ''
      },
      select: (model, provider) => {
        settings = applyModelSelection(settings, model, provider)
        persistSettings()
        patch()
        host.composer.focus(null)

        return true
      },
      /**
       * The host's per-row thinking submenu hands its edit HERE.
       *
       * This used to be `() => {}`, then briefly became "record the pick and
       * persist it". Neither is right: the first moved the radio and changed
       * nothing; the second changed the file and still nothing reached the
       * model, so it read as a working setting. The pick cannot be carried
       * (no official plugin LLM door takes a reasoning parameter) and the
       * control cannot be hidden (the catalog menu exposes no prop for it), so
       * the honest third option is to REFUSE it: no settings write, no
       * persistence, and a notice naming the boundary. `next.fast` is left
       * alone, exactly as before — this file has no fast mode to write.
       */
      setOptions: (next, row) => {
        if (!next || next.effort === undefined || next.effort === null) {
          return
        }

        notify('warn', translate(EFFORT_TRANSPORT.pickRejectedKey))

        void row
      },
      /**
       * No level is remembered for ANY row — see `current.effort`. Returning
       * the stored level here would make the catalog render this row's effort
       * as chosen.
       */
      presetFor: () => ({}),
      /**
       * One atomic "apply this model's preset" write, as the SDK contract asks.
       *
       * Only the MODEL is applied. `preset.effort` arrives on every selection —
       * the menu fills it from the profile default — and is dropped: this build
       * cannot transmit a level, so storing it would be storing a no-op
       * (`EFFORT_TRANSPORT`).
       */
      applyPreset: (preset, row) => {
        settings = applyModelSelection(settings, row.model, row.provider)
        persistSettings()
        patch()

        void preset
      }
    }),
    // `pinned` alone is all this controller reads now that no level is reported
    // or written; `settings.pinnedEffort` is gone from this list because the
    // controller no longer lets it decide anything the menu renders.
    [pinned, patch]
  )

  const rows = [
    jsxs('div', {
      className: 'flex flex-col gap-1',
      children: [
        jsx('div', { children: translate('settings.modelTitle') }),
        jsx(SegmentedControl, {
          'data-fpe': 'model-choice',
          onChange: choice => {
            settings = applyModelChoice(settings, choice)
            persistSettings()
            patch()
          },
          options: MODEL_CHOICES.map(choice => ({ id: choice.id, label: translate(choice.labelKey) })),
          value: modelChoiceValue(settings)
        }),
        jsx('div', {
          'data-fpe': 'model-choice-hint',
          className: 'text-[0.7rem] text-(--ui-text-quaternary)',
          children: translate(panel.gateOpen ? 'settings.modelChoiceHint' : 'settings.modelChoiceHintClosed')
        })
      ]
    })
  ]

  if (panel.showCatalog) {
    rows.push(
      jsxs('div', {
        'data-fpe': 'model-catalog',
        className: 'flex flex-col gap-1',
        children: [
          jsx('div', {
            className: 'text-[0.7rem] text-(--ui-text-quaternary)',
            children: pinned ? translate('settings.modelPinnedHint') : translate('settings.modelPinnedUnset')
          }),
          // The catalog is MENU CONTENT, never a block. `ModelCatalogMenu`
          // renders Radix `Menu.Item`s at its own top level — the loading
          // skeletons and the trailing Add-custom / Edit-models rows — and
          // Radix's `MenuItem` throws `` `MenuItem` must be used within `Menu` ``
          // unless a root and a content provider sit above it. Rendered straight
          // into this panel's div (which is what shipped), the throw landed
          // inside the composer-action error boundary and took the whole toolbar
          // with it. Mount it the way core mounts its own picker
          // (model-pill.tsx) and the SDK's plugin reference does
          // (kanban/model-override.tsx), so search, provider grouping, the
          // per-row thinking/effort submenu and click-to-close all keep working.
          jsxs(DropdownMenu, {
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
          }),
          pinned
            ? jsx(Button, {
                'data-fpe': 'model-clear',
                onClick: () => {
                  settings = normalizeSettings(Object.assign({}, settings, { pinnedModel: null }))
                  persistSettings()
                  patch()
                },
                type: 'button',
                variant: 'ghost',
                children: translate('settings.modelClear')
              })
            : null
        ]
      })
    )
  }

  if (panel.showCatalog) {
    // The dedicated model's thinking level: BLOCKED by this host's plugin
    // interface, not implemented.
    //
    // There is no level to offer (no official plugin LLM door takes a reasoning
    // parameter) and no control to remove (the catalog menu exposes no prop
    // that hides its own thinking submenu), so what is left is to say so
    // plainly. Anything still on file from an earlier build is shown as what it
    // is — an inert value — never as the current selection, and it is labelled
    // with the level itself so it can be recognised rather than silently
    // deleted (`EFFORT_TRANSPORT`).
    rows.push(
      jsxs('div', {
        'data-fpe': 'model-effort',
        'data-supported': EFFORT_TRANSPORT.supported ? 'true' : 'false',
        className: 'flex flex-col gap-1',
        children: [
          jsx('div', { children: translate('settings.effortTitle') }),
          jsx('div', {
            'data-fpe': 'model-effort-blocked',
            className: 'text-[0.72rem] text-(--ui-text-secondary)',
            children: translate(EFFORT_TRANSPORT.reasonKey)
          }),
          settings.pinnedEffort
            ? jsx('div', {
                'data-effort': settings.pinnedEffort,
                'data-fpe': 'model-effort-stored',
                className: 'text-[0.7rem] text-(--ui-text-quaternary)',
                // The levels are host identifiers (`high`, `xhigh`, …), not
                // prose, so they are shown as they are — inside a sentence that
                // says they are not applied.
                children: translate('settings.effortStored', settings.pinnedEffort)
              })
            : null
        ]
      })
    )
  }

  // Authorization, as its own block: a fact about this installation, shown
  // BESIDE the picker instead of in place of it. The block reports the two host
  // layers separately and offers the shipped entry as copyable text — nothing
  // in it can grant or revoke the capability.
  rows.push(jsx(PermissionSection, { patch, translate, trust }))

  return jsxs('div', {
    'data-fpe': 'model-panel',
    className: 'flex flex-col gap-3',
    children: rows
  })
}

export function openSettings() {
  refreshRollback()
  setUi({
    settingsOpen: true,
    templateDraft: {
      precise: { system: templates.precise.system, user: templates.precise.user },
      creative: { system: templates.creative.system, user: templates.creative.user }
    },
    templateError: false
  })
}

/** Save the in-dialog template edits. Refused when {{draft}} is missing. */
export function saveTemplatesFromDraft(draft) {
  const next = {}

  for (const mode of MODES) {
    const pair = (draft && draft[mode]) || {}
    const check = validateTemplatePair(pair)

    if (!check.ok) {
      setUi({ templateError: true })

      return { ok: false, errors: check.errors }
    }

    next[mode] = { system: pair.system, user: pair.user }
  }

  templatesMigrated = false
  commitTemplates(next, { source: 'edit' })
  setUi({ templateError: false, templateDraft: null, templatesMigrated: false })
  notify('info', t('settings.templateSaved'))

  return { ok: true }
}

export function resetTemplatesToDefault() {
  templatesMigrated = false
  commitTemplates(DEFAULT_TEMPLATES, {
    state: 'default',
    version: TEMPLATE_VERSION,
    fromVersion: null,
    source: 'restore-defaults'
  })
  setUi({
    templateError: false,
    templatesMigrated: false,
    templateDraft: {
      precise: { system: templates.precise.system, user: templates.precise.user },
      creative: { system: templates.creative.system, user: templates.creative.user }
    }
  })
  notify('info', t('settings.templateResetDone'))

  return templates
}

// ── template archives: export, import, and the ONE rollback ────────────────
//
// The renderer has no filesystem access, and it must not pretend otherwise.
// `ctx.os.pickSavePath` hands back a path on the BACKEND's filesystem — the
// contract in `apps/desktop/src/contrib/plugin.ts` says in as many words to hand
// it to a `rest` call rather than write it from here — so the file routes are:
// pick, then let the backend read/write, then report what the backend said. The
// clipboard route is the second, explicitly labelled one (`ctx.os.writeClipboard`)
// and is never taken silently in place of a save that did not happen.

/** A transfer call is quick; a wedged one must not hold the dialog forever. */
const TRANSFER_TIMEOUT_MS = 20000

/** The archive's fields, in render order. */
const TRANSFER_FIELDS = ['system', 'user']

/**
 * How many changed lines the import preview shows per field.
 *
 * A preview is not an editor and must not become one: enough REAL lines for the
 * user to recognise what is about to replace their text, with an explicit count
 * for the rest rather than a silent truncation.
 */
export const PREVIEW_DIFF_ROWS = 8

/**
 * The native dialogs' filter, in the exact shape `PluginFileDialogOptions`
 * declares (`{ extensions, name }` per filter).
 */
const ARCHIVE_FILTERS = [{ extensions: ['json'], name: 'Fragile Prompt Enhance templates' }]

/** The name offered in the save dialog, mirroring the backend's own. */
function archiveFilename(body) {
  const parts = ['fragile-prompt-enhance-templates']

  if (body.mode !== 'both') {
    parts.push(body.mode)
  }

  if (body.scope !== 'both') {
    parts.push(body.scope)
  }

  return parts.join('-') + '.json'
}

/**
 * What a refused transfer says, in the transport's own terms.
 *
 * The backend's `{ error: { code } }` envelope when there is one (the same
 * envelope `readErrorEnvelope` already reads for the run path), otherwise the
 * message the door raised, collapsed onto one line.
 */
export function transferDetail(error) {
  const envelope = readErrorEnvelope(error && error.message)
  const code = envelope && envelope.error && typeof envelope.error.code === 'string' ? envelope.error.code : null

  if (code) {
    return code
  }

  const message = error && typeof error.message === 'string' ? error.message : ''

  return message.replace(/\s+/g, ' ').trim() || 'unknown error'
}

/**
 * The body an export sends: the live pair, and nothing that is not a template.
 *
 * `template_version` states what those bytes ARE — the shipped default version
 * `defaultVersionOf` recognises them as, or the explicit `custom` marker. It is
 * derived from `current` unless the caller states one, and an unusable value is
 * never echoed as `null`: a gap in this field is what made a real export of
 * default content read as "no version at all".
 */
export function exportRequestBody(current, options = {}) {
  const stated = options.version === undefined ? defaultVersionOf(current) : options.version
  const version = Number.isInteger(stated) && stated >= 1 ? stated : TEMPLATE_VERSION_CUSTOM
  const body = {
    mode: options.mode || 'both',
    scope: options.scope || 'both',
    template_version: version,
    templates: {}
  }

  for (const mode of MODES) {
    const pair = current && current[mode] ? current[mode] : {}

    body.templates[mode] = { system: pair.system, user: pair.user }
  }

  return body
}

/** The body an import sends: exactly ONE of the two doors, or `null`. */
export function importRequestBody(input) {
  const given = input && typeof input === 'object' ? input : {}

  if (typeof given.path === 'string' && given.path) {
    return { path: given.path }
  }

  if (typeof given.json === 'string' && given.json) {
    return { json: given.json }
  }

  return null
}

/**
 * One template door. Never throws: a refused archive is a result the caller
 * reports, not an exception that unwinds a click handler.
 */
async function callDoor(path, body) {
  try {
    const response = await runtime.rest(path, { method: 'POST', body, timeoutMs: TRANSFER_TIMEOUT_MS })

    return { ok: true, body: response }
  } catch (error) {
    return { ok: false, detail: transferDetail(error) }
  }
}

/**
 * The live templates, in the scope the archive asks for, with the version.
 *
 * The version comes from `exportRequestBody`'s own derivation over `templates`
 * — the bytes that are about to be packed — never from the stored record: the
 * record can be absent (a first run stores none) or stale, and reading it is
 * what produced the `null` a real export carried for default content.
 */
function transferBody(options = {}) {
  return exportRequestBody(templates, options)
}

/**
 * Export to a file the user picks.
 *
 * The path comes from the native save dialog and goes straight to the backend,
 * which is the only half that can write. A cancel — and a surface with no native
 * dialog at all, which the same door reports as `null` — says nothing was
 * exported and points at the clipboard route, rather than quietly copying the
 * archive and letting the user believe a file exists.
 */
export async function exportTemplatesToFile(options = {}) {
  const body = transferBody(options)
  const pick = runtime.os && typeof runtime.os.pickSavePath === 'function' ? runtime.os.pickSavePath : null

  if (!pick) {
    notify('info', t('settings.transferExportNoPath'))

    return { ok: false, reason: 'no-path' }
  }

  let path = null

  try {
    path = await pick({
      defaultPath: archiveFilename(body),
      filters: ARCHIVE_FILTERS,
      title: t('settings.transferExportFile')
    })
  } catch (error) {
    notify('error', t('settings.transferExportFailed', transferDetail(error)))

    return { ok: false, reason: 'failed' }
  }

  if (!path) {
    notify('info', t('settings.transferExportNoPath'))

    return { ok: false, reason: 'no-path' }
  }

  const outcome = await callDoor('/templates/export', Object.assign({}, body, { path }))

  if (!outcome.ok) {
    notify('error', t('settings.transferExportFailed', outcome.detail))

    return { ok: false, reason: 'failed', detail: outcome.detail }
  }

  const written = outcome.body && outcome.body.written ? outcome.body.path || path : null

  notify('info', t('settings.transferExportWritten', written || path))

  return { ok: true, path: written || path, bytes: outcome.body && outcome.body.bytes, sha256: outcome.body && outcome.body.sha256 }
}

/**
 * Export to the clipboard — a separate, separately labelled action.
 *
 * The archive is packed by the backend (so one place decides what a valid
 * archive is) and then written to the clipboard through the attributed OS door.
 * A clipboard that refuses is an error, never a silent no-op.
 */
export async function exportTemplatesToClipboard(options = {}) {
  const outcome = await callDoor('/templates/export', transferBody(options))

  if (!outcome.ok) {
    notify('error', t('settings.transferExportFailed', outcome.detail))

    return { ok: false, reason: 'failed', detail: outcome.detail }
  }

  const text = outcome.body && typeof outcome.body.json === 'string' ? outcome.body.json : ''
  const write = runtime.os && typeof runtime.os.writeClipboard === 'function' ? runtime.os.writeClipboard : null

  if (!write || !text) {
    notify('error', t('settings.transferExportClipboardFailed'))

    return { ok: false, reason: 'clipboard' }
  }

  let written = false

  try {
    written = await write(text)
  } catch (error) {
    void error
    written = false
  }

  if (!written) {
    notify('error', t('settings.transferExportClipboardFailed'))

    return { ok: false, reason: 'clipboard' }
  }

  notify('info', t('settings.transferExportCopied', text.length))

  return { ok: true, bytes: text.length, sha256: outcome.body && outcome.body.sha256 }
}

/**
 * The REAL content difference between the live field and the incoming one.
 *
 * Character counts alone do not answer the only question the user has — "what
 * would this replace my text with?" — and a preview that answers it with two
 * numbers is not a preview of the content, it is a preview of its length. So
 * this returns an actual line-level difference, computed with the SAME
 * `diffDrafts` the comparison view uses: one diff implementation, one set of
 * bounds, no second definition of "changed".
 *
 * `rows` carries the raw line text of at most `PREVIEW_DIFF_ROWS` changed lines
 * (nothing is rewritten — the marker is added by the renderer, never stored);
 * `truncated` says how many more there are. A field too large to diff reports
 * `ok: false` with the reason and the line count, and the surface says so
 * instead of quietly falling back to a character count.
 */
export function previewFieldDiff(live, incoming) {
  const before = typeof live === 'string' ? live : ''
  const after = typeof incoming === 'string' ? incoming : ''

  if (typeof live === 'string' && before === after) {
    return {
      ok: true,
      identical: true,
      added: 0,
      removed: 0,
      rows: [],
      shown: 0,
      changed: 0,
      truncated: false,
      reason: null,
      lines: 0
    }
  }

  const diff = diffDrafts(before, after)

  if (!diff.ok) {
    return {
      ok: false,
      identical: false,
      added: null,
      removed: null,
      rows: [],
      shown: 0,
      changed: null,
      truncated: false,
      reason: diff.reason,
      lines: diff.lines
    }
  }

  const changed = diff.rows.filter(row => row.kind !== 'same')
  const shown = changed.slice(0, PREVIEW_DIFF_ROWS)

  return {
    ok: true,
    identical: diff.identical,
    added: diff.added,
    removed: diff.removed,
    rows: shown.map(row => ({ kind: row.kind, text: row.text })),
    shown: shown.length,
    changed: changed.length,
    truncated: changed.length > shown.length,
    reason: null,
    lines: before.split('\n').length
  }
}

/**
 * What a confirmed import would change, computed against the LIVE templates.
 *
 * One entry per field the archive carries, in `TRANSFER_FIELDS` order inside
 * `MODES` order, with the character counts on both sides AND the real line
 * difference (`diff`, see :func:`previewFieldDiff`) — enough for the user to
 * recognise the archive without the dialog becoming a second editor of content
 * it does not own. `applies` is exactly what a confirm writes: only the modes
 * and fields the archive itself carries.
 */
export function importPreview(current, inspected) {
  const payload = inspected && inspected.templates && typeof inspected.templates === 'object' ? inspected.templates : {}
  const modes = MODES.filter(mode => payload[mode] && typeof payload[mode] === 'object')
  const applies = {}
  const changes = []

  for (const mode of modes) {
    applies[mode] = {}

    for (const field of TRANSFER_FIELDS) {
      const incoming = payload[mode][field]

      if (typeof incoming !== 'string') {
        continue
      }

      const live = current && current[mode] ? current[mode][field] : null

      applies[mode][field] = incoming
      changes.push({
        mode,
        field,
        changed: typeof live !== 'string' || live !== incoming,
        currentChars: typeof live === 'string' ? live.length : 0,
        incomingChars: incoming.length,
        diff: previewFieldDiff(live, incoming)
      })
    }
  }

  return {
    source: inspected && inspected.source === 'paste' ? 'paste' : 'file',
    path: inspected && typeof inspected.path === 'string' ? inspected.path : null,
    scope: inspected && typeof inspected.scope === 'string' ? inspected.scope : null,
    /**
     * What the ARCHIVE says its content is — information for the preview, never
     * the record: an archive can claim a version its bytes are not, and the
     * record is settled from the bytes the import actually applies.
     */
    version: statedTemplateVersion(inspected),
    formatVersion: inspected && Number.isInteger(inspected.format_version) ? inspected.format_version : null,
    warnings: Array.isArray(inspected && inspected.warnings) ? inspected.warnings : [],
    modes,
    changes,
    applies,
    identical: changes.length > 0 && changes.every(entry => !entry.changed)
  }
}

/** The version an inspected archive states: an integer, the custom marker, or `null`. */
function statedTemplateVersion(inspected) {
  const stated = inspected ? inspected.template_version : null

  return Number.isInteger(stated) || stated === TEMPLATE_VERSION_CUSTOM ? stated : null
}

/**
 * Inspect an archive and stage it. NOTHING is applied here.
 *
 * Two failures, kept apart on purpose: a request the backend could not serve at
 * all (`reason: 'failed'`, nothing staged) and a document it read and refused
 * (`reason: 'invalid'`, every reason staged for the user to read). The live
 * templates are untouched either way.
 */
async function stageImport(input) {
  const body = importRequestBody(input)
  const outcome = await callDoor('/templates/import/inspect', body)

  if (!outcome.ok) {
    notify('error', t('settings.transferImportFailed', outcome.detail))

    return { ok: false, reason: 'failed', detail: outcome.detail }
  }

  const answer = outcome.body && typeof outcome.body === 'object' ? outcome.body : {}

  if (!answer.ok) {
    const errors = Array.isArray(answer.errors) ? answer.errors : []

    setUi({ importOpen: true, importPreview: null, importErrors: errors })
    notify('error', t('settings.transferImportInvalid'))

    return { ok: false, reason: 'invalid', errors }
  }

  const preview = importPreview(templates, answer)

  setUi({ importOpen: true, importPreview: preview, importErrors: [] })

  return { ok: true, preview }
}

/** Import from a file the user picks. */
export async function importTemplatesFromFile() {
  const pick = runtime.os && typeof runtime.os.pickOpenPath === 'function' ? runtime.os.pickOpenPath : null

  if (!pick) {
    notify('info', t('settings.transferImportNoPath'))

    return { ok: false, reason: 'no-path' }
  }

  let path = null

  try {
    path = await pick({ filters: ARCHIVE_FILTERS, title: t('settings.transferImportFile') })
  } catch (error) {
    notify('error', t('settings.transferImportFailed', transferDetail(error)))

    return { ok: false, reason: 'failed' }
  }

  if (!path) {
    notify('info', t('settings.transferImportNoPath'))

    return { ok: false, reason: 'no-path' }
  }

  return stageImport({ path })
}

/**
 * Import from pasted text — the same door, reached without a filesystem.
 *
 * This is what keeps the feature usable where the native open dialog resolves
 * nothing (an OAuth remote, an older desktop build): identical validation, one
 * fewer capability.
 */
export async function importTemplatesFromPaste(text) {
  if (typeof text !== 'string' || !text.trim()) {
    notify('info', t('settings.transferImportPasteEmpty'))

    return { ok: false, reason: 'empty' }
  }

  return stageImport({ json: text })
}

/** Forget a staged archive. Applies nothing — there is nothing to undo. */
export function cancelImport() {
  setUi({ importOpen: false, importPreview: null, importErrors: [], importPaste: '' })
}

/**
 * Apply the staged archive, after the user confirmed the preview.
 *
 * Refused with nothing written when no archive is staged or when the merged pair
 * is one a run could not send (the same `validateTemplatePair` the editor uses,
 * so an import cannot smuggle in a pair the editor would refuse). On success the
 * write goes through the ONE template write path, so the outgoing pair reaches
 * the rollback slot and the version record describes this event.
 */
export function applyImportPreview() {
  const preview = $ui.get().importPreview

  if (!preview || !Array.isArray(preview.modes) || !preview.modes.length) {
    return { ok: false, reason: 'nothing-staged' }
  }

  const next = {}

  for (const mode of MODES) {
    next[mode] = { system: templates[mode].system, user: templates[mode].user }
  }

  for (const mode of preview.modes) {
    for (const field of TRANSFER_FIELDS) {
      const incoming = preview.applies[mode] ? preview.applies[mode][field] : null

      if (typeof incoming === 'string') {
        next[mode][field] = incoming
      }
    }
  }

  const errors = []

  for (const mode of MODES) {
    const check = validateTemplatePair(next[mode])

    if (!check.ok) {
      errors.push({ code: 'placeholder', field: mode + '.user', detail: check.errors.join('; ') })
    }
  }

  if (errors.length) {
    setUi({ importErrors: errors })

    return { ok: false, reason: 'invalid', errors }
  }

  commitTemplates(next, {
    state: 'imported',
    fromVersion: null,
    source: preview.source === 'paste' ? 'import-paste' : 'import-file'
  })

  setUi({
    importOpen: false,
    importPreview: null,
    importErrors: [],
    importPaste: '',
    templateDraft: null,
    templateError: false,
    templatesMigrated: false
  })

  return { ok: true, meta: templateMeta() }
}

/** What the rollback control may offer, composed fresh from the slot. */
export function previousVersionPanel() {
  const snapshot = previousTemplates()

  return {
    available: Boolean(snapshot),
    savedAt: snapshot && typeof snapshot.savedAt === 'number' ? snapshot.savedAt : null,
    state: snapshot && snapshot.meta ? snapshot.meta.state : null
  }
}

/**
 * The settings surface's rollback: restore the previous version, or say there is
 * none. :func:`restorePreviousTemplates` already refuses an empty or unusable
 * slot and notifies on success; this only has to report it and drop the edit
 * draft, which no longer describes what is live.
 */
export function restorePreviousVersionFromSettings() {
  const outcome = restorePreviousTemplates()

  if (!outcome.ok) {
    notify('info', t('settings.transferRollbackNone'))

    return { ok: false, reason: outcome.reason }
  }

  setUi({ templateDraft: null, templateError: false })

  return { ok: true, meta: outcome.meta }
}

function TemplatePanel(props) {
  const { ui, translate, patch } = props
  const draft = ui.templateDraft || {
    precise: { system: templates.precise.system, user: templates.precise.user },
    creative: { system: templates.creative.system, user: templates.creative.user }
  }

  const edit = (mode, field, value) => {
    const next = {
      precise: Object.assign({}, draft.precise),
      creative: Object.assign({}, draft.creative)
    }

    next[mode][field] = value
    setUi({ templateDraft: next, templateError: false })
  }

  return jsxs('div', {
    'data-fpe': 'template-panel',
    className: 'flex min-h-0 flex-col gap-3',
    children: [
      ui.templatesMigrated
        ? jsx('div', {
            'data-fpe': 'template-migrated',
            className: 'rounded-md border border-(--ui-stroke-secondary) p-2 text-[0.72rem]',
            children: translate('settings.templateMigrated')
          })
        : null,
      jsx('div', {
        className: 'text-[0.7rem] text-(--ui-text-quaternary)',
        children: translate('settings.templateHint')
      }),
      ...MODES.map(mode =>
        jsxs('div', {
          'data-fpe': 'template-' + mode,
          className: 'flex flex-col gap-1',
          children: [
            jsx('div', { className: 'font-medium', children: translate('mode.' + mode) }),
            jsx('div', {
              className: 'text-[0.7rem] text-(--ui-text-quaternary)',
              children: translate('settings.templateSystem')
            }),
            jsx(Textarea, {
              'data-fpe': 'template-' + mode + '-system',
              className: 'min-h-20 font-mono text-[0.72rem]',
              onChange: event => edit(mode, 'system', event.currentTarget.value),
              value: draft[mode].system
            }),
            jsx('div', {
              className: 'text-[0.7rem] text-(--ui-text-quaternary)',
              children: translate('settings.templateUser')
            }),
            jsx(Textarea, {
              'data-fpe': 'template-' + mode + '-user',
              className: 'min-h-24 font-mono text-[0.72rem]',
              onChange: event => edit(mode, 'user', event.currentTarget.value),
              value: draft[mode].user
            })
          ]
        }, mode)
      ),
      ui.templateError
        ? jsx('div', {
            'data-fpe': 'template-error',
            className: 'text-[0.72rem] text-(--ui-accent)',
            children: translate('settings.templateInvalid')
          })
        : null,
      jsx('div', {
        className: 'text-[0.7rem] text-(--ui-text-quaternary)',
        children: translate('settings.templateDraftPlaceholder')
      }),
      jsx(Separator, {}),
      jsxs('div', {
        'data-fpe': 'template-transfer',
        className: 'flex flex-col gap-2',
        children: [
          jsx('div', { className: 'font-medium', children: translate('settings.transferTitle') }),
          jsx('div', {
            className: 'text-[0.7rem] text-(--ui-text-quaternary)',
            children: translate('settings.transferHint')
          }),
          // Two named actions, never one that could be mistaken for the
          // other: the file route is the primary affordance and says so, the
          // clipboard route is labelled with the clipboard. `flex-wrap`
          // because four labels on one line squeeze into unreadable strips at
          // the dialog's minimum width.
          jsxs('div', {
            'data-fpe': 'template-transfer-actions',
            className: 'flex flex-wrap gap-2',
            children: [
              jsx(Button, {
                'data-fpe': 'template-export-file',
                onClick: () => {
                  void exportTemplatesToFile().then(patch)
                },
                type: 'button',
                variant: 'secondary',
                children: translate('settings.transferExportFile')
              }),
              jsx(Button, {
                'data-fpe': 'template-export-clipboard',
                onClick: () => {
                  void exportTemplatesToClipboard().then(patch)
                },
                type: 'button',
                variant: 'ghost',
                children: translate('settings.transferExportClipboard')
              }),
              jsx(Button, {
                'data-fpe': 'template-import-file',
                onClick: () => {
                  void importTemplatesFromFile().then(patch)
                },
                type: 'button',
                variant: 'secondary',
                children: translate('settings.transferImportFile')
              }),
              jsx(Button, {
                'data-fpe': 'template-import-paste',
                onClick: () => {
                  setUi({ importOpen: true, importPreview: null, importErrors: [], importPaste: '' })
                  patch()
                },
                type: 'button',
                variant: 'ghost',
                children: translate('settings.transferImportPaste')
              })
            ]
          }),
          ui.importOpen ? jsx(ImportPreview, { patch, translate, ui }) : null
        ]
      }),
      jsx(Separator, {}),
      jsxs('div', {
        'data-fpe': 'template-rollback',
        className: 'flex flex-col gap-1',
        children: [
          jsx('div', { className: 'text-[0.68rem] tracking-wide text-(--ui-text-quaternary) uppercase', children: translate('settings.transferRollbackTitle') }),
          jsx(Button, {
            'data-fpe': 'template-restore-previous',
            'aria-disabled': ui.previousAvailable ? 'false' : 'true',
            disabled: !ui.previousAvailable,
            onClick: () => {
              restorePreviousVersionFromSettings()
              patch()
            },
            type: 'button',
            variant: 'secondary',
            children: translate('settings.transferRollback')
          }),
          // Why the control is off, in the user's own terms: "no previous
          // version" and "there is one, kept since T" are different states.
          jsx('div', {
            'data-fpe': 'template-rollback-note',
            'data-available': ui.previousAvailable ? 'true' : 'false',
            className: 'text-[0.7rem] text-(--ui-text-quaternary)',
            children: ui.previousAvailable
              ? translate('settings.transferRollbackSavedAt', ui.previousSavedAt === null ? '—' : new Date(ui.previousSavedAt).toISOString().slice(11, 19)) +
                (ui.previousState ? ' · ' + translate('settings.transferRollbackState', ui.previousState) : '')
              : translate('settings.transferRollbackNone')
          })
        ]
      })
    ]
  })
}

/**
 * The REAL difference of one previewed field, as rows the user can read.
 *
 * The character counts beside this block say how much would change; this says
 * WHAT — the lines that would go and the lines that would arrive, verbatim, so
 * the confirm is a decision about content and not about arithmetic. Nothing is
 * reflowed, trimmed or highlighted beyond a leading marker (the marker is added
 * at render time and is never part of the staged archive). A field too large to
 * diff says so; it never degrades into a number presented as a preview.
 */
function previewDiffBlock(entry, translate) {
  const diff = entry.diff
  const seam = 'import-diff-' + entry.mode + '-' + entry.field

  if (!diff) {
    return []
  }

  if (diff.ok === false) {
    return [
      jsx('div', {
        'data-fpe': seam,
        'data-diff': 'too-large',
        className: 'text-[0.68rem] text-(--ui-text-quaternary)',
        children: translate('settings.transferImportDiffTooLarge', diff.lines)
      }, seam)
    ]
  }

  const block = [
    jsx('div', {
      'data-fpe': seam + '-count',
      className: 'text-[0.68rem] text-(--ui-text-quaternary)',
      children: translate('settings.transferImportDiffCount', diff.added, diff.removed)
    }, seam + '-count'),
    ...diff.rows.map((row, index) =>
      row.kind === 'add'
        ? jsx('div', {
            'data-fpe': seam + '-add',
            'data-kind': 'add',
            className: 'whitespace-pre-wrap break-words font-mono text-[0.7rem] text-(--ui-accent)',
            children: '+ ' + row.text
          }, seam + '-add-' + index)
        : jsx('div', {
            'data-fpe': seam + '-remove',
            'data-kind': 'remove',
            className: 'whitespace-pre-wrap break-words font-mono text-[0.7rem] text-(--ui-text-tertiary)',
            children: '- ' + row.text
          }, seam + '-remove-' + index)
    )
  ]

  if (diff.truncated) {
    block.push(
      jsx('div', {
        'data-fpe': seam + '-more',
        className: 'text-[0.68rem] text-(--ui-text-quaternary)',
        children: translate('settings.transferImportDiffMore', diff.changed - diff.shown)
      }, seam + '-more')
    )
  }

  return [
    jsxs('div', {
      'data-fpe': seam,
      'data-diff': 'ok',
      className: 'flex flex-col gap-0.5',
      children: block
    }, seam)
  ]
}

/**
 * The staged archive: what it carries, what would change, or why it cannot be
 * applied. Rendered inside the templates tab, next to the controls that opened
 * it, so the confirmation is never a dialog stacked on a dialog.
 *
 * `Apply` is offered ONLY for a staged, valid archive: with errors on the
 * surface, the confirm button is disabled and every reason is listed, because
 * an archive that cannot be applied must not look one click from being applied.
 * Each field that would change also renders :func:`previewDiffBlock` — the real
 * content difference, not only its length.
 */
function ImportPreview(props) {
  const { ui, translate, patch } = props
  const preview = ui.importPreview
  const errors = Array.isArray(ui.importErrors) ? ui.importErrors : []
  const rows = preview
    ? preview.changes.flatMap(entry => {
        const seam = entry.mode + '.' + entry.field
        const line = jsx('div', {
          'data-fpe': 'import-field-' + entry.mode + '-' + entry.field,
          'data-changed': entry.changed ? 'true' : 'false',
          className: 'text-[0.7rem] text-(--ui-text-tertiary)',
          children: entry.changed
            ? translate('settings.transferImportField', entry.mode, entry.field, entry.currentChars, entry.incomingChars)
            : translate('settings.transferImportFieldSame', entry.mode, entry.field, entry.currentChars)
        }, seam)

        // A field the archive leaves alone gets no difference block: "unchanged"
        // needs no lines to illustrate.
        return entry.changed ? [line].concat(previewDiffBlock(entry, translate)) : [line]
      })
    : []

  return jsxs('div', {
    'data-fpe': 'import-preview',
    'data-staged': preview ? 'true' : 'false',
    className: 'flex flex-col gap-2 rounded-md border border-(--ui-stroke-secondary) p-2',
    children: [
      jsx('div', { className: 'font-medium', children: translate('settings.transferImportTitle') }),
      // The paste door: no filesystem, so the archive arrives as text.
      preview
        ? null
        : jsxs('div', {
            'data-fpe': 'import-paste',
            className: 'flex flex-col gap-1',
            children: [
              jsx('div', {
                className: 'text-[0.7rem] text-(--ui-text-quaternary)',
                children: translate('settings.transferImportPastePrompt')
              }),
              jsx(Textarea, {
                'data-fpe': 'import-paste-text',
                className: 'min-h-20 font-mono text-[0.72rem]',
                onChange: event => setUi({ importPaste: event.currentTarget.value }),
                value: ui.importPaste || ''
              }),
              jsx(Button, {
                'data-fpe': 'import-paste-inspect',
                onClick: () => {
                  void importTemplatesFromPaste(ui.importPaste || '').then(patch)
                },
                type: 'button',
                variant: 'secondary',
                children: translate('settings.transferImportPasteInspect')
              })
            ]
          }),
      preview
        ? jsx('div', {
            'data-fpe': 'import-scope',
            'data-source': preview.source,
            className: 'text-[0.7rem] text-(--ui-text-quaternary)',
            children:
              translate('settings.transferImportScope', preview.scope || '—') +
              ' · ' +
              translate('settings.transferImportSource', preview.path || preview.source)
          })
        : null,
      preview && preview.identical
        ? jsx('div', {
            'data-fpe': 'import-identical',
            className: 'text-[0.7rem] text-(--ui-text-quaternary)',
            children: translate('settings.transferImportIdentical')
          })
        : null,
      ...rows,
      preview && preview.warnings.length
        ? jsxs('div', {
            'data-fpe': 'import-warnings',
            className: 'flex flex-col gap-0.5 text-[0.7rem] text-(--ui-text-quaternary)',
            children: [
              jsx('div', { children: translate('settings.transferImportWarnings') }),
              ...preview.warnings.map((warning, index) =>
                jsx('div', { 'data-fpe': 'import-warning-' + (warning.code || 'unknown'), children: warning.detail }, index)
              )
            ]
          })
        : null,
      // Every reason the archive was refused, on the surface — never a toast
      // that scrolls away, and never hidden behind the disabled button.
      errors.length
        ? jsxs('div', {
            'data-fpe': 'import-errors',
            className: 'flex flex-col gap-0.5 text-[0.72rem] text-(--ui-accent)',
            children: [
              jsx('div', { children: translate('settings.transferImportInvalid') }),
              ...errors.map((error, index) =>
                jsx('div', {
                  'data-fpe': 'import-error-' + (error.code || 'unknown'),
                  className: 'font-mono text-[0.7rem]',
                  children: (error.field ? error.field + ': ' : '') + (error.detail || error.code || '')
                }, index)
              )
            ]
          })
        : null,
      jsxs('div', {
        className: 'flex items-center gap-2',
        children: [
          jsx(Button, {
            'data-fpe': 'import-apply',
            disabled: !preview || errors.length > 0,
            onClick: () => {
              applyImportPreview()
              patch()
            },
            type: 'button',
            variant: 'secondary',
            children: translate('settings.transferImportApply')
          }),
          jsx(Button, {
            'data-fpe': 'import-cancel',
            onClick: () => {
              cancelImport()
              patch()
            },
            type: 'button',
            variant: 'ghost',
            children: translate('settings.transferImportCancel')
          })
        ]
      })
    ]
  })
}

function DiagnosticsPanel(props) {
  const { ui, translate, patch } = props

  return jsxs('div', {
    'data-fpe': 'diagnostics-panel',
    className: 'flex flex-col gap-3 text-[0.74rem]',
    children: [
      jsx('div', {
        className: 'text-[0.7rem] text-(--ui-text-quaternary)',
        children: translate('status.memoryOnly')
      }),
      jsx('div', {
        className: 'text-[0.68rem] tracking-wide text-(--ui-text-quaternary) uppercase',
        children: translate('settings.diagnosticsRuns')
      }),
      memory.runs.length
        ? jsx('div', {
            'data-fpe': 'runs',
            className: 'flex flex-col gap-0.5 font-mono text-[0.7rem]',
            children: memory.runs.map((run, index) =>
              jsx('div', {
                children:
                  new Date(run.at).toISOString().slice(11, 19) +
                  '  ' +
                  run.mode +
                  '  ' +
                  translate('diagnostics.' + (run.outcome === 'ok' ? 'ok' : run.outcome)) +
                  (run.reason ? ' (' + run.reason + ')' : '')
              }, index)
            )
          })
        : jsx('div', {
            'data-fpe': 'runs-empty',
            className: 'text-(--ui-text-quaternary)',
            children: translate('settings.diagnosticsRunsEmpty')
          }),
      jsx('div', {
        className: 'text-[0.68rem] tracking-wide text-(--ui-text-quaternary) uppercase',
        children: translate('settings.diagnosticsLastError')
      }),
      jsx('div', {
        'data-fpe': 'last-error',
        className: 'font-mono text-[0.7rem] whitespace-pre-wrap',
        children: memory.lastError
          ? memory.lastError.code + '  ' + truncate(memory.lastError.message, 400)
          : '—'
      }),
      jsx('div', {
        className: 'text-[0.68rem] tracking-wide text-(--ui-text-quaternary) uppercase',
        children: translate('settings.diagnosticsLastResult')
      }),
      jsx('div', {
        'data-fpe': 'last-result',
        className: 'rounded-md border border-(--ui-stroke-secondary) p-2 text-[0.72rem] whitespace-pre-wrap',
        children: memory.lastResult ? resultDigest(memory.lastResult) : '—'
      }),
      jsx(Button, {
        'data-fpe': 'diagnostics-clear',
        onClick: () => {
          clearDiagnostics()
          notify('info', translate('status.cleared'))
          patch()
        },
        type: 'button',
        variant: 'ghost',
        children: translate('settings.diagnosticsClear')
      })
    ]
  })
}

function resultDigest(result) {
  const attribution = modelAttribution(result)
  const requested = attribution.requested
    ? [attribution.requested.provider, attribution.requested.model].filter(Boolean).join(': ')
    : '—'
  const bits = [
    'mode=' + result.mode,
    'path=' + (result.path || '—'),
    'source=' + (result.source || '—'),
    'provider=' + (result.provider || '—'),
    'model=' + (result.model || '—'),
    'receipt=' + (attribution.receipt ? 'yes' : 'no'),
    'requested=' + requested,
    'shape=' + (result.textShape || '—'),
    'scores=' + (result.scores ? 'yes' : 'no'),
    'changes=' + (result.changeNote ? 'yes' : 'no'),
    'protection=' + result.protection.tone,
    'ms=' + (result.durationMs === null ? '—' : result.durationMs),
    'original=' + result.original.length + 'ch',
    'enhanced=' + result.enhanced.length + 'ch'
  ]

  return bits.join('\n')
}

function AboutPanel(props) {
  const { ui, translate } = props

  return jsxs('div', {
    'data-fpe': 'about-panel',
    className: 'flex flex-col gap-2 text-[0.75rem]',
    children: [
      jsx('div', { children: translate('settings.aboutBody') }),
      jsx('div', {
        'data-fpe': 'language-note',
        className: 'text-(--ui-text-quaternary)',
        children: translate('languageNote')
      }),
      jsxs('div', {
        className: 'flex flex-col gap-0.5 font-mono text-[0.7rem] text-(--ui-text-tertiary)',
        children: [
          jsx('div', { children: translate('settings.aboutId') + ': ' + PLUGIN_ID }),
          jsx('div', {
            children:
              translate('settings.aboutBackend') +
              ': ' +
              (ui.binding === 'unavailable' ? translate('settings.aboutBoundUnavailable') : translate('settings.aboutBoundCtx'))
          }),
          jsx('div', {
            children: translate('settings.aboutProtocol') + ': ' + (ui.protocolVersion === null ? '—' : ui.protocolVersion)
          })
        ]
      }),
      jsx('div', { className: 'text-(--ui-text-quaternary)', children: translate('settings.aboutLimits') }),
      jsx('div', { className: 'text-(--ui-text-quaternary)', children: translate('settings.aboutStorage') })
    ]
  })
}

function SettingsDialog() {
  const ui = useUi()
  // `usePluginI18n` re-renders on a locale switch AND on a late bundle
  // registration, so the whole surface follows Hermes's language hot. Args are
  // spread — the SDK passes them straight to a function-valued leaf.
  const translate = usePluginI18n(PLUGIN_ID)
  const [tab, setTab] = useState('mode')
  const patch = () => setUi({})

  const tabs = [
    { id: 'mode', label: translate('settings.tabsMode') },
    { id: 'model', label: translate('settings.tabsModel') },
    { id: 'templates', label: translate('settings.tabsTemplates') },
    { id: 'diagnostics', label: translate('settings.tabsDiagnostics') },
    { id: 'about', label: translate('settings.tabsAbout') }
  ]

  const body = () => {
    if (tab === 'model') {
      return jsx(ModelPanel, { patch, translate, ui })
    }

    if (tab === 'templates') {
      return jsx(TemplatePanel, { patch, translate, ui })
    }

    if (tab === 'diagnostics') {
      return jsx(DiagnosticsPanel, { patch, translate, ui })
    }

    if (tab === 'about') {
      return jsx(AboutPanel, { patch, translate, ui })
    }

    return jsxs('div', {
      'data-fpe': 'mode-panel',
      className: 'flex flex-col gap-3',
      children: [
        jsx('div', { className: 'font-medium', children: translate('settings.modeTitle') }),
        jsx('div', {
          className: 'text-[0.72rem] text-(--ui-text-quaternary)',
          children: translate('settings.modeHint')
        }),
        jsxs('div', {
          className: 'flex flex-col gap-2',
          children: MODES.map(mode =>
            jsxs('button', {
              'data-fpe': 'settings-mode-' + mode,
              'data-active': settings.mode === mode ? '1' : '0',
              className: cn(
                'flex cursor-pointer items-start gap-2 rounded-md border p-2 text-left',
                settings.mode === mode ? 'border-(--ui-accent)' : 'border-(--ui-stroke-secondary)'
              ),
              onClick: () => {
                setMode(mode)
                patch()
              },
              type: 'button',
              children: [
                jsx(Codicon, {
                  className: cn(!(settings.mode === mode) && 'opacity-0'),
                  name: 'check',
                  size: 13
                }),
                jsxs('span', {
                  className: 'flex flex-col',
                  children: [
                    jsx('span', { children: translate('mode.' + mode) }),
                    jsx('span', {
                      className: 'text-[0.7rem] text-(--ui-text-quaternary)',
                      children: translate('mode.' + mode + 'Hint')
                    })
                  ]
                })
              ]
            }, mode)
          )
        }),
        jsxs('div', {
          className: 'flex items-center justify-between gap-3',
          children: [
            jsx('span', { children: translate('settings.autoCompare') }),
            jsx(Switch, {
              'data-fpe': 'auto-compare',
              checked: settings.showCompareOnSuccess,
              onCheckedChange: on => {
                settings = normalizeSettings(Object.assign({}, settings, { showCompareOnSuccess: on }))
                persistSettings()
                patch()
              }
            })
          ]
        })
      ]
    })
  }

  return jsx(Dialog, {
    onOpenChange: open => setUi({ settingsOpen: open }),
    open: ui.settingsOpen,
    children: jsxs(DialogContent, {
      'data-fpe': 'settings-dialog',
      className: 'max-w-2xl',
      children: [
        jsx(DialogHeader, {
          children: jsx(DialogTitle, { children: translate('settings.title') })
        }),
        jsxs('div', {
          className: 'flex min-h-0 gap-4',
          children: [
            jsx('div', {
              className: 'flex w-32 shrink-0 flex-col gap-0.5',
              children: tabs.map(entry =>
                jsx('button', {
                  'data-fpe': 'tab-' + entry.id,
                  className: cn(
                    'cursor-pointer rounded-md px-2 py-1 text-left text-[0.75rem]',
                    tab === entry.id ? 'bg-(--ui-bg-tertiary)' : 'hover:bg-(--ui-bg-tertiary)'
                  ),
                  onClick: () => setTab(entry.id),
                  type: 'button',
                  children: entry.label
                }, entry.id)
              )
            }),
            jsx('div', { className: 'flex min-h-48 min-w-0 flex-1 flex-col overflow-auto', children: body() })
          ]
        }),
        jsxs(DialogFooter, {
          children: [
            tab === 'templates'
              ? jsx(Button, {
                  'data-fpe': 'template-reset',
                  onClick: () => {
                    resetTemplatesToDefault()
                    patch()
                  },
                  type: 'button',
                  variant: 'ghost',
                  children: translate('settings.templateReset')
                })
              : null,
            tab === 'templates'
              ? jsx(Button, {
                  'data-fpe': 'template-save',
                  onClick: () => {
                    const outcome = saveTemplatesFromDraft(ui.templateDraft)

                    if (outcome.ok) {
                      patch()
                    }
                  },
                  type: 'button',
                  children: translate('settings.templateSave')
                })
              : null,
            jsx(Button, {
              'data-fpe': 'settings-close',
              onClick: () => setUi({ settingsOpen: false }),
              type: 'button',
              variant: 'ghost',
              children: translate('compare.cancel')
            })
          ]
        })
      ]
    })
  })
}

function ComposerRoot() {
  return jsxs(Fragment, {
    children: [jsx(ComposerAction, {}), jsx(CompareDialog, {}), jsx(SettingsDialog, {})]
  })
}

export default {
  id: PLUGIN_ID,
  name: DISPLAY_NAME,
  description:
    'Composer button that rewrites the current draft (precise / creative) and shows a reference self-score for both drafts.',
  register(ctx) {
    runtime.ctx = ctx
    runtime.rest = ctx.rest
    runtime.storage = ctx.storage
    // The curated OS door (`ctx.os`): the native dialogs and the clipboard.
    // Every member resolves a result instead of throwing when the capability
    // is absent, so the callers below branch on what they get back.
    runtime.os = ctx.os || {}
    runtime.setInterval = ctx.setInterval
    runtime.host = host

    try {
      settings = normalizeSettings(ctx.storage.get(STORAGE_KEYS.settings, null))

      // Templates stored by an EARLIER release are the only ones this may
      // touch, and only when both fields of a mode match one recorded shipped
      // default EXACTLY. `stored` is kept so the boot can hand the pair it read
      // to the rollback slot: the module state is still the shipped default at
      // this point, not what the user actually had.
      const stored = ctx.storage.get(STORAGE_KEYS.templates, null)
      const migration = migrateTemplates(stored)

      templatesMigrated = migration.migrated

      if (migration.migrated) {
        // One write, through the same path every other change uses, so the
        // rollback slot and the version record describe the same event.
        commitTemplates(
          migration.templates,
          { state: 'default', version: TEMPLATE_VERSION, fromVersions: migration.fromVersions, source: 'migration' },
          stored
        )
      } else {
        // No migration, no write: a record left by an earlier boot (an import,
        // an edit) describes content this boot did not produce and must not
        // erase.
        templates = normalizeTemplates(stored)
      }

      // ...but the VERSION record is settled from the bytes that are now live,
      // including the first run where no record exists at all. It writes only
      // the record: the templates and the rollback slot are untouched.
      settleTemplateVersion()
    } catch (error) {
      settings = normalizeSettings(null)
      templates = normalizeTemplates(null)
      templatesMigrated = false
      void error
    }

    ctx.i18n.register(I18N)

    ctx.register({
      id: 'composer-action',
      area: 'composer.actions',
      order: 40,
      render: () => jsx(ComposerRoot, {})
    })

    // Ask the backend what this installation permits. Non-fatal when it fails:
    // the run path still refuses a pinned model the backend refuses.
    void loadCapability()

    // Reset the memory-only surface on reload so a stale diagnostics list or undo
    // snapshot can never be shown as if it belonged to the new instance.
    memory.undo = null
    memory.lastResult = null
    memory.lastError = null
    memory.runs = []
    memory.runToken += 1
    setUi(initialUi())
  }
}

/** Test surface. Not part of the plugin contract; the loader reads `default`. */
export const __testing = {
  applyGuard,
  applyCompareResult,
  applyResult,
  bindingKey,
  buildOneshotParams,
  buildParseBody,
  buildPrepareBody,
  buildRequest,
  classifyFailure,
  classifyGatewayFailure,
  classifyRestFailure,
  clearDiagnostics,
  currentSettings: () => settings,
  currentTemplates: () => templates,
  DEFAULT_TEMPLATES,
  LEGACY_DEFAULT_TEMPLATES,
  /**
   * The recorded shipped-default table and the bookkeeping around it: which
   * version a stored pair IS, which version a pair of two tweaked fields is
   * NOT, what a write left behind, and the single rollback slot.
   */
  TEMPLATE_DEFAULT_VERSIONS,
  TEMPLATE_VERSION,
  TEMPLATE_META_SCHEMA,
  TEMPLATE_META_STATES,
  TEMPLATE_WRITE_SOURCES,
  TEMPLATE_VERSION_CUSTOM,
  defaultVersionOf,
  normalizeTemplateMeta,
  previousTemplates,
  restorePreviousTemplates,
  settleTemplateVersion,
  templateMeta,
  templateVersionOf,
  DIMENSIONS,
  /* The comparison view: which one opens, the line diff behind it, and the
   * panels that render the rationale, the change note and the model source. */
  changeNote: result => (result && result.changeNote) || '',
  /**
   * The result page's two layers: the ONE short summary line that stays on the
   * main surface (source, model, duration, and whether the model is the host's
   * receipt or only this plugin's request), and the provenance rows the
   * disclosure holds.
   */
  resultSummary,
  resultDetails,
  ResultSummary,
  /**
   * The template archive surface: the two request bodies, the two export
   * routes (a native save → the backend's write, and the clipboard), the two
   * import routes (a native open → the backend's read, and pasted text), the
   * pure preview projection, the confirm, and the ONE rollback slot.
   */
  TRANSFER_FIELDS,
  PREVIEW_DIFF_ROWS,
  transferDetail,
  exportRequestBody,
  importRequestBody,
  exportTemplatesToFile,
  exportTemplatesToClipboard,
  importTemplatesFromFile,
  importTemplatesFromPaste,
  importPreview,
  previewFieldDiff,
  applyImportPreview,
  cancelImport,
  previousVersionPanel,
  restorePreviousVersionFromSettings,
  ImportPreview,
  TemplatePanel,
  ChangeNote,
  compareView,
  CompareDialog,
  DIFF_LIMITS,
  DIFF_MAX_ROWS,
  diffDrafts,
  DiffPanel,
  ModelSource,
  modelAttribution,
  RationalePanel,
  RUN_SOURCES,
  sourceLabelKey,
  failureMessageKey,
  I18N,
  LIMITS,
  MAX_REPORTED_MISSING,
  MODEL_CHOICES,
  ONESHOT_TEMPERATURE,
  loadCapability,
  memory,
  migrateTemplates,
  /** Mounted directly by the structural tests: the dialog's model tab is the
   *  only caller, and its own tab state is not drivable from outside React. */
  ModelPanel,
  MODES,
  modelChoiceValue,
  applyModelChoice,
  applyModelSelection,
  modelPanelState,
  /**
   * The authorization view-model and the section that renders it. Exported so
   * the suite can drive the panel's rows, its operator texts and its clipboard
   * door directly; the section itself is mounted through `ModelPanel`.
   */
  permissionHint,
  permissionPanel,
  PermissionSection,
  /**
   * The dedicated model's thinking level: the host's own scale, the normaliser
   * that reads a stored level, and the boundary recording the TWO checks that
   * make a pick impossible to honour — the LLM doors that carry no reasoning
   * parameter, and the catalog menu whose props cannot hide its submenu.
   */
  REASONING_EFFORTS,
  DEFAULT_REASONING_EFFORT,
  normalizeEffort,
  EFFORT_TRANSPORT,
  planRun,
  readErrorEnvelope,
  resolveRunRoute,
  statusCode,
  STORAGE_KEYS,
  normalizeSettings,
  normalizeTemplates,
  openSettings,
  protectionSummary,
  resetTemplatesToDefault,
  resolveAddress,
  runEnhance,
  runUndo,
  saveTemplatesFromDraft,
  scoreErrorKey,
  scoreRows,
  setMode,
  /** Test-only: replace the persisted settings through the real normalizer. */
  setSettings: next => {
    settings = normalizeSettings(next)
  },
  setUiState: setUi,
  stopRun,
  ui: $ui,
  undoGuard,
  /** Test-only: point the module at a locale without mounting React. */
  setActiveLocale: value => {
    activeLocale = value
  },
  activeLocale: () => activeLocale
}
