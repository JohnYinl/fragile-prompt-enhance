"""Slice 1 — protocol contract and prompt assembly (TDD RED first).

The protocol (output markers, scoring rubric, hard behavioural limits) is owned
by the PYTHON side and appended to whatever editorial template the desktop half
sends, so the parser and the instructions can never drift apart.
"""

from __future__ import annotations

import unittest

import fpe_core


class TestTemplateRendering(unittest.TestCase):
    def test_renders_draft_placeholder(self):
        out = fpe_core.render_template("Rewrite:\n{{draft}}\nEND", {"draft": "hello"})

        self.assertEqual(out, "Rewrite:\nhello\nEND")

    def test_renders_ui_lang_placeholder(self):
        out = fpe_core.render_template("reason in {{ui_lang}}", {"ui_lang": "zh"})

        self.assertEqual(out, "reason in zh")

    def test_unknown_placeholder_is_left_verbatim(self):
        self.assertEqual(fpe_core.render_template("a {{nope}} b", {"draft": "x"}),
                         "a {{nope}} b")

    def test_missing_placeholder_value_raises(self):
        with self.assertRaises(fpe_core.TemplateError):
            fpe_core.render_template("{{draft}}", {})

    def test_empty_template_raises(self):
        with self.assertRaises(fpe_core.TemplateError):
            fpe_core.render_template("   ", {"draft": "x"})

    def test_template_without_draft_placeholder_raises(self):
        with self.assertRaises(fpe_core.TemplateError):
            fpe_core.render_template("no placeholder here", {"draft": "x"})


class TestProtocolBlock(unittest.TestCase):
    def setUp(self):
        self.block = fpe_core.protocol_block(ui_lang="zh")

    def test_declares_both_markers_and_terminator(self):
        self.assertIn(fpe_core.ENHANCED_MARKER, self.block)
        self.assertIn(fpe_core.SCORES_MARKER, self.block)
        self.assertIn(fpe_core.END_MARKER, self.block)

    def test_names_every_scoring_dimension(self):
        for dim in fpe_core.DIMENSIONS:
            self.assertIn('"%s"' % dim, self.block)

    def test_forbids_asymmetric_inflation(self):
        lowered = self.block.lower()
        self.assertIn("do not inflate", lowered)
        self.assertIn("may score", lowered)

    def test_declares_the_self_assessment_caveat(self):
        self.assertIn("self-assessment", self.block.lower())

    def test_forbids_tool_use_and_role_framing(self):
        # Assert on collapsed whitespace: the block is hard-wrapped prose and a
        # re-wrap must not make this test lie about the contract.
        lowered = " ".join(self.block.lower().split())
        self.assertIn("do not call any tool", lowered)
        self.assertIn("do not answer", lowered)

    def test_forbids_length_quota_and_fabrication(self):
        lowered = self.block.lower()
        self.assertIn("no length quota", lowered)
        self.assertIn("never invent", lowered)

    def test_keeps_draft_language(self):
        lowered = self.block.lower()
        self.assertIn("language of the draft", lowered)

    def test_rationale_language_follows_ui_lang(self):
        zh = fpe_core.protocol_block(ui_lang="zh")
        en = fpe_core.protocol_block(ui_lang="en")

        self.assertIn("Simplified Chinese", zh)
        self.assertIn("English", en)

    def test_unknown_ui_lang_falls_back_to_english_rationale(self):
        self.assertIn("English", fpe_core.protocol_block(ui_lang="klingon"))

    def test_protects_exact_content_verbatim(self):
        lowered = self.block.lower()
        self.assertIn("verbatim", lowered)
        self.assertIn("code block", lowered)
        self.assertIn("url", lowered)


