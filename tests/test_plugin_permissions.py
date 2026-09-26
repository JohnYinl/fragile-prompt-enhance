"""Authorization read-back and the operator's revoke steps — no write path.

The desktop half shows the model picker natively and, beside it, whether a
pinned model is AUTHORIZED. That authorization is decided by two DIFFERENT
layers of the host, and this suite pins both facts and their divergence:

* the ENFORCING layer is ``agent/plugin_llm._resolve_trust_policy``, which reads
  ``plugins.entries.<id>.llm.allow_model_override`` / ``allow_provider_override``
  from config.yaml on every call. A run is refused by THAT layer;
* the CONSENT record is ``plugins.entries.<id>.granted_capabilities``, written by
  ``hermes_cli.plugin_capabilities.record_consent`` during the shipped CLI
  consent screen (``hermes_cli/plugins_cmd_capabilities.py:_run_capability_consent``),
  which mirrors each grant into the legacy ``allow_*`` key. The gate NEVER reads
  the record — so a record without the mirrored key enforces nothing, and a
  hand-set key enforces without any record.

Neither layer is reachable for a GRANT from the desktop: ``plugins.manage``
(``tui_gateway/methods_tools.py``) exposes list/onboarding/toggle/install/
update/remove/settings and no capability action, the Desktop plugin SDK has no
consent door, and the consent screen is TTY-gated
(``plugins_cmd._is_tty()``) so it fails closed off a terminal. This backend
therefore READS both layers, reports the divergence, and hands the operator the
exact official commands — it never grants and never revokes.
"""

from __future__ import annotations

import json
import re
import sys
import unittest
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
PROJECT_DIR = TESTS_DIR.parent
PACKAGE_DIR = PROJECT_DIR / "package" / "fragile-prompt-enhance"
DASHBOARD_DIR = PACKAGE_DIR / "dashboard"
SOURCE_PATH = DASHBOARD_DIR / "plugin_api.py"

for entry in (str(PACKAGE_DIR), str(DASHBOARD_DIR)):
    if entry not in sys.path:
        sys.path.insert(0, entry)

try:
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
except Exception as exc:  # pragma: no cover - the Hermes venv always has these
    raise unittest.SkipTest("fastapi/httpx unavailable: %s" % exc)

import plugin_api  # noqa: E402

PREFIX = "/api/plugins/fragile-prompt-enhance"
PLUGIN_ID = "fragile-prompt-enhance"

#: The exact legacy keys ``agent/plugin_llm._resolve_trust_policy`` reads.
ENFORCING_KEYS = {
    "model": "plugins.entries.%s.llm.allow_model_override" % PLUGIN_ID,
    "provider": "plugins.entries.%s.llm.allow_provider_override" % PLUGIN_ID,
}
CONSENT_KEY = "plugins.entries.%s.granted_capabilities" % PLUGIN_ID


class PermissionCase(unittest.TestCase):
    """A client + a steerable trust gate, exactly as the real route sees it."""

    def setUp(self):
        self._patch({"allow_model_override": False, "allow_provider_override": False})

    def _patch(self, gate):
        original = plugin_api.read_trust_policy

        def fake(plugin_id=PLUGIN_ID):
            return dict(gate, plugin_id=plugin_id)

        plugin_api.read_trust_policy = fake
        self.addCleanup(lambda: setattr(plugin_api, "read_trust_policy", original))

    def client(self):
        app = FastAPI()
        app.include_router(plugin_api.router, prefix=PREFIX)

        return TestClient(app, raise_server_exceptions=False)

    def status(self):
        body = self.client().get(PREFIX + "/status").json()

        return body["llm"]["trust"]

    def rows(self):
        return {row["capability"]: row for row in self.status()["capabilities"]}


# ── the read-back ───────────────────────────────────────────────────────────


