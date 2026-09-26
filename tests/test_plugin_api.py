"""Slice 4 — the thin Python host backend (FastAPI router).

Exercises the real router over the real HTTP stack (starlette TestClient), with
the host LLM seam injected. Covers the two contracts that must not be faked:

* a requested model/provider is NEVER hard-passed when the operator has not
  granted the trust gate, and never silently downgraded either — the call is
  refused with the exact config key that unlocks it;
* a backend that cannot reach a host-owned LLM says so precisely instead of
  falling back to some other credential path.
"""

from __future__ import annotations

import importlib
import json
import sys
import types
import unittest
from pathlib import Path
from types import SimpleNamespace

TESTS_DIR = Path(__file__).resolve().parent
PROJECT_DIR = TESTS_DIR.parent
PACKAGE_DIR = PROJECT_DIR / "package" / "fragile-prompt-enhance"
DASHBOARD_DIR = PACKAGE_DIR / "dashboard"

for entry in (str(PACKAGE_DIR), str(DASHBOARD_DIR)):
    if entry not in sys.path:
        sys.path.insert(0, entry)

import fpe_core as core  # noqa: E402

try:
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
except Exception as exc:  # pragma: no cover - the Hermes venv always has these
    raise unittest.SkipTest("fastapi/httpx unavailable: %s" % exc)

import plugin_api  # noqa: E402

PREFIX = "/api/plugins/fragile-prompt-enhance"

VALID = {
    "mode": "precise",
    "draft": "帮我写周报，看 https://example.com 和 ./src/app.ts",
    "system_template": "You rewrite drafts.",
    "user_template": "Rewrite this:\n{{draft}}",
    "ui_lang": "zh",
}


SCORE_JSON = json.dumps({
    "original": {"goal_clarity": 40, "info_sufficiency": 35, "constraints": 30,
                 "deliverable": 30, "expression_efficiency": 45, "overall": 36,
                 "rationale": "原文偏短"},
    "enhanced": {"goal_clarity": 80, "info_sufficiency": 75, "constraints": 70,
                 "deliverable": 78, "expression_efficiency": 72, "overall": 75,
                 "rationale": "更明确"},
})


def model_reply(enhanced="Enhanced body.", *, with_scores=True, score_block=None):
    """A model response in the protocol shape.

    ``with_scores=False`` leaves the score section empty; ``score_block`` puts
    arbitrary (possibly broken) text there instead.
    """
    if score_block is None:
        score_block = SCORE_JSON if with_scores else ""

    return "%s\n%s\n%s\n%s\n%s\n" % (
        core.ENHANCED_MARKER, enhanced, core.SCORES_MARKER, score_block, core.END_MARKER,
    )


class FakeLlm:
    """Stands in for ``ctx.llm`` — records calls, replays a canned response."""

    def __init__(self, text=None, error=None, fail_after=0):
        self.calls = []
        self.text = text if text is not None else model_reply()
        self.error = error
        self.fail_after = fail_after

    async def acomplete(self, messages, **kwargs):
        self.calls.append({"messages": messages, "kwargs": kwargs})

        if self.error is not None and len(self.calls) > self.fail_after:
            raise self.error

        return SimpleNamespace(
            text=self.text,
            provider="fake-provider",
            model=kwargs.get("model") or "session-model",
            agent_id="default",
            usage=SimpleNamespace(input_tokens=11, output_tokens=22, total_tokens=33,
                                  cache_read_tokens=0, cache_write_tokens=0, cost_usd=None),
            audit={"plugin_id": "fragile-prompt-enhance"},
        )


class ApiCase(unittest.TestCase):
    gate = {"allow_model_override": False, "allow_provider_override": False}

    def setUp(self):
        self._auto = None
        self.llm = None
        self._patch_trust(self.gate)

    def _patch_trust(self, gate):
        original = plugin_api.read_trust_policy

        def fake(plugin_id="fragile-prompt-enhance"):
            return dict(gate, plugin_id=plugin_id)

        plugin_api.read_trust_policy = fake
        self.addCleanup(lambda: setattr(plugin_api, "read_trust_policy", original))

    def use_llm(self, llm):
        self.llm = llm
        plugin_api.set_llm_provider(lambda: llm)
        self.addCleanup(plugin_api.reset_llm_provider)
        return llm

    def use_no_llm(self, reason="no live plugin context"):
        def boom():
            raise plugin_api.LlmUnavailable(reason)

        plugin_api.set_llm_provider(boom)
        self.addCleanup(plugin_api.reset_llm_provider)

    def client(self):
        app = FastAPI()
        app.include_router(plugin_api.router, prefix=PREFIX)

        return TestClient(app, raise_server_exceptions=False)

    def post(self, payload, **kw):
        return self.client().post(PREFIX + "/enhance", json=payload, **kw)


