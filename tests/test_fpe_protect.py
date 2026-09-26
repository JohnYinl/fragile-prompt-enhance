"""Slice 3 — exact-content protection.

Code blocks, paths, URLs and reference tokens must survive an enhancement
verbatim. The protection layer reports what was lost so the desktop half can
refuse to apply silently; it never rewrites the enhanced text itself.
"""

from __future__ import annotations

import unittest

import fpe_core as c


def kinds(report):
    return sorted({entry["kind"] for entry in report["missing"]})


def texts(entries):
    return [entry["text"] for entry in entries]


class TestExtraction(unittest.TestCase):
    def test_fenced_code_block(self):
        found = c.extract_protected("Run this:\n```py\nprint(1)\n```\ndone")

        blocks = [t for t in found if t["kind"] == "code_block"]

        self.assertEqual(len(blocks), 1)
        self.assertIn("print(1)", blocks[0]["text"])

    def test_inline_code(self):
        found = c.extract_protected("use `--dry-run` here")

        self.assertIn("--dry-run", texts([t for t in found if t["kind"] == "inline_code"]))
        self.assertNotIn("--dry-run", texts([t for t in found if t["kind"] == "flag"]))

    def test_http_url(self):
        found = c.extract_protected("see https://example.com/a?b=1#c for more")

        self.assertIn("https://example.com/a?b=1#c", texts([t for t in found if t["kind"] == "url"]))

    def test_windows_path(self):
        fixture = r"C:\Users\example\AppData\Local\x.yaml"
        found = c.extract_protected("edit " + fixture + " now")

        self.assertIn(fixture, texts([t for t in found if t["kind"] == "path"]))

    def test_relative_path(self):
        found = c.extract_protected("open ./src/app/main.ts please")

        self.assertIn("./src/app/main.ts", texts([t for t in found if t["kind"] == "path"]))

    def test_bare_filename_with_extension(self):
        found = c.extract_protected("update plugin.yaml and README.md")

        paths = texts([t for t in found if t["kind"] == "path"])

        self.assertIn("plugin.yaml", paths)
        self.assertIn("README.md", paths)

    def test_at_reference(self):
        found = c.extract_protected("ask @researcher and @file:src/app.ts about it")

        refs = texts([t for t in found if t["kind"] == "at_ref"])

        self.assertIn("@researcher", refs)
        self.assertIn("@file:src/app.ts", refs)

    def test_email_is_not_an_at_reference(self):
        found = c.extract_protected("mail me at someone@example.com")

        self.assertEqual([t for t in found if t["kind"] == "at_ref"], [])

    def test_slash_command_at_line_start(self):
        found = c.extract_protected("then run\n/compact\nafterwards")

        self.assertIn("/compact", texts([t for t in found if t["kind"] == "slash_command"]))

    def test_transcript_directive(self):
        found = c.extract_protected("::preview{file=\"a.md\"} and ::task")

        self.assertIn('::preview{file="a.md"}', texts([t for t in found if t["kind"] == "directive"]))

    def test_issue_reference(self):
        found = c.extract_protected("fixed in #120907 and PR #116031")

        self.assertIn("#120907", texts([t for t in found if t["kind"] == "issue_ref"]))

    def test_markdown_heading_is_not_an_issue_reference(self):
        found = c.extract_protected("# Heading\n## Another")

        self.assertEqual([t for t in found if t["kind"] == "issue_ref"], [])

    def test_env_var_name(self):
        found = c.extract_protected("set HERMES_HOME and FPE_TIMEOUT_MS first")

        self.assertIn("HERMES_HOME", texts([t for t in found if t["kind"] == "env_var"]))

    def test_plain_acronym_is_not_an_env_var(self):
        found = c.extract_protected("ship the MVP with an API")

        self.assertEqual([t for t in found if t["kind"] == "env_var"], [])

    def test_cli_flag(self):
        found = c.extract_protected("run with --dry-run and --verbose=2")

        self.assertIn("--dry-run", texts([t for t in found if t["kind"] == "flag"]))

    def test_tokens_are_deduplicated(self):
        found = c.extract_protected("https://a.example https://a.example")

        self.assertEqual(len([t for t in found if t["kind"] == "url"]), 1)

    def test_path_inside_a_code_block_is_not_double_counted(self):
        found = c.extract_protected("```\ncp ./a/b.ts ./c/d.ts\n```")

        self.assertEqual([t for t in found if t["kind"] == "path"], [])
        self.assertEqual(len([t for t in found if t["kind"] == "code_block"]), 1)

    def test_blank_input_yields_nothing(self):
        self.assertEqual(c.extract_protected(""), [])
        self.assertEqual(c.extract_protected(None), [])

    def test_extraction_is_capped(self):
        draft = "\n".join("see https://example.com/%d now" % i for i in range(600))

        found = c.extract_protected(draft)

        self.assertLessEqual(len(found), c.MAX_PROTECTED_TOKENS)


class TestVerification(unittest.TestCase):
    def test_all_preserved(self):
        original = "check https://example.com and `npm run build`"
        report = c.verify_protected(original, "Please check https://example.com and `npm run build`.")

        self.assertTrue(report["ok"])
        self.assertEqual(report["missing"], [])
        self.assertEqual(report["total"], 2)
        self.assertEqual(report["present"], 2)

    def test_missing_url_is_reported(self):
        report = c.verify_protected("see https://example.com", "see the docs")

        self.assertFalse(report["ok"])
        self.assertIn("https://example.com", texts(report["missing"]))
        self.assertEqual(kinds(report), ["url"])

    def test_missing_path_is_reported(self):
        report = c.verify_protected("edit ./src/app.ts", "edit the entry module")

        self.assertEqual(kinds(report), ["path"])

    def test_missing_code_block_is_reported(self):
        report = c.verify_protected("```py\nx = 1\n```", "just run one line")

        self.assertEqual(kinds(report), ["code_block"])

    def test_reindented_code_block_is_soft_not_hard(self):
        original = "```py\ndef f():\n    return 1\n```"
        reindented = "```py\ndef f():\n  return 1\n```"

        report = c.verify_protected(original, reindented)

        self.assertTrue(report["ok"])
        self.assertEqual([entry["kind"] for entry in report["missing"]], [])
        self.assertEqual([entry["kind"] for entry in report["altered_whitespace"]], ["code_block"])

    def test_renumbered_issue_ref_is_reported(self):
        report = c.verify_protected("see #120907", "see #120908")

        self.assertEqual(kinds(report), ["issue_ref"])

    def test_report_is_ok_when_a_draft_has_nothing_protected(self):
        report = c.verify_protected("write me a weekly report", "Please write a weekly report.")

        self.assertTrue(report["ok"])
        self.assertEqual(report["total"], 0)

    def test_translation_of_a_path_counts_as_missing(self):
        report = c.verify_protected("open src/配置/rules.md", "open the rules file")

        self.assertEqual(kinds(report), ["path"])

    def test_total_counts_every_extracted_token(self):
        original = "https://a.example and ./b/c.ts and #12"

        report = c.verify_protected(original, original)

        self.assertEqual(report["total"], 3)
        self.assertEqual(report["present"], 3)

    def test_none_inputs_are_safe(self):
        report = c.verify_protected(None, None)

        self.assertTrue(report["ok"])
        self.assertEqual(report["total"], 0)


if __name__ == "__main__":
    unittest.main()
