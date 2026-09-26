# 第三方声明 / Third-party notices

本插件（fragile-prompt-enhance）的代码由作者 Ludens 编写，按仓库根目录的
[`LICENSE`](LICENSE)（MIT）发布。其**默认提示词模板**（`package/fragile-prompt-enhance/desktop/plugin.js` 的
`DEFAULT_TEMPLATES`）在编写时融合并部分译写了若干第三方提示词插件，逐条对应关系见
[`docs/来源映射与许可.md`](docs/来源映射与许可.md)。本文件按各来源的许可义务收录**可核验的许可证原文**。

本文件的每一条都不是对上游权利归属的司法或法律确认，只记录**我们实际读到过的许可声明与文本**，
以及我们据此再分发的方式。

## 1. WB-Enhance-Prompt（`WB-Enhance-Prompt-1.5.6-share`）

来源：分享包 `WB-Enhance-Prompt-1.5.6-share.zip`（内含 `wb-enhance-prompt-share.js`，`version: 1.5.6-share`）
包内 `LICENSE` 声明的许可：**MIT**
包内 `LICENSE` 声明的版权人：`Copyright (c) 2026 WB Enhance Prompt contributors`
脚本头声明：`SPDX-License-Identifier: MIT`

使用方式：`precise` / `creative` 两套出厂模板中，多条条款译写自其 `WORKBUDDY_SYSTEM_TEMPLATE`
与创意增强模板（分析流程、`WHAT not HOW`、未提及技术不添加、不索取指南/代码片段、
`INTENT AND SCOPE`、`EVIDENCE AND MISSING CONTEXT`、`EXACT CONTENT`、`FINAL CHECK` 等）。

**授权范围**：该分享包的 `LICENSE` 明文覆盖「本分享包的全部内容，包括但不限于：脚本代码、
内嵌提示词模板（WorkBuddy 原版与创意增强模式）、排版规则、README 文档及注释」；其
`README.zh-CN.md` 亦写明「1.5.6 起分享包以 MIT 许可证发布，覆盖脚本代码、内嵌提示词模板和文档」。
我们据此外向再分发由这些模板派生的条款，并保留下列署名与许可全文。

我们**读到的**两项与署名有关的事实，如实记录而不作引申：

- 该脚本自述 `author: WB Enhance Prompt (community port; not an official WorkBuddy or Augment product)`，
  即它是社区移植，**不是** WorkBuddy 或 Augment 的官方产品。
- 其模板注释自述「来自用户提供的 WorkBuddy 文档」。

因此上面的 MIT 授权是**分享包署名方（WB Enhance Prompt contributors）给出的对外授权**；
我们据此发布，并**不声称**这一授权等同于对上游 WorkBuddy 文档权利归属的确认或司法确权。

包内校验和（`SHA256SUMS.txt`，与本机实测逐条一致；校验和只证明与清单一致，不证明作者身份或许可）：

```
fdf5cd97f6eade27abe7ed91d39d9c134a3266d62c9643c1d55a1b1e5d5857bc  wb-enhance-prompt-share.js
93579466ab46c7aca70a8c6c648af3b1966678af3374d58a0c148fd60912b0ca  README.zh-CN.md
b58fc140fa8ad971fa521a3bc9465392ae6f16c890bc665001750d4fd8ee3da6  LICENSE
```

其 `LICENSE` 原文：

```
MIT License

Copyright (c) 2026 WB Enhance Prompt contributors

本许可证覆盖本分享包的全部内容，包括但不限于：
脚本代码、内嵌提示词模板（WorkBuddy 原版与创意增强模式）、
排版规则、README 文档及注释。
This license applies to the entire contents of this package, including but
not limited to: the script source code, the embedded prompt templates
(WorkBuddy mode and Creative mode), output layout rules, the README,
and all comments.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### 1.1 随其分发的 Lucide 图标（ISC）

该分享包的 `LICENSE` 与脚本头均声明：其中改编自 **Lucide v1.8.0** 的图标
（Sparkles、LoaderCircle、Undo2、X）按 **ISC** 许可发布。

```
Icons adapted from Lucide v1.8.0 (Sparkles, LoaderCircle, Undo2, X), ISC License.
Copyright (c) 2026 Lucide Icons and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

记录说明：本项目**不复用**其图标资源，只复用提示词文本；上列 ISC 声明随上述来源一并记录，
以保证来源事实完整。

## 2. Heybinshao/prompt-enhancer

来源：https://github.com/Heybinshao/prompt-enhancer
锁定提交：`8fb4e23d7e25aacf41e3be6e5c91d72af0829e86`
使用方式：`precise` / `creative` 两套模板的部分条款译写自其 `desktop/plugin.js` 的
`SYSTEM_TEMPLATE` 与硬性约束文本（尤其是「语言跟随」与「只改写不执行」两类规则）。

其 MIT 许可要求：在所有副本或实质部分中保留下列版权声明与许可全文。

```
MIT License

Copyright (c) 2026 Binshao

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 3. 已核许可、本轮未复用其文本（无署名义务，留痕备查）

- **apoapostolov/hermes-agent-awesome-plugins**（`public/prompt-enhance/`），锁定提交
  `b1d5ea1363d4f830967da4ae4748d006b07fee0e`，MIT，`Copyright (c) 2026 Apostol Apostolov`
  （其 LICENSE 另含 `Copyright (c) Adolanium`，对应仓库内的 hermes-rss）。
  本轮**未复用其文本**，仅参考其「一次调用选择模型、不改变会话模型」的产品思路。
- **Sahil-SS9/hermes-multichannel-prompt-optimizer**，目录条目提交
  `e83eba9a8e102ed255a5bfd20cc88ea50e3af28f`，MIT，`Copyright (c) 2026 Sahil Saghir`。
  本轮**未打开其源码、未复用任何内容**。

## 4. 作者自有的方法来源

`precise` / `creative` 两套模板的「解构 → 重构 → 复核 → 只输出」工作流骨架，以及「实体」「受众」
两项，来自作者本人提供的「AI 提示词优化专家」方法，不涉及第三方许可。

## 署名随包带入的两个副本

宿主安装本插件时会把统一包里的 `desktop/` 目录**复制**到 `<HERMES_HOME>/desktop-plugins/<name>/`
（`.hermes-package.json` 标记）。为避免这一复制路径下丢失署名，本文件的等价内容同时放在：

- `package/fragile-prompt-enhance/NOTICE`
- `package/fragile-prompt-enhance/desktop/NOTICE`

## 本文件**没有**主张的事

- 没有对 WB 分享包做安全审计（只读其模板、README、许可文件与文本，未运行它）。
- 没有确认 WB 分享包署名方与其自述的「WorkBuddy 文档」上游之间的授权关系。
- 没有把任何来源的许可声明当作司法确权；本文件只记录「我们读到了什么」与「我们据此怎么发布」。
- 没有运行任何第三方插件，未做跨插件行为对比实测。