class TestBuildMessages(unittest.TestCase):
    def _build(self, **kw):
        args = dict(
            mode="precise",
            draft="帮我写周报",
            system_template="EDITORIAL SYSTEM",
            user_template="EDITORIAL USER\n{{draft}}",
            ui_lang="zh",
        )
        args.update(kw)
        return fpe_core.build_messages(**args)

    def test_shape_is_system_then_user(self):
        msgs = self._build()

        self.assertEqual([m["role"] for m in msgs], ["system", "user"])

    def test_editorial_template_survives_and_protocol_is_appended(self):
        msgs = self._build()

        self.assertIn("EDITORIAL SYSTEM", msgs[0]["content"])
        self.assertIn(fpe_core.ENHANCED_MARKER, msgs[0]["content"])
        self.assertIn("EDITORIAL USER", msgs[1]["content"])

    def test_draft_is_substituted_into_the_user_message(self):
        msgs = self._build()

        self.assertIn("帮我写周报", msgs[1]["content"])
        self.assertNotIn("{{draft}}", msgs[1]["content"])

    def test_draft_is_fenced_as_data_not_instructions(self):
        msgs = self._build()

        self.assertIn(fpe_core.DRAFT_FENCE, msgs[1]["content"])
        self.assertIn("data to be edited", msgs[1]["content"])

    def test_empty_draft_is_refused(self):
        with self.assertRaises(fpe_core.TemplateError):
            self._build(draft="")

    def test_unknown_mode_is_refused(self):
        with self.assertRaises(fpe_core.TemplateError):
            self._build(mode="professional")

    def test_both_modes_are_accepted(self):
        for mode in fpe_core.MODES:
            with self.subTest(mode=mode):
                self.assertEqual(len(self._build(mode=mode)), 2)


class UiLanguageContractTest(unittest.TestCase):
    """The UI language is Hermes's, and it decides the rationale language ONLY.

    These pin the two halves of the user's rule: the rationale follows the
    language the UI actually rendered, while the rewritten prompt keeps the
    DRAFT's language and is never translated to match the UI.
    """

    def test_simplified_chinese_ui_asks_for_chinese_rationale(self):
        block = fpe_core.protocol_block(ui_lang="zh")

        self.assertIn("Simplified Chinese", block)

    def test_english_ui_asks_for_english_rationale(self):
        self.assertIn("English", fpe_core.protocol_block(ui_lang="en"))

    def test_missing_ui_lang_falls_back_to_english(self):
        for value in (None, "", "   "):
            with self.subTest(value=value):
                self.assertIn("English", fpe_core.protocol_block(ui_lang=value))

    def test_unshipped_locale_falls_back_to_english_not_a_third_language(self):
        """`zh-hant` ships no bundle, so the UI the user sees is English.

        Asking for a Traditional-Chinese rationale there would hand the user a
        language they cannot read the surrounding UI in.
        """
        for value in ("zh-hant", "ja", "fr", "de", "ar", "ru", "es"):
            with self.subTest(value=value):
                block = fpe_core.protocol_block(ui_lang=value)

                self.assertIn("English", block)
                self.assertNotIn("Traditional Chinese", block)

    def test_only_shipped_locales_are_mapped(self):
        self.assertEqual(fpe_core.SHIPPED_UI_LOCALES, ("en", "zh"))

    def test_draft_language_is_preserved_regardless_of_ui_language(self):
        """A Chinese UI must never translate an English draft (and vice versa)."""
        block = fpe_core.protocol_block(ui_lang="zh")
        collapsed = " ".join(block.split())

        self.assertIn("Keep the language of the draft", collapsed)
        self.assertIn("Never translate the draft", collapsed)

    def test_rationale_language_rule_is_stated_explicitly(self):
        collapsed = " ".join(fpe_core.protocol_block(ui_lang="zh").split())

        # The rationale follows the UI...
        self.assertIn("current UI language", collapsed)
        # ...while the prompt itself follows the draft.
        self.assertIn("always keeps the draft's own language", collapsed)

    def test_ui_lang_is_a_usable_template_placeholder(self):
        self.assertIn("ui_lang", fpe_core.KNOWN_PLACEHOLDERS)

        rendered = fpe_core.render_template(
            "answer in {{ui_lang}}",
            {"draft": "x", "ui_lang": "zh", "mode": "precise"},
        )

        self.assertEqual(rendered, "answer in zh")

    def test_ui_lang_reaches_the_user_message_variables(self):
        messages = fpe_core.build_messages(
            draft="写一个周报",
            mode=fpe_core.MODE_PRECISE,
            user_template="[[{{ui_lang}}]] {{draft}}",
            system_template="sys",
            ui_lang="zh",
        )

        self.assertIn("[[zh]]", messages[1]["content"])


if __name__ == "__main__":
    unittest.main()
