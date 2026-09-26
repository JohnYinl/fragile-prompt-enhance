"""Template import/export: the transfer format and its two backend doors.

The format is Python-owned on purpose. The desktop half holds the templates in
its own storage and cannot write a file, so the contract has to live where the
bytes are actually read and written:

* ``fpe_templates`` is pure — it builds, serialises, validates and describes a
  template archive, with no I/O and no Hermes import;
* ``/templates/export`` packs the live pair (and writes it, when the desktop
  half hands over a path the user picked in the native save dialog);
* ``/templates/import/inspect`` reads a file (or pasted text) and answers with
  the validated payload or the reasons it is not one.

What the format may and may not carry is asserted here, not just documented: an
archive holds TEMPLATES and nothing else — no draft, no result, no history, no
model setting, no credential — and an unknown top-level key is a refusal, not
something quietly dropped.
"""

from __future__ import annotations

import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
PROJECT_DIR = TESTS_DIR.parent
PACKAGE_DIR = PROJECT_DIR / "package" / "fragile-prompt-enhance"
DASHBOARD_DIR = PACKAGE_DIR / "dashboard"

for entry in (str(PACKAGE_DIR), str(DASHBOARD_DIR)):
    if entry not in sys.path:
        sys.path.insert(0, entry)

import fpe_templates as transfer  # noqa: E402

try:
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
except Exception as exc:  # pragma: no cover - the Hermes venv always has these
    raise unittest.SkipTest("fastapi/httpx unavailable: %s" % exc)

import plugin_api  # noqa: E402

PREFIX = "/api/plugins/fragile-prompt-enhance"

PRECISE = {"system": "精确系统提示词", "user": "把草稿改写清楚。\n\n{{draft}}"}
CREATIVE = {"system": "创意系统提示词", "user": "把草稿拓展完整。\n\n{{draft}}"}
LIVE = {"precise": dict(PRECISE), "creative": dict(CREATIVE)}


def inspect_errors(payload):
    """The error codes a payload produces (empty when it loads clean)."""
    result = transfer.loads(payload)

    return result, [entry["code"] for entry in result["errors"]]


