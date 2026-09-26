"""Slice 2 — model-output parsing and score normalisation.

The hard requirement under test: a missing, empty or malformed score block must
NEVER cost the user the enhanced text. The score JSON is strictly optional
payload riding along with the body.
"""

from __future__ import annotations

import json
import unittest

import fpe_core as c


def _block(enhanced: str, scores) -> str:
    payload = "" if scores is None else (scores if isinstance(scores, str) else json.dumps(scores))
    return "%s\n%s\n%s\n%s\n%s\n" % (c.ENHANCED_MARKER, enhanced, c.SCORES_MARKER, payload, c.END_MARKER)


def _scores(orig=50, enh=70, om="o {}", em="e {}"):
    def side(v, r):
        return {
            "goal_clarity": v, "info_sufficiency": v, "constraints": v,
            "deliverable": v, "expression_efficiency": v, "overall": v, "rationale": r,
        }

    return {"original": side(orig, om), "enhanced": side(enh, em)}


class TestParseMarkers(unittest.TestCase):
    def test_extracts_body_and_scores(self):
        out = c.parse_model_output(_block("Do the thing.", _scores()))

        self.assertEqual(out["enhanced"], "Do the thing.")
        self.assertEqual(out["shape"], "markers")
        self.assertIsNone(out["score_error"])
        self.assertEqual(out["scores"]["enhanced"]["overall"], 70)

    def test_body_keeps_internal_newlines_and_indentation(self):
        body = "Line one.\n\n```py\ndef f():\n    return 1\n```\n"
        out = c.parse_model_output(_block(body, _scores()))

        self.assertIn("def f():\n    return 1", out["enhanced"])
        self.assertEqual(out["enhanced"].strip(), body.strip())

    def test_missing_end_marker_still_parses(self):
        raw = "%s\nBody here.\n%s\n%s" % (c.ENHANCED_MARKER, c.SCORES_MARKER, json.dumps(_scores()))
        out = c.parse_model_output(raw)

        self.assertEqual(out["enhanced"], "Body here.")
        self.assertEqual(out["scores"]["original"]["overall"], 50)

    def test_end_marker_is_optional_when_scores_are_absent(self):
        raw = "%s\nOnly a body.\n%s\n" % (c.ENHANCED_MARKER, c.SCORES_MARKER)
        out = c.parse_model_output(raw)

        self.assertEqual(out["enhanced"], "Only a body.")
        self.assertIsNone(out["scores"])
        self.assertEqual(out["score_error"], "empty")


class TestScoreLossNeverLosesBody(unittest.TestCase):
    def test_malformed_json_keeps_body(self):
        out = c.parse_model_output(_block("Keep me.", "{not json at all"))

        self.assertEqual(out["enhanced"], "Keep me.")
        self.assertIsNone(out["scores"])
        self.assertEqual(out["score_error"], "unparseable")

    def test_truncated_json_keeps_body(self):
        raw = _block("Keep me too.", '{"original": {"overall": 4')

        out = c.parse_model_output(raw)

        self.assertEqual(out["enhanced"], "Keep me too.")
        self.assertEqual(out["score_error"], "unparseable")

    def test_json_without_expected_sides_keeps_body(self):
        out = c.parse_model_output(_block("Body wins.", '{"note": "hi"}'))

        self.assertEqual(out["enhanced"], "Body wins.")
        self.assertIsNone(out["scores"])
        self.assertEqual(out["score_error"], "unrecognized")

    def test_score_block_never_leaks_into_the_body(self):
        out = c.parse_model_output(_block("Clean body.", _scores()))

        self.assertNotIn(c.SCORES_MARKER, out["enhanced"])
        self.assertNotIn("goal_clarity", out["enhanced"])


