"""Slice 7 — the backend's follow-session door and host-aligned trust mirror.

Two fidelity gaps this file pins down:

* **Follow-session.** ``ctx.llm`` resolves the *profile global* model — it has no
  session to borrow, so every "follow the session model" run actually ran on the
  global model. The real follow door is the official stateless gateway RPC
  ``llm.oneshot`` with a ``session_id``, whose handler builds ``main_runtime``
  from the live session's agent. The desktop half therefore assembles the
  request here (``/prepare``), sends it through that RPC, and hands the answer
  back for parsing (``/parse``). Both endpoints are PURE: no model call, no
  credentials, no state — so the prototype/parse contract (markers, fence,
  scores, exact-content protection) stays byte-identical on both paths.

* **Trust mirror.** The plugin refuses a not-granted override *before* calling a
  provider. That pre-check must never disagree with the layer that actually
  enforces it (``agent.plugin_llm._resolve_trust_policy``), and it must mirror
  the host's allow-list coercion exactly — including the ``"*"`` wildcard and
  the lowercasing — or it becomes a second, subtly different gate.
"""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

TESTS_DIR = Path(__file__).resolve().parent
PROJECT_DIR = TESTS_DIR.parent
PACKAGE_DIR = PROJECT_DIR / "package" / "fragile-prompt-enhance"
DASHBOARD_DIR = PACKAGE_DIR / "dashboard"
CORE_PATH = (PACKAGE_DIR / "fpe_core.py").resolve()

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
PLUGIN_ID = "fragile-prompt-enhance"

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

DEFAULT_TRUST = {
    "allow_model_override": False,
    "allow_provider_override": False,
    "allowed_models": None,
    "allow_any_model": False,
    "allowed_providers": None,
    "allow_any_provider": False,
}


def model_reply(enhanced="Enhanced body.", *, with_scores=True, score_block=None):
    if score_block is None:
        score_block = SCORE_JSON if with_scores else ""

    return "%s\n%s\n%s\n%s\n%s\n" % (
        core.ENHANCED_MARKER, enhanced, core.SCORES_MARKER, score_block, core.END_MARKER,
    )


class FakeLlm:
    """Stands in for ``ctx.llm`` — records calls, replays a canned response."""

    def __init__(self, text=None):
        self.calls = []
        self.text = text if text is not None else model_reply()

    async def acomplete(self, messages, **kwargs):
        self.calls.append({"messages": messages, "kwargs": kwargs})

        return SimpleNamespace(
            text=self.text,
            provider="fake-provider",
            model=kwargs.get("model") or "session-model",
            agent_id="default",
            usage=SimpleNamespace(input_tokens=11, output_tokens=22, total_tokens=33,
                                  cache_read_tokens=0, cache_write_tokens=0, cost_usd=None),
            audit={"plugin_id": PLUGIN_ID},
        )


class DeliveryCase(unittest.TestCase):
    trust = DEFAULT_TRUST

    def setUp(self):
        self._patch_trust(self.trust)

    def _patch_trust(self, gate):
        original = plugin_api.read_trust_policy
        merged = dict(DEFAULT_TRUST)
        merged.update(gate)

        def fake(plugin_id=PLUGIN_ID):
            return dict(merged, plugin_id=plugin_id, enforced_by="host")

        plugin_api.read_trust_policy = fake
        self.addCleanup(lambda: setattr(plugin_api, "read_trust_policy", original))

    def use_llm(self, llm):
        plugin_api.set_llm_provider(lambda: llm)
        self.addCleanup(plugin_api.reset_llm_provider)

        return llm

    def use_no_llm(self):
        def boom():
            raise plugin_api.LlmUnavailable("no live plugin context")

        plugin_api.set_llm_provider(boom)
        self.addCleanup(plugin_api.reset_llm_provider)

    def client(self):
        app = FastAPI()
        app.include_router(plugin_api.router, prefix=PREFIX)

        return TestClient(app, raise_server_exceptions=False)

    def post(self, path, payload):
        return self.client().post(PREFIX + path, json=payload)


# ── the route table ──────────────────────────────────────────────────────────

