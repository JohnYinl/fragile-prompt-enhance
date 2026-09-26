# 芙拉吉尔·提示词增强 (Fragile Prompt Enhance)

Hermes Desktop 提示词增强插件：在**原生输入框**里加一个 split 按钮，把**当前草稿**改写成更清晰的提示词，并对「原文 / 增强稿」给出**同一次模型调用的参考自评**。

- 插件 id：`fragile-prompt-enhance`
- 显示名：Fragile Prompt Enhance / 芙拉吉尔·提示词增强
- 形态：统一包（agent 半 + dashboard 后端 + desktop 前端），**不安装任何依赖**，Python 只用 stdlib + Hermes 运行时自带的 FastAPI。
- 许可：**MIT**（见 [`LICENSE`](LICENSE)）；第三方署名与许可全文见 [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md)。

---

## 关于

| 项 | 值 |
| --- | --- |
| 插件 id | `fragile-prompt-enhance` |
| 版本 | `1.0.0`（变更见 [`CHANGELOG.md`](CHANGELOG.md)） |
| 界面语言 | **跟随 Hermes 当前显示语言**（`display.language`），插件自身没有语言开关 |
| 已提供语言包 | `en`、`zh`（简体） |
| 模型来源 | 默认**跟随当前会话的模型**（官方 `llm.oneshot` + `session_id`）；也可用经授权的独立模型；两条路都由宿主托管鉴权 |
| 持久化 | 仅非敏感项：默认模式、模型选择、模板 |
| 不持久化 | 草稿、增强稿、评分、诊断（只在内存，插件重载即清空） |
| 网络 | 只访问本机 Hermes 后端 `/api/plugins/fragile-prompt-enhance/` |

### 它做什么

1. 读取当前输入框草稿。
2. 用**精准**或**创意**模式，经插件自己的 Python 后端调用宿主 `ctx.llm`，一次调用同时返回：增强稿、原文与增强稿的 0-100 参考评分、五维子分、简短理由。
3. 默认把增强稿回填到草稿（纯文本，**不自动发送**），并提供单级撤销。
4. 提供原文/增强稿对比视图，含评分、免责声明与「精确内容」核对结果。
5. 查看 / 编辑 / 恢复出厂提示词模板，并可与一份小 JSON 归档互相导入导出。归档写出的是布局
   **`format_version: 2`**，**布局 1 的旧文件仍可读**（其中 `template_version: null` 一律如实报成
   「未声明版本」而不猜；自定义内容标成 `"custom"`，**不**冒用任何版本号）。导入在应用之前会显示
   真实的逐行内容差异；「恢复上一个版本」把上一次写入换下来的那一对换回来。

### 它不做什么

- 不调用任何工具，不代替你发送。
- 不读取历史会话、附件、文件、记忆；**只发送当前草稿**。
- 不扩大授权或任务范围、不降低 MVP、不编造事实、不强制长篇、不套角色框架、不凑 800 字符。
- 不探测 DOM / React 内部，不修改 Hermes 核心或 venv。
- 不支持「专业」第三模式（按约定只有精准/创意两模式）。

---

## 界面语言规则（重要）

界面语言**完全跟随 Hermes**，实现方式是官方机制：

- `ctx.i18n.register({ en, zh })` 注册语言包；
- `usePluginI18n(PLUGIN_ID)` 取翻译函数（React 侧，语言切换**热响应**）；
- `ctx.i18n.t(key, ...args)` 供非 React 的处理函数（通知、诊断）使用，同样按当前语言解析。

覆盖范围：按钮、下拉菜单、设置各页、评分五维名称、免责声明、错误、进度（增强中… N 秒）、空状态。

**两条必须区分开的语言规则：**

1. **界面语言**跟随 Hermes；未提供语言包的 locale（`ja` / `zh-hant` / `fr` …）按官方规则回退到英文包，因此界面是英文。
2. **增强正文永远保留草稿本身的语言**，并保留自然的中英混排。界面是中文**不会**把英文草稿翻译成中文，反之亦然。
3. **评分理由**按「界面实际渲染的语言」输出：界面是中文→中文理由；界面回退成英文（例如 `zh-hant`）→英文理由。这样理由与用户正在看的外壳语言一致。
4. 技术标识（插件 id、模型名、provider、`ctx.llm` 等）不翻译。