class TestTolerantShapes(unittest.TestCase):
    def test_fenced_bare_body(self):
        out = c.parse_model_output("```\nFenced body.\n```")

        self.assertEqual(out["enhanced"], "Fenced body.")
        self.assertEqual(out["shape"], "fenced")

    def test_fence_inside_a_marked_body_is_preserved(self):
        out = c.parse_model_output(_block("```py\nx = 1\n```", _scores()))

        self.assertIn("```py", out["enhanced"])
        self.assertEqual(out["shape"], "markers")

    def test_json_envelope_with_enhanced_key(self):
        raw = json.dumps({"enhanced": "From a JSON envelope.", "scores": _scores()})
        out = c.parse_model_output(raw)

        self.assertEqual(out["enhanced"], "From a JSON envelope.")
        self.assertEqual(out["shape"], "json")
        self.assertEqual(out["scores"]["enhanced"]["overall"], 70)

    def test_json_envelope_without_scores_still_yields_text(self):
        out = c.parse_model_output(json.dumps({"enhanced": "No scores here."}))

        self.assertEqual(out["enhanced"], "No scores here.")
        self.assertIsNone(out["scores"])

    def test_plain_text_is_used_as_is(self):
        out = c.parse_model_output("Just a plain rewrite.")

        self.assertEqual(out["enhanced"], "Just a plain rewrite.")
        self.assertEqual(out["shape"], "plain")

    def test_leading_label_line_is_dropped(self):
        out = c.parse_model_output("Enhanced prompt:\nThe actual body.")

        self.assertEqual(out["enhanced"], "The actual body.")

    def test_a_body_that_merely_mentions_a_label_is_untouched(self):
        out = c.parse_model_output("Enhanced prompt: keep this because it is content, not a label body here")

        self.assertEqual(out["enhanced"],
                         "Enhanced prompt: keep this because it is content, not a label body here")

    def test_empty_response_reports_empty(self):
        out = c.parse_model_output("   \n  ")

        self.assertEqual(out["enhanced"], "")
        self.assertEqual(out["shape"], "empty")

    def test_non_string_input_is_refused_not_crashed(self):
        out = c.parse_model_output(None)  # type: ignore[arg-type]

        self.assertEqual(out["enhanced"], "")
        self.assertEqual(out["shape"], "empty")


class TestNormalizeScores(unittest.TestCase):
    def test_clamps_nothing_and_keeps_valid_ints(self):
        out = c.normalize_scores(_scores())

        self.assertEqual(out["original"]["overall"], 50)
        self.assertEqual(out["enhanced"]["rationale"], "e {}")
        self.assertEqual(out["issues"], [])

    def test_accepts_numeric_strings(self):
        raw = _scores()
        raw["original"]["overall"] = "62"

        self.assertEqual(c.normalize_scores(raw)["original"]["overall"], 62)

    def test_rounds_floats(self):
        raw = _scores()
        raw["enhanced"]["goal_clarity"] = 71.6

        self.assertEqual(c.normalize_scores(raw)["enhanced"]["goal_clarity"], 72)

    def test_out_of_range_field_becomes_none_and_is_reported(self):
        raw = _scores()
        raw["enhanced"]["overall"] = 105

        out = c.normalize_scores(raw)

        self.assertIsNone(out["enhanced"]["overall"])
        self.assertTrue(any("105" in issue for issue in out["issues"]))

    def test_non_numeric_field_becomes_none_without_dropping_the_side(self):
        raw = _scores()
        raw["original"]["constraints"] = "tight"

        out = c.normalize_scores(raw)

        self.assertIsNone(out["original"]["constraints"])
        self.assertEqual(out["original"]["goal_clarity"], 50)

    def test_missing_dimension_becomes_none(self):
        raw = _scores()
        del raw["original"]["deliverable"]

        self.assertIsNone(c.normalize_scores(raw)["original"]["deliverable"])

    def test_requires_both_sides(self):
        self.assertIsNone(c.normalize_scores({"original": _scores()["original"]}))
        self.assertIsNone(c.normalize_scores({"enhanced": _scores()["enhanced"]}))

    def test_rejects_non_dict(self):
        for bad in (None, [], "x", 3):
            with self.subTest(bad=bad):
                self.assertIsNone(c.normalize_scores(bad))

    def test_unknown_extra_keys_are_ignored(self):
        raw = _scores()
        raw["original"]["vibe"] = 99
        raw["model_note"] = "hi"

        out = c.normalize_scores(raw)

        self.assertEqual(set(out["original"]), set(c.DIMENSIONS) | {"overall", "rationale"})

    def test_rationale_is_trimmed_and_capped(self):
        raw = _scores(om="x" * 5000)

        out = c.normalize_scores(raw)

        self.assertEqual(len(out["original"]["rationale"]), c.MAX_RATIONALE_CHARS)

    def test_declares_scale_and_self_assessment(self):
        out = c.normalize_scores(_scores())

        self.assertEqual(out["scale"], "0-100")
        self.assertEqual(out["basis"], "self_assessed")