class TestRouteTable(unittest.TestCase):
    def paths(self):
        return {getattr(route, "path", "") for route in plugin_api.router.routes}

    def test_exposes_the_prepare_and_parse_doors(self):
        paths = self.paths()

        self.assertIn("/prepare", paths)
        self.assertIn("/parse", paths)
        self.assertIn("/enhance", paths)
        self.assertIn("/status", paths)

    def test_has_no_useless_reset_provider_route(self):
        """A route that only ever answers a fixed acknowledgement is dead weight."""
        self.assertNotIn("/reset-provider", self.paths())

    def test_no_request_model_accepts_a_credential(self):
        """No door here takes a key, a base URL or an auth header from the client."""
        for model in (plugin_api.PrepareRequest, plugin_api.ParseRequest, plugin_api.EnhanceRequest):
            with self.subTest(model=model.__name__):
                fields = set(model.model_fields)

                self.assertEqual(fields & {"api_key", "base_url", "authorization", "headers", "token"}, set())


# ── /prepare ─────────────────────────────────────────────────────────────────

class TestPrepare(DeliveryCase):
    def prepare(self, payload=None, **kw):
        return self.post("/prepare", dict(VALID, **(payload or {}), **kw))

    def test_returns_the_exact_messages_the_enhance_path_sends(self):
        """One assembly, two doors: /prepare must not drift from /enhance."""
        self.use_no_llm()
        simple = self.prepare().json()

        llm = self.use_llm(FakeLlm())
        self.post("/enhance", VALID)

        messages = llm.calls[0]["messages"]

        self.assertTrue(simple["ok"])
        self.assertEqual(simple["instructions"], messages[0]["content"])
        self.assertEqual(simple["input"], messages[1]["content"])

    def test_the_draft_is_delivered_exactly_once(self):
        body = self.prepare().json()

        self.assertEqual(body["input"].count("帮我写周报"), 1)
        self.assertEqual(body["instructions"].count("帮我写周报"), 0)

    def test_carries_the_protocol_block(self):
        body = self.prepare().json()

        self.assertIn(core.ENHANCED_MARKER, body["instructions"])
        self.assertIn(core.SCORES_MARKER, body["instructions"])
        self.assertIn("Simplified Chinese", body["instructions"])

    def test_carries_the_oneshot_limits(self):
        body = self.prepare().json()

        self.assertEqual(body["max_tokens"], core.ONESHOT_MAX_TOKENS)
        self.assertGreater(core.ONESHOT_MAX_TOKENS, 1024)
        self.assertEqual(body["protocol_version"], core.PROTOCOL_VERSION)

    def test_is_pure_and_needs_no_model_door(self):
        self.use_no_llm()

        self.assertEqual(self.prepare().status_code, 200)

    def test_never_returns_the_draft_as_a_separate_field(self):
        """The body travels inside the messages only — no second copy to leak."""
        body = self.prepare().json()

        self.assertNotIn("draft", body)
        self.assertEqual(body["draft_chars"], len(VALID["draft"]))

    def test_rejects_an_unknown_mode(self):
        self.assertEqual(self.prepare({"mode": "professional"}).status_code, 400)

    def test_rejects_an_empty_draft(self):
        self.assertEqual(self.prepare({"draft": "   "}).status_code, 400)

    def test_rejects_a_template_without_the_draft_placeholder(self):
        self.assertEqual(self.prepare({"user_template": "no placeholder"}).status_code, 400)

    def test_rejects_a_malformed_body(self):
        response = self.client().post(PREFIX + "/prepare", content=b"nope",
                                      headers={"content-type": "application/json"})

        self.assertEqual(response.status_code, 400)


# ── /parse ───────────────────────────────────────────────────────────────────