class TestStatus(ApiCase):
    def test_reports_protocol_and_limits(self):
        r = self.client().get(PREFIX + "/status")
        body = r.json()

        self.assertEqual(r.status_code, 200)
        self.assertTrue(body["ok"])
        self.assertEqual(body["protocol_version"], core.PROTOCOL_VERSION)
        self.assertEqual(body["dimensions"], list(core.DIMENSIONS))
        self.assertEqual(body["limits"]["max_draft_chars"], core.MAX_DRAFT_CHARS)

    def test_reports_the_trust_gate_verbatim(self):
        body = self.client().get(PREFIX + "/status").json()

        self.assertFalse(body["llm"]["trust"]["allow_model_override"])
        self.assertIn("allow_model_override", body["llm"]["trust"]["unlock_hint"])

    def test_reports_gate_open_when_granted(self):
        self._patch_trust({"allow_model_override": True, "allow_provider_override": True})

        body = self.client().get(PREFIX + "/status").json()

        self.assertTrue(body["llm"]["trust"]["allow_model_override"])
        self.assertTrue(body["llm"]["trust"]["allow_provider_override"])

    def test_status_never_leaks_draft_content(self):
        self.use_llm(FakeLlm())

        self.post(dict(VALID, draft="SECRET-DRAFT-MARKER"))

        self.assertNotIn("SECRET-DRAFT-MARKER",
                         json.dumps(self.client().get(PREFIX + "/status").json()))


class TestEnhanceHappyPath(ApiCase):
    def test_returns_enhanced_text_and_attribution(self):
        self.use_llm(FakeLlm())

        body = self.post(VALID).json()

        self.assertTrue(body["ok"])
        self.assertEqual(body["enhanced"], "Enhanced body.")
        self.assertEqual(body["provider"], "fake-provider")
        self.assertEqual(body["model"], "session-model")
        self.assertEqual(body["usage"]["total_tokens"], 33)
        self.assertEqual(body["mode"], "precise")

    def test_returns_normalized_both_sides_scores(self):
        self.use_llm(FakeLlm())

        scores = self.post(VALID).json()["scores"]

        self.assertEqual(scores["original"]["overall"], 36)
        self.assertEqual(scores["enhanced"]["overall"], 75)
        self.assertEqual(scores["basis"], "self_assessed")
        self.assertEqual(scores["scale"], "0-100")

    def test_does_not_pass_a_model_when_none_was_requested(self):
        llm = self.use_llm(FakeLlm())

        self.post(VALID)

        self.assertIsNone(llm.calls[0]["kwargs"]["model"])
        self.assertIsNone(llm.calls[0]["kwargs"]["provider"])

    def test_sends_two_messages_with_the_protocol_appended(self):
        llm = self.use_llm(FakeLlm())

        self.post(VALID)

        messages = llm.calls[0]["messages"]

        self.assertEqual([m["role"] for m in messages], ["system", "user"])
        self.assertIn(core.ENHANCED_MARKER, messages[0]["content"])
        self.assertIn("帮我写周报", messages[1]["content"])

    def test_carries_a_purpose_string_for_the_audit_log(self):
        llm = self.use_llm(FakeLlm())

        self.post(VALID)

        self.assertTrue(llm.calls[0]["kwargs"]["purpose"])

    def test_includes_the_protection_report(self):
        self.use_llm(FakeLlm(text=model_reply("A rewrite that dropped everything.")))

        report = self.post(VALID).json()["protection"]

        self.assertFalse(report["ok"])
        self.assertTrue(report["missing"])

    def test_protection_ok_when_tokens_survive(self):
        self.use_llm(FakeLlm(text=model_reply("请看 https://example.com 并且 ./src/app.ts 再写周报")))

        self.assertTrue(self.post(VALID).json()["protection"]["ok"])

    def test_reports_duration(self):
        self.use_llm(FakeLlm())

        self.assertGreaterEqual(self.post(VALID).json()["duration_ms"], 0)