class TestCapabilityRows(PermissionCase):
    def test_status_reports_one_row_per_declared_capability(self):
        """plugin.yaml declares exactly these two; nothing else may appear."""
        trust = self.status()

        self.assertEqual(
            sorted(row["capability"] for row in trust["capabilities"]),
            ["llm.model_override", "llm.provider_override"],
        )

    def test_every_row_carries_both_layers_and_names_the_answering_one(self):
        trust = self.status()

        for row in trust["capabilities"]:
            self.assertIsInstance(row["enforced"], bool)
            self.assertIsInstance(row["consent"], bool)
            self.assertIn(row["enforced_by"], ("host", "config-mirror"))

    def test_a_row_names_the_config_key_that_enforces_it(self):
        rows = self.rows()

        for kind, key in ENFORCING_KEYS.items():
            self.assertEqual(rows["llm.%s_override" % kind]["legacy_key"], key)

    def test_a_hand_set_key_without_a_consent_record_is_reported_as_divergent(self):
        """The legacy key alone opens the gate — it must not read as consented."""
        self._patch({"allow_model_override": True, "granted_capabilities": []})

        row = self.rows()["llm.model_override"]

        self.assertTrue(row["enforced"])
        self.assertFalse(row["consent"])
        self.assertEqual(row["divergence"], "gate-without-consent")

    def test_a_consent_record_without_the_key_is_reported_as_divergent(self):
        """A record alone enforces NOTHING — the UI must not show it as authorized."""
        self._patch({"allow_model_override": False, "granted_capabilities": ["llm.model_override"]})

        row = self.rows()["llm.model_override"]

        self.assertFalse(row["enforced"])
        self.assertTrue(row["consent"])
        self.assertEqual(row["divergence"], "consent-without-gate")

    def test_a_granted_and_enforced_capability_has_no_divergence(self):
        self._patch({"allow_model_override": True, "granted_capabilities": ["llm.model_override"]})

        self.assertIsNone(self.rows()["llm.model_override"]["divergence"])

    def test_an_ungranted_capability_has_no_divergence(self):
        self._patch({"allow_model_override": False, "granted_capabilities": []})

        self.assertIsNone(self.rows()["llm.model_override"]["divergence"])

    def test_an_unknown_id_in_the_record_is_ignored(self):
        """Only this plugin's declared ids are read out of the record."""
        self._patch({"granted_capabilities": ["tools.override", "llm.task_override"]})

        rows = self.rows()

        self.assertEqual(sorted(rows), ["llm.model_override", "llm.provider_override"])
        self.assertFalse(any(row["consent"] for row in rows.values()))

    def test_rows_fail_closed_when_the_gate_is_unreadable(self):
        rows = plugin_api.capability_rows({})

        self.assertEqual(len(rows), 2)
        self.assertFalse(any(row["enforced"] for row in rows))
        self.assertFalse(any(row["consent"] for row in rows))

    def test_rows_tolerate_a_malformed_record(self):
        rows = plugin_api.capability_rows({"allow_model_override": True, "granted_capabilities": "not-a-list"})

        by_id = {row["capability"]: row for row in rows}

        self.assertTrue(by_id["llm.model_override"]["enforced"])
        self.assertFalse(by_id["llm.model_override"]["consent"])
        self.assertFalse(by_id["llm.provider_override"]["enforced"])


# ── the record is not the gate ──────────────────────────────────────────────


class TestConsentRecordIsNotAuthorization(PermissionCase):
    def test_a_consent_record_alone_does_not_open_the_run_path(self):
        """The route must refuse on the ENFORCING layer, record or not."""
        self._patch({"allow_model_override": False, "granted_capabilities": ["llm.model_override"]})

        body = self.client().post(PREFIX + "/enhance", json={
            "mode": "precise",
            "draft": "帮我写周报",
            "system_template": "You rewrite drafts.",
            "user_template": "Rewrite this:\n{{draft}}",
            "model": "some-model",
        }).json()

        self.assertFalse(body["ok"])
        self.assertEqual(body["error"]["code"], "model_override_denied")


# ── the operator steps ──────────────────────────────────────────────────────


