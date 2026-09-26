"""Fragile Prompt Enhance — agent half (芙拉吉尔·提示词增强).

This half does one thing: publish the plugin's live :class:`PluginContext` so the
dashboard backend beside it (``dashboard/plugin_api.py``) can call the official
host-owned LLM door ``ctx.llm``. That is the ONLY credential path this plugin
uses — it never reads ``.env``, never touches ``config.yaml`` secrets and never
constructs a provider client of its own.

The dashboard mount exec's ``plugin_api.py`` as a standalone module (not as a
submodule of this package), so the two halves share state through this module's
object identity, which ``plugin_api.resolve_plugin_context()`` finds by file
path rather than by re-importing (a second import would give a second holder).

Nothing else is registered on purpose: no tools, no hooks, no prompt sections,
no middleware. The enhancement model is told not to call tools, and this plugin
adds no interception of the user's messages.
"""

from __future__ import annotations

from typing import Any, Optional

from . import fpe_core  # noqa: F401  (warmed here so the backend reuses this copy)

__all__ = ["PLUGIN_ID", "PLUGIN_CTX", "ContextHolder", "register"]

PLUGIN_ID = "fragile-prompt-enhance"


class ContextHolder:
    """Single-slot holder for the live plugin context.

    Deliberately tiny and exception-free: it is read from a request handler in
    another module of the same process, so it must never raise or allocate.
    """

    __slots__ = ("_ctx",)

    def __init__(self) -> None:
        self._ctx: Optional[Any] = None

    def set(self, ctx: Any) -> None:
        self._ctx = ctx

    def get(self) -> Optional[Any]:
        return self._ctx

    def clear(self) -> None:
        self._ctx = None


PLUGIN_CTX = ContextHolder()


def register(ctx: Any) -> None:
    """Called once by the Hermes plugin loader. Publishes the context.

    Also exercises the host-owned LLM door lazily rather than at load time: a
    plugin that cannot reach ``ctx.llm`` must still load, so the desktop half can
    show the user a precise reason instead of an empty Plugins row.
    """
    PLUGIN_CTX.set(ctx)

    on_unload = getattr(ctx, "on_unload", None)

    if callable(on_unload):
        on_unload(PLUGIN_CTX.clear)
