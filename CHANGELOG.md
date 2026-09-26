# Changelog

本项目的所有重要变更都记录在此。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Fixed

- **导出的归档里 `template_version` 是 `null`**（真实缺陷）：导出读的是 `templates.meta.v1`
  这条**记录**，而不是它即将打包的那串字节。初次运行的安装**没有**记录（`templates.v1` 尚未写过，
  插件直接服务出厂默认），于是导出的 JSON 带着 `"template_version": null`；导入又会把归档
  **自己声称**的版本抄进记录，让「版本」既不描述字节也不描述事实。现在：导出由
  `defaultVersionOf()` **从字节推导**（是某个已记录的出厂默认就给那个整数，否则给显式的
  `custom` 标记），导入**不再**抄声明（声明只作预览信息），并在 `register()` 里新增
  `settleTemplateVersion()` 把记录在**首次运行**就落定为实际服务的版本——它只写记录，
  不碰 `templates.v1`、不碰回退槽，且记录与字节一致时不写。归档布局因此升到
  `format_version: 2`（新增常量 `CUSTOM_TEMPLATE_VERSION = "custom"`）；**布局 1 仍可读**，
  其 `null` 被如实报成「未声明版本」（`older_version` + `template_version_unstated`）而不是
  错误，也**不**冒充任何版本。用户自定义与旧版内容**不**被贴上任何新默认。**已同步两处安装副本**
  （`docs/部署记录-260926T1704-模板版本记录同步.md`；需重启 Hermes Desktop 与网关后生效）。

### Changed

- **公开发布前的文档口径收尾（只改文档与 `.gitignore`，未动任何插件源码或测试）**：
  `README.md` / `README.zh-CN.md` 补上模板归档这一项的说明（布局 **`format_version: 2`**、
  **布局 1 仍可读**、`null` 报成「未声明版本」、自定义标 `"custom"`）、宿主**思考等级不受支持**
  这条边界（点选被拒绝、不记录、不落盘、请求体里也不出现），以及「**自动化测试不等于真实
  Desktop**、不声称全端到端无遗漏」这条边界；两份 README 与 `docs/测试与验收说明.md` 的实测
  数字对齐为 **Python 323 / desktop 199**（两套退出码均为 `0`）。`.gitignore` 把本机发布候选与
  安全扫描记录（`docs/发布候选清单与安全扫描.md`）一并列进「只留磁盘、不发布」的清单。

- **文档与仓库整洁统一（收尾）**：`README.md` / `README.zh-CN.md` 的文件树补上缺失的
  `package/fragile-prompt-enhance/fpe_templates.py` 与三份测试文件
  （`test_template_transfer.py` / `test_plugin_api_delivery.py` / `test_plugin_permissions.py`）；
  `docs/测试与验收说明.md` 的实测数字（Python 323 / desktop 199）、各文件用例分组、
  验收清单与「已部署 / 未部署」状态全部对齐真实结果（上一轮的三份文件已由
  `docs/部署记录-260926T1634-收尾同步.md` 同步）；清掉 `tests/.harness/` 里旧命名
  （每次加载写一份）留下的 12 447 个 `plugin.*.mjs`（1 754 762 685 字节）与本工程
  `__pycache__/`（3 个目录、14 个文件、413 514 字节）。保留：先红探针的源码备份
  `plugin.js.orig`、全部 `backups/` 恢复备份、部署证据与档案馆内容、用户附件/模板/配置。
  发布清单（`docs/发布候选清单与安全扫描.md`，本机留存、不随仓库发布）**未**改动——那一轮不做发布，也没有 GitHub 操作。

- **模板导入预览只报字数，不显示改了什么**：每条 `changes` 之前只有
  `currentChars` / `incomingChars`，界面文案是「mode · field: N → M characters」——**字数相同即可满足**，
  而用户要决定的正是「这会把我的文字换成什么」。现在 `previewFieldDiff()`（复用对比视图那**同一个**
  `diffDrafts`）为每个会变的字段给出真实的逐行差异：最多 `PREVIEW_DIFF_ROWS`（8）条**改动行原文**
  带 `+` / `-` 前缀（前缀只由渲染端加，**归档字节不动**）、真实 `added` / `removed` 行数，
  超出部分明说**还剩几行未列出**；超过 `DIFF_LIMITS` 的字段报 `too-large` 并直说
  「太长，无法在此逐行比较」，**不**退回成只报字数。不改动的字段不渲染差异块。
  4 条新文案（`transferImportDiffCount` / `More` / `TooLarge`）进 `en` + `zh` 两个语言包。
- **部署文档要求清空用户设置**：`docs/部署步骤.md` §4「回滚」原先写着「清除持久设置：设置存于
  localStorage 的 `hermes.plugin.fragile-prompt-enhance.*` 键」——那是**要求清空用户数据**，
  违背「保留现有设置」。已改为显式的**保留规则**：回滚只撤回新增配置项与插件包，
  设置与两套模板**原样保留**，回出厂模板由用户自己在「设置 → 模板」按「恢复默认」/
  「恢复上一个版本」；并写明**取消导出不动剪贴板**（含不清空其中已有内容）。
  `docs/部署记录-260926T1218.md` §6 第 4 条同一处错误已**就地标注**（部署记录是历史文件，
  改写会变成伪造记录）。