语言包叶子节点的写法遵循 SDK 契约：**带参数的文案必须是函数**（`count => ...`），因为 SDK 对字符串叶子原样返回，只有函数叶子才会收到参数。项目里有测试专门拦截「字符串叶子残留 `{count}` 占位符」这类错误。

---

## 精确内容保护

代码块、文件路径、URL、引用标识（`#123` / `[doc]` 等）属于**精确内容**，必须逐字保留。

- 后端在增强稿里核对每一条精确内容，并给出报告：`total` / `missing` / `altered_whitespace` / `truncated`。
- 只要有精确内容**丢失**，就**不自动回填**，而是打开对比视图让用户自己决定（可点「仍然回填」）。
- 空行/空白变化（不算丢失）只在对比视图里提示。

---

## 模型选择

设置页里是一道**明确的二选一**（跟随会话 / 使用专用模型），**两种都不会改变会话模型**：

1. **跟随会话**（默认）：真实走官方无状态 RPC `llm.oneshot` 并带 `session_id`，
   网关据此把该会话的 `main_runtime` 借给这次调用 —— 用的是你正在聊的那个模型，
   且**不写入会话历史**。正文与协议由插件的 `/prepare` 渲染、回答由 `/parse` 解析，正文只发一次。
   - 当前输入框**还没有活跃会话**（`new`）时，不存在可跟随的会话：此时明确改用**全局模型**
     （`ctx.llm` 的 profile 全局绑定）并在界面上说明，**不会为了凑 `session_id` 而新建会话**。
   - 该调用的归属按 **(connectionId, profile)** 解析；草稿属于另一个连接且拿不到路由描述符时
     **直接拒绝**，绝不误发到当前连接。
2. **使用专用模型**：在设置里选一个模型，只用于增强；走插件后端 `/enhance` 的 `ctx.llm` 覆写。

**无论是否已授权，模型目录都能打开、都能选**：授权是**独立的一行状态**，与选择器并列，
不再替换选择器，也不再用一段 YAML 挡住设置页。选中只写插件设置（`settings.v1`），
不碰会话模型、不碰 `config.yaml`。

目录本身是官方组件 `ModelCatalogMenu`（`@hermes/plugin-sdk` 导出，与 composer 的模型药丸
**同一个组件**，不是复刻）：它按提供方分组、`-fast` 家族折叠成一行、顶部有搜索框、每行悬停
出思考/effort 子菜单。它**是菜单内容**，自身顶层就会渲染 Radix 的 `Menu.Item`，所以必须挂在
`DropdownMenu`（root）→ `DropdownMenuTrigger` → `DropdownMenuContent` →
`ModelMenuCloseContext.Provider` 之下 —— 与核心 `model-pill.tsx` 和 SDK 的插件范例
`kanban/model-override.tsx` 完全相同的挂法。设置页里它是一个「当前模型 / 选择模型…」按钮，
点开就是同一个目录；选中即写设置并关闭菜单。

### 授权专用模型：官方入口

专用模型受 Hermes 的插件信任门控制（`agent/plugin_llm.py` 的 `PluginLLMPolicy`，
默认 `allow_model_override = False`，**失败即关闭**）。官方入口是**命令行**：

```bash
# 查看本插件声明了什么、已经授了什么
hermes plugins capabilities fragile-prompt-enhance

# 交互式授权（会列出风险并让你确认）
hermes plugins enable fragile-prompt-enhance
```

`hermes plugins enable` 写入的是 `plugins.entries.<id>.granted_capabilities`（并记下你看到的声明集合
的哈希），同时把结果镜像到下面这个**已废弃但仍被遵守**的旧键上，所以两套机制不会打架：

```yaml
# 旧键：deprecated but honored。`hermes plugins enable` 会自动写它；
# 只有你本来就这样管理信任时才手改。
plugins:
  entries:
    fragile-prompt-enhance:
      granted_capabilities: ["llm.model_override"]   # 新版入口写这里
      llm:
        allow_model_override: true                   # 镜像到的旧键（执行层读它）
        # allow_provider_override: true              # 如需同时指定 provider
        # allowed_models: ["claude-...", "*"]        # 可选白名单
        # allowed_providers: ["anthropic", "*"]
```

**我们不知道也无法自动完成的事情：** 插件不能给自己授权，界面上也不会出现任何「自动开通」
的按钮 —— 那一行只报告状态并给出上面两条命令。插件不读任何密钥、不改 `config.yaml`。