class TransferFormatCase(unittest.TestCase):
    """The pure format: building, serialising, validating."""

    def codes(self, payload):
        return inspect_errors(payload)[1]

    def build(self, **kwargs):
        options = {"mode": "both", "scope": "both", "template_version": 3}
        options.update(kwargs)

        return transfer.build_export(LIVE, **options)

    # ── round trip ───────────────────────────────────────────────────────────

    def test_a_both_scope_export_round_trips_both_fields_of_both_modes(self):
        text = transfer.dumps(self.build())
        result = transfer.loads(text)

        self.assertEqual(result["errors"], [])
        self.assertTrue(result["ok"])
        self.assertEqual(result["templates"], LIVE)
        self.assertEqual(result["scope"], "both")
        self.assertEqual(result["format_version"], transfer.FORMAT_VERSION)
        self.assertEqual(result["template_version"], 3)

    def test_chinese_survives_the_text_form_unchanged(self):
        text = transfer.dumps(self.build())

        # Real UTF-8, not \u escapes: the file a user opens must be readable.
        self.assertIn("精确系统提示词", text)
        self.assertNotIn("\\u7cbe", text)
        self.assertEqual(transfer.loads(text)["templates"]["precise"]["system"], "精确系统提示词")

    def test_a_system_only_export_carries_only_system_fields_and_applies_only_them(self):
        payload = self.build(scope="system")

        self.assertEqual(sorted(payload["modes"]["precise"]), ["system"])
        self.assertEqual(sorted(payload["modes"]["creative"]), ["system"])

        result = transfer.loads(transfer.dumps(payload))

        self.assertTrue(result["ok"])
        self.assertEqual(result["scope"], "system")
        self.assertEqual(result["templates"], {"precise": {"system": PRECISE["system"]}, "creative": {"system": CREATIVE["system"]}})

    def test_a_user_only_export_carries_the_placeholder_and_is_accepted(self):
        result = transfer.loads(transfer.dumps(self.build(scope="user")))

        self.assertTrue(result["ok"])
        self.assertEqual(result["templates"]["precise"]["user"], PRECISE["user"])

    def test_one_mode_can_be_exported_on_its_own(self):
        payload = self.build(mode="creative")

        self.assertEqual(list(payload["modes"]), ["creative"])
        self.assertEqual(transfer.loads(transfer.dumps(payload))["templates"], {"creative": dict(CREATIVE)})

    # ── what the archive may carry ───────────────────────────────────────────

    def test_the_archive_top_level_is_exactly_schema_version_time_version_scope_modes(self):
        payload = self.build()

        self.assertEqual(
            sorted(payload),
            ["exported_at", "format_version", "modes", "plugin_version", "schema", "scope", "template_version"],
        )
        self.assertEqual(payload["schema"], transfer.SCHEMA_ID)

    def test_no_draft_result_history_model_or_secret_key_can_ride_along(self):
        payload = self.build()
        serialised = transfer.dumps(payload)

        def keys(node):
            found = set()

            if isinstance(node, dict):
                for key, value in node.items():
                    found.add(key)
                    found |= keys(value)
            elif isinstance(node, list):
                for item in node:
                    found |= keys(item)

            return found

        present = keys(payload)

        for forbidden in ("draft", "history", "results", "pinnedModel", "modelMode", "provider", "api_key", "token", "settings", "env"):
            self.assertNotIn(forbidden, present, forbidden)
            self.assertNotIn('"%s"' % forbidden, serialised, forbidden)

        # The user text DOES carry the `{{draft}}` placeholder — that is the
        # template, not a draft. The line above is about KEYS, not substrings.
        self.assertIn("{{draft}}", serialised)

        # ...and an archive that carries one is refused, not silently trimmed.
        smuggled = json.loads(serialised)
        smuggled["draft"] = "the user's unpublished draft"
        self.assertIn("unknown_key", self.codes(json.dumps(smuggled)))
        self.assertIsNone(transfer.loads(json.dumps(smuggled))["templates"])

    def test_an_unknown_key_inside_a_mode_is_refused_too(self):
        smuggled = json.loads(transfer.dumps(self.build()))
        smuggled["modes"]["precise"]["notes"] = "x"

        self.assertIn("unknown_field", self.codes(json.dumps(smuggled)))

    # ── refusing what it cannot honestly accept ──────────────────────────────

    def test_a_broken_payload_reports_every_reason_not_only_the_first(self):
        payload = {
            "schema": "something-else",
            "format_version": 0,
            "scope": "all",
            "modes": {"precise": {"system": ""}, "extra": {}},
            "extra_key": 1,
        }
        result, codes = inspect_errors(json.dumps(payload))

        self.assertFalse(result["ok"])
        for expected in ("schema", "version", "scope", "unknown_mode", "empty_field", "unknown_key"):
            self.assertIn(expected, codes, codes)
        self.assertIsNone(result["templates"])

    def test_text_that_is_not_json_is_a_stated_failure(self):
        result, codes = inspect_errors("{not json")

        self.assertIn("not_json", codes)
        self.assertIsNone(result["templates"])
        self.assertEqual(result["ok"], False)

    def test_a_json_array_is_refused(self):
        self.assertIn("not_object", self.codes("[1, 2, 3]"))

    def test_a_version_from_the_future_is_refused_rather_than_guessed_at(self):
        payload = json.loads(transfer.dumps(self.build()))
        payload["format_version"] = transfer.FORMAT_VERSION + 1

        self.assertIn("version", self.codes(json.dumps(payload)))

    def test_a_string_version_is_refused(self):
        payload = json.loads(transfer.dumps(self.build()))
        payload["format_version"] = "1"

        self.assertIn("version", self.codes(json.dumps(payload)))

    def test_a_missing_required_field_for_the_scope_is_refused(self):
        payload = {
            "schema": transfer.SCHEMA_ID,
            "format_version": 1,
            "scope": "both",
            "modes": {"precise": {"system": "只给了 system"}},
        }

        self.assertIn("missing_field", self.codes(json.dumps(payload)))

    def test_a_user_field_without_the_draft_placeholder_is_refused(self):
        payload = json.loads(transfer.dumps(self.build(scope="user")))
        payload["modes"]["precise"]["user"] = "把草稿改写清楚，但没有占位符"

        self.assertIn("placeholder", self.codes(json.dumps(payload)))

    def test_an_oversized_field_is_refused(self):
        payload = json.loads(transfer.dumps(self.build(scope="system")))
        payload["modes"]["precise"]["system"] = "x" * (transfer.MAX_FIELD_CHARS + 1)

        self.assertIn("field_too_long", self.codes(json.dumps(payload)))

    def test_an_oversized_document_is_refused_before_it_is_parsed(self):
        result, codes = inspect_errors("x" * (transfer.MAX_BYTES + 1))

        self.assertIn("too_large", codes)
        self.assertIsNone(result["templates"])

    def test_a_byte_order_mark_is_accepted_and_reported(self):
        text = transfer.dumps(self.build())
        result = transfer.loads(text)

        self.assertEqual(result["errors"], [])

        result = transfer.loads("\ufeff" + text)

        self.assertTrue(result["ok"])
        self.assertIn("bom", [entry["code"] for entry in result["warnings"]])

    def test_the_window_raised_by_an_unusable_export_names_the_field(self):
        with self.assertRaises(transfer.TransferError) as caught:
            transfer.build_export({"precise": {"system": "s", "user": "no placeholder"}}, mode="both", scope="both")

        self.assertIn("precise.user", str(caught.exception))

    def test_an_unknown_scope_or_mode_is_refused_at_build_time(self):
        with self.assertRaises(transfer.TransferError):
            self.build(scope="everything")

        with self.assertRaises(transfer.TransferError):
            self.build(mode="verbose")

    # ── the preview the user confirms against ────────────────────────────────

    def test_the_summary_describes_each_field_without_carrying_it(self):
        summary = transfer.summarize(transfer.loads(transfer.dumps(self.build()))["payload"])

        self.assertEqual(summary["scope"], "both")
        self.assertEqual(summary["modes"], ["creative", "precise"])
        entry = [item for item in summary["fields"] if item["mode"] == "precise" and item["field"] == "system"][0]

        self.assertEqual(entry["chars"], len(PRECISE["system"]))
        self.assertEqual(entry["lines"], 1)
        self.assertEqual(entry["placeholders"], [])
        # A summary is counts and names — never the text itself.
        self.assertNotIn("system", summary.keys())


