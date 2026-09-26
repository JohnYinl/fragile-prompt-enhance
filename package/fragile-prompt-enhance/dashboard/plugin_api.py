"""Fragile Prompt Enhance — thin Python host backend.

Mounted by the dashboard plugin host at ``/api/plugins/fragile-prompt-enhance``.
The desktop half reaches it through ``ctx.rest('/enhance')``.

Why a backend at all: the desktop SDK's gateway RPC for a stateless completion
(``llm.oneshot``) exposes ``profile``, ``template``, ``instructions``, ``input``,
``variables``, ``task``, ``temperature``, ``max_tokens`` and ``session_id`` — and
**no ``model`` or ``provider``**. Picking a dedicated enhancement model therefore
cannot be expressed on that door. The one supported door that carries a model is
the Python plugin API ``ctx.llm`` (``agent.plugin_llm.PluginLlm``), whose
``provider=`` / ``model=`` arguments are gated per plugin by
``plugins.entries.<id>.llm.allow_model_override`` / ``allow_provider_override``.
This module is that door, and nothing else:

* no credential handling — auth, routing, fallback and timeouts stay host-owned;
* no state — every request carries its own draft and templates;
* no privilege escalation — a requested model that the operator has not granted
  is REFUSED (403) rather than passed anyway or silently dropped.
"""

from __future__ import annotations

import asyncio
import hashlib
import importlib.util
import logging
import sys
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple, Union

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, ValidationError

logger = logging.getLogger(__name__)

PLUGIN_ID = "fragile-prompt-enhance"

_PACKAGE_DIR = Path(__file__).resolve().parent.parent
_CORE_PATH = (_PACKAGE_DIR / "fpe_core.py").resolve()


# ── host imports (defensive: the backend must never break the dashboard) ─────

try:  # the exact class ctx.llm raises
    from agent.plugin_llm import PluginLlmTrustError
except Exception:  # pragma: no cover - only when the host tree is unavailable
    class PluginLlmTrustError(PermissionError):
        """Fallback used only when ``agent.plugin_llm`` cannot be imported."""


def _redact(text: str) -> str:
    """Official redactor, then a hard cap. Error text is user-facing."""
    scrubbed = text

    try:
        from agent.redact import redact_sensitive_text

        scrubbed = redact_sensitive_text(text, force=True)
    except Exception:  # pragma: no cover - redaction is best-effort here
        pass

    return scrubbed[:400]


def _load_core() -> Any:
    """The protocol core, loaded WITHOUT touching ``sys.path``.

    The dashboard mount exec's this file by path (``spec_from_file_location``)
    and never makes the plugin directory importable, so:
      1. reuse the module object the agent half already imported — matched by
         FILE IDENTITY, whatever name it was imported under;
      2. otherwise load the file by path under a private name.

    A ``sys.path`` insert would work too, but it mutates process-global import
    state on behalf of every other module in the gateway for one file we can
    address directly.
    """
    for module in list(sys.modules.values()):
        try:
            path = getattr(module, "__file__", None)

            if path and Path(path).resolve() == _CORE_PATH:
                return module
        except (OSError, ValueError):
            continue

    spec = importlib.util.spec_from_file_location("fpe_core_backend", _CORE_PATH)

    if spec is None or spec.loader is None:  # pragma: no cover
        raise ImportError("cannot load fpe_core from %s" % _CORE_PATH)

    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    return module


core = _load_core()


def _load_sibling(name: str, path: Path) -> Any:
    """A sibling module of the package, loaded WITHOUT touching ``sys.path``.

    Same reasoning as :func:`_load_core`: the dashboard mount exec's this file
    by path, so a sibling is found by FILE IDENTITY when it is already imported
    and otherwise loaded by path under a private name — never by making the
    plugin directory importable for every other module in the gateway.
    """
    resolved = path.resolve()

    for module in list(sys.modules.values()):
        try:
            existing = getattr(module, "__file__", None)

            if existing and Path(existing).resolve() == resolved:
                return module
        except (OSError, ValueError):
            continue

    spec = importlib.util.spec_from_file_location(name, resolved)

    if spec is None or spec.loader is None:  # pragma: no cover
        raise ImportError("cannot load %s from %s" % (name, resolved))

    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    return module


#: The template archive format: what an export may contain, what an import
#: accepts. Pure, and shared by both doors below so they cannot drift.
templates = _load_sibling("fpe_templates_backend", _PACKAGE_DIR / "fpe_templates.py")


# ── plugin-context bridge ────────────────────────────────────────────────────

def resolve_plugin_context() -> Optional[Any]:
    """The live ``PluginContext`` of this plugin in THIS process, or ``None``.

    The dashboard host exec's this file as a standalone module, so the agent
    half's holder is found by FILE PATH. Re-importing ``__init__.py`` here would
    create a second module object with its own empty holder — the exact silent
    failure this lookup exists to avoid.
    """
    init_path = (_PACKAGE_DIR / "__init__.py").resolve()

    for module in list(sys.modules.values()):
        try:
            path = getattr(module, "__file__", None)

            if not path or Path(path).resolve() != init_path:
                continue
        except (OSError, ValueError):
            continue

        holder = getattr(module, "PLUGIN_CTX", None)
        getter = getattr(holder, "get", None)

        if callable(getter):
            ctx = getter()

            if ctx is not None:
                return ctx
        else:  # a test double that exposes the context directly
            ctx = getattr(module, "PLUGIN_CTX", None)

            if ctx is not None:
                return ctx

    return None


class LlmUnavailable(RuntimeError):
    """No host-owned LLM door is reachable from this process."""


_LLM_PROVIDER: Optional[Callable[[], Any]] = None
_BINDING: Optional[str] = None