**没有授权时不会静默降级：**

- 前端在发起前**直接拒绝本次增强**，并**按模型名说明被拒的是哪个模型**，不会把 `model` 从请求里
  悄悄删掉换成会话模型。
- 后端在任何 provider 调用之前先查信任门，未授权返回 `403 model_override_denied`（附解锁提示）。
- 宿主 `ctx.llm` 自身也会抛 `PluginLlmTrustError`，后端捕获后同样返回明确错误。

---

## 默认提示词模板（本版重点）

出厂的 `DEFAULT_TEMPLATES` 是**两套完整中文模板**（精准 / 创意），不再是两句泛化英文。
它们以用户提供的中文提示词插件里的**实际提示词**为底稿融合而成，保留其工作方法：

- **解构原稿**（核心意图、含糊与冲突、实体、已知/推测/未知）→ **重构** → **复核** → 只输出；
- **保留草稿本来的语言**（中文→中文、英文→英文、中英混排保持自然混排）；
- **精确内容保护**：代码、命令、路径、URL、标识、配置值、错误原文原样保留；
- **只改写不执行**：不回答问题、不代替用户执行、不读取历史/仓库/附件。

按已确认的合同只做了「消除冲突」的删改：**不扩大授权、不编造事实、不强制长文、不套角色框架、
不读历史**。具体地：去掉了来源的「提示词工程专家」头衔（不强制角色框架）、删掉了约 800 字符的
字数配额（不强制长文）、去掉了与来源自身规则自相矛盾的示例技术选型。

模板仍可在设置里查看/编辑/恢复默认；输出协议（标记、评分结构、硬性限制）由 `fpe_core.py`
持有并追加在编辑内容之后，所以**改模板不会让解析器失配**。

### 来源与许可

出厂中文模板是**三源融合**的产物（用户的意图，不是只取一家）：用户自有的「AI 提示词优化专家」
提示词、Heybinshao/prompt-enhancer、WorkBuddy 的 `WB-Enhance-Prompt` 分享包。
**三者在默认模板里都保留**，不因为许可口径而删掉任何一路。

三路来源**都具备可依赖的再分发许可**，且都以 **MIT** 发布，因此本插件包整体按 MIT 发布：

| 来源 | 许可 | 版权人 | 依据 |
| --- | --- | --- | --- |
| WB-Enhance-Prompt `1.5.6-share` | MIT | `WB Enhance Prompt contributors` | 分享包 `LICENSE` 明文覆盖「内嵌提示词模板（WorkBuddy 原版与创意增强模式）」；1.5.5 → 1.5.6 脚本逐行差异**只有许可注释与版本号**，模板文本逐字未变 |
| Heybinshao/prompt-enhancer（提交 `8fb4e23…`） | MIT | `Binshao` | 锁定提交的 `LICENSE` |
| 用户自有的「AI 提示词优化专家」方法 | 作者自有 | — | 不涉及第三方许可 |

署名与许可全文随包分发：仓库根 [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md)，
以及 `package/fragile-prompt-enhance/NOTICE` 与 `package/fragile-prompt-enhance/desktop/NOTICE`
（后者会跟着被宿主复制到 `desktop-plugins/` 的那一半走）。

逐条落地条款的来源映射（哪一条来自哪个来源、复用方式、许可状态）见
[`docs/来源映射与许可.md`](docs/来源映射与许可.md)。

> 说明：以上记录的是**我们读到的授权声明与覆盖范围**，不是对上游权利归属的司法确权。
> WB 分享包自述为 `community port; not an official WorkBuddy or Augment product`，
> 其模板注释自述「来自用户提供的 WorkBuddy 文档」；本项目据此在分享包署名方给出的 MIT 授权下
> 再分发，并保留其署名。

---

## 目录结构