class TestParse(DeliveryCase):
    def parse(self, **kw):
        payload = {"mode": "precise", "draft": VALID["draft"], "model_text": model_reply()}
        payload.update(kw)

        return self.post("/parse", payload)

    def test_returns_the_enhanced_text_and_scores(self):
        body = self.parse().json()

        self.assertTrue(body["ok"])
        self.assertEqual(body["enhanced"], "Enhanced body.")
        self.assertEqual(body["scores"]["enhanced"]["overall"], 75)
        self.assertEqual(body["text_shape"], "markers")

    def test_matches_what_enhance_reports_for_the_same_model_text(self):
        """The parse contract is shared, so the two doors cannot disagree."""
        self.use_llm(FakeLlm())
        enhanced = self.post("/enhance", VALID).json()
        parsed = self.parse().json()

        for field in ("enhanced", "scores", "score_error", "text_shape", "protection"):
            self.assertEqual(parsed[field], enhanced[field], field)

    def test_body_survives_a_missing_score_block(self):
        body = self.parse(model_text=model_reply(with_scores=False)).json()

        self.assertTrue(body["ok"])
        self.assertEqual(body["enhanced"], "Enhanced body.")
        self.assertIsNone(body["scores"])
        self.assertIn(body["score_error"], ("empty", "unparseable"))

    def test_reports_the_protection_of_the_original_draft(self):
        body = self.parse(model_text=model_reply("丢掉了 https://other.example")).json()

        self.assertFalse(body["protection"]["ok"])
        self.assertTrue(body["protection"]["missing"])

    def test_protection_is_ok_when_the_exact_content_survives(self):
        body = self.parse(
            model_text=model_reply("请看 https://example.com 并且 ./src/app.ts 再写周报")
        ).json()

        self.assertTrue(body["protection"]["ok"])

    def test_an_empty_model_answer_is_reported_not_invented(self):
        response = self.parse(model_text="   ")
        body = response.json()

        self.assertEqual(response.status_code, 200)
        self.assertFalse(body["ok"])
        self.assertEqual(body["error"]["code"], "empty_response")
        self.assertEqual(body["enhanced"], "")

    def test_is_pure_and_needs_no_model_door(self):
        self.use_no_llm()

        self.assertEqual(self.parse().status_code, 200)

    def test_requires_a_draft(self):
        self.assertEqual(self.parse(draft="").status_code, 400)

    def test_requires_the_model_text(self):
        self.assertEqual(self.parse(model_text=None).status_code, 400)

    def test_rejects_an_unknown_mode(self):
        self.assertEqual(self.parse(mode="professional").status_code, 400)

    def test_never_echoes_the_draft_on_failure(self):
        secret = "SECRET-DRAFT-MARKER"
        body = self.parse(draft=secret, model_text="").json()

        self.assertNotIn(secret, json.dumps(body))