class TestScoreLoss(ApiCase):
    def test_body_survives_a_missing_score_block(self):
        self.use_llm(FakeLlm(text=model_reply(with_scores=False)))

        body = self.post(VALID).json()

        self.assertTrue(body["ok"])
        self.assertEqual(body["enhanced"], "Enhanced body.")
        self.assertIsNone(body["scores"])
        self.assertIn(body["score_error"], ("empty", "unparseable"))

    def test_body_survives_a_plain_prose_answer(self):
        self.use_llm(FakeLlm(text="Just a plain rewrite, no protocol followed."))

        body = self.post(VALID).json()

        self.assertEqual(body["enhanced"], "Just a plain rewrite, no protocol followed.")
        self.assertIsNone(body["scores"])
        self.assertEqual(body["text_shape"], "plain")

    def test_body_survives_unparseable_json(self):
        self.use_llm(FakeLlm(text=model_reply(score_block='{"original": {"overall": 4')))

        body = self.post(VALID).json()

        self.assertEqual(body["enhanced"], "Enhanced body.")
        self.assertEqual(body["score_error"], "unparseable")


class TestModelOverrideGate(ApiCase):
    """The load-bearing contract: no hard-pass, no silent downgrade."""

    def test_refuses_when_gate_closed_and_never_calls_the_model(self):
        llm = self.use_llm(FakeLlm())

        r = self.post(dict(VALID, model="some-other-model"))
        body = r.json()

        self.assertEqual(r.status_code, 403)
        self.assertFalse(body["ok"])
        self.assertEqual(body["error"]["code"], "model_override_denied")
        self.assertEqual(llm.calls, [])

    def test_refusal_names_the_exact_config_key(self):
        self.use_llm(FakeLlm())

        detail = self.post(dict(VALID, model="m")).json()["error"]

        self.assertIn("allow_model_override", detail["unlock_hint"])
        self.assertIn("fragile-prompt-enhance", detail["unlock_hint"])

    def test_the_unlock_hint_leads_with_the_official_cli_entry(self):
        """The operator path must be the real command, not only a hand-edited YAML.

        ``hermes plugins enable`` / ``hermes plugins capabilities`` are the
        shipped consent surface (hermes_cli/plugins_cmd_capabilities.py). The
        hint previously opened with a YAML block, which reads as "hand-edit this
        file" and is the deprecated legacy gate, not the supported entry.
        """
        self.use_llm(FakeLlm())

        hint = self.post(dict(VALID, model="m")).json()["error"]["unlock_hint"]

        self.assertIn("hermes plugins enable fragile-prompt-enhance", hint)
        self.assertIn("hermes plugins capabilities fragile-prompt-enhance", hint)
        # The first non-blank line must be the runnable command.
        self.assertTrue(
            hint.strip().splitlines()[0].strip().startswith("hermes plugins"),
            "unlock_hint must open with the command, not with YAML",
        )
        # The legacy key stays documented, and is labelled as legacy.
        self.assertIn("allow_model_override", hint)
        self.assertIn("deprecated", hint.lower())

    def test_the_unlock_hint_offers_no_auto_grant(self):
        """A hint is text. It must not read as something the plugin can do itself."""
        self.use_llm(FakeLlm())

        hint = self.post(dict(VALID, model="m")).json()["error"]["unlock_hint"].lower()

        for forbidden in ("automatic", "auto-grant", "will grant", "已经授权", "自动开通"):
            self.assertNotIn(forbidden, hint)

    def test_provider_override_is_gated_separately(self):
        self.use_llm(FakeLlm())

        r = self.post(dict(VALID, provider="openrouter"))

        self.assertEqual(r.status_code, 403)
        self.assertEqual(r.json()["error"]["code"], "provider_override_denied")

    def test_passes_the_model_when_the_gate_is_open(self):
        self._patch_trust({"allow_model_override": True, "allow_provider_override": False})
        llm = self.use_llm(FakeLlm())

        r = self.post(dict(VALID, model="picked-model"))

        self.assertEqual(r.status_code, 200)
        self.assertEqual(llm.calls[0]["kwargs"]["model"], "picked-model")
        self.assertIsNone(llm.calls[0]["kwargs"]["provider"])

    def test_passes_provider_when_its_gate_is_open(self):
        self._patch_trust({"allow_model_override": True, "allow_provider_override": True})
        llm = self.use_llm(FakeLlm())

        self.post(dict(VALID, model="picked-model", provider="openrouter"))

        self.assertEqual(llm.calls[0]["kwargs"]["provider"], "openrouter")

    def test_an_empty_model_string_is_not_an_override(self):
        llm = self.use_llm(FakeLlm())

        r = self.post(dict(VALID, model="   ", provider=""))

        self.assertEqual(r.status_code, 200)
        self.assertIsNone(llm.calls[0]["kwargs"]["model"])

    def test_the_host_trust_error_maps_to_a_clean_refusal(self):
        class Boom(Exception):
            pass

        class TrustError(Exception):
            pass

        llm = FakeLlm(error=plugin_api.PluginLlmTrustError("denied by policy"))
        self._patch_trust({"allow_model_override": True, "allow_provider_override": False})
        self.use_llm(llm)

        r = self.post(dict(VALID, model="m"))
        body = r.json()

        self.assertEqual(r.status_code, 403)
        self.assertEqual(body["error"]["code"], "model_override_denied")


