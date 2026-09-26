"""Manifest tests — validated against the REAL Hermes parsers.

These do not re-implement the schema: they import `hermes_cli.plugins_manifest`
and `hermes_cli.web_server_dashboard` out of an actual Hermes checkout and run
our files through them. That is the only way to catch a manifest that looks fine
but that the loader would reject or mount somewhere unexpected.

Skipped (not silently passed) when no Hermes checkout is importable, so a run on
a machine without one reports the gap instead of claiming coverage.
"""

import json
import os
import pathlib
import sys
import unittest

PACKAGE_DIR = pathlib.Path(__file__).resolve().parent.parent / "package" / "fragile-prompt-enhance"

#: The delivery project root (docs/, THIRD-PARTY-NOTICES.md live here).
PROJECT_DIR = PACKAGE_DIR.parent.parent

#: Where a Hermes checkout may be. `HERMES_REPO` wins so a parent can point the
#: suite at a source tree rather than the installed copy.
REPO_CANDIDATES = [
    os.environ.get("HERMES_REPO"),
    str(pathlib.Path(os.environ.get("LOCALAPPDATA", "")) / "hermes" / "hermes-agent"),
    str(pathlib.Path.home() / "hermes" / "hermes-agent"),
]


def _find_repo():
    for candidate in REPO_CANDIDATES:
        if candidate and (pathlib.Path(candidate) / "hermes_cli" / "plugins_manifest.py").is_file():
            return pathlib.Path(candidate)

    return None


REPO = _find_repo()

if REPO is not None and str(REPO) not in sys.path:
    sys.path.insert(0, str(REPO))


@unittest.skipIf(REPO is None, "no Hermes checkout importable (set HERMES_REPO)")
class AgentManifestTest(unittest.TestCase):
    """`plugin.yaml` must parse into the real PluginManifest."""

    def test_parses_and_carries_identity(self):
        from hermes_cli.plugins_manifest import parse_manifest_file

        manifest = parse_manifest_file(PACKAGE_DIR / "plugin.yaml", PACKAGE_DIR, "user", "fragile-prompt-enhance")

        self.assertIsNotNone(manifest)
        self.assertEqual(manifest.name, "fragile-prompt-enhance")
        self.assertEqual(manifest.kind, "standalone")
        self.assertTrue(manifest.version)

    def test_declares_no_hooks_tools_or_dependencies(self):
        """This plugin must never intercept a turn or install anything."""
        from hermes_cli.plugins_manifest import parse_manifest_file

        manifest = parse_manifest_file(PACKAGE_DIR / "plugin.yaml", PACKAGE_DIR, "user", "fragile-prompt-enhance")

        self.assertEqual(list(manifest.provides_hooks), [])
        self.assertEqual(list(manifest.provides_tools), [])
        self.assertEqual(list(manifest.python_dependencies), [])

    def test_agent_half_exposes_register(self):
        """The loader looks for a bare `register` on the package."""
        source = (PACKAGE_DIR / "__init__.py").read_text(encoding="utf-8")

        self.assertIn("def register(", source)

    def _declared_capabilities(self):
        """The raw `capabilities:` value from plugin.yaml, as the parser sees it."""
        import re

        source = (PACKAGE_DIR / "plugin.yaml").read_text(encoding="utf-8")
        match = re.search(r"^capabilities:\s*(\[.*?\])\s*$", source, re.MULTILINE)

        if match is None:
            return None

        return json.loads(match.group(1).replace("'", '"'))

    def test_declares_exactly_the_capabilities_it_can_use(self):
        """The manifest must name the gates this plugin actually exercises.

        The plugin can pin a model (`llm.model_override`) and a provider
        (`llm.provider_override`) for an enhancement. It never asks for an agent
        id, an auth profile or an auxiliary task lane, so declaring those would
        be a consent screen for capabilities nothing in the code uses.
        """
        from hermes_cli.plugins_manifest import parse_manifest_file

        manifest = parse_manifest_file(PACKAGE_DIR / "plugin.yaml", PACKAGE_DIR, "user", "fragile-prompt-enhance")

        self.assertEqual(sorted(manifest.capabilities), ["llm.model_override", "llm.provider_override"])

    def test_every_declared_capability_is_a_real_official_id(self):
        """A typo would be dropped silently by the parser — assert nothing was."""
        from hermes_cli.plugin_capabilities import VALID_CAPABILITY_IDS, parse_declared_capabilities

        raw = self._declared_capabilities()

        self.assertIsInstance(raw, list)
        self.assertEqual(parse_declared_capabilities(raw, "fragile-prompt-enhance"), raw)

        for capability in raw:
            self.assertIn(capability, VALID_CAPABILITY_IDS)

    def test_the_declared_capabilities_cover_the_override_paths(self):
        """`/enhance` reads the two legacy keys; both must be consented, not assumed."""
        source = (PACKAGE_DIR / "dashboard" / "plugin_api.py").read_text(encoding="utf-8")

        self.assertIn("allow_model_override", source)
        self.assertIn("allow_provider_override", source)


