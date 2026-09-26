# Fragile Prompt Enhance

A Hermes Desktop plugin that adds one **native composer button**: it rewrites the **current draft**
into a clearer prompt and returns a **reference self-score** for the original and the rewrite, all in
a **single model call**.

- Plugin id: `fragile-prompt-enhance`
- Display name: Fragile Prompt Enhance
- Shape: one unified package (agent half + dashboard backend + desktop half). It **installs no
  dependencies** — the Python side uses only the stdlib plus the FastAPI that already ships with the
  Hermes runtime.
- Licence: **MIT** — see [`LICENSE`](LICENSE). Third-party attribution and full licence texts:
  [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).
- 中文说明：[`README.zh-CN.md`](README.zh-CN.md)

---

## About

| Item | Value |
| --- | --- |
| Plugin id | `fragile-prompt-enhance` |
| Version | `1.0.0` (see [`CHANGELOG.md`](CHANGELOG.md)) |
| UI language | **Follows the current Hermes display language** (`display.language`); the plugin has no language switch of its own |
| Bundled locales | `en`, `zh` (Simplified) |
| Model | Defaults to **the current session's model** (official `llm.oneshot` + `session_id`); a dedicated model is also supported once the operator grants it. Both paths are host-owned and host-authenticated |
| Persisted | Non-sensitive settings only: default mode, model selection, templates |
| Not persisted | Drafts, rewrites, scores, diagnostics — memory only, cleared on plugin reload |
| Network | Only the local Hermes backend at `/api/plugins/fragile-prompt-enhance/` |

### What it does

1. Reads the current composer draft.
2. In **precise** or **creative** mode, calls the host-owned `ctx.llm` through the plugin's own Python
   backend, returning in one call: the rewrite, a 0–100 reference self-score for both drafts,
   five sub-scores, and a short rationale.
3. Writes the rewrite back into the draft (plain text, **never auto-sent**), with single-level undo.
4. Offers an original/rewrite comparison view with the score, a disclaimer, and the exact-content check.
5. Lets you view, edit and restore the prompt templates, and move them in and out of a small JSON
   archive. Archives are written in layout **`format_version: 2`**; **layout 1 files are still
   readable** (their `template_version: null` is reported as *unstated*, never guessed, and custom
   content is marked `"custom"` rather than stamped with a version number). An import shows a real
   line-level diff of what would change before anything is applied, and "restore previous version"
   swaps back the pair the last write replaced.

### What it does not do

- Calls no tools and never sends on your behalf.
- Reads no history, attachments, files or memory; it sends **only the current draft**.
- Does not widen your authorisation or scope, does not downgrade a task to an MVP, does not invent
  facts, does not force length, does not impose a role frame, does not pad to 800 characters.
- Does not probe the DOM or React internals; does not modify Hermes core or the venv.
- Has no third "professional" mode — by design there are exactly two: precise and creative.

---

## UI language rules (important)

The UI language **follows Hermes exactly**, through official mechanisms:

- `ctx.i18n.register({ en, zh })` registers the locale packs;
- `usePluginI18n(PLUGIN_ID)` returns the translation function (React side; language switches are
  picked up live);
- `ctx.i18n.t(key, ...args)` serves the non-React handlers (notifications, diagnostics) and resolves
  against the current language too.

Coverage: button, dropdown menu, every settings page, the five score dimensions, the disclaimer,
errors, progress, and empty states.

**Two language rules that must stay distinct:**

1. **The UI language** follows Hermes. Locales without a pack (`ja`, `zh-hant`, `fr`, …) fall back to
   English per the official rule, so the UI is English there.
2. **The enhanced body always keeps the draft's own language**, including natural Chinese/English
   mixing. A Chinese UI does **not** translate an English draft, and vice versa.
3. **Score rationales** follow the language the UI actually renders in: Chinese UI → Chinese
   rationale; UI fell back to English (e.g. `zh-hant`) → English rationale.
4. Technical identifiers (plugin id, model name, provider, `ctx.llm`, …) are never translated.