class TestMarkerWrapperIsNotContent(unittest.TestCase):
    """A real Kimi answer closed with a repeated ``===ENHANCED_PROMPT===``.

    Only the LEADING marker was consumed, so the trailing one survived into the
    text the user was about to send. The fix must strip the envelope WITHOUT
    becoming a global replacement: a marker the body itself carries — the user's
    own sentence about these markers, a code sample, a template under discussion
    — is content and has to survive.
    """

    DRAFT = "帮我看看 src/app.ts 里的 main()"

    def test_a_trailing_duplicate_marker_is_dropped(self):
        raw = "%s\n请阅读 src/app.ts 并说明 main() 的作用。\n%s\n" % (c.ENHANCED_MARKER, c.ENHANCED_MARKER)
        out = c.parse_model_output(raw)

        self.assertEqual(out["enhanced"], "请阅读 src/app.ts 并说明 main() 的作用。")
        self.assertEqual(out["shape"], "markers")

    def test_a_trailing_marker_after_the_end_marker_is_dropped(self):
        raw = "%s\nBody text.\n%s\n%s\n%s\n" % (
            c.ENHANCED_MARKER, c.SCORES_MARKER, json.dumps(_scores()), c.END_MARKER
        )
        raw += "%s\n" % c.ENHANCED_MARKER  # the leak, after the terminator
        out = c.parse_model_output(raw)

        self.assertEqual(out["enhanced"], "Body text.")
        self.assertNotIn(c.ENHANCED_MARKER, out["enhanced"])

    def test_a_repeated_leading_marker_is_dropped(self):
        raw = "%s\n%s\nBody.\n" % (c.ENHANCED_MARKER, c.ENHANCED_MARKER)

        self.assertEqual(c.parse_model_output(raw)["enhanced"], "Body.")

    def test_a_stray_end_marker_on_its_own_line_still_terminates(self):
        raw = "%s\nKept body.\n%s\nDropped tail.\n%s\n" % (c.ENHANCED_MARKER, c.END_MARKER, c.ENHANCED_MARKER)

        self.assertEqual(c.parse_model_output(raw)["enhanced"], "Kept body.")

    def test_a_marker_the_body_itself_carries_is_never_touched(self):
        """The user's own text about the markers is data, not envelope."""
        body = "把 %s 这个标记原样写进 README\n后面还有正文" % c.ENHANCED_MARKER
        raw = "%s\n%s\n%s\n" % (c.ENHANCED_MARKER, body, c.SCORES_MARKER)

        self.assertEqual(c.parse_model_output(raw)["enhanced"], body)

    def test_an_inline_end_marker_inside_the_body_is_content(self):
        """Only a WHOLE marker line terminates the body."""
        body = "正文里提到 ===END=== 这个终止符，并继续说明"
        raw = "%s\n%s\n%s\n" % (c.ENHANCED_MARKER, body, c.SCORES_MARKER)

        self.assertEqual(c.parse_model_output(raw)["enhanced"], body)

    def test_a_marker_inside_a_code_fence_is_preserved(self):
        body = "```bash\nprintf '%s\\n' done\n```" % c.ENHANCED_MARKER
        raw = "%s\n%s\n%s\n" % (c.ENHANCED_MARKER, body, c.SCORES_MARKER)

        self.assertEqual(c.parse_model_output(raw)["enhanced"], body)

    def test_the_draft_is_the_evidence_that_a_marker_line_is_its_own_content(self):
        """A draft that itself ends with that line keeps it.

        Told apart only by the draft: without it the parser cannot know whether
        the line came from the model's envelope or from the author.
        """
        draft = "整理一下这份说明\n%s" % c.ENHANCED_MARKER
        raw = "%s\n整理一下这份说明\n%s\n" % (c.ENHANCED_MARKER, c.ENHANCED_MARKER)

        self.assertEqual(
            c.parse_model_output(raw, draft=draft)["enhanced"],
            "整理一下这份说明\n%s" % c.ENHANCED_MARKER,
        )
        # Same answer, no draft: treated as envelope.
        self.assertEqual(c.parse_model_output(raw)["enhanced"], "整理一下这份说明")

    def test_a_body_that_is_only_markers_yields_nothing_rather_than_a_marker(self):
        raw = "%s\n%s\n" % (c.ENHANCED_MARKER, c.END_MARKER)

        self.assertEqual(c.parse_model_output(raw)["enhanced"], "")

    def test_a_decorated_marker_line_is_still_recognised(self):
        raw = "%s\nBody.\n**%s**\n" % (c.ENHANCED_MARKER, c.ENHANCED_MARKER)

        self.assertEqual(c.parse_model_output(raw)["enhanced"], "Body.")

    def test_a_line_that_only_starts_with_the_marker_is_content(self):
        raw = "%s\n%s 后面是正文，不是包装\n" % (c.ENHANCED_MARKER, c.ENHANCED_MARKER)

        self.assertEqual(
            c.parse_model_output(raw)["enhanced"],
            "%s 后面是正文，不是包装" % c.ENHANCED_MARKER,
        )

    def test_a_score_section_closed_by_a_marker_still_parses(self):
        """Bad format costs nothing: the note and the scores survive too."""
        payload = json.dumps(dict(_scores(), changes="删去重复"))
        raw = "%s\nBody.\n%s\n%s\n%s\n" % (c.ENHANCED_MARKER, c.SCORES_MARKER, payload, c.ENHANCED_MARKER)
        out = c.parse_model_output(raw)

        self.assertEqual(out["enhanced"], "Body.")
        self.assertEqual(out["scores"]["enhanced"]["overall"], 70)
        self.assertEqual(out["changes"], "删去重复")

    def test_a_bad_score_block_still_keeps_the_body(self):
        raw = "%s\nBody wins.\n%s\n{not json\n%s\n" % (c.ENHANCED_MARKER, c.SCORES_MARKER, c.END_MARKER)
        out = c.parse_model_output(raw)

        self.assertEqual(out["enhanced"], "Body wins.")
        self.assertEqual(out["score_error"], "unparseable")
        self.assertEqual(out["changes"], "")

    def test_plain_and_fenced_shapes_lose_the_same_envelope(self):
        """The shape must not change whether a wrapper marker is stripped.

        A whole-string fence is wrapper-level: the marker-free form already
        unwrapped it, so the same answer plus an ``===END===`` must not suddenly
        keep its ``` fences in the deliverable.
        """
        self.assertEqual(c.parse_model_output("Body.\n%s\n" % c.END_MARKER)["enhanced"], "Body.")

        fenced = c.parse_model_output("```\nBody.\n```\n%s\n" % c.END_MARKER)
        self.assertEqual(fenced["enhanced"], "Body.")
        self.assertEqual(fenced["shape"], "fenced")

    def test_a_whole_string_fence_is_the_only_fence_that_is_unwrapped(self):
        """Fences INSIDE real prose are the author's formatting and stay."""
        body = "先跑：\n```bash\nmake test\n```\n然后看结果。"
        raw = "%s\n%s\n%s\n" % (c.ENHANCED_MARKER, body, c.END_MARKER)

        self.assertEqual(c.parse_model_output(raw)["enhanced"], body)

    def test_fences_inside_the_protocol_body_are_the_author_formatting(self):
        """A fenced block in the BODY is content, not envelope.

        Only a fence wrapping the WHOLE answer is unwrapped (and only on the
        no-marker path). Once the body is inside the protocol markers, its own
        fenced blocks are what the user is going to send — item 6's exact code
        text — so they stay byte for byte, including the fence.
        """
        body = "先跑：\n```bash\nmake test\n```\n然后看结果。"
        raw = "%s\n%s\n%s\n" % (c.ENHANCED_MARKER, body, c.END_MARKER)

        self.assertEqual(c.parse_model_output(raw)["enhanced"], body)

    def test_whitespace_survives_when_there_is_no_wrapper_at_all(self):
        """`_strip_wrapper_markers` must be a no-op on a body with no marker run.

        It reaches into whitespace to find a wrapper behind a blank line, so the
        no-wrapper path is the one that must prove it changed nothing.
        """
        for body in ("Body.\n\n", "\n\nBody.", "Body.\n\nSecond paragraph.\n\n"):
            with self.subTest(body=body):
                self.assertEqual(c._strip_wrapper_markers(body), body)

    def test_a_wrapper_marker_behind_a_blank_line_is_still_stripped(self):
        raw = "%s\nBody.\n\n%s\n" % (c.ENHANCED_MARKER, c.ENHANCED_MARKER)

        self.assertEqual(c.parse_model_output(raw)["enhanced"], "Body.")