class TestRequestValidation(ApiCase):
    def test_rejects_an_unknown_mode(self):
        self.use_llm(FakeLlm())

        r = self.post(dict(VALID, mode="professional"))

        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json()["error"]["code"], "invalid_request")

    def test_rejects_an_empty_draft(self):
        self.use_llm(FakeLlm())

        self.assertEqual(self.post(dict(VALID, draft="   ")).status_code, 400)

    def test_rejects_a_template_without_the_draft_placeholder(self):
        self.use_llm(FakeLlm())

        r = self.post(dict(VALID, user_template="no placeholder at all"))

        self.assertEqual(r.status_code, 400)

    def test_rejects_an_empty_system_template(self):
        self.use_llm(FakeLlm())

        self.assertEqual(self.post(dict(VALID, system_template="")).status_code, 400)

    def test_rejects_an_oversized_draft(self):
        self.use_llm(FakeLlm())

        r = self.post(dict(VALID, draft="x" * (core.MAX_DRAFT_CHARS + 1)))

        self.assertEqual(r.status_code, 400)

    def test_rejects_a_malformed_body(self):
        self.use_llm(FakeLlm())

        r = self.client().post(PREFIX + "/enhance", content=b"not json",
                               headers={"content-type": "application/json"})

        self.assertEqual(r.status_code, 400)

    def test_a_missing_backend_llm_is_503_not_a_fallback(self):
        self.use_no_llm("plugin context not loaded in this process")

        r = self.post(VALID)

        self.assertEqual(r.status_code, 503)
        self.assertEqual(r.json()["error"]["code"], "llm_unavailable")
        self.assertIn("plugin context", r.json()["error"]["message"])


class TestUpstreamFailures(ApiCase):
    def test_upstream_error_is_502_with_a_sanitized_message(self):
        self.use_llm(FakeLlm(error=RuntimeError("upstream exploded with sk-abcdef0123456789")))

        r = self.post(VALID)
        body = r.json()

        self.assertEqual(r.status_code, 502)
        self.assertEqual(body["error"]["code"], "upstream_error")
        self.assertNotIn("sk-abcdef0123456789", json.dumps(body))

    def test_upstream_failure_never_echoes_the_draft(self):
        self.use_llm(FakeLlm(error=RuntimeError("boom")))

        payload = dict(VALID, draft="SECRET-DRAFT-MARKER please rewrite")

        self.assertNotIn("SECRET-DRAFT-MARKER", json.dumps(self.post(payload).json()))

    def test_an_empty_model_response_is_reported_not_applied(self):
        self.use_llm(FakeLlm(text="   "))

        r = self.post(VALID)
        body = r.json()

        self.assertEqual(r.status_code, 200)
        self.assertFalse(body["ok"])
        self.assertEqual(body["error"]["code"], "empty_response")
        self.assertEqual(body["enhanced"], "")


