"""Fragile Prompt Enhance — the template archive format (pure, stdlib only).

One job: describe a template archive and decide whether some bytes are one.
No I/O, no Hermes import, no state — the two backend doors in
``dashboard/plugin_api.py`` read and write files, this module only says what a
file may contain.

What an archive IS
------------------
A UTF-8 JSON document holding TEMPLATES and nothing else::

    {
      "schema": "fragile-prompt-enhance.templates",
      "format_version": 2,
      "exported_at": "2026-09-26T12:00:00Z",
      "plugin_version": "1.0.0",
      "template_version": 3,
      "scope": "both",
      "modes": { "precise": { "system": "…", "user": "…" }, "creative": { … } }
    }

* ``scope`` says which fields the archive carries — ``system``, ``user`` or
  ``both`` — and an import applies exactly those, no more.
* ``modes`` carries one or both of ``precise`` / ``creative``.
* ``template_version`` says which shipped default the packed bytes ARE: an
  integer when they are exactly one of the recorded defaults, and the explicit
  ``"custom"`` marker when they are not. It is information, never a rule — an
  import applies the bytes either way.
* In format 1 the field could also be ``null``, which could not be told apart
  from "the exporter kept no record": a real archive of this project said
  ``null`` for content that WAS the shipped default 3. Format 2 therefore never
  writes ``null`` (a caller that states no version is packed as ``"custom"``,
  the value that claims no shipped default), and a format-1 document that does
  carry ``null`` is still READ — its version is reported as unstated, as a
  warning, so the older file keeps importing instead of being half-understood.
* Every ``user`` field must still carry ``{{draft}}``: a template without it
  cannot be run, so it is refused rather than loaded as a broken default.

What an archive may NOT carry is the point of the strictness here: no draft, no
result, no history, no model or provider setting, no credential, no other
plugin's storage. An unknown KEY — at the top level or inside a mode — is a
refusal, not something quietly dropped, because "we only kept the fields we
recognised" is exactly how a file that looks applied is not.

Notes:
  * Sizes are capped BEFORE parsing (``MAX_BYTES``), so a large or hostile file
    is a stated refusal instead of a memory event.
  * A UTF-8 BOM is accepted and REPORTED as a warning — Windows editors add one,
    and silently accepting it without saying so would misreport the bytes.
  * Validation reports EVERY reason it found, not just the first: a user fixing
    a file should not have to re-run this to discover the next problem.
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Sequence, Tuple

#: Identifies the document kind. A JSON object without it is not an archive.
SCHEMA_ID = "fragile-prompt-enhance.templates"

#: The archive layout version. Bumped only for an incompatible change; a
#: document from a LATER version is refused instead of half-understood.
#:
#: 2 — ``template_version`` became a statement about the packed BYTES (an
#: integer, or the ``custom`` marker) and never ``null``. Layout 1 is still
#: read, with its ``null`` reported as an unstated version.
FORMAT_VERSION = 2

#: The older layout, still accepted on read.
LEGACY_FORMAT_VERSIONS: Tuple[int, ...] = (1,)

#: The explicit marker for content that is not any recorded shipped default.
#:
#: ``null`` could not carry this meaning: it is indistinguishable from an
#: exporter that simply kept no record, and the two are different facts.
CUSTOM_TEMPLATE_VERSION = "custom"

#: Which fields an archive carries (and an import therefore applies).
SCOPES: Tuple[str, ...] = ("system", "user", "both")

#: Which modes an export may include. `both` is the whole library.
EXPORT_MODES: Tuple[str, ...] = ("both", "precise", "creative")

#: The two editorial modes, in the order the desktop half ships them.
MODES: Tuple[str, ...] = ("precise", "creative")

#: The two halves of a template pair.
FIELDS: Tuple[str, ...] = ("system", "user")

#: Keys an archive is allowed to have. Anything else is an `unknown_key`.
TOP_LEVEL_KEYS: Tuple[str, ...] = (
    "schema",
    "format_version",
    "exported_at",
    "plugin_version",
    "template_version",
    "scope",
    "modes",
)

#: Where the caller forgot to name one. Written so the file says which build.
DEFAULT_PLUGIN_VERSION = "1.0.0"

#: Hard cap on an archive, checked on the raw bytes before parsing. A template
#: pair is a few kilobytes; 256 KiB is far past any real one and far below
#: anything that could hurt a request handler.
MAX_BYTES = 256 * 1024

#: Hard cap on one field. The desktop half's own cap on a draft is 60k chars;
#: a template that long is not a template.
MAX_FIELD_CHARS = 20_000

#: The placeholder vocabulary, identical to the core's regex on purpose: the
#: "must contain {{draft}}" rule has to mean the same thing in both halves.
_PLACEHOLDER_RE = re.compile(r"\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}")

#: The one placeholder a runnable template cannot do without.
REQUIRED_PLACEHOLDER = "draft"


class TransferError(ValueError):
    """Raised when a template set cannot be packed into an archive.

    Only ever for the CALLER's input (an unusable template pair, an unknown
    scope); a file that cannot be read is reported by :func:`loads`, never by an
    exception, because a broken file is a result the user asked to see.

    ``code`` is the error code the door reports, so the endpoint does not have to
    re-derive why a build failed: a bad ``mode``/``scope`` argument is a request
    error, an unusable template pair is a template error.
    """

    def __init__(self, message: str, code: str = "templates_invalid") -> None:
        super().__init__(message)
        self.code = code


def placeholders(text: Any) -> List[str]:
    """The ``{{name}}`` placeholders in ``text``, in order, unique."""
    seen: List[str] = []

    for match in _PLACEHOLDER_RE.finditer(text if isinstance(text, str) else ""):
        if match.group(1) not in seen:
            seen.append(match.group(1))

    return seen


def _error(code: str, detail: str, *, field: Optional[str] = None, **extra: Any) -> Dict[str, Any]:
    entry: Dict[str, Any] = {"code": code, "field": field, "detail": detail}
    entry.update(extra)

    return entry


def _fields_for(scope: Any) -> Tuple[str, ...]:
    """Which fields a scope covers. An invalid scope asks for BOTH, so the
    per-field checks still run and the user sees every problem at once."""
    if scope in SCOPES:
        return FIELDS if scope == "both" else (scope,)

    return FIELDS


# ── building ────────────────────────────────────────────────────────────────


def _now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _field_error(mode: str, field: str, reason: str) -> TransferError:
    return TransferError("%s.%s %s" % (mode, field, reason))


def _version_field(value: Any) -> Optional[Any]:
    """``template_version`` as it may be written, or ``None`` when unusable.

    A positive integer names the shipped default the bytes ARE; the ``custom``
    marker says they are not one. Anything else — including ``None`` — cannot be
    written, because the field may not be left ambiguous.
    """
    if value == CUSTOM_TEMPLATE_VERSION:
        return CUSTOM_TEMPLATE_VERSION

    if isinstance(value, int) and not isinstance(value, bool) and value >= 1:
        return value

    return None


def build_export(
    templates: Any,
    *,
    mode: str = "both",
    scope: str = "both",
    template_version: Optional[int] = None,
    plugin_version: str = DEFAULT_PLUGIN_VERSION,
    exported_at: Optional[str] = None,
) -> Dict[str, Any]:
    """The archive document for ``templates``, or :class:`TransferError`.

    Every field it includes is checked here with the SAME rules the import door
    applies, so this plugin cannot hand the user a file its own import refuses.

    ``template_version`` is what the CALLER knows the bytes to be: the integer
    of the shipped default they are, or the explicit ``custom`` marker. A value
    that is neither is refused, and a caller that states nothing at all is
    packed as ``custom`` — a statement that claims no shipped default, instead
    of the ambiguous ``null`` this field used to carry.
    """
    if mode not in EXPORT_MODES:
        raise TransferError(
            "unknown export mode %r (expected one of %s)" % (mode, ", ".join(EXPORT_MODES)),
            code="invalid_request",
        )

    if scope not in SCOPES:
        raise TransferError(
            "unknown scope %r (expected one of %s)" % (scope, ", ".join(SCOPES)),
            code="invalid_request",
        )

    if not isinstance(templates, dict):
        raise TransferError("templates must be an object")

    stated = CUSTOM_TEMPLATE_VERSION if template_version is None else _version_field(template_version)

    if stated is None:
        raise TransferError(
            "template_version must be a positive integer or %r (what the templates ARE), found %r"
            % (CUSTOM_TEMPLATE_VERSION, template_version),
            code="invalid_request",
        )

    wanted_modes = list(MODES) if mode == "both" else [mode]
    wanted_fields = _fields_for(scope)
    packed: Dict[str, Dict[str, str]] = {}

    for entry in wanted_modes:
        pair = templates.get(entry)

        if not isinstance(pair, dict):
            raise TransferError("%s is missing" % entry)

        packed[entry] = {}

        for field in wanted_fields:
            value = pair.get(field)

            if not isinstance(value, str) or not value.strip():
                raise _field_error(entry, field, "is empty")

            if len(value) > MAX_FIELD_CHARS:
                raise _field_error(entry, field, "is longer than %d characters" % MAX_FIELD_CHARS)

            if field == "user" and REQUIRED_PLACEHOLDER not in placeholders(value):
                raise _field_error(entry, field, "must contain the {{%s}} placeholder" % REQUIRED_PLACEHOLDER)

            packed[entry][field] = value

    return {
        "schema": SCHEMA_ID,
        "format_version": FORMAT_VERSION,
        "exported_at": exported_at or _now(),
        "plugin_version": plugin_version or DEFAULT_PLUGIN_VERSION,
        "template_version": stated,
        "scope": scope,
        "modes": packed,
    }


def dumps(payload: Any) -> str:
    """An archive as the text that gets written.

    ``ensure_ascii=False`` on purpose: the file a user opens must show the
    Chinese they wrote, not a wall of ``\\u`` escapes.
    """
    return json.dumps(payload, ensure_ascii=False, indent=2) + "\n"


def filename_for(mode: str = "both", scope: str = "both") -> str:
    """The default name offered in the native save dialog."""
    parts = ["fragile-prompt-enhance-templates"]

    if mode != "both":
        parts.append(mode)

    if scope != "both":
        parts.append(scope)

    return "-".join(parts) + ".json"


# ── validating ──────────────────────────────────────────────────────────────


def _validate(payload: Any, errors: List[Dict[str, Any]], warnings: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """The usable template map in ``payload``, or ``None`` while appending why."""
    if not isinstance(payload, dict):
        errors.append(_error("not_object", "the document is not a JSON object"))

        return None

    for key in payload:
        if key not in TOP_LEVEL_KEYS:
            errors.append(_error("unknown_key", "unknown top-level key %r" % key, field=str(key)))

    if payload.get("schema") != SCHEMA_ID:
        errors.append(
            _error(
                "schema",
                "expected schema %r, found %r" % (SCHEMA_ID, payload.get("schema")),
                field="schema",
            )
        )

    version = payload.get("format_version")
    layout = version if isinstance(version, int) and not isinstance(version, bool) else None

    if not isinstance(version, int) or isinstance(version, bool) or not 1 <= version <= FORMAT_VERSION:
        errors.append(
            _error(
                "version",
                "format_version must be an integer between 1 and %d, found %r" % (FORMAT_VERSION, version),
                field="format_version",
            )
        )
    elif version < FORMAT_VERSION:
        warnings.append(_error("older_version", "the archive uses format version %d" % version, field="format_version"))

    scope = payload.get("scope")

    if scope not in SCOPES:
        errors.append(_error("scope", "scope must be one of %s, found %r" % (", ".join(SCOPES), scope), field="scope"))

    template_version = payload.get("template_version")

    if layout is not None and layout >= 2:
        # Layout 2 states what the bytes ARE. `null` is not one of the two
        # things it may say, so it is refused rather than read as "unknown".
        if _version_field(template_version) is None:
            errors.append(
                _error(
                    "template_version",
                    "template_version must be a positive integer or %r, found %r"
                    % (CUSTOM_TEMPLATE_VERSION, template_version),
                    field="template_version",
                )
            )
    else:
        # Layout 1 allowed `null`, which could not be told apart from an
        # exporter that kept no record. Read it, and NAME the gap.
        if template_version is not None and _version_field(template_version) is None:
            errors.append(
                _error("template_version", "template_version must be an integer or null", field="template_version")
            )
        elif template_version is None:
            warnings.append(
                _error(
                    "template_version_unstated",
                    "the archive does not say which shipped default these templates are, "
                    "nor that they are custom",
                    field="template_version",
                )
            )

    modes = payload.get("modes")

    if not isinstance(modes, dict) or not modes:
        errors.append(_error("missing_modes", "modes must be a non-empty object", field="modes"))

        return None

    wanted_fields = _fields_for(scope)
    kept: Dict[str, Dict[str, str]] = {}

    for entry, pair in modes.items():
        if entry not in MODES:
            errors.append(_error("unknown_mode", "unknown mode %r" % entry, field="modes.%s" % entry))

            continue

        if not isinstance(pair, dict):
            errors.append(_error("mode_not_object", "%s must be an object" % entry, field=entry))

            continue

        for key in pair:
            if key not in FIELDS:
                errors.append(_error("unknown_field", "unknown field %r" % key, field="%s.%s" % (entry, key)))

        accepted: Dict[str, str] = {}

        for field in wanted_fields:
            value = pair.get(field)
            name = "%s.%s" % (entry, field)

            if field not in pair:
                errors.append(_error("missing_field", "%s is required by this archive's scope" % name, field=name))

                continue

            if not isinstance(value, str):
                errors.append(_error("field_not_text", "%s must be a string" % name, field=name))

                continue

            if not value.strip():
                errors.append(_error("empty_field", "%s is empty" % name, field=name))

                continue

            if len(value) > MAX_FIELD_CHARS:
                errors.append(
                    _error(
                        "field_too_long",
                        "%s is longer than %d characters" % (name, MAX_FIELD_CHARS),
                        field=name,
                        limit=MAX_FIELD_CHARS,
                    )
                )

                continue

            if field == "user" and REQUIRED_PLACEHOLDER not in placeholders(value):
                errors.append(
                    _error(
                        "placeholder",
                        "%s must contain the {{%s}} placeholder" % (name, REQUIRED_PLACEHOLDER),
                        field=name,
                    )
                )

                continue

            accepted[field] = value

        if accepted:
            kept[entry] = accepted

    if not kept:
        return None

    return kept


def loads(text: Any) -> Dict[str, Any]:
    """Inspect archive TEXT: the validated payload, or every reason it is not one.

    Never raises for a bad document. ``ok`` is True only when there are no
    errors AND a usable template map came out; ``templates`` is ``None``
    whenever the caller must not apply anything.
    """
    errors: List[Dict[str, Any]] = []
    warnings: List[Dict[str, Any]] = []

    if not isinstance(text, str):
        return {
            "ok": False,
            "errors": [_error("not_text", "the archive must be text")],
            "warnings": warnings,
            "templates": None,
            "scope": None,
            "format_version": None,
            "template_version": None,
            "payload": None,
            "placeholders": {},
        }

    if len(text.encode("utf-8", "surrogatepass")) > MAX_BYTES:
        return {
            "ok": False,
            "errors": [
                _error(
                    "too_large",
                    "the archive is larger than %d bytes" % MAX_BYTES,
                    limit=MAX_BYTES,
                )
            ],
            "warnings": warnings,
            "templates": None,
            "scope": None,
            "format_version": None,
            "template_version": None,
            "payload": None,
            "placeholders": {},
        }

    if text.startswith("\ufeff"):
        warnings.append(_error("bom", "the archive starts with a UTF-8 byte order mark"))
        text = text[1:]

    try:
        payload = json.loads(text)
    except ValueError as exc:
        return {
            "ok": False,
            "errors": [_error("not_json", "the archive is not valid JSON: %s" % exc)],
            "warnings": warnings,
            "templates": None,
            "scope": None,
            "format_version": None,
            "template_version": None,
            "payload": None,
            "placeholders": {},
        }

    templates = _validate(payload, errors, warnings)

    found: Dict[str, List[str]] = {}

    if isinstance(payload, dict) and isinstance(payload.get("modes"), dict):
        for entry, pair in payload["modes"].items():
            if isinstance(pair, dict):
                for field, value in pair.items():
                    if isinstance(value, str):
                        found["%s.%s" % (entry, field)] = placeholders(value)

    ok = not errors and templates is not None

    return {
        "ok": ok,
        "errors": errors,
        "warnings": warnings,
        "templates": templates if ok else None,
        "scope": payload.get("scope") if isinstance(payload, dict) else None,
        "format_version": payload.get("format_version") if isinstance(payload, dict) else None,
        "template_version": payload.get("template_version") if isinstance(payload, dict) else None,
        "payload": payload,
        "placeholders": found,
    }


def summarize(payload: Any) -> Dict[str, Any]:
    """A preview of an archive: counts and names, never the text itself.

    How long each field is, how many lines, which placeholders it uses — enough
    for the user to recognise what they are about to apply without the dialog
    becoming a second editor of content it does not own.
    """
    modes = payload.get("modes") if isinstance(payload, dict) else None
    fields: List[Dict[str, Any]] = []
    names: List[str] = []

    if isinstance(modes, dict):
        for entry in sorted(modes):
            pair = modes.get(entry)

            if not isinstance(pair, dict):
                continue

            names.append(entry)

            for field in FIELDS:
                value = pair.get(field)

                if not isinstance(value, str):
                    continue

                fields.append(
                    {
                        "mode": entry,
                        "field": field,
                        "chars": len(value),
                        "lines": value.count("\n") + 1,
                        "placeholders": placeholders(value),
                    }
                )

    return {
        "scope": payload.get("scope") if isinstance(payload, dict) else None,
        "modes": names,
        "fields": fields,
    }


__all__ = [
    "CUSTOM_TEMPLATE_VERSION",
    "DEFAULT_PLUGIN_VERSION",
    "EXPORT_MODES",
    "FIELDS",
    "FORMAT_VERSION",
    "LEGACY_FORMAT_VERSIONS",
    "MAX_BYTES",
    "MAX_FIELD_CHARS",
    "MODES",
    "REQUIRED_PLACEHOLDER",
    "SCHEMA_ID",
    "SCOPES",
    "TOP_LEVEL_KEYS",
    "TransferError",
    "build_export",
    "dumps",
    "filename_for",
    "loads",
    "placeholders",
    "summarize",
]
