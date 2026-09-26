/**
 * Dashboard-plugin entry — intentionally a no-op.
 *
 * `dashboard/manifest.json` exists ONLY so the gateway mounts this plugin's
 * backend router (`api: plugin_api.py` at `/api/plugins/fragile-prompt-enhance`).
 * The plugin has no dashboard tab and registers no slots: its whole UI is the
 * native composer button contributed by `desktop/plugin.js`, which the DESKTOP
 * plugin system loads.
 *
 * This file exists so the manifest's `entry` resolves instead of 404-ing.
 */

export {}