class TransferVersionRecordCase(unittest.TestCase):
    """`template_version`: which shipped default the bytes ARE — or that they are not one.

    The field is a claim the user can check, so a bare ``null`` is not good
    enough: it cannot be told apart from "the exporter kept no record", and a
    real export of this project said ``null`` for content that WAS the shipped
    default 3. Format 2 therefore never writes ``null`` — an integer names the
    shipped default the content is, and the explicit ``custom`` marker says it
    is not one. Format 1 documents (the ones already written) are still read:
    their ``null`` is the field's older meaning, reported as a warning.
    """

    def build(self, **kwargs):
        options = {"mode": "both", "scope": "both", "template_version": 3}
        options.update(kwargs)

        return transfer.build_export(LIVE, **options)

    def codes(self, payload):
        return inspect_errors(payload)[1]

    def v1(self, **overrides):
        """The archive layout this plugin wrote before the version record was fixed."""
        payload = self.build()
        payload["format_version"] = 1
        payload.update(overrides)

        return payload

    def test_the_layout_is_two_and_the_field_is_an_integer_for_a_shipped_default(self):
        payload = self.build()

        self.assertEqual(transfer.FORMAT_VERSION, 2)
        self.assertEqual(payload["format_version"], 2)
        self.assertEqual(payload["template_version"], 3)
        self.assertNotIn("null", transfer.dumps(payload).split('"template_version"')[1].split(",")[0])

    def test_custom_content_is_marked_custom_and_still_imports(self):
        payload = self.build(template_version=transfer.CUSTOM_TEMPLATE_VERSION)
        text = transfer.dumps(payload)

        self.assertEqual(payload["template_version"], "custom")
        self.assertNotIn('"template_version": null', text)

        result = transfer.loads(text)

        self.assertTrue(result["ok"])
        self.assertEqual(result["errors"], [])
        self.assertEqual(result["template_version"], "custom")
        self.assertEqual(result["templates"], LIVE)

    def test_a_caller_that_states_no_version_claims_no_shipped_default(self):
        """The field's v1 meaning for exactly that case, kept as the safe default."""
        self.assertEqual(self.build(template_version=None)["template_version"], "custom")
        self.assertEqual(transfer.build_export(LIVE, mode="both", scope="both")["template_version"], "custom")

    def test_an_unusable_stated_version_is_refused_at_build_time(self):
        for unusable in ("3", 0, -1, 2.5, True, ["3"]):
            with self.assertRaises(transfer.TransferError, msg=repr(unusable)) as caught:
                self.build(template_version=unusable)

            self.assertEqual(caught.exception.code, "invalid_request")
            self.assertIn("template_version", str(caught.exception))

    def test_a_v2_archive_that_leaves_the_version_null_is_refused(self):
        payload = self.build()
        payload["template_version"] = None

        result, codes = inspect_errors(transfer.dumps(payload))

        self.assertIn("template_version", codes)
        self.assertFalse(result["ok"])
        self.assertIsNone(result["templates"])

    def test_a_v2_archive_naming_a_string_version_other_than_custom_is_refused(self):
        payload = self.build()
        payload["template_version"] = "3"

        self.assertIn("template_version", self.codes(transfer.dumps(payload)))

    def test_a_v1_archive_is_still_read_and_its_null_version_is_reported_as_unstated(self):
        """Archives this plugin already exported keep working, with the gap named."""
        result, codes = inspect_errors(transfer.dumps(self.v1(template_version=None)))

        self.assertEqual(codes, [])
        self.assertTrue(result["ok"])
        self.assertEqual(result["templates"], LIVE)
        self.assertEqual(result["template_version"], None)
        self.assertEqual(
            [entry["code"] for entry in result["warnings"]],
            ["older_version", "template_version_unstated"],
        )

    def test_a_v1_archive_that_names_a_version_is_read_without_that_warning(self):
        result, codes = inspect_errors(transfer.dumps(self.v1()))

        self.assertEqual(codes, [])
        self.assertTrue(result["ok"])
        self.assertEqual(result["template_version"], 3)
        # The layout itself is older, so that warning stays — but the version is
        # STATED, so the gap warning is not raised.
        self.assertEqual([entry["code"] for entry in result["warnings"]], ["older_version"])

    def test_a_v1_archive_with_a_non_integer_version_is_still_refused(self):
        self.assertIn("template_version", self.codes(transfer.dumps(self.v1(template_version="3"))))