class TestRevokeHint(PermissionCase):
    def test_status_carries_both_operator_hints(self):
        trust = self.status()

        self.assertTrue(trust["unlock_hint"].strip())
        self.assertTrue(trust["revoke_hint"].strip())

    def test_the_revoke_hint_clears_the_layer_that_enforces(self):
        """Clearing only the consent record would leave the gate OPEN."""
        hint = plugin_api.revoke_hint()

        for key in ENFORCING_KEYS.values():
            self.assertIn(key, hint)

    def test_the_revoke_hint_also_clears_the_consent_record(self):
        self.assertIn(CONSENT_KEY, plugin_api.revoke_hint())

    def test_the_revoke_hint_opens_with_a_runnable_command(self):
        hint = plugin_api.revoke_hint()
        first = hint.strip().splitlines()[0].strip()

        self.assertTrue(first.startswith("hermes "), "must open with a command, got %r" % first)

    def test_the_revoke_hint_names_the_official_disable_command(self):
        self.assertIn("hermes plugins disable %s" % PLUGIN_ID, plugin_api.revoke_hint())

    def test_the_revoke_hint_names_the_official_read_command(self):
        self.assertIn("hermes plugins capabilities %s" % PLUGIN_ID, plugin_api.revoke_hint())

    def test_the_revoke_hint_never_reads_as_something_the_plugin_did(self):
        hint = plugin_api.revoke_hint().lower()

        for forbidden in ("自动撤销", "auto-revoke", "will revoke", "已经撤销", "revoked by the plugin"):
            self.assertNotIn(forbidden, hint)

    def test_the_revoke_hint_is_text_only(self):
        self.assertIsInstance(plugin_api.revoke_hint(), str)


# ── no write path exists in this backend ────────────────────────────────────


class TestNoWritePath(unittest.TestCase):
    """Docstrings may NAME the host's writers; code may never CALL one.

    A call is the name followed by ``(`` — with a lookbehind so
    ``unset_config_value(`` is not read as ``set_config_value(``.
    """

    def source(self):
        return SOURCE_PATH.read_text(encoding="utf-8")

    def assert_never_called(self, source, names):
        for name in names:
            self.assertIsNone(
                re.search(r"(?<![\w])%s\s*\(" % name, source),
                "%s is called somewhere in plugin_api.py" % name,
            )

    def test_the_backend_never_records_consent(self):
        """A plugin that could write the record could grant itself."""
        source = self.source()

        self.assert_never_called(source, ["record_consent", "capability_set_hash", "pending_capabilities"])
        self.assertNotIn("from hermes_cli.plugin_capabilities import", source)
        self.assertNotIn("import plugin_capabilities", source)

    def test_the_backend_never_writes_config(self):
        source = self.source()

        self.assert_never_called(
            source, ["save_config", "set_config_value", "unset_config_value", "load_config"]
        )
        self.assertNotIn("from hermes_cli.config import load_config\n", source)

    def test_the_backend_shells_out_to_nothing(self):
        source = self.source()

        for door in ("subprocess", "os.system", "os.popen"):
            self.assertNotIn(door, source)

    def test_the_backend_exposes_no_grant_route(self):
        """Every mounted route is a read, a stateless completion, or a template
        archive door — never a grant.

        The two `/templates/*` routes are the import/export pair: one packs the
        live templates the desktop half sends (writing a file only at a path the
        user picked in the native dialog), the other reads a file or pasted text
        and reports what it would apply. Neither records consent, writes config,
        grants a capability or touches the live templates.
        """
        routes = sorted(
            (route.path, method)
            for route in plugin_api.router.routes
            for method in getattr(route, "methods", set())
        )

        self.assertEqual(
            routes,
            sorted([
                ("/status", "GET"),
                ("/prepare", "POST"),
                ("/parse", "POST"),
                ("/enhance", "POST"),
                ("/templates/export", "POST"),
                ("/templates/import/inspect", "POST"),
            ]),
        )

    def test_the_revoke_hint_uses_the_official_config_writer(self):
        """The precise revoke goes through `hermes config unset`, not a hand edit."""
        hint = plugin_api.revoke_hint()

        for kind in ("model", "provider"):
            self.assertRegex(
                hint,
                re.compile(r"hermes config unset plugins\.entries\.%s\.llm\.allow_%s_override" % (PLUGIN_ID, kind)),
            )
        self.assertRegex(
            hint,
            re.compile(r"hermes config unset plugins\.entries\.%s\.granted_capabilities" % PLUGIN_ID),
        )


# ── bilingual: the commands are identical, the commentary follows the UI ────