def set_llm_provider(provider: Optional[Callable[[], Any]], *, binding: str = "injected") -> None:
    """Test/embedding seam: supply the object that answers ``acomplete``."""
    global _LLM_PROVIDER, _BINDING
    _LLM_PROVIDER = provider
    _BINDING = binding if provider is not None else None


def reset_llm_provider() -> None:
    set_llm_provider(None)


def current_binding() -> str:
    """How the LLM door is currently sourced: ``ctx`` / ``injected`` / ``unavailable``."""
    if _LLM_PROVIDER is not None:
        return _BINDING or "injected"

    return "ctx" if resolve_plugin_context() is not None else "unavailable"


def resolve_llm() -> Tuple[Any, str]:
    """``(llm, binding)``. Raises :class:`LlmUnavailable` — never falls back."""
    if _LLM_PROVIDER is not None:
        return _LLM_PROVIDER(), (_BINDING or "injected")

    ctx = resolve_plugin_context()

    if ctx is None:
        raise LlmUnavailable(
            "The plugin's agent half is not loaded in this process, so ctx.llm is "
            "unavailable. Add %r to plugins.enabled in config.yaml and restart the "
            "gateway; the plugin never falls back to its own credentials." % PLUGIN_ID
        )

    llm = getattr(ctx, "llm", None)

    if llm is None:
        raise LlmUnavailable("The plugin context exposes no ctx.llm in this build.")

    return llm, "ctx"


# ── trust gate ───────────────────────────────────────────────────────────────

_OVERRIDE_KEYS = (
    "allow_model_override",
    "allow_provider_override",
    "allow_agent_id_override",
    "allow_profile_override",
)

#: The official capability ids this backend's gates map to
#: (``hermes_cli.plugin_capabilities.CAPABILITY_REGISTRY``). Declared in
#: plugin.yaml; reported here read-only so the UI can show what was consented.
#: ``(kind, capability id, legacy path)`` — the legacy path is the pair a grant
#: mirrors into and the ONLY thing ``agent/plugin_llm._resolve_trust_policy``
#: reads, so it is also what a revoke has to clear.
DECLARED_CAPABILITIES: Tuple[Tuple[str, str, Tuple[str, ...]], ...] = (
    ("model", "llm.model_override", ("llm", "allow_model_override")),
    ("provider", "llm.provider_override", ("llm", "allow_provider_override")),
)

_OVERRIDE_CAPABILITIES = {kind: capability for kind, capability, _path in DECLARED_CAPABILITIES}

#: The two revoke/complex states a reader can be in: the enforcing layer and the
#: consent record disagreeing in either direction.
GATE_WITHOUT_CONSENT = "gate-without-consent"
CONSENT_WITHOUT_GATE = "consent-without-gate"


def _coerce_allowlist(raw: Any) -> Tuple[Optional[List[str]], bool]:
    """Mirror of ``agent.plugin_llm._coerce_allowlist``.

    ``"*"`` is the wildcard and is NOT an entry; entries are stripped and
    lower-cased; blanks are dropped. A non-list (including a missing key) is "no
    allow-list", which is different from an empty list — the host treats
    ``None`` as "any value the trust flag allows".
    """
    if not isinstance(raw, list):
        return None, False

    normalized = [item.strip().lower() for item in raw if isinstance(item, str)]

    return [item for item in normalized if item and item != "*"], "*" in normalized


def _read_granted_capabilities(config: Any, plugin_id: str) -> List[str]:
    """The official ``plugins.entries.<id>.granted_capabilities`` consent record.

    Read-only and informational: the ENFORCING layer for ``ctx.llm`` is
    ``agent.plugin_llm``, which reads the legacy ``allow_*`` keys that
    ``record_consent`` mirrors a grant into. This plugin therefore never treats
    a grant alone as authorization — it reports it so the operator can see a
    divergence instead of being surprised by a 403.
    """
    wanted = set(_OVERRIDE_CAPABILITIES.values())
    node: Any = config if isinstance(config, dict) else {}

    for key in ("plugins", "entries", plugin_id):
        node = node.get(key) if isinstance(node, dict) else None

    raw = node.get("granted_capabilities") if isinstance(node, dict) else None

    if not isinstance(raw, list):
        return []

    known = [item.strip() for item in raw if isinstance(item, str) and item.strip() in wanted]

    return sorted(set(known))


def read_trust_policy_from_config(config: Any, plugin_id: str = PLUGIN_ID) -> Dict[str, Any]:
    """Mirror of ``agent.plugin_llm``'s own resolution, from raw config.

    Read-only and fail-closed: any shape surprise yields the fully restrictive
    policy, which is what the host itself would apply. Allow-lists go through
    :func:`_coerce_allowlist`, the host's own coercion, so this can never be
    more permissive than the layer that enforces it.
    """
    gate: Dict[str, Any] = {key: False for key in _OVERRIDE_KEYS}
    gate["allowed_models"] = None
    gate["allow_any_model"] = False
    gate["allowed_providers"] = None
    gate["allow_any_provider"] = False
    gate["granted_capabilities"] = []
    gate["enforced_by"] = "config-mirror"

    node: Any = (config or {}).get("plugins") if isinstance(config, dict) else None
    node = node.get("entries") if isinstance(node, dict) else None
    node = node.get(plugin_id) if isinstance(node, dict) else None
    node = node.get("llm") if isinstance(node, dict) else None

    gate["granted_capabilities"] = _read_granted_capabilities(config, plugin_id)

    if not isinstance(node, dict):
        return gate

    for key in _OVERRIDE_KEYS:
        gate[key] = bool(node.get(key, False))

    models, any_model = _coerce_allowlist(node.get("allowed_models"))
    providers, any_provider = _coerce_allowlist(node.get("allowed_providers"))
    gate["allowed_models"] = models
    gate["allow_any_model"] = any_model
    gate["allowed_providers"] = providers
    gate["allow_any_provider"] = any_provider

    return gate