Locale leaves follow the SDK contract: **any text with arguments must be a function**
(`count => ...`), because the SDK returns string leaves verbatim and only function leaves receive
arguments. A test specifically catches leftovers like a `{count}` placeholder in a string leaf.

---

## Exact-content protection

Code blocks, file paths, URLs and reference markers (`#123`, `[doc]`, …) are **exact content** and
must survive verbatim.

- The backend checks every exact-content item in the rewrite and reports
  `total` / `missing` / `altered_whitespace` / `truncated`.
- If any exact content is **missing**, the plugin does **not** auto-write back; it opens the
  comparison view and lets you decide (you can still choose "write back anyway").
- Blank-line/whitespace changes (not losses) are only surfaced in the comparison view.

---

## Model selection

Settings offer an explicit either/or — **follow the session** or **use a dedicated model**. Neither
changes your session model.

1. **Follow the session** (default): really goes through the official stateless RPC `llm.oneshot`
   with a `session_id`, and the gateway lends that session's `main_runtime` to the call — the model
   you are actually chatting with — without writing to the session history. The plugin's `/prepare`
   renders instructions and input, `/parse` parses the answer, and the body is sent exactly once.
   - When the composer has **no active session yet** (`new`), there is nothing to follow: the plugin
     states plainly that it falls back to the **global model** (the `ctx.llm` profile binding) and it
     **never creates a session** just to obtain a `session_id`.
   - The call is attributed by **(connectionId, profile)**. If the draft belongs to another connection
     and no routing descriptor can be obtained, the plugin **refuses** — it never sends to the wrong
     connection.
2. **Use a dedicated model**: pick a model in settings, used only for enhancement, via the
   `ctx.llm` override on the plugin backend's `/enhance`.

**The model catalogue opens and selects regardless of authorisation.** Authorisation is a **separate
status line** next to the picker — it no longer replaces the picker, and no YAML block hides the
settings page. Selecting writes only the plugin's own settings (`settings.v1`); it touches neither
the session model nor `config.yaml`.

The catalogue itself is the official `ModelCatalogMenu` component (exported by `@hermes/plugin-sdk`,
the **same** component as the composer's model pill, not a re-implementation): grouped by provider,
`-fast` families collapsed into one row, a search box at the top, and per-row thinking/effort
submenus. It **is** menu content — it renders a Radix `Menu.Item` at its own top level — so it must be
mounted under `DropdownMenu` (root) → `DropdownMenuTrigger` → `DropdownMenuContent` →
`ModelMenuCloseContext.Provider`, exactly as core `model-pill.tsx` and the SDK's own
`kanban/model-override.tsx` do. In settings it appears as a "current model / choose model…" button
that opens the same catalogue; selecting writes the setting and closes the menu.

### Granting the dedicated model: the official entry point

The dedicated model is gated by Hermes' plugin trust gate (`PluginLLMPolicy` in
`agent/plugin_llm.py`; `allow_model_override = False` by default, **fail-closed**). The official entry
point is the CLI:

```bash
# What this plugin declares, and what you have granted
hermes plugins capabilities fragile-prompt-enhance

# Interactive grant (lists the risks and asks you to confirm)
hermes plugins enable fragile-prompt-enhance
```

`hermes plugins enable` writes `plugins.entries.<id>.granted_capabilities` (recording a hash of the
declaration set you were shown) and mirrors the result onto the deprecated-but-honoured legacy key
below, so the two mechanisms cannot fight:

```yaml
# Legacy key: deprecated but honoured. `hermes plugins enable` writes it for you;
# hand-edit it only if you already manage trust that way.
plugins:
  entries:
    fragile-prompt-enhance:
      granted_capabilities: ["llm.model_override"]   # new entry point writes here
      llm:
        allow_model_override: true                   # mirrored legacy key (enforcement reads it)
        # allow_provider_override: true              # if you also want to pin a provider
        # allowed_models: ["claude-...", "*"]        # optional allow-list
        # allowed_providers: ["anthropic", "*"]
```

**What we cannot know or automate:** a plugin cannot grant itself anything, and no "auto-enable"
button exists anywhere in the UI — that status line only reports state and prints the two commands
above. The plugin reads no keys and never edits `config.yaml`.