CJK = re.compile(r"[\u3000-\u9fff\uff00-\uffef]")

COMMANDS = re.compile(r"(?m)^\s*(hermes .*?)\s*$")


def runnable(text):
    return [line.strip() for line in COMMANDS.findall(text)]


class TestHintsFollowTheUiLanguage(unittest.TestCase):
    """The plugin ships en + zh; the operator text must follow the UI locale.

    Only the COMMENTARY is translated — a command is a command. Translating or
    reformatting one would hand the operator a different command than the host
    ships.
    """

    def test_the_revoke_hint_speaks_english_by_default(self):
        hint = plugin_api.revoke_hint()

        self.assertFalse(CJK.search(hint), "the default hint must be the English one")

    def test_the_revoke_hint_speaks_chinese_when_asked(self):
        hint = plugin_api.revoke_hint(lang="zh")

        self.assertTrue(CJK.search(hint))
        self.assertNotEqual(hint, plugin_api.revoke_hint(lang="en"))

    def test_the_translated_revoke_hint_runs_the_same_commands(self):
        en, zh = plugin_api.revoke_hint(lang="en"), plugin_api.revoke_hint(lang="zh")

        self.assertEqual(runnable(en), runnable(zh))
        self.assertGreaterEqual(len(runnable(en)), 5)

    def test_the_unlock_hint_follows_the_same_rule(self):
        en, zh = plugin_api.unlock_hint(lang="en"), plugin_api.unlock_hint(lang="zh")

        self.assertFalse(CJK.search(en))
        self.assertTrue(CJK.search(zh))
        self.assertEqual(runnable(en), runnable(zh))
        # The English one keeps the shipped wording the older suite pins.
        self.assertIn("deprecated", en.lower())

    def test_an_unsupported_language_falls_back_to_english(self):
        for lang in ("fr", "zh-hant", "", None, "ZH"):
            self.assertEqual(plugin_api.revoke_hint(lang=lang), plugin_api.revoke_hint(lang="en"))
            self.assertEqual(plugin_api.unlock_hint(lang=lang), plugin_api.unlock_hint(lang="en"))

    def test_the_need_provider_variant_survives_translation(self):
        zh = plugin_api.unlock_hint(need_provider=True, lang="zh")

        self.assertIn("allow_provider_override", zh)
        self.assertEqual(
            runnable(plugin_api.unlock_hint(need_provider=True, lang="zh")),
            runnable(plugin_api.unlock_hint(need_provider=True)),
        )


class TestStatusHints(PermissionCase):
    """Both shipped locales ride in one payload.

    The panel is already mounted when the user switches language, and the desktop
    half re-renders reactively — so a per-locale round trip would either lag
    behind the switch or need a refetch. The read stays exactly ``/status``.
    """

    def test_status_serves_both_shipped_languages(self):
        hints = self.status()["hints"]

        self.assertEqual(sorted(hints), ["en", "zh"])
        for lang in ("en", "zh"):
            self.assertEqual(sorted(hints[lang]), ["revoke_hint", "unlock_hint"])

    def test_each_served_locale_matches_the_generator(self):
        hints = self.status()["hints"]

        for lang in ("en", "zh"):
            self.assertEqual(hints[lang]["revoke_hint"], plugin_api.revoke_hint(lang=lang))
            self.assertEqual(hints[lang]["unlock_hint"], plugin_api.unlock_hint(lang=lang))

    def test_the_flat_hints_stay_english_for_older_readers(self):
        trust = self.status()

        self.assertEqual(trust["unlock_hint"], trust["hints"]["en"]["unlock_hint"])
        self.assertEqual(trust["revoke_hint"], trust["hints"]["en"]["revoke_hint"])
        self.assertEqual(trust["revoke_hint"], plugin_api.revoke_hint())

    def test_the_capability_rows_are_language_independent(self):
        trust = self.status()

        self.assertEqual(sorted(trust["capabilities"][0]), [
            "capability", "consent", "divergence", "enforced", "enforced_by", "kind", "legacy_key",
        ])
        self.assertFalse(CJK.search(json.dumps(trust["capabilities"])))


if __name__ == "__main__":
    unittest.main()