```
.
├── README.md / README.zh-CN.md      # 英文 / 中文说明
├── LICENSE                          # MIT（Copyright (c) 2026 Ludens）
├── THIRD-PARTY-NOTICES.md           # 第三方版权声明与许可全文
├── CHANGELOG.md                     # 版本记录
├── .gitignore                       # 排除本机部署记录、备份、日志、测试 harness 与凭据
├── docs/
│   ├── 来源映射与许可.md             # 逐条来源映射 + 各来源许可状态
│   ├── 测试与验收说明.md
│   └── 部署步骤.md
├── package/fragile-prompt-enhance/  # 可部署的插件包
│   ├── plugin.yaml                  # agent 半清单（loader 需要）
│   ├── NOTICE                       # 第三方署名（随包分发）
│   ├── __init__.py                  # agent 半：register(ctx)，发布 ctx.llm
│   ├── fpe_core.py                  # 协议/解析/保护/评分（纯 stdlib）
│   ├── fpe_templates.py             # 模板归档格式：构建/序列化/校验/摘要（纯 stdlib，无 I/O）
│   ├── dashboard/
│   │   ├── manifest.json            # 仅用于挂载后端路由
│   │   ├── plugin_api.py            # FastAPI 路由（/api/plugins/fragile-prompt-enhance）
│   │   └── entry.js                 # no-op，避免 entry 404
│   └── desktop/
│       ├── plugin.js                # 原生 composer 按钮 + 默认中文模板（单文件 ESM）
│       └── NOTICE                   # 第三方署名（随被复制的那一半走）
└── tests/
    ├── run_python_tests.py          # stdlib 测试驱动（不装 pytest）
    ├── red_probe_plugin_desktop.py  # 回归用例的先红验证（源码级 revert + 自动恢复）
    ├── test_fpe_core.py             # 协议 / 提示词组装 / 语言规则
    ├── test_fpe_parsing.py          # 解析与评分归一化
    ├── test_fpe_protect.py          # 精确内容保护
    ├── test_fpe_single_draft.py     # 出厂模板只发一次草稿（读真实 JS 源）
    ├── test_plugin_api.py           # 后端路由 + ctx 桥 + 授权提示
    ├── test_plugin_api_delivery.py  # 跟随会话门（llm.oneshot）+ 协议标记泄漏与改动说明的投递
    ├── test_plugin_permissions.py   # 授权只读回读（宿主两层）+ 撤销步骤，无写路径
    ├── test_template_transfer.py    # 模板归档格式 + 后端两道门（导出 / 导入校验）
    ├── test_manifests.py            # 清单用真实 Hermes 解析器校验 + 许可诚实性
    ├── test_plugin_desktop.mjs      # desktop 半（node --test）
    ├── desktop-harness.mjs          # 只重写 3 个 import 说明符
    └── desktop-stubs/               # SDK / react / jsx-runtime stub
        └── render.mjs               # 契约渲染器：走真实元素树，按 Radix 规则校验父级 provider
```

各文件职责：

- **`fpe_core.py`** 拥有**输出协议**（输出标记、评分 JSON 结构、硬性行为限制）和模板渲染。协议由 Python 侧持有并**追加在编辑内容之后**，所以改模板不会让解析器失配。
- **`plugin_api.py`** 是薄后端：校验请求 → 查信任门 → 组装消息 → `ctx.llm.acomplete` → 解析 → 返回增强稿 + 评分 + 保护报告。
- **`plugin.js`** 只做装配与渲染，草稿只经 `host.composer.getDraft` / `setDraft` 流动。

---

## 交互细节

- **split 按钮**：主键执行当前模式；右侧下拉切换模式、查看对比、撤销、打开设置。
- **停止且丢弃迟到结果**：增强中再点一次即停止；运行令牌递增，迟到的响应到达时被丢弃，既不回填也不弹成功提示。
- **独立撤销**：只回填时记录单级撤销；回填后读回**实际**草稿文本作为匹配基准，因此撤销不匹配时会明确阻止，而不是覆盖你后续的修改。
- **原文/增强稿对比**：左右对照、五维评分（目标清晰／信息充分／约束明确／交付明确／表达效率）+ 总评、免责声明、精确内容核对。
- **模板**：可查看/编辑/恢复默认；用户模板必须含 `{{draft}}` 占位符，否则保存被拒绝。存量
  `templates.v1` 只在**精确等于**旧版示例时自动迁移到新版中文默认；你改过的模板一律原样保留，
  需要主动切换时用「恢复默认」（给的是新版）。
- **诊断**：最近 8 次运行结果、最近错误、最近结果摘要，可清空；全部只在内存。

## 绑定的边界（已知限制，明确告知）