**Without a grant there is no silent fallback:**

- The front end **refuses the run up front** and **names the model that was refused** instead of
  quietly dropping `model` from the request and substituting the session model.
- The backend consults the trust gate before any provider call and returns
  `403 model_override_denied` (with an unlock hint) when unauthorised.
- The host's `ctx.llm` itself also raises `PluginLlmTrustError`; the backend catches it and returns an
  equally explicit error.

---

## Default prompt templates (the focus of this version)

The shipped `DEFAULT_TEMPLATES` are **two complete Chinese templates** (precise / creative) rather
than two generic English sentences. They were fused from the **actual prompts** of Chinese prompt
plugins supplied by the author, keeping their working method:

- **Deconstruct the draft** (core intent, ambiguity and conflict, entities, known/inferred/unknown)
  → **rebuild** → **final check** → output only;
- **Keep the draft's own language** (Chinese→Chinese, English→English, natural mixing preserved);
- **Exact-content protection**: code, commands, paths, URLs, identifiers, config values and original
  error text stay verbatim;
- **Rewrite, never execute**: no answering, no acting on the user's behalf, no reading of
  history/repo/attachments.

Only the conflict-removal edits the agreed contract required were made: **no widened authorisation, no
invented facts, no forced length, no role frame, no history reading.** Concretely: the sources' shared
"Prompt Engineering Expert" role title was dropped (no role frame), the ~800-character quota was
removed (no length quota), and the worked example that prescribed a technology was dropped because it
contradicted the sources' own "no unmentioned technologies" rule.

Templates stay viewable/editable/restorable in settings. The output protocol (markers, score schema,
hard behavioural limits) lives in `fpe_core.py` and is appended **after** the editable text, so
editing a template can never desynchronise the parser.

### Provenance and licence