### Changed

- **「取消 = 原样」与「拒绝 = 无副作用」被钉成回归**：取消导出后，**预置**在剪贴板里的用户内容必须
  **逐字未变**、`writeClipboard` 零调用、后端零请求（旧用例只断言「没有东西被推进剪贴板数组」，
  证明不了没被清空）；后端对未知顶层键 / mode 内未知字段 / 超限三种拒绝，新增断言
  **文件字节与 `st_mtime_ns` 都不变、目录不多出条目**，并区分 200+`ok:false`（文档不可用）
  与 400（尺寸/编码这类传输级拒绝）。

- **对比弹窗「完整原文」视图被压成 39px 横条**：全文块原先是 `flex-1 overflow-auto`，而父级链没有
  一个是定高——`flex: 1 1 0%` 在自动高度祖先里 basis 解成 0，盒子只剩自身 padding，`overflow-auto`
  再把其余内容藏起来。现在全文块**不自带高度与滚动**（`min-h-24` 可读下限 + `whitespace-pre-wrap`
  + `break-words`），滚动只由宿主 `DialogContent` 那一处承担。**已部署。**
- **弹窗宽度没生效**：原先加的 `max-w-4xl` 在宿主 bundle 里**根本没有编译出规则**，弹窗一直保持
  宿主 shell 的 32rem，两列全文被挤成竖条。改用 `min-w-[min(48rem,90vw)]`——`min-width` 在层叠里
  胜过 `max-width`，且这正是宿主自己的宽弹窗在用的类。**已部署。**
- **评分列对不齐**：评分原先是每行一个 `justify-between`，中缝跟着该行文字跑。改为真正的三列表格
  （标签 / 原文 / 增强稿），数值列 `text-right tabular-nums`，颜色只用宿主既有 token。**已部署。**
- **「0 项精确内容全部保留」误导**：草稿里没有代码块/路径/URL/引用标识时，这句话读起来像一次通过的
  检查。现在 `total === 0` 走新的 `compare.protectionNone`：「未检测到需逐字保护内容，因此没有需要
  逐条核对的项目。」**已部署。**
- **评分表格上有一个无规则的类**：`align-bottom` 在宿主 bundle 里没有编译规则（宿主源码没用到），
  一直在白写；改用 `align-top`。并给测试补上「类列表写在 `const` 里」的扫描，让这类死类不再漏网。
  **已部署。**
- **思考等级的「可选但不发送」是不合约的**：上一轮把目录里的选择**记录下来并持久化**
  （`settings.pinnedEffort`），而本构建根本发不出去（两扇官方插件 LLM 门都不带 reasoning 参数）。
  那是一个**能选但不会生效**的控件，正是本项目承诺不做的东西。现在改为**明确阻断**：
  选一次等级**不写设置、不落盘**，并弹一条本地化通知说明「当前宿主插件接口不支持，这个选择不会应用」；
  `current.effort` 与 `presetFor()` 一律报空，**不再把已存等级画成已选中**；若设置里还留着旧版写入的
  值，面板会点名显示「仍留着此前版本记录的值：X。它不会被应用。」而不是假装它是当前选择。
  **已部署。**

### Changed

- **思考等级的能力边界写进代码并被两次核查钉住**。核查一：`agent/plugin_llm.PluginLlm` 的四个补全方法
  与 `tui_gateway/contracts/sessions.py` 的 `LlmOneshotParams` **都不带 reasoning 参数**，插件无法把
  任何等级发给模型。核查二（本轮新增）：`ModelCatalogMenu` 的**全部** props 是
  `controller`/`footer`/`gateway`/`includeMoa`/`ownerConnectionId`/`profile`/`request`/`sessionId`，
  **没有任何一项**能隐藏或禁用它的思考子菜单（子菜单由菜单自己无条件渲染，行内门来自回传给它的目录
  数据）。所以等级**既发不出去、也藏不掉**，唯一不能做的就是收下它并让人以为生效。
  `EFFORT_TRANSPORT` 现记录这两次核查；宿主哪天给门加参数、或给菜单加控制 prop，对应断言会**先红**。
  没有预埋「等宿主支持就自动打开」的分支——契约变了先让测试红，再由人决定。
- **等级写入口全部删除**：`applyEffort()` 与 `applyModelSelection(…, effort)` 的 `effort` 形参一并去掉；
  `normalizeEffort` 保留为**只读**归一化（读旧值、拒绝陌生值），不再有第二个能写等级的地方。
  目录在每次选中时回传的 `preset.effort` 也**不落盘**——存一个不会生效的值和假控件是同一种谎话。