class TransferDoorCase(unittest.TestCase):
    """The two endpoints, through a real FastAPI app."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="fpe-transfer-")
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)

    def client(self):
        app = FastAPI()
        app.include_router(plugin_api.router, prefix=PREFIX)

        return TestClient(app, raise_server_exceptions=False)

    def post(self, path, payload):
        return self.client().post(PREFIX + path, json=payload)

    def export(self, **overrides):
        body = {"mode": "both", "scope": "both", "templates": LIVE, "template_version": 3}
        body.update(overrides)

        return self.post("/templates/export", body)

    def test_the_route_table_carries_both_doors(self):
        paths = {getattr(route, "path", "") for route in plugin_api.router.routes}

        self.assertIn("/templates/export", paths)
        self.assertIn("/templates/import/inspect", paths)

    # ── export ───────────────────────────────────────────────────────────────

    def test_export_without_a_path_returns_the_archive_and_writes_nothing(self):
        before = sorted(entry.name for entry in self.dir.iterdir())
        response = self.export()
        body = response.json()

        self.assertEqual(response.status_code, 200)
        self.assertTrue(body["ok"])
        self.assertEqual(transfer.loads(body["json"])["templates"], LIVE)
        self.assertEqual(body["bytes"], len(body["json"].encode("utf-8")))
        self.assertEqual(body["sha256"], hashlib.sha256(body["json"].encode("utf-8")).hexdigest())
        self.assertTrue(body["filename"].endswith(".json"))
        self.assertEqual(sorted(entry.name for entry in self.dir.iterdir()), before)

    def test_export_with_a_picked_path_writes_exactly_the_bytes_it_returns(self):
        target = self.dir / "templates.json"
        response = self.export(path=str(target))
        body = response.json()

        self.assertEqual(response.status_code, 200)
        self.assertTrue(body["written"])
        self.assertTrue(target.is_file())

        written = target.read_bytes()

        self.assertEqual(written, body["json"].encode("utf-8"))
        self.assertEqual(hashlib.sha256(written).hexdigest(), body["sha256"])
        # ...and the file is a valid archive for the import door.
        self.assertEqual(transfer.loads(written.decode("utf-8"))["templates"], LIVE)

    def test_export_refuses_a_template_a_run_could_not_send(self):
        response = self.export(templates={"precise": {"system": "s", "user": "no placeholder"}, "creative": CREATIVE})

        self.assertEqual(response.status_code, 400)
        body = response.json()

        self.assertFalse(body["ok"])
        self.assertEqual(body["error"]["code"], "templates_invalid")
        self.assertTrue(body["error"]["detail"])

    def test_export_refuses_to_write_outside_a_nameable_file(self):
        cases = [
            ("", "invalid_path"),
            ("relative/templates.json", "invalid_path"),
            (str(self.dir), "invalid_path"),
            (str(self.dir / "missing" / "templates.json"), "invalid_path"),
        ]

        for path, code in cases:
            response = self.export(path=path)

            self.assertEqual(response.status_code, 400, path)
            self.assertEqual(response.json()["error"]["code"], code, path)

    def test_export_refuses_an_unknown_scope(self):
        response = self.export(scope="all")

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"]["code"], "invalid_request")

    # ── import ───────────────────────────────────────────────────────────────

    def test_inspect_reads_a_picked_file_and_returns_the_validated_payload(self):
        target = self.dir / "picked.json"
        archive = transfer.dumps(transfer.build_export(LIVE, mode="both", scope="both", template_version=3))
        target.write_text(archive, encoding="utf-8", newline="")

        body = self.post("/templates/import/inspect", {"path": str(target)}).json()

        self.assertTrue(body["ok"])
        self.assertEqual(body["source"], "file")
        self.assertEqual(body["templates"], LIVE)
        self.assertEqual(body["scope"], "both")
        self.assertEqual(body["format_version"], transfer.FORMAT_VERSION)
        self.assertEqual(body["template_version"], 3)
        self.assertEqual(body["sha256"], hashlib.sha256(target.read_bytes()).hexdigest())
        self.assertEqual(body["errors"], [])

    def test_inspect_accepts_pasted_text_as_the_same_contract(self):
        archive = transfer.dumps(transfer.build_export(LIVE, mode="creative", scope="user", template_version=3))
        body = self.post("/templates/import/inspect", {"json": archive}).json()

        self.assertTrue(body["ok"])
        self.assertEqual(body["source"], "paste")
        self.assertEqual(body["templates"], {"creative": {"user": CREATIVE["user"]}})

    def test_inspect_asks_for_exactly_one_input(self):
        for payload in ({}, {"path": "x", "json": "{}"}):
            response = self.post("/templates/import/inspect", payload)

            self.assertEqual(response.status_code, 400)
            self.assertEqual(response.json()["error"]["code"], "invalid_request")

    def test_inspect_reports_a_missing_or_unreadable_file_without_pretending_to_have_read_it(self):
        response = self.post("/templates/import/inspect", {"path": str(self.dir / "nope.json")})

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"]["code"], "unreadable_file")

        self.assertEqual(
            self.post("/templates/import/inspect", {"path": "relative.json"}).json()["error"]["code"],
            "invalid_path",
        )

    def test_inspect_refuses_a_file_larger_than_the_limit(self):
        big = self.dir / "big.json"
        big.write_text("x" * (transfer.MAX_BYTES + 1), encoding="utf-8")

        response = self.post("/templates/import/inspect", {"path": str(big)})

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"]["code"], "too_large")
        self.assertEqual(response.json()["error"]["limit"], transfer.MAX_BYTES)

    def test_inspect_refuses_bytes_that_are_not_utf8(self):
        binary = self.dir / "latin.json"
        binary.write_bytes(b'{"schema": "\xff\xfe"}')

        response = self.post("/templates/import/inspect", {"path": str(binary)})

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"]["code"], "not_utf8")

    def test_inspect_answers_an_invalid_archive_with_its_reasons_and_no_payload(self):
        broken = transfer.dumps(transfer.build_export(LIVE, mode="both", scope="both", template_version=3))
        broken = broken.replace("{{draft}}", "占位符没了")

        body = self.post("/templates/import/inspect", {"json": broken}).json()

        self.assertEqual(body["ok"], False)
        self.assertIsNone(body["templates"])
        self.assertEqual([entry["code"] for entry in body["errors"]], ["placeholder", "placeholder"])
        self.assertEqual([entry["field"] for entry in body["errors"]], ["precise.user", "creative.user"])

    def test_a_refused_archive_leaves_the_file_and_the_directory_untouched(self):
        """Every refusal is read-only: the door never writes, edits or deletes.

        A failure that "helpfully" rewrote the file it had just refused would be
        a side effect the user never asked for, so the bytes AND the file's own
        timestamp are checked, and the directory must not gain an entry.
        """
        smuggled = json.loads(transfer.dumps(transfer.build_export(LIVE, mode="both", scope="both")))
        smuggled["notes"] = "x"
        unknown_field = json.loads(transfer.dumps(transfer.build_export(LIVE, mode="both", scope="both")))
        unknown_field["modes"]["precise"]["extra"] = "x"

        cases = [
            # (name, text, expected status, expected code) — a well-formed
            # request whose DOCUMENT is unusable is 200 with `ok: false`; a
            # transport-level refusal (the size cap, checked before parsing) is
            # a 400. Two different failures, neither of which may touch a file.
            ("smuggled.json", json.dumps(smuggled), 200, "unknown_key"),
            ("field.json", json.dumps(unknown_field), 200, "unknown_field"),
            ("big.json", "x" * (transfer.MAX_BYTES + 1), 400, "too_large"),
        ]

        for name, text, status, code in cases:
            target = self.dir / name
            target.write_text(text, encoding="utf-8", newline="")
            before_bytes = target.read_bytes()
            before_mtime = target.stat().st_mtime_ns
            before_entries = sorted(entry.name for entry in self.dir.iterdir())

            response = self.post("/templates/import/inspect", {"path": str(target)})
            body = response.json()

            self.assertEqual(response.status_code, status, name)

            if status == 200:
                self.assertFalse(body["ok"], name)
                self.assertIsNone(body["templates"], name)
                self.assertIn(code, [entry["code"] for entry in body["errors"]], name)
            else:
                self.assertEqual(body["error"]["code"], code, name)

            self.assertEqual(target.read_bytes(), before_bytes, name)
            self.assertEqual(target.stat().st_mtime_ns, before_mtime, name)
            self.assertEqual(sorted(entry.name for entry in self.dir.iterdir()), before_entries, name)

    def test_the_two_doors_agree_end_to_end(self):
        """Export → file → inspect, which is the round trip a user performs."""
        target = self.dir / "round-trip.json"
        exported = self.export(path=str(target), template_version=3).json()

        self.assertEqual(exported["sha256"], hashlib.sha256(target.read_bytes()).hexdigest())

        imported = self.post("/templates/import/inspect", {"path": str(target)}).json()

        self.assertEqual(imported["templates"], LIVE)
        self.assertEqual(imported["sha256"], exported["sha256"])

    # ── the version record, through the real doors ───────────────────────────

    def test_the_export_door_packs_the_custom_marker_and_the_import_door_reports_it(self):
        target = self.dir / "custom.json"
        exported = self.export(path=str(target), template_version="custom").json()

        self.assertTrue(exported["ok"])
        self.assertEqual(transfer.loads(exported["json"])["template_version"], "custom")

        imported = self.post("/templates/import/inspect", {"path": str(target)}).json()

        self.assertTrue(imported["ok"])
        self.assertEqual(imported["template_version"], "custom")
        self.assertEqual(imported["templates"], LIVE)
        self.assertEqual(imported["warnings"], [])

    def test_the_export_door_refuses_a_version_that_is_not_a_default_or_the_custom_marker(self):
        # `True` is not in this list: the request model coerces a bool to an int
        # before the format sees it, so at this boundary it IS the integer 1 —
        # the refusal of a real bool belongs to `build_export`, which is tested
        # there. Everything else the format cannot read must be a stated refusal.
        for unusable in ("yes", 0, -2, 1.5):
            response = self.export(template_version=unusable)

            self.assertEqual(response.status_code, 400, repr(unusable))
            self.assertEqual(response.json()["error"]["code"], "invalid_request", repr(unusable))

    def test_the_export_door_still_packs_an_archive_it_wrote_before_the_layout_moved_on(self):
        """A caller that states no version claims no shipped default — never null."""
        response = self.post("/templates/export", {"mode": "both", "scope": "both", "templates": LIVE})
        body = response.json()

        self.assertEqual(response.status_code, 200)
        self.assertEqual(transfer.loads(body["json"])["template_version"], "custom")

    def test_the_import_door_reads_a_v1_archive_and_names_the_unstated_version(self):
        target = self.dir / "older.json"
        payload = transfer.build_export(LIVE, mode="both", scope="both", template_version=3)
        payload["format_version"] = 1
        payload["template_version"] = None
        target.write_text(transfer.dumps(payload), encoding="utf-8", newline="")

        body = self.post("/templates/import/inspect", {"path": str(target)}).json()

        self.assertTrue(body["ok"])
        self.assertEqual(body["templates"], LIVE)
        self.assertEqual(body["template_version"], None)
        self.assertEqual(
            [entry["code"] for entry in body["warnings"]],
            ["older_version", "template_version_unstated"],
        )


if __name__ == "__main__":
    unittest.main()