class TestChangeNote(unittest.TestCase):
    """The OPTIONAL same-call "what changed" note.

    Additive and never fatal: a model that omits it costs the user nothing, a bad
    one is dropped, and neither case triggers a follow-up request or touches the
    body.
    """

    def test_a_present_note_is_returned_trimmed(self):
        payload = json.dumps(dict(_scores(), changes="  删去重复的要求，补上验收方式。  "))
        out = c.parse_model_output(_block("Body.", payload))

        self.assertEqual(out["changes"], "删去重复的要求，补上验收方式。")

    def test_a_missing_note_is_an_empty_string_not_an_error(self):
        out = c.parse_model_output(_block("Body.", _scores()))

        self.assertEqual(out["changes"], "")
        self.assertIsNone(out["score_error"])

    def test_an_overlong_note_is_capped(self):
        payload = json.dumps(dict(_scores(), changes="x" * 5000))

        self.assertEqual(len(c.parse_model_output(_block("Body.", payload))["changes"]),
                         c.MAX_CHANGE_NOTE_CHARS)

    def test_a_non_string_note_is_dropped(self):
        for bad in (42, ["a"], {"b": 1}, None, True):
            with self.subTest(bad=bad):
                payload = json.dumps(dict(_scores(), changes=bad))

                self.assertEqual(c.parse_model_output(_block("Body.", payload))["changes"], "")

    def test_a_note_survives_unusable_scores(self):
        """A note is its own fact; unusable scores do not erase it."""
        raw = json.dumps({"note": "hi", "changes": "只删了重复"})

        out = c.parse_model_output(_block("Body.", raw))

        self.assertEqual(out["enhanced"], "Body.")
        self.assertIsNone(out["scores"])
        self.assertEqual(out["score_error"], "unrecognized")
        self.assertEqual(out["changes"], "只删了重复")

    def test_a_note_survives_an_unparseable_score_block(self):
        out = c.parse_model_output(_block("Body.", "{not json"))

        self.assertEqual(out["changes"], "")

    def test_an_envelope_level_note_is_read(self):
        raw = json.dumps({"enhanced": "Body.", "scores": _scores(), "changes": "挪了顺序"})
        out = c.parse_model_output(raw)

        self.assertEqual(out["shape"], "json")
        self.assertEqual(out["changes"], "挪了顺序")
        self.assertEqual(out["scores"]["enhanced"]["overall"], 70)

    def test_every_shape_reports_the_key(self):
        """A caller must never have to guess whether the field exists."""
        for raw in (
            "%s\nB\n" % c.ENHANCED_MARKER,
            "```\nB\n```",
            "plain body",
            json.dumps({"enhanced": "B"}),
            "",
        ):
            with self.subTest(raw=raw[:24]):
                self.assertIn("changes", c.parse_model_output(raw))


if __name__ == "__main__":
    unittest.main()