- **专用模型思考等级：记录 + 明说无法传输**（上一轮的做法，**本轮已推翻**，见上）。
  等级刻度仍逐值照抄宿主 `apps/shared/src/reasoning-effort.ts`，不发明刻度。
- **许可与公开发布资料**：`plugin.yaml` 的 `license` 改为 `MIT`（此前为「带保留」写法）。
  依据是 `WB-Enhance-Prompt 1.5.6-share` 的 `LICENSE` 明文以 MIT 覆盖「内嵌提示词模板」，
  且 1.5.5 → 1.5.6 的脚本逐行差异只有许可注释与版本号，模板文本未变。
  原因与逐条证据见 [`docs/来源映射与许可.md`](docs/来源映射与许可.md)。
- 新增仓库根 [`LICENSE`](LICENSE)（MIT，`Copyright (c) 2026 Ludens`）。
- 新增 `package/fragile-prompt-enhance/NOTICE` 与 `package/fragile-prompt-enhance/desktop/NOTICE`：
  第三方署名与许可全文随包分发；desktop 那一份会跟着被宿主复制到 `desktop-plugins/` 的那一半走。
- [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md) 重写：收录 WB 1.5.6 的 MIT 全文
  （`Copyright (c) 2026 WB Enhance Prompt contributors`）、随其分发的 Lucide ISC 声明，
  以及 Heybinshao/prompt-enhancer 的 MIT 全文；并明确本文件记录的是**读到的授权声明**，
  不是对上游权利归属的司法确权。
- 新增 [`README.md`](README.md)（英文）；[`README.zh-CN.md`](README.zh-CN.md) 更新许可口径、
  去掉本机绝对路径。
- 新增 [`.gitignore`](.gitignore)：排除本机部署/验收记录、`backups/`、日志、测试 harness
  （`tests/.harness/`）、`__pycache__/` 与凭据类文件。
- `docs/部署步骤.md`、`docs/测试与验收说明.md` 改为使用 `<HERMES_HOME>` 占位符，不再写死本机用户名路径。

## [1.0.0] — 2026-09-26

首次以此形态发布：一个统一包（agent 半 + dashboard 后端 + desktop 前端），
把 Hermes Desktop 原生输入框里的**当前草稿**改写为更清晰的提示词。

### Added

- **原生输入框按钮**：split 按钮（主键执行当前模式，右侧下拉切换模式／对比／撤销／设置），
  不注入 DOM、不探测 React 内部。
- **两条模型路径**：默认「跟随会话」（官方无状态 RPC `llm.oneshot` + `session_id`，
  网关把该会话的 `main_runtime` 借给这次调用，且不写入会话历史）；
  以及「使用专用模型」（经宿主信任门授权后走 `ctx.llm` 覆写）。两条路都不改变会话模型。
  - 输入框尚无活跃会话时明确改用全局模型并提示，**不会为了凑 `session_id` 新建会话**。
  - 调用按 (connectionId, profile) 归属；拿不到路由描述符时**拒绝**，不误发到当前连接。
  - 未授权时不静默降级：前端直接拒绝并按模型名说明，后端在任何 provider 调用前返回
    `403 model_override_denied`。
- **一次调用返回正文 + 参考自评**：原文与增强稿的 0-100 总评、五维子分
  （目标清晰、信息充分、约束明确、交付明确、表达效率）与简短理由；
  允许分数不变或下降，不要求增强稿必须更高分。字段缺失或无效时显示「评分不可用」并保留正文。
- **精确内容保护**：代码块、路径、URL、引用标识等逐条核对，报告
  `total` / `missing` / `altered_whitespace` / `truncated`；只要有丢失就不自动回填，
  改成打开对比视图由用户决定（可点「仍然回填」）。
- **两套完整中文默认模板**（精准 / 创意）：解构 → 重构 → 复核 → 只输出；
  保留草稿语言（含中英混排）；保留任务阶段；不扩大授权、不编造事实、不强制长文、不套角色框架。
  输出协议由 `fpe_core.py` 持有并追加在可编辑内容之后，改模板不会让解析器失配。
- **界面语言跟随 Hermes**：`ctx.i18n.register({ en, zh })` + `usePluginI18n`，运行中切换热响应；
  增强正文语言与界面语言分开处理。
- **单级撤销与对比视图**：回填后读回**实际**草稿文本作为匹配基准，不匹配时明确阻止撤销。
- **停止且丢弃迟到结果**：运行令牌递增，迟到的响应不回填、不弹成功提示；不自动重试。
- **内存态诊断**：最近 8 次运行、最近错误、最近结果摘要，可清空，全部只在内存。

### Notes

- 不安装任何依赖（Python 只用 stdlib + Hermes 运行时自带的 FastAPI），不改 Hermes 核心或 venv。
- 测试：Python 侧 stdlib `unittest` 驱动，desktop 侧 Node 内置 `node:test`；
  实测数字与验收清单见 [`docs/测试与验收说明.md`](docs/测试与验收说明.md)。