class TestProtocolMarkerLeak(DeliveryCase):
    """The real Kimi answer: the protocol marker came back in the deliverable.

    A model closed its output with a repeated ``===ENHANCED_PROMPT===``; only the
    leading marker was consumed, so the trailing one rode along into the text the
    user was about to send. Regression at the API boundary, where the leak was
    seen, and with the caller's own draft supplied so the parser can tell the
    model's wrapper from the author's content.
    """

    LEAKED = "请阅读 src/app.ts 并说明 main() 的作用。\n%s\n"

    def parse(self, model_text, draft=None):
        payload = {"mode": "precise", "draft": VALID["draft"] if draft is None else draft,
                   "model_text": model_text}

        return self.post("/parse", payload)

    def body(self, response):
        data = response.json()

        self.assertTrue(data["ok"], data)

        return data

    def test_a_trailing_duplicate_marker_never_reaches_the_user(self):
        leaked = "%s\n%s%s" % (core.ENHANCED_MARKER, self.LEAKED % core.ENHANCED_MARKER, "")

        data = self.body(self.parse(leaked))

        self.assertEqual(data["enhanced"], "请阅读 src/app.ts 并说明 main() 的作用。")
        self.assertNotIn(core.ENHANCED_MARKER, data["enhanced"])
        self.assertNotIn(core.ENHANCED_MARKER, json.dumps(data))

    def test_the_leak_is_stripped_with_the_scores_and_the_end_marker_present(self):
        leaked = model_reply(self.LEAKED % core.ENHANCED_MARKER)

        data = self.body(self.parse(leaked))

        self.assertEqual(data["enhanced"], "请阅读 src/app.ts 并说明 main() 的作用。")
        self.assertEqual(data["scores"]["enhanced"]["overall"], 75)

    def test_a_marker_the_author_wrote_is_kept_when_the_draft_carries_it(self):
        draft = "把这份说明整理一下\n%s" % core.ENHANCED_MARKER
        model_text = "%s\n把这份说明整理一下\n%s\n" % (core.ENHANCED_MARKER, core.ENHANCED_MARKER)

        data = self.body(self.parse(model_text, draft=draft))

        self.assertEqual(data["enhanced"], draft)

    def test_an_inline_marker_in_the_body_is_never_touched(self):
        body = "在 README 里说明 %s 这个标记的作用" % core.ENHANCED_MARKER

        data = self.body(self.parse(model_reply(body)))

        self.assertEqual(data["enhanced"], body)

    def test_bad_format_still_returns_the_body_and_only_loses_the_scores(self):
        leaked = "%s\nBody wins.\n%s\n{not json\n%s\n" % (
            core.ENHANCED_MARKER, core.SCORES_MARKER, core.END_MARKER,
        )

        data = self.body(self.parse(leaked))

        self.assertEqual(data["enhanced"], "Body wins.")
        self.assertIsNone(data["scores"])
        self.assertEqual(data["score_error"], "unparseable")

    def test_both_doors_report_the_same_clean_text(self):
        leaked = model_reply(self.LEAKED % core.ENHANCED_MARKER)

        self.use_llm(FakeLlm(leaked))
        from_enhance = self.post("/enhance", VALID).json()
        from_parse = self.body(self.parse(leaked))

        self.assertEqual(from_enhance["enhanced"], from_parse["enhanced"])
        self.assertNotIn(core.ENHANCED_MARKER, from_enhance["enhanced"])

    def test_a_long_mixed_language_body_survives_intact(self):
        """Item 7's long-text path: CN/EN mixed, code, paths — byte for byte."""
        body = "\n".join(
            ["背景：src/app.ts 的 main() 在 CI 上偶发失败。", ""]
            + ["- 第 %d 条：run `make test` 并检查 main() 的返回值 %d" % (i, i) for i in range(1, 121)]
            + ["", "```ts", "export function main(): number {", "  return 0", "}", "```"]
        )
        data = self.body(self.parse(model_reply(body)))

        self.assertEqual(data["enhanced"], body)
        self.assertEqual(data["scores"]["original"]["overall"], 36)


class TestChangeNote(DeliveryCase):
    """Item 5: the optional same-call change note rides along, or is simply absent.

    Nothing here may cost the user the body, and a missing note must never
    trigger a second request — the note is generated in the SAME call or not at
    all.
    """

    def parse(self, model_text):
        return self.post("/parse", {"mode": "precise", "draft": VALID["draft"], "model_text": model_text})

    def with_note(self, note):
        payload = json.loads(SCORE_JSON)
        payload["changes"] = note

        return model_reply(score_block=json.dumps(payload))

    def test_the_note_is_passed_through(self):
        body = self.parse(self.with_note("删去重复的要求，补上验收方式。")).json()

        self.assertEqual(body["changes"], "删去重复的要求，补上验收方式。")
        self.assertEqual(body["enhanced"], "Enhanced body.")

    def test_an_absent_note_is_an_empty_string_not_a_missing_key(self):
        body = self.parse(model_reply()).json()

        self.assertIn("changes", body)
        self.assertEqual(body["changes"], "")

    def test_a_missing_note_still_costs_nothing(self):
        body = self.parse(model_reply()).json()

        self.assertTrue(body["ok"])
        self.assertEqual(body["enhanced"], "Enhanced body.")
        self.assertEqual(body["scores"]["enhanced"]["overall"], 75)

    def test_a_broken_note_value_never_costs_the_body(self):
        for note in (42, ["a"], {"b": 1}, None):
            with self.subTest(note=note):
                body = self.parse(self.with_note(note)).json()

                self.assertTrue(body["ok"])
                self.assertEqual(body["enhanced"], "Enhanced body.")
                self.assertEqual(body["changes"], "")

    def test_an_unusable_score_block_still_keeps_the_body_and_drops_the_note(self):
        body = self.parse(model_reply(score_block="{not json")).json()

        self.assertTrue(body["ok"])
        self.assertEqual(body["enhanced"], "Enhanced body.")
        self.assertEqual(body["changes"], "")

    def test_an_old_format_answer_without_a_note_still_parses(self):
        """Schema compatibility: the pre-note score block is still valid input."""
        legacy = json.dumps({
            "original": {"goal_clarity": 40, "overall": 36},
            "enhanced": {"goal_clarity": 80, "overall": 75},
        })
        body = self.parse(model_reply(score_block=legacy)).json()

        self.assertTrue(body["ok"])
        self.assertEqual(body["enhanced"], "Enhanced body.")
        self.assertEqual(body["scores"]["enhanced"]["overall"], 75)
        # No rationale in the payload is reported as absent, never invented.
        self.assertEqual(body["scores"]["original"]["rationale"], "")

    def test_the_doors_agree_on_the_note_too(self):
        note = "只删了重复"
        text = self.with_note(note)

        self.use_llm(FakeLlm(text))
        from_enhance = self.post("/enhance", VALID).json()
        from_parse = self.parse(text).json()

        self.assertEqual(from_enhance["changes"], note)
        self.assertEqual(from_parse["changes"], from_enhance["changes"])