def _host_trust_policy(plugin_id: str) -> Optional[Any]:
    """The live ``_TrustPolicy`` from ``agent.plugin_llm``, or ``None``.

    The host's own resolver IS the enforcement point for ``ctx.llm``, so
    preferring it removes any chance of a second, subtly different gate.
    """
    try:
        from agent.plugin_llm import _resolve_trust_policy
    except Exception:  # pragma: no cover - host tree unavailable
        return None

    try:
        return _resolve_trust_policy(plugin_id)
    except Exception:  # pragma: no cover - defensive: never break the route
        return None


def _policy_to_gate(policy: Any, plugin_id: str) -> Dict[str, Any]:
    """``_TrustPolicy`` → the JSON shape the desktop half reads."""
    def as_list(value: Any) -> Optional[List[str]]:
        if value is None:
            return None

        try:
            return sorted(str(item) for item in value)
        except TypeError:  # pragma: no cover - defensive
            return None

    return {
        "plugin_id": plugin_id,
        "allow_model_override": bool(getattr(policy, "allow_model_override", False)),
        "allow_provider_override": bool(getattr(policy, "allow_provider_override", False)),
        "allow_agent_id_override": bool(getattr(policy, "allow_agent_id_override", False)),
        "allow_profile_override": bool(getattr(policy, "allow_profile_override", False)),
        "allowed_models": as_list(getattr(policy, "allowed_models", None)),
        "allow_any_model": bool(getattr(policy, "allow_any_model", False)),
        "allowed_providers": as_list(getattr(policy, "allowed_providers", None)),
        "allow_any_provider": bool(getattr(policy, "allow_any_provider", False)),
        "granted_capabilities": [],
        "enforced_by": "host",
    }


def read_trust_policy(plugin_id: str = PLUGIN_ID) -> Dict[str, Any]:
    """Live gate: the host's own resolver first, the config mirror as fallback.

    ``enforced_by`` names which layer answered — ``host`` (``agent.plugin_llm``,
    the layer that actually enforces ``ctx.llm``) or ``config-mirror`` (a
    read-only copy of what the host would read). It is stamped here rather than
    by either resolver so the label always describes the path taken.
    """
    policy = _host_trust_policy(plugin_id)

    if policy is not None:
        gate = _policy_to_gate(policy, plugin_id)
        gate["granted_capabilities"] = _granted_capabilities(plugin_id)

        return gate

    try:
        from hermes_cli.config import load_config_readonly

        config = load_config_readonly() or {}
    except Exception as exc:  # pragma: no cover - config IO failure
        logger.warning("fpe: trust policy read failed: %s", exc)
        config = {}

    gate = dict(read_trust_policy_from_config(config, plugin_id))
    gate.setdefault("granted_capabilities", _read_granted_capabilities(config, plugin_id))
    gate["plugin_id"] = gate.get("plugin_id") or plugin_id
    gate["enforced_by"] = "config-mirror"

    return gate


def _granted_capabilities(plugin_id: str) -> List[str]:
    """The official consent record, read-only, never fatal."""
    try:
        from hermes_cli.config import load_config_readonly

        return _read_granted_capabilities(load_config_readonly() or {}, plugin_id)
    except Exception:  # pragma: no cover - informational only
        return []


def _gate_allowlists(gate: Dict[str, Any], kind: str) -> Tuple[Optional[List[str]], bool]:
    """``(allowed_entries_or_None, allow_any)`` for ``model`` / ``provider``.

    Coerced through the host's own :func:`_coerce_allowlist` every time, so the
    verdict cannot depend on which resolver produced the gate — a raw
    ``["*"]`` means "any" whichever door it came through.
    """
    entries, any_entry = _coerce_allowlist(gate.get("allowed_%ss" % kind))

    return entries, any_entry or bool(gate.get("allow_any_%s" % kind))


def _override_refusal(kind: str, request: Dict[str, Optional[str]]) -> Optional[Tuple[str, str]]:
    """``(code, message)`` when the host would refuse this override, else ``None``.

    Mirrors ``agent.plugin_llm._gate_ref_override`` in order: trust flag first,
    then the optional allow-list. Same order means the refusal names the real
    reason — a closed gate is not reported as an allow-list miss.
    """
    requested = (request.get(kind) or "").strip()

    if not requested:
        return None

    gate = read_trust_policy()

    if not gate.get("allow_%s_override" % kind):
        return (
            "%s_override_denied" % kind,
            "A dedicated enhancement %s was requested but this plugin is not "
            "granted that override, and it will not be passed anyway or silently "
            "ignored." % kind,
        )

    allowed, allow_any = _gate_allowlists(gate, kind)

    if not allow_any and allowed is not None and requested.lower() not in allowed:
        return (
            "%s_not_allowed" % kind,
            "The requested enhancement %s is not in this plugin's %s allow-list, "
            "so the run was refused rather than sent with a model the operator "
            "did not authorize." % (kind, "allowed_%ss" % kind),
        )

    return None


# ── authorization read-back (the two layers, side by side) ───────────────────