class LicenceHonestyTest(unittest.TestCase):
    """The licence claim must be one the shipped artifacts actually back.

    Both template sources are now cleared for redistribution — WB-Enhance-Prompt
    1.5.6-share ships MIT (its LICENSE expressly covers the embedded prompt
    templates) and Heybinshao/prompt-enhancer is MIT — so the package declares
    plain MIT and carries BOTH attributions with their full licence texts. These
    tests pin that end state: they no longer encode the earlier "no licence, do
    not claim MIT" state, and they still refuse an unattributed claim.
    """

    def setUp(self):
        self.text = (PACKAGE_DIR / "plugin.yaml").read_text(encoding="utf-8")
        self.line = next(
            line for line in self.text.splitlines() if line.startswith("license:")
        )

    def test_the_manifest_declares_mit(self):
        """The release posture is MIT; the field must say exactly that."""
        self.assertEqual(self.line.strip(), "license: MIT")

    def test_the_manifest_no_longer_carries_the_old_licence_caveat(self):
        """A leftover 'not yet cleared' note would contradict the published state."""
        self.assertNotIn("not yet cleared", self.line)
        self.assertNotIn("发布前缺口", self.line)

    def test_both_template_sources_are_attributed_with_their_licence_text(self):
        """MIT requires the copyright line AND the full text in every copy.

        One block per source: the WB share package (whose LICENSE covers the
        embedded templates) and Heybinshao/prompt-enhancer.
        """
        notices = (PROJECT_DIR / "THIRD-PARTY-NOTICES.md").read_text(encoding="utf-8")

        self.assertIn("Copyright (c) 2026 WB Enhance Prompt contributors", notices)
        self.assertIn("Copyright (c) 2026 Binshao", notices)
        self.assertEqual(notices.count("Permission is hereby granted, free of charge"), 2)
        self.assertIn("8fb4e23d7e25aacf41e3be6e5c91d72af0829e86", notices)

    def test_the_provenance_doc_names_both_sources_and_their_versions(self):
        """The releaser must be able to trace each attribution to a source."""
        doc = (PROJECT_DIR / "docs" / "来源映射与许可.md").read_text(encoding="utf-8")

        self.assertIn("WB-Enhance-Prompt", doc)
        self.assertIn("1.5.6", doc)
        self.assertIn("Heybinshao/prompt-enhancer", doc)
        self.assertIn("MIT", doc)
        # The now-closed gap must not come back as an open blocker...
        self.assertNotIn("发布前缺口", doc)

    def test_no_source_attribution_is_invented(self):
        """Every claim in the provenance doc must be one we actually verified."""
        doc = (PROJECT_DIR / "docs" / "来源映射与许可.md").read_text(encoding="utf-8")

        # The two commits whose licence files were read, at the pinned revisions.
        self.assertIn("8fb4e23d7e25aacf41e3be6e5c91d72af0829e86", doc)
        self.assertIn("b1d5ea1363d4f830967da4ae4748d006b07fee0e", doc)
        # And the one that was NOT opened must say so.
        self.assertIn("本轮未打开", doc)
        # A licence statement read from a share package is not an upstream ruling;
        # the doc must keep saying so rather than upgrading it into one.
        self.assertIn("不声称", doc)


@unittest.skipIf(REPO is None, "no Hermes checkout importable (set HERMES_REPO)")
class DashboardManifestTest(unittest.TestCase):
    """`dashboard/manifest.json` must mount our router on the path the desktop half calls."""

    def setUp(self):
        self.data = json.loads((PACKAGE_DIR / "dashboard" / "manifest.json").read_text(encoding="utf-8"))

    def test_api_field_is_accepted_by_the_real_path_guard(self):
        from hermes_cli.web_server_dashboard import _safe_plugin_api_relpath

        accepted = _safe_plugin_api_relpath(self.data.get("api"), dashboard_dir=PACKAGE_DIR / "dashboard")

        self.assertEqual(accepted, "plugin_api.py")
        self.assertTrue((PACKAGE_DIR / "dashboard" / accepted).is_file())

    def test_entry_file_exists_so_the_ui_never_404s(self):
        from hermes_cli.web_server_dashboard import _dashboard_plugin_entry

        entry = _dashboard_plugin_entry(self.data, self.data["name"], PACKAGE_DIR / "dashboard", "user")

        self.assertTrue((PACKAGE_DIR / "dashboard" / entry["entry"]).is_file())

    def test_adds_no_dashboard_tab(self):
        """The UI lives in the composer button; a phantom tab would be wrong."""
        from hermes_cli.web_server_dashboard import _dashboard_plugin_entry

        entry = _dashboard_plugin_entry(self.data, self.data["name"], PACKAGE_DIR / "dashboard", "user")

        self.assertTrue(entry["tab"].get("hidden"))
        self.assertEqual(list(entry["slots"]), [])

    def test_plugin_name_matches_the_desktop_plugin_id(self):
        """`/api/plugins/<name>/` must be what `ctx.rest('/enhance')` resolves to.

        The desktop half is namespaced by its plugin id, so a manifest `name`
        that differed by even a character would 404 every call.
        """
        from hermes_cli.web_server_dashboard import _dashboard_plugin_entry

        entry = _dashboard_plugin_entry(self.data, self.data["name"], PACKAGE_DIR / "dashboard", "user")
        desktop = (PACKAGE_DIR / "desktop" / "plugin.js").read_text(encoding="utf-8")

        self.assertIn("id: PLUGIN_ID", desktop)
        self.assertIn("PLUGIN_ID = '%s'" % entry["name"], desktop)

    def test_router_exposes_router_for_mounting(self):
        """The mounter requires a `router` attribute on the api module."""
        source = (PACKAGE_DIR / "dashboard" / "plugin_api.py").read_text(encoding="utf-8")

        self.assertIn("router = APIRouter(", source)

    def test_both_string_bundles_are_registered(self):
        """en + zh only, matching ctx.i18n's bundle contract."""
        desktop = (PACKAGE_DIR / "desktop" / "plugin.js").read_text(encoding="utf-8")

        self.assertIn("  en: {", desktop)
        self.assertIn("  zh: {", desktop)
        self.assertNotIn("  ja: {", desktop)


if __name__ == "__main__":
    unittest.main()