# ── core loading ─────────────────────────────────────────────────────────────

class TestCoreLoading(unittest.TestCase):
    """`_load_core` runs inside the dashboard mount, which imports nothing for us.

    ``_mount_plugin_api_routes`` exec's ``dashboard/plugin_api.py`` by path
    (``spec_from_file_location``) and never touches ``sys.path``, so the backend
    must load ``fpe_core`` itself — and must load it WITHOUT mutating the
    process-global import path on the way.
    """

    def test_loads_by_path_without_mutating_sys_path(self):
        stashed = {
            name: module
            for name, module in list(sys.modules.items())
            if getattr(module, "__file__", None)
            and Path(module.__file__).resolve() == CORE_PATH
        }

        for name in stashed:
            sys.modules.pop(name, None)

        # Reproduce the mount's condition: the plugin directory is NOT importable.
        plugin_dirs = {PACKAGE_DIR.resolve(), DASHBOARD_DIR.resolve()}
        removed = [entry for entry in sys.path if _resolves_into(entry, plugin_dirs)]
        sys.path[:] = [entry for entry in sys.path if entry not in removed]

        def restore():
            sys.modules.update(stashed)
            sys.path.extend(removed)

        self.addCleanup(restore)

        before = list(sys.path)
        module = plugin_api._load_core()

        self.assertEqual(sys.path, before, "loading the core must not mutate sys.path")
        self.assertEqual(Path(module.__file__).resolve(), CORE_PATH)
        self.assertTrue(callable(module.build_messages))
        self.assertEqual(module.PROTOCOL_VERSION, core.PROTOCOL_VERSION)


def _resolves_into(entry, targets):
    try:
        return Path(entry or ".").resolve() in targets
    except (OSError, ValueError):
        return False


# ── trust mirror alignment ───────────────────────────────────────────────────