The shipped Chinese templates fuse **three sources** (by the author's intent, not one vendor): the
author's own "AI prompt optimisation expert" method, Heybinshao/prompt-enhancer, and the WorkBuddy
`WB-Enhance-Prompt` share package. **All three are kept** in the default templates; no path was
dropped for licence reasons.

All three carry a usable redistribution licence, and all are **MIT**, so this plugin ships under MIT:

| Source | Licence | Copyright holder | Basis |
| --- | --- | --- | --- |
| WB-Enhance-Prompt `1.5.6-share` | MIT | `WB Enhance Prompt contributors` | Its package `LICENSE` explicitly covers "the embedded prompt templates (WorkBuddy mode and Creative mode)"; the 1.5.5 → 1.5.6 script diff contains **only licence comments and version strings**, the template text is byte-identical |
| Heybinshao/prompt-enhancer (commit `8fb4e23…`) | MIT | `Binshao` | The pinned commit's `LICENSE` |
| The author's own "AI prompt optimisation expert" method | Author's own | — | No third-party licence involved |

Attribution and full licence texts travel with the package: [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md)
at the repo root, plus `package/fragile-prompt-enhance/NOTICE` and
`package/fragile-prompt-enhance/desktop/NOTICE` (the latter follows the half the host copies into
`desktop-plugins/`).

Per-clause provenance — which clause came from which source, how it was reused, and its licence
status — is in [`docs/来源映射与许可.md`](docs/来源映射与许可.md).

> Note: the above records **the licence statements and scope we actually read**; it is not a judicial
> determination of upstream ownership. The WB package self-describes as a
> `community port; not an official WorkBuddy or Augment product`, and its template comments say the
> text came "from user-supplied WorkBuddy documentation". We redistribute under the MIT grant issued
> by the package's named contributors and keep their attribution.

---

## Layout

```
.
├── README.md / README.zh-CN.md      # English / Chinese docs
├── LICENSE                          # MIT (Copyright (c) 2026 Ludens)
├── THIRD-PARTY-NOTICES.md           # Third-party copyright notices and full licence texts
├── CHANGELOG.md
├── .gitignore                       # excludes local deployment records, backups, logs, test harness, credentials
├── docs/
│   ├── 来源映射与许可.md             # per-clause provenance + licence status of each source
│   ├── 测试与验收说明.md            # tests and acceptance criteria
│   └── 部署步骤.md                  # deployment steps
├── package/fragile-prompt-enhance/  # the deployable plugin package
│   ├── plugin.yaml                  # agent-half manifest (required by the loader)
│   ├── NOTICE                       # third-party attribution (ships with the package)
│   ├── __init__.py                  # agent half: register(ctx), publishes ctx.llm
│   ├── fpe_core.py                  # protocol / parsing / protection / scoring (stdlib only)
│   ├── fpe_templates.py             # the template-archive format: build / serialise / validate / describe (stdlib only)
│   ├── dashboard/
│   │   ├── manifest.json            # exists only to mount the backend router
│   │   ├── plugin_api.py            # FastAPI routes (/api/plugins/fragile-prompt-enhance)
│   │   └── entry.js                 # no-op, so `entry` does not 404
│   └── desktop/
│       ├── plugin.js                # native composer button + default Chinese templates (single-file ESM)
│       └── NOTICE                   # third-party attribution (travels with the copied half)
└── tests/
    ├── run_python_tests.py          # stdlib test driver (no pytest)
    ├── red_probe_plugin_desktop.py  # red-first probe for a regression (source-level revert + auto-restore)
    ├── test_fpe_core.py             # protocol / prompt assembly / language rules
    ├── test_fpe_parsing.py          # parsing and score normalisation
    ├── test_fpe_protect.py          # exact-content protection
    ├── test_fpe_single_draft.py     # the shipped templates send the draft exactly once (reads the real JS source)
    ├── test_plugin_api.py           # backend routes + ctx bridge + authorisation hints
    ├── test_plugin_api_delivery.py  # follow-session door (`llm.oneshot`) + marker-leak and change-note delivery
    ├── test_plugin_permissions.py   # authorisation read-back (two host layers) + the revoke steps, no write path
    ├── test_template_transfer.py    # template-archive format + the two backend doors (export / import inspect)
    ├── test_manifests.py            # manifests through the real Hermes parsers + licence honesty
    ├── test_plugin_desktop.mjs      # desktop half (node --test)
    ├── desktop-harness.mjs          # rewrites exactly 3 import specifiers
    └── desktop-stubs/               # SDK / react / jsx-runtime stubs
        └── render.mjs               # contract renderer: walks the real element tree, asserts the parent provider per Radix rules
```

Responsibilities:

- **`fpe_core.py`** owns the **output protocol** (markers, score JSON schema, hard behavioural limits)
  and template rendering. It is held on the Python side and appended **after** the editable text, so
  template edits cannot desynchronise the parser.
- **`plugin_api.py`** is a thin backend: validate → consult the trust gate → assemble messages →
  `ctx.llm.acomplete` → parse → return rewrite + scores + protection report.
- **`plugin.js`** only assembles and renders; the draft only ever moves through
  `host.composer.getDraft` / `setDraft`.

---

## Interaction details

- **Split button**: the main key runs the current mode; the right-hand dropdown switches mode, opens
  the comparison, undoes, or opens settings.
- **Stop discards late results**: clicking again during a run stops it; a run token increments, so a
  late response is discarded — no write-back, no success toast.
- **Independent undo**: single-level undo is recorded only on write-back, and the **actual** draft text
  is read back as the match baseline, so a mismatch blocks the undo explicitly instead of overwriting
  your later edits.
- **Original/rewrite comparison**: side-by-side, five sub-scores (goal clarity / information
  sufficiency / constraint explicitness / deliverable clarity / expression efficiency) plus an
  overall score, the disclaimer, and the exact-content check.
- **Templates**: view/edit/restore. A user template must contain the `{{draft}}` placeholder or the
  save is rejected. Stored `templates.v1` is auto-migrated only when it **exactly equals** the old
  sample; anything you edited is preserved as-is (use "restore default" to switch).
- **Diagnostics**: the last 8 runs, last error and a last-result summary, clearable — memory only.

## Known limits (stated up front)

- **Draft read/write is not atomic**: `getDraft` and `setDraft` are two independent composer-bus
  round trips, and the composer can unmount in between. Therefore the draft is re-validated against
  the enhancement's starting point before writing, and a failed write (no mounted composer) reports
  an explicit error instead of half-writing.
- A run is bound to (profile, connection, composer address); when that binding changes (session or
  connection switch) the result is discarded.
- **Stop** discards arriving results, but **a call the gateway has already issued cannot be
  interrupted** — it may still run to completion and be billed.
- In-memory state (undo, diagnostics, last result) is cleared on plugin reload: by design, not a bug.
- **The host's plugin LLM doors carry no thinking/reasoning level.** Neither `ctx.llm`
  (`PluginLlm.complete` / `acomplete` / `complete_structured` / `acomplete_structured`) nor the
  stateless `llm.oneshot` RPC accepts one, and the official `ModelCatalogMenu` exposes no prop that
  could hide or disable its thinking submenu. A level pick is therefore **refused**: it is not
  recorded, not persisted and never sent in a request body, and the plugin says so instead of drawing
  a control that cannot work. A level stored by an earlier build is left on file but never drawn as
  the current selection.
- **The automated suites are not the real Desktop.** The desktop half runs against a contract
  renderer with exactly 3 stubbed specifiers, so the suites pin the plugin's own code and its
  contracts with the host — not pixels, not a live model round trip, not multi-window behaviour.
  Those stay deliberate human checks (listed in [`docs/测试与验收说明.md`](docs/测试与验收说明.md));
  this README makes no full end-to-end claim.

---

## Tests

No dependencies are installed. The Python side uses stdlib `unittest` with a small custom driver; the
desktop side uses Node's built-in `node:test`.

Last measured run against the sources in this repository (2026-09-26): Python **323 / 323** (`OK`,
0 skipped) and desktop **199 / 199** (`pass 199`, `fail 0`, `skipped 0`); both processes exited `0`.
The measured numbers and per-file case groups are kept in
[`docs/测试与验收说明.md`](docs/测试与验收说明.md).

```bash
# Python half. You must use the venv python of the install environment that
# `hermes --version` reports — not a global python: the manifest cases import the
# real Hermes (fastapi/starlette, hermes_cli.*), which a global python lacks.
PY="<HERMES_HOME>/installs/<install>/environments/<env>/venv/Scripts/python.exe"
HERMES_REPO="<HERMES_HOME>/hermes-agent" "$PY" tests/run_python_tests.py

# desktop half (Node's built-in test runner)
node --test tests/test_plugin_desktop.mjs
```

`HERMES_REPO` only affects the manifest cases: they import the real
`hermes_cli.plugins_manifest` and `hermes_cli.web_server_dashboard`. When the source is not found
those cases **skip rather than pass**, so coverage is never faked.

`desktop-harness.mjs` rewrites exactly 3 bare specifiers (`@hermes/plugin-sdk`, `react`,
`react/jsx-runtime`) to stubs — the runtime loader allows exactly those 3, so every other line is the
source that will be deployed. `desktop-stubs/render.mjs` really walks the element tree the plugin
builds (function components are invoked, so a component's **own** children are visible too) and
asserts the parent provider against the scoping rules in `@radix-ui`'s source: mounting menu content
on a bare element throws the **verbatim** `` `MenuItem` must be used within `Menu` `` from the real
crash, instead of passing merely because no child was rendered.

Detailed cases, measured numbers and the acceptance checklist are in
[`docs/测试与验收说明.md`](docs/测试与验收说明.md).

---

## Deployment

See [`docs/部署步骤.md`](docs/部署步骤.md). In short: copy `package/fragile-prompt-enhance/` as a
whole to `<HERMES_HOME>/plugins/fragile-prompt-enhance/`, add it to `plugins.enabled` (without that
the backend `api` is never imported), then restart Hermes Desktop.

## Licence

Released under **MIT**, copyright `Ludens` — see [`LICENSE`](LICENSE).
Third-party notices and full licence texts: [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).
Per-clause provenance: [`docs/来源映射与许可.md`](docs/来源映射与许可.md).