- 草稿**读写不是原子的**：`getDraft` 与 `setDraft` 是两次独立的输入框总线往返，中间输入框可能卸载。因此：写入前会重新校验草稿是否仍与增强起点一致；写失败（无挂载输入框）会明确报错，绝不半写。
- 运行绑定 (profile, connection, composer 地址)：切会话/切连接导致绑定变化时，结果被丢弃。
- 「停止」会丢弃到达的结果，但**网关侧已发出的模型调用无法中断**，它可能仍会跑完并计费。
- 插件重载后内存态（撤销、诊断、最近结果）清空，这是设计而非缺陷。
- **宿主的插件 LLM 门不带思考等级**：`ctx.llm`（`PluginLlm.complete` / `acomplete` /
  `complete_structured` / `acomplete_structured`）与无状态的 `llm.oneshot` RPC 都不接受等级参数，
  官方 `ModelCatalogMenu` 也没有任何能隐藏或禁用其思考子菜单的 prop。因此点选等级会被**拒绝**：
  不记录、不落盘、请求体里也不出现，界面直说这一点，而不是画一个不生效的控件。旧版本存过的值
  仍留在文件里，但绝不会被画成当前选择。
- **自动化测试不等于真实 Desktop**：desktop 半跑在只重写 3 个说明符的契约渲染器上，所以两套用例
  钉住的是插件自己的代码与它和宿主的契约 —— 不是像素、不是真实模型往返、也不是多窗口行为。
  这些属于刻意保留的人工检查（清单见 [`docs/测试与验收说明.md`](docs/测试与验收说明.md)）；
  本 README 不声称全端到端无遗漏。

---

## 测试

不安装任何依赖。Python 侧用 stdlib `unittest` + 自建驱动，desktop 侧用 Node 内置 `node:test`。

对**本仓库源码**的最近一次实测（2026-09-26）：Python **323 / 323**（`OK`，0 skip）、
desktop **199 / 199**（`pass 199`、`fail 0`、`skipped 0`），两个进程的退出码均为 `0`。
实测数字与逐文件用例分组见 [`docs/测试与验收说明.md`](docs/测试与验收说明.md)。

```bash
# Python 半（stdlib 驱动）。
# 必须用 `hermes --version` 对应的那个安装环境的 venv python，不要用全局 python：
# 测试要导入真实的 Hermes（fastapi/starlette、hermes_cli.*），全局 python 没有它们。
PY="<HERMES_HOME>/installs/<install>/environments/<env>/venv/Scripts/python.exe"
HERMES_REPO="<HERMES_HOME>/hermes-agent" "$PY" tests/run_python_tests.py

# desktop 半（Node 内置测试器）
node --test tests/test_plugin_desktop.mjs
```

`HERMES_REPO` 只影响清单类用例：它们需要导入真实 Hermes 的
`hermes_cli.plugins_manifest` 与 `hermes_cli.web_server_dashboard`。
找不到源码时这些用例 **skip 而不是 pass**，避免假装覆盖。

`desktop-harness.mjs` 只把 3 个裸说明符（`@hermes/plugin-sdk`、`react`、`react/jsx-runtime`）重写到 stub —— 运行期 loader 本来也只允许这 3 个，其余每一行都是将被部署的源码。
`desktop-stubs/render.mjs` 会真的走一遍插件搭出来的元素树（函数组件被调用，所以组件**自己的** children 也看得见），并按 `@radix-ui` 源码里的作用域规则断言父级 provider：菜单内容挂在裸元素上会抛出与真实崩溃**逐字相同**的 `` `MenuItem` must be used within `Menu` ``，而不是"没渲染 child 所以通过"。

详细用例、实测数字与验收清单见 [`docs/测试与验收说明.md`](docs/测试与验收说明.md)。

---

## 部署

见 [`docs/部署步骤.md`](docs/部署步骤.md)。要点：把 `package/fragile-prompt-enhance/` 整个复制为
`<HERMES_HOME>/plugins/fragile-prompt-enhance/`，把它加入 `plugins.enabled`
（未启用时后端 `api` 不会被导入），然后重启 Hermes Desktop。

## 许可

本项目以 **MIT** 发布，版权人为 `Ludens`：见 [`LICENSE`](LICENSE)。
第三方来源的版权声明与许可全文见 [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md)，
逐条来源映射见 [`docs/来源映射与许可.md`](docs/来源映射与许可.md)。