class TrustMirrorTestCase(unittest.TestCase):
    """Read-only mirrors of the operator's LLM gate."""

    def mirror(self, entry):
        return plugin_api.read_trust_policy_from_config(
            {"plugins": {"entries": {PLUGIN_ID: entry}}}, PLUGIN_ID
        )

    def test_reads_the_official_legacy_keys(self):
        gate = self.mirror({"llm": {"allow_model_override": True, "allowed_models": ["a", "b"]}})

        self.assertTrue(gate["allow_model_override"])
        self.assertFalse(gate["allow_provider_override"])
        self.assertEqual(gate["allowed_models"], ["a", "b"])

    def test_allowlist_mirrors_the_host_coercion(self):
        """The host lowercases, trims, drops blanks and treats ``*`` as wildcard."""
        gate = self.mirror({"llm": {"allowed_models": ["  Claude-X ", "*", "", "  ", "gpt-y"]}})

        self.assertEqual(gate["allowed_models"], ["claude-x", "gpt-y"])
        self.assertTrue(gate["allow_any_model"])

    def test_a_star_only_allowlist_has_no_named_entries(self):
        gate = self.mirror({"llm": {"allowed_models": ["*"]}})

        self.assertEqual(gate["allowed_models"], [])
        self.assertTrue(gate["allow_any_model"])

    def test_absent_allowlist_is_not_an_empty_allowlist(self):
        gate = self.mirror({"llm": {"allow_model_override": True}})

        self.assertIsNone(gate["allowed_models"])
        self.assertFalse(gate["allow_any_model"])

    def test_provider_allowlist_mirrors_the_same_coercion(self):
        gate = self.mirror({"llm": {"allowed_providers": [" OpenRouter ", "*"]}})

        self.assertEqual(gate["allowed_providers"], ["openrouter"])
        self.assertTrue(gate["allow_any_provider"])

    def test_reports_the_official_granted_capabilities_key_verbatim(self):
        gate = self.mirror({"granted_capabilities": ["llm.model_override", "tools.override", "made.up"]})

        self.assertEqual(gate["granted_capabilities"], ["llm.model_override"])

    def test_a_grant_without_the_legacy_key_is_reported_but_never_authorizing(self):
        """The enforcing layer reads the legacy ``allow_*`` key, so the mirror must too.

        ``record_consent`` mirrors a grant into the legacy key, so in practice the
        two agree — but a hand-written ``granted_capabilities`` alone does not
        unlock ``agent.plugin_llm``, and the plugin must never be more permissive
        than the layer that enforces it.
        """
        gate = self.mirror({"granted_capabilities": ["llm.model_override"]})

        self.assertFalse(gate["allow_model_override"])
        self.assertEqual(gate["granted_capabilities"], ["llm.model_override"])

    def test_malformed_config_is_fully_restrictive(self):
        for bad in (None, [], {"plugins": "x"}, {"plugins": {"entries": []}}):
            with self.subTest(bad=bad):
                gate = plugin_api.read_trust_policy_from_config(bad, PLUGIN_ID)

                self.assertFalse(gate["allow_model_override"])
                self.assertIsNone(gate["allowed_models"])

    def test_reads_the_hosts_own_resolver_when_it_is_importable(self):
        """The host's resolver is the truth, not a second copy of the rules."""
        gateway = None

        try:
            from agent.plugin_llm import _TrustPolicy  # type: ignore
        except Exception:  # pragma: no cover - no host tree on this machine
            self.skipTest("agent.plugin_llm not importable")

        sentinel = _TrustPolicy(
            plugin_id=PLUGIN_ID, allow_model_override=True, allowed_models=frozenset({"host-model"}),
            allow_provider_override=True, allowed_providers=frozenset({"host-provider"}),
        )

        original = getattr(plugin_api, "_host_trust_policy", None)
        plugin_api._host_trust_policy = lambda plugin_id: sentinel
        self.addCleanup(lambda: setattr(plugin_api, "_host_trust_policy", original))

        gate = plugin_api.read_trust_policy(PLUGIN_ID)

        self.assertTrue(gate["allow_model_override"])
        self.assertEqual(gate["allowed_models"], ["host-model"])
        self.assertEqual(gate["allowed_providers"], ["host-provider"])
        self.assertEqual(gate["enforced_by"], "host")

    def test_falls_back_to_the_config_mirror_and_says_so(self):
        original = plugin_api._host_trust_policy
        plugin_api._host_trust_policy = lambda plugin_id: None
        self.addCleanup(lambda: setattr(plugin_api, "_host_trust_policy", original))

        original_config = plugin_api.read_trust_policy_from_config
        plugin_api.read_trust_policy_from_config = lambda config, plugin_id: dict(
            DEFAULT_TRUST, plugin_id=plugin_id
        )
        self.addCleanup(lambda: setattr(plugin_api, "read_trust_policy_from_config", original_config))

        gate = plugin_api.read_trust_policy(PLUGIN_ID)

        self.assertEqual(gate["enforced_by"], "config-mirror")