class TestTrustPolicyReader(ApiCase):
    def test_reads_the_official_config_shape(self):
        gate = plugin_api.read_trust_policy_from_config(
            {"plugins": {"entries": {"fragile-prompt-enhance": {"llm": {
                "allow_model_override": True, "allowed_models": ["a", "b"]}}}}},
            "fragile-prompt-enhance",
        )

        self.assertTrue(gate["allow_model_override"])
        self.assertEqual(gate["allowed_models"], ["a", "b"])
        self.assertFalse(gate["allow_provider_override"])

    def test_missing_entry_is_fully_restrictive(self):
        gate = plugin_api.read_trust_policy_from_config({}, "fragile-prompt-enhance")

        self.assertFalse(gate["allow_model_override"])
        self.assertFalse(gate["allow_provider_override"])

    def test_malformed_config_does_not_raise(self):
        for bad in (None, [], {"plugins": "x"}, {"plugins": {"entries": []}}):
            with self.subTest(bad=bad):
                gate = plugin_api.read_trust_policy_from_config(bad, "x")

                self.assertFalse(gate["allow_model_override"])


class TestContextBridge(ApiCase):
    def load_agent_half(self, module_name="hermes_plugins.fragile_prompt_enhance"):
        """Import ``__init__.py`` the way ``_load_directory_module`` does.

        Reproducing the loader (namespace parent first, ``__path__`` set,
        ``sys.modules`` pre-registered) is the point: a bridge test that imports
        the file some other way would not prove the two halves share one module
        object.
        """
        init_file = PACKAGE_DIR / "__init__.py"

        if "hermes_plugins" not in sys.modules:
            parent = types.ModuleType("hermes_plugins")
            parent.__path__ = []  # type: ignore[attr-defined]
            parent.__package__ = "hermes_plugins"
            sys.modules["hermes_plugins"] = parent

        spec = importlib.util.spec_from_file_location(
            module_name, init_file, submodule_search_locations=[str(PACKAGE_DIR)])
        module = importlib.util.module_from_spec(spec)
        module.__package__ = module_name
        module.__path__ = [str(PACKAGE_DIR)]
        sys.modules[module_name] = module
        spec.loader.exec_module(module)

        def cleanup():
            for key in list(sys.modules):
                if key.split(".")[0] == "hermes_plugins":
                    sys.modules.pop(key, None)

        self.addCleanup(cleanup)

        return module

    def test_resolves_the_plugin_context_from_the_loaded_agent_half(self):
        module = self.load_agent_half()

        sentinel = SimpleNamespace(llm="THE-LIVE-CTX")
        module.register(sentinel)

        self.assertIs(plugin_api.resolve_plugin_context(), sentinel)

    def test_the_agent_half_wires_ctx_llm_through_the_holder(self):
        module = self.load_agent_half("hermes_plugins.fpe_probe")

        unloads = []
        ctx = SimpleNamespace(llm="CTX-LLM", on_unload=lambda fn: unloads.append(fn))

        module.register(ctx)

        self.assertIs(module.PLUGIN_CTX.get(), ctx)
        self.assertEqual(len(unloads), 1)

        unloads[0]()

        self.assertIsNone(module.PLUGIN_CTX.get())

    def test_register_tolerates_a_context_without_on_unload(self):
        module = self.load_agent_half("hermes_plugins.fpe_bare")

        module.register(object())

        self.assertIsNotNone(module.PLUGIN_CTX.get())

    def test_returns_none_when_the_agent_half_is_absent(self):
        sys.modules.pop("hermes_plugins.fragile_prompt_enhance", None)

        self.assertIsNone(plugin_api.resolve_plugin_context())

    def test_reports_how_the_llm_was_bound(self):
        self.use_llm(FakeLlm())

        self.assertEqual(self.post(VALID).json()["llm_binding"], "injected")

    def test_binding_is_unavailable_without_a_live_context(self):
        self.addCleanup(plugin_api.reset_llm_provider)

        self.assertEqual(plugin_api.current_binding(), "unavailable")


if __name__ == "__main__":
    unittest.main()