def capability_rows(gate: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
    """One row per DECLARED capability: what each layer says, and any divergence.

    Two different host layers decide whether a dedicated model may run, and they
    are NOT the same store:

    * ``enforced`` — the ENFORCING layer: the legacy ``allow_*_override`` boolean
      ``agent/plugin_llm._resolve_trust_policy`` reads on every call. This is the
      one that refuses a run.
    * ``consent`` — the consent RECORD: whether this capability id is in
      ``plugins.entries.<id>.granted_capabilities``, written by
      ``hermes_cli.plugin_capabilities.record_consent`` during the shipped CLI
      consent screen. The gate never reads it.

    ``record_consent`` mirrors each grant into its legacy key, so a normally
    consented install has both. Anything else is a real divergence and is
    reported as such rather than smoothed over: a hand-set key is enforced
    without consent, and a record whose key was cleared reads as granted while
    every run is refused.

    Fail-closed and shape-tolerant: an unreadable or malformed gate yields the
    fully restrictive row (which is what the host would apply).
    """
    data = gate if isinstance(gate, dict) else {}
    raw_record = data.get("granted_capabilities")
    granted = {
        item.strip()
        for item in (raw_record if isinstance(raw_record, list) else [])
        if isinstance(item, str) and item.strip()
    }
    enforced_by = data.get("enforced_by")
    enforced_by = enforced_by if enforced_by in ("host", "config-mirror") else "config-mirror"

    rows: List[Dict[str, Any]] = []

    for kind, capability, legacy_path in DECLARED_CAPABILITIES:
        enforced = bool(data.get("allow_%s_override" % kind, False))
        consent = capability in granted

        if enforced and not consent:
            divergence: Optional[str] = GATE_WITHOUT_CONSENT
        elif consent and not enforced:
            divergence = CONSENT_WITHOUT_GATE
        else:
            divergence = None

        rows.append({
            "capability": capability,
            "kind": kind,
            "legacy_key": "plugins.entries.%s.%s" % (PLUGIN_ID, ".".join(legacy_path)),
            "enforced": enforced,
            "consent": consent,
            "enforced_by": enforced_by,
            "divergence": divergence,
        })

    return rows


# ── the operator's two paths: grant / revoke (TEXT ONLY) ────────────────────
#
# Neither path can be executed from here. The shipped consent screen
# (`hermes_cli/plugins_cmd_capabilities.py::_run_capability_consent`) is gated on
# `plugins_cmd._is_tty()` (stdin AND stdout a terminal) and fails closed
# otherwise; `plugins.manage` exposes no capability action; the desktop plugin
# SDK has no consent door. So this backend READS the two layers back and hands
# the operator the exact official commands instead of faking a button.
#
# Only the COMMENTARY is translated. The `hermes …` lines are byte-identical in
# every language — a translated or reformatted command would not be the command
# the host ships.

_HINT_LANGS = ("en", "zh")


def _hint_lang(lang: Any) -> str:
    """The shipped hint languages; anything else falls back to English."""
    return lang if lang in _HINT_LANGS else "en"


_REVOKE_COMMENTARY: Dict[str, Tuple[str, ...]] = {
    "en": (
        "# 1) Coarse: the official CLI disables the whole plugin, so nothing it\n"
        "#    declared loads. Cost: the enhancement button and the model choice go\n"
        "#    with it.\n\n",
        "# 2) Read the live declared-vs-granted state first (read-only).\n\n",
        "# 3) Precise: keep the plugin and the model choice, close the two overrides.\n",
        "",
        "",
    ),
    "zh": (
        "# 1) 粗粒度：用官方 CLI 关掉整个插件，它声明过的东西都不再加载。\n"
        "#    代价：增强按钮和模型选择一起消失。\n\n",
        "# 2) 先读一次 declared / granted 的实况（只读）。\n\n",
        "# 3) 精确撤销：保留插件与模型选择，只关掉这两个 override。\n",
        "",
        "",
    ),
}

_REVOKE_TAIL: Dict[str, str] = {
    "en": (
        "#    All three commands are required. The first two clear the keys\n"
        "#    agent/plugin_llm._resolve_trust_policy actually reads (leave either and\n"
        "#    a pinned run is still allowed); the third clears the consent record\n"
        "#    (leave it and this page still reads as granted). The host ships no\n"
        "#    revoke command or revoke API for a capability, so this is the only\n"
        "#    mechanism.\n"
        "\n"
        "# 4) Back in this plugin, press \"Re-read permission\" to confirm the\n"
        "#    enforcing layer is closed. The model choice stays; a pinned run is\n"
        "#    then refused by name and is never downgraded to the session model.\n"
    ),
    "zh": (
        "#    上面三行必须都执行：前两行清掉的是 agent/plugin_llm\n"
        "#    ._resolve_trust_policy 真正读取的键（留下任何一行，专用模型的运行\n"
        "#    仍然被放行）；第三行清掉的是授权记录（留着它，本页就仍然显示已授权）。\n"
        "#    宿主没有为“撤销能力”提供任何命令或 API，这是唯一机制。\n"
        "\n"
        "# 4) 回到本插件点“重新读取权限”确认执行层已关闭。模型选择会保留；\n"
        "#    此后用专用模型的运行会按模型名明确拒绝，不会降级为会话模型。\n"
    ),
}

_UNLOCK_COMMENTARY: Dict[str, Tuple[str, str]] = {
    "en": (
        "# grants it interactively; decline and the plugin stays enabled with the\n"
        "# capability off (fail closed). Nothing is granted without this step.\n\n",
        "# shows declared vs. granted for this plugin\n\n",
    ),
    "zh": (
        "# 在终端里交互授权：这就是官方的能力同意流程。拒绝它，或运行在没有终端\n"
        "# 的环境里，能力都保持关闭（fail closed）——不会自动授权。\n\n",
        "# 查看本插件 declared / granted 的实况\n\n",
    ),
}

_UNLOCK_YAML_INTRO: Dict[str, str] = {
    "en": (
        "# equivalent, via the DEPRECATED legacy key (honored, but superseded by\n"
        "# plugins.entries.<id>.granted_capabilities — edit config.yaml by hand only\n"
        "# if you already manage trust that way):\n"
    ),
    "zh": (
        "# 等价的旧键写法：宿主仍然读取它，但它已被能力同意流程取代；只有你本来\n"
        "# 就这样管理信任时，才按这个形状手改 config.yaml：\n"
    ),
}


def revoke_hint(plugin_id: str = PLUGIN_ID, *, lang: str = "en") -> str:
    """The exact operator steps that CLOSE a granted override — text only.

    Verified against the shipped source (Hermes v0.21.5+2446.g9fc7f17), because
    there is no revoke API to call:

    * ``hermes_cli/plugin_capabilities.py`` has exactly one writer,
      ``record_consent``, and it only UNIONS grants in — nothing removes one;
    * ``hermes_cli/subcommands/plugins.py`` registers no revoke/ungrant
      subcommand, and ``plugins.manage``
      (``tui_gateway/methods_tools.py:_PLUGINS_ACTIONS``) has no capability
      action at all;
    * the gate is open when EITHER the record OR the legacy key is set
      (``plugin_capability_granted``), while the layer that actually enforces
      ``ctx.llm`` reads ONLY the legacy key — so a revoke must clear both, or it
      either keeps a run allowed (record cleared, key left) or reads as granted
      while refusing (key cleared, record left);
    * ``hermes config unset`` is the official writer for those keys
      (``hermes_cli/config.py::unset_config_value`` → ``_unset_nested``, which
      handles these dotted paths — checked against those functions directly).

    This function only ever RETURNS TEXT. The plugin cannot revoke its own trust
    any more than it can grant it, and it must never appear to.
    """
    commands = (
        "hermes plugins disable %s" % plugin_id,
        "hermes plugins capabilities %s" % plugin_id,
        "hermes config unset plugins.entries.%s.llm.allow_model_override" % plugin_id,
        "hermes config unset plugins.entries.%s.llm.allow_provider_override" % plugin_id,
        "hermes config unset plugins.entries.%s.granted_capabilities" % plugin_id,
    )
    commentary = _REVOKE_COMMENTARY[_hint_lang(lang)]

    return "".join(
        "%s\n%s" % (command, note) for command, note in zip(commands, commentary)
    ) + _REVOKE_TAIL[_hint_lang(lang)]


def unlock_hint(plugin_id: str = PLUGIN_ID, *, need_provider: bool = False, lang: str = "en") -> str:
    """The exact steps that unlock a dedicated enhancement model — text only.

    Opens with the SHIPPED consent surface — ``hermes plugins enable`` grants
    interactively and ``hermes plugins capabilities`` shows declared vs granted
    (``hermes_cli/plugins_cmd_capabilities.py``). The YAML below it is the
    deprecated-but-honored legacy gate, documented so an operator who already
    works that way is not stranded; it is not the supported entry point.

    This function only ever RETURNS TEXT. Nothing here grants anything: the
    plugin cannot widen its own trust, and it must not appear to.
    """
    keys = ["      llm:", "        allow_model_override: true"]

    if need_provider:
        keys.append("        allow_provider_override: true")

    yaml_block = (
        "plugins:\n"
        "  entries:\n"
        "    %s:\n" % plugin_id
        + "\n".join(keys)
        + "\n    # optional allow-lists: allowed_models: [\"*\"] / allowed_providers: [\"*\"]"
    )

    commands = (
        "hermes plugins enable %s" % plugin_id,
        "hermes plugins capabilities %s" % plugin_id,
    )
    commentary = _UNLOCK_COMMENTARY[_hint_lang(lang)]

    return (
        "".join("%s\n%s" % (command, note) for command, note in zip(commands, commentary))
        + _UNLOCK_YAML_INTRO[_hint_lang(lang)]
        + yaml_block
    )


# ── request/response models ──────────────────────────────────────────────────

class EnhanceRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    mode: str = core.MODE_PRECISE
    draft: str = ""
    system_template: str = ""
    user_template: str = ""
    ui_lang: Optional[str] = None
    model: Optional[str] = None
    provider: Optional[str] = None
    timeout_s: Optional[float] = None


class PrepareRequest(BaseModel):
    """The editorial half of a run, assembled but not sent.

    ``model_config`` ignores extras for the same reason as :class:`EnhanceRequest`:
    one shared client posts to all three doors.
    """

    model_config = ConfigDict(extra="ignore")

    mode: str = core.MODE_PRECISE
    draft: str = ""
    system_template: str = ""
    user_template: str = ""
    ui_lang: Optional[str] = None


class ParseRequest(BaseModel):
    """A model answer to parse against the draft it was produced from."""

    model_config = ConfigDict(extra="ignore")

    mode: str = core.MODE_PRECISE
    draft: str = ""
    model_text: Any = None


class TemplateExportRequest(BaseModel):
    """Pack the live templates into an archive, optionally writing it out.

    ``path`` is the path the USER picked in the native save dialog — a string
    the desktop half never writes itself, because the renderer has no filesystem
    access and must not pretend to. Absent/empty means "hand me the archive, I
    will put it on the clipboard".

    ``template_version`` is the desktop half's statement about the bytes it is
    sending: the integer of the shipped default they ARE, or ``"custom"`` when
    they are not one. It may stay unset — a caller that says nothing gets the
    ``custom`` marker, which claims no shipped default (see
    :func:`fpe_templates.build_export`); a value that is neither is refused.
    """

    model_config = ConfigDict(extra="ignore")

    mode: str = "both"
    scope: str = "both"
    templates: Any = None
    template_version: Optional[Union[int, str]] = None
    plugin_version: Optional[str] = None
    path: Optional[str] = None


class TemplateImportRequest(BaseModel):
    """A picked file path OR pasted archive text — exactly one of the two.

    The paste form is what keeps this usable on a surface where the native open
    dialog resolves nothing (an OAuth remote, an older desktop build): the same
    validation, reached without a filesystem the renderer does not have.
    """

    model_config = ConfigDict(extra="ignore")

    path: Optional[str] = None
    json: Optional[str] = None


DEFAULT_TIMEOUT_S = 120.0
MIN_TIMEOUT_S = 5.0
MAX_TIMEOUT_S = 300.0


def _error(status: int, code: str, message: str, **extra: Any) -> JSONResponse:
    payload: Dict[str, Any] = {"ok": False, "error": {"code": code, "message": message}}
    payload["error"].update(extra)

    return JSONResponse(status_code=status, content=payload)


def _clean(value: Optional[str]) -> Optional[str]:
    if not isinstance(value, str):
        return None

    stripped = value.strip()

    return stripped or None


def _assemble(payload: Any) -> List[Dict[str, str]]:
    """The two messages for one run. The ONE assembly point for every door."""
    mode = _clean(getattr(payload, "mode", None)) or core.MODE_PRECISE

    return core.build_messages(
        mode=mode,
        draft=payload.draft if isinstance(payload.draft, str) else "",
        system_template=payload.system_template,
        user_template=payload.user_template,
        ui_lang=_clean(payload.ui_lang),
    )


def _result_payload(parsed: Dict[str, Any], *, draft: str, mode: str) -> Dict[str, Any]:
    """The shared result body — /enhance and /parse must never disagree."""
    if not parsed["enhanced"]:
        return {
            "ok": False,
            "error": {
                "code": "empty_response",
                "message": "The model returned no usable prompt text; nothing was applied.",
            },
            "enhanced": "",
            "scores": None,
            "score_error": parsed["score_error"],
            # Always present, even empty: the desktop half reads it as "no note"
            # rather than as a missing field, and a model that omits the key must
            # never cost the user the body or trigger a second request.
            "changes": parsed.get("changes") or "",
            "text_shape": parsed["shape"],
            "mode": mode,
        }

    return {
        "ok": True,
        "enhanced": parsed["enhanced"],
        "scores": parsed["scores"],
        "score_error": parsed["score_error"],
        "changes": parsed.get("changes") or "",
        "text_shape": parsed["shape"],
        "protection": core.verify_protected(draft, parsed["enhanced"]),
        "mode": mode,
    }


def _prepare_response(payload: Any) -> Dict[str, Any]:
    """Body of a successful ``/prepare``."""
    messages = _assemble(payload)

    return {
        "ok": True,
        "protocol_version": core.PROTOCOL_VERSION,
        "mode": _clean(getattr(payload, "mode", None)) or core.MODE_PRECISE,
        "instructions": messages[0]["content"],
        "input": messages[1]["content"],
        "draft_chars": len(payload.draft if isinstance(payload.draft, str) else ""),
        "draft_fence": core.DRAFT_FENCE,
        "max_tokens": core.ONESHOT_MAX_TOKENS,
    }


def _parse_response(payload: Any) -> Any:
    """Body of ``/parse`` — or the 400 envelope for an unusable request."""
    draft = payload.draft if isinstance(payload.draft, str) else ""

    if not draft.strip():
        return _error(400, "invalid_request", "draft is empty")

    mode = _clean(payload.mode) or core.MODE_PRECISE

    if mode not in core.MODES:
        return _error(400, "invalid_request", "unknown mode %r" % payload.mode)

    if not isinstance(payload.model_text, str):
        return _error(400, "invalid_request", "model_text must be a string")

    parsed = core.parse_model_output(payload.model_text, draft=draft)
    body = _result_payload(parsed, draft=draft, mode=mode)
    body["model_text_chars"] = len(payload.model_text)

    return body


# ── routes ───────────────────────────────────────────────────────────────────

router = APIRouter()


@router.get("/status")
async def status() -> Dict[str, Any]:
    """Capabilities + the operator's LLM gate. No draft, no secrets.

    Both shipped locales ride along in ``hints`` so a language switch repaints
    without another read; the flat ``unlock_hint`` / ``revoke_hint`` stay the
    English ones for any reader that already parses them.
    """
    gate = read_trust_policy()
    hints = {
        lang: {"unlock_hint": unlock_hint(lang=lang), "revoke_hint": revoke_hint(lang=lang)}
        for lang in _HINT_LANGS
    }

    return {
        "ok": True,
        "plugin_id": PLUGIN_ID,
        "protocol_version": core.PROTOCOL_VERSION,
        "modes": list(core.MODES),
        "dimensions": list(core.DIMENSIONS),
        "score_scale": "0-100",
        "score_basis": "self_assessed",
        "limits": {
            "max_draft_chars": core.MAX_DRAFT_CHARS,
            "max_protected_tokens": core.MAX_PROTECTED_TOKENS,
            "max_output_tokens": core.ONESHOT_MAX_TOKENS,
            "min_timeout_s": MIN_TIMEOUT_S,
            "max_timeout_s": MAX_TIMEOUT_S,
            "default_timeout_s": DEFAULT_TIMEOUT_S,
        },
        "llm": {
            "binding": current_binding(),
            "trust": dict(
                gate,
                unlock_hint=hints["en"]["unlock_hint"],
                revoke_hint=hints["en"]["revoke_hint"],
                hints=hints,
                capabilities=capability_rows(gate),
            ),
        },
    }


async def _parse_body(request: Request, model: Any = EnhanceRequest) -> Tuple[Optional[Any], Optional[JSONResponse]]:
    """Parse the body ourselves so EVERY client error answers with one shape.

    FastAPI's default validation failure is a 422 with a framework-shaped body;
    the desktop half has a single error renderer, so a bad request must arrive as
    the same ``{"ok": false, "error": {...}}`` envelope as everything else.
    """
    try:
        raw = await request.json()
    except Exception:
        return None, _error(400, "invalid_request", "The request body is not valid JSON.")

    if not isinstance(raw, dict):
        return None, _error(400, "invalid_request", "The request body must be a JSON object.")

    try:
        return model(**raw), None
    except ValidationError as exc:
        return None, _error(
            400, "invalid_request", "Invalid request fields.",
            detail=_redact(str(exc)),
        )


@router.post("/prepare")
async def prepare(request: Request) -> Any:
    """Assemble one run's messages WITHOUT calling any model.

    The desktop half needs exactly the two messages a run sends, because the
    real follow-session door is the official stateless gateway RPC
    ``llm.oneshot`` (which borrows the live session's model) — that RPC takes
    ``instructions`` / ``input``, not a model override, so the editorial half and
    the output protocol have to be rendered somewhere both paths agree on. That
    is here. Pure: no credential, no provider, no state, no draft echo.
    """
    payload, failure = await _parse_body(request, PrepareRequest)

    if failure is not None:
        return failure

    assert payload is not None

    try:
        return _prepare_response(payload)
    except core.TemplateError as exc:
        return _error(400, "invalid_request", str(exc))


@router.post("/parse")
async def parse(request: Request) -> Any:
    """Turn a model answer into the shared result body. Pure.

    Identical parsing, score normalisation and exact-content protection to
    :func:`enhance`, so the two delivery paths cannot drift: whichever door
    produced the text, the user gets the same body, the same optional score
    block and the same protection report.
    """
    payload, failure = await _parse_body(request, ParseRequest)

    if failure is not None:
        return failure

    assert payload is not None

    return _parse_response(payload)


@router.post("/enhance")
async def enhance(request: Request) -> Any:
    """One enhancement through the host's model door: rewrite + self-score.

    Status contract: 200 for a produced result (INCLUDING a body whose score
    block was missing — the body is the product), 400 bad request, 403 gate
    refusal, 502 upstream failure, 503 no host LLM door.

    This door carries a MODEL, so it is used for the two paths that need one:
    a pinned enhancement model (gated override) and the explicit global fallback
    when the draft has no live chat to follow. Following a live session goes
    through ``/prepare`` → ``llm.oneshot`` → ``/parse`` instead, because
    ``ctx.llm`` here resolves the PROFILE GLOBAL model — it has no session to
    borrow — and pretending otherwise would be a silent model substitution.
    """
    payload, failure = await _parse_body(request)

    if failure is not None:
        return failure

    assert payload is not None

    mode = _clean(payload.mode) or core.MODE_PRECISE
    model = _clean(payload.model)
    provider = _clean(payload.provider)

    try:
        messages = _assemble(payload)
    except core.TemplateError as exc:
        return _error(400, "invalid_request", str(exc))

    # ── trust gate FIRST: refuse before any provider call ────────────────────
    # Order matches `agent.plugin_llm._check_overrides` (provider before model),
    # so when both are refused the user is told the reason the host would give.
    requested = {"model": model, "provider": provider}

    for kind in ("provider", "model"):
        refusal = _override_refusal(kind, requested)

        if refusal is not None:
            code, message = refusal

            return _error(
                403,
                code,
                message,
                requested=requested,
                unlock_hint=unlock_hint(need_provider=(kind == "provider")),
            )

    try:
        llm, binding = resolve_llm()
    except LlmUnavailable as exc:
        return _error(503, "llm_unavailable", str(exc))

    timeout = payload.timeout_s

    if not isinstance(timeout, (int, float)) or timeout != timeout:
        timeout = DEFAULT_TIMEOUT_S

    timeout = float(min(max(float(timeout), MIN_TIMEOUT_S), MAX_TIMEOUT_S))

    started = time.monotonic()

    try:
        result = await llm.acomplete(
            messages=messages,
            model=model,
            provider=provider,
            timeout=timeout,
            purpose="fragile-prompt-enhance.rewrite",
        )
    except PluginLlmTrustError as exc:
        return _error(
            403,
            "model_override_denied",
            "The host refused the requested model/provider for this plugin.",
            detail=_redact(str(exc)),
            unlock_hint=unlock_hint(need_provider=bool(provider)),
        )
    except asyncio.TimeoutError:
        return _error(504, "upstream_timeout", "The model call timed out.")
    except Exception as exc:
        logger.warning("fpe: enhancement call failed (%s)", type(exc).__name__)

        return _error(
            502,
            "upstream_error",
            "The model call failed.",
            detail=_redact("%s: %s" % (type(exc).__name__, exc)),
        )

    duration_ms = int((time.monotonic() - started) * 1000)
    text = getattr(result, "text", "") or ""
    parsed = core.parse_model_output(text, draft=payload.draft if isinstance(payload.draft, str) else "")
    body = _result_payload(parsed, draft=payload.draft, mode=mode)

    body.update(
        provider=getattr(result, "provider", "") or "",
        model=getattr(result, "model", "") or "",
        duration_ms=duration_ms,
        llm_binding=binding,
    )

    if not body["ok"]:
        # The attribution still has to travel with an unusable answer, so the
        # user can see which model produced nothing.
        return body

    usage = getattr(result, "usage", None)

    body.update(
        usage={
            "input_tokens": getattr(usage, "input_tokens", 0),
            "output_tokens": getattr(usage, "output_tokens", 0),
            "total_tokens": getattr(usage, "total_tokens", 0),
            "cost_usd": getattr(usage, "cost_usd", None),
        },
        requested_model={"model": model, "provider": provider} if (model or provider) else None,
    )

    return body


# ── template archive doors ───────────────────────────────────────────────────
#
# Both doors are stateless: the templates live in the desktop half's own storage,
# and these only pack what it sends, or read what the user picked. Neither one
# touches the live templates, the settings, the chat or any credential — a file
# that reaches a path is the only side effect either of them has, and only when
# the user chose that path in the native dialog.

def _absolute_path(raw: Any) -> Tuple[Optional[Path], Optional[str]]:
    """``(path, error_code)`` for a path a native dialog handed back.

    A relative path is refused rather than resolved: it would quietly mean
    "relative to whatever working directory the gateway happens to have", which
    is not a place the user chose.
    """
    if not isinstance(raw, str) or not raw.strip():
        return None, "invalid_path"

    candidate = Path(raw)

    if not candidate.is_absolute():
        return None, "invalid_path"

    if candidate.is_dir():
        return None, "invalid_path"

    return candidate, None


def _write_target(raw: Any) -> Tuple[Optional[Path], Optional[str]]:
    """A save path that can actually be written, or why not.

    The parent must already exist: creating a directory tree on the user's
    behalf from a string this plugin did not compose is not its call to make.
    """
    target, code = _absolute_path(raw)

    if code is not None:
        return None, code

    assert target is not None

    if not target.parent.is_dir():
        return None, "invalid_path"

    return target, None


def _digest(text: str) -> Tuple[int, str]:
    """``(bytes, sha256)`` of the exact UTF-8 text — of what is written/read."""
    raw = text.encode("utf-8")

    return len(raw), hashlib.sha256(raw).hexdigest()


@router.post("/templates/export")
async def export_templates(request: Request) -> Any:
    """Pack the live templates into an archive; write it only to a chosen path.

    Status contract: 200 for a packed archive (with ``written: true`` and the
    path when one was written), 400 for a template set that cannot be exported,
    an unusable path, or a write that failed. ``json`` is always the archive
    text, so the desktop half can put it on the clipboard when no path was
    picked — the clipboard is an explicit choice, never a silent substitute for
    a file that did not get written.

    ``template_version`` travels as the caller stated it: an integer when those
    bytes ARE that shipped default, ``"custom"`` when they are not one, and
    ``"custom"`` as well when the caller states nothing — never ``null``, which
    cannot be told apart from "no record was kept".
    """
    payload, failure = await _parse_body(request, TemplateExportRequest)

    if failure is not None:
        return failure

    assert payload is not None

    try:
        archive = templates.build_export(
            payload.templates,
            mode=payload.mode,
            scope=payload.scope,
            template_version=payload.template_version,
            plugin_version=payload.plugin_version or templates.DEFAULT_PLUGIN_VERSION,
        )
    except templates.TransferError as exc:
        return _error(
            400,
            exc.code,
            "The templates cannot be exported.",
            detail=_redact(str(exc)),
        )

    text = templates.dumps(archive)
    size, sha256 = _digest(text)

    body: Dict[str, Any] = {
        "ok": True,
        "json": text,
        "filename": templates.filename_for(payload.mode, payload.scope),
        "bytes": size,
        "sha256": sha256,
        "written": False,
        "path": None,
    }

    # `None` means "hand me the archive"; an empty or relative string is a path
    # that cannot be honoured, and saying so beats writing nothing and claiming
    # success.
    if payload.path is not None:
        target, code = _write_target(payload.path)

        if code is not None:
            return _error(400, code, "The chosen path is not a writable file path.", path=_redact(str(payload.path)))

        assert target is not None

        try:
            target.write_text(text, encoding="utf-8", newline="\n")
        except OSError as exc:
            return _error(400, "write_failed", "The archive could not be written.", detail=_redact(str(exc)))

        body.update(written=True, path=str(target))

    return body


@router.post("/templates/import/inspect")
async def inspect_templates(request: Request) -> Any:
    """Read a picked file (or pasted text) and say what it would apply.

    ``ok: false`` with 200 is deliberate for a well-formed request whose
    DOCUMENT is unusable: the inspection succeeded, and the reasons are the
    answer the user asked for. Transport-level failures — nothing to read, an
    unreadable or oversized file, bytes that are not UTF-8 — are 400s, because
    then there is no document to report on.

    Nothing is applied here. The desktop half applies from the payload this
    returns, after the user confirms the preview.
    """
    payload, failure = await _parse_body(request, TemplateImportRequest)

    if failure is not None:
        return failure

    assert payload is not None

    given = [
        name
        for name, value in (("path", payload.path), ("json", payload.json))
        if isinstance(value, str) and value.strip()
    ]

    if len(given) != 1:
        return _error(400, "invalid_request", "Provide exactly one of 'path' or 'json'.")

    edge = {
        "source": "file" if given[0] == "path" else "paste",
        "path": None,
        "bytes": None,
        "sha256": None,
    }

    if edge["source"] == "file":
        target, code = _absolute_path(payload.path)

        if code is not None:
            return _error(400, code, "The path is not an absolute file path.")

        assert target is not None

        if not target.is_file():
            return _error(400, "unreadable_file", "No readable file at that path.")

        try:
            raw = target.read_bytes()
        except OSError as exc:
            return _error(400, "unreadable_file", "The file could not be read.", detail=_redact(str(exc)))

        if len(raw) > templates.MAX_BYTES:
            return _error(
                400,
                "too_large",
                "The archive is larger than this door accepts.",
                limit=templates.MAX_BYTES,
            )

        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError as exc:
            return _error(400, "not_utf8", "The archive is not UTF-8 text.", detail=_redact(str(exc)))

        edge.update(path=str(target))
    else:
        text = payload.json

    assert isinstance(text, str)

    if edge["source"] == "paste":
        size, sha256 = _digest(text)
        edge.update(bytes=size, sha256=sha256)
    else:
        edge.update(bytes=len(raw), sha256=hashlib.sha256(raw).hexdigest())

    result = templates.loads(text)

    return {
        "ok": result["ok"],
        **edge,
        "scope": result["scope"],
        "format_version": result["format_version"],
        "template_version": result["template_version"],
        "templates": result["templates"],
        "errors": result["errors"],
        "warnings": result["warnings"],
        "summary": templates.summarize(result["payload"]),
    }