# ── allow-list enforcement on the override path ──────────────────────────────

class TestAllowlistEnforcement(DeliveryCase):
    def test_a_model_outside_the_allowlist_is_refused_before_any_call(self):
        self._patch_trust({
            "allow_model_override": True,
            "allowed_models": ["claude-x"],
        })
        llm = self.use_llm(FakeLlm())

        response = self.post("/enhance", dict(VALID, model="gpt-y"))
        body = response.json()

        self.assertEqual(response.status_code, 403)
        self.assertEqual(body["error"]["code"], "model_not_allowed")
        self.assertEqual(llm.calls, [])
        self.assertIn("allowed_models", body["error"]["unlock_hint"])

    def test_the_allowlist_compares_case_insensitively_like_the_host(self):
        self._patch_trust({"allow_model_override": True, "allowed_models": ["claude-x"]})
        llm = self.use_llm(FakeLlm())

        response = self.post("/enhance", dict(VALID, model="  CLAUDE-X "))

        self.assertEqual(response.status_code, 200)
        self.assertEqual(llm.calls[0]["kwargs"]["model"], "CLAUDE-X")

    def test_a_star_allowlist_admits_any_model(self):
        self._patch_trust({"allow_model_override": True, "allowed_models": ["*"]})
        llm = self.use_llm(FakeLlm())

        self.assertEqual(self.post("/enhance", dict(VALID, model="anything")).status_code, 200)
        self.assertEqual(llm.calls[0]["kwargs"]["model"], "anything")

    def test_an_absent_allowlist_admits_any_model(self):
        self._patch_trust({"allow_model_override": True})
        llm = self.use_llm(FakeLlm())

        self.assertEqual(self.post("/enhance", dict(VALID, model="anything")).status_code, 200)

    def test_a_provider_outside_the_allowlist_is_refused(self):
        self._patch_trust({
            "allow_model_override": True,
            "allow_provider_override": True,
            "allowed_providers": ["anthropic"],
        })
        llm = self.use_llm(FakeLlm())

        response = self.post("/enhance", dict(VALID, provider="openrouter"))

        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()["error"]["code"], "provider_not_allowed")
        self.assertEqual(llm.calls, [])

    def test_the_closed_gate_reason_wins_over_the_allowlist(self):
        self._patch_trust({"allowed_models": ["claude-x"]})

        response = self.post("/enhance", dict(VALID, model="gpt-y"))

        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()["error"]["code"], "model_override_denied")

    def test_the_refusal_order_matches_the_host(self):
        """Both refused → the reason the HOST would give first.

        ``agent.plugin_llm._check_overrides`` gates provider before model, so a
        request that pins both is refused on the provider. Reporting the model
        first would name a different cause than the layer that actually enforces
        this, and the user would fix the wrong thing.

        The host call uses a LOCALLY constructed closed policy, not
        ``_resolve_trust_policy(PLUGIN_ID)``: that resolver reads this machine's
        real ``config.yaml``, and once an operator HAS granted the two overrides
        (which is the normal state of a working install) it raises nothing —
        the assertion would then be about the operator's config rather than
        about the host's code.
        """
        from agent.plugin_llm import _check_overrides, _TrustPolicy, PluginLlmTrustError

        self._patch_trust({})  # every gate closed
        llm = self.use_llm(FakeLlm())

        response = self.post("/enhance", dict(VALID, model="gpt-y", provider="openrouter"))

        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()["error"]["code"], "provider_override_denied")
        self.assertEqual(llm.calls, [])

        # And that IS the host's own order, for a policy with both gates closed.
        host_first = None

        try:
            _check_overrides(
                _TrustPolicy(plugin_id=PLUGIN_ID),
                requested_provider="openrouter",
                requested_model="gpt-y",
                requested_agent_id=None,
                requested_profile=None,
            )
        except PluginLlmTrustError as exc:
            host_first = str(exc)

        self.assertIsNotNone(host_first)
        self.assertIn("provider", host_first)
        self.assertIn("allow_provider_override", host_first)


if __name__ == "__main__":
    unittest.main()
