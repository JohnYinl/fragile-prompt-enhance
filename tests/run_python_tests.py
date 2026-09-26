#!/usr/bin/env python
"""Run the Fragile Prompt Enhance Python test suite with the stdlib runner.

pytest is not part of the Hermes runtime environment and this project installs
nothing, so the suite is plain ``unittest``. Run it with the Hermes venv python
that owns the gateway dependencies (fastapi/httpx):

    <hermes-venv>/Scripts/python.exe tests/run_python_tests.py -v
"""

from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
PROJECT_DIR = TESTS_DIR.parent
PACKAGE_DIR = PROJECT_DIR / "package" / "fragile-prompt-enhance"


def _install_paths() -> None:
    for entry in (str(TESTS_DIR), str(PACKAGE_DIR), str(PACKAGE_DIR / "dashboard")):
        if entry not in sys.path:
            sys.path.insert(0, entry)


def main() -> int:
    _install_paths()
    os.environ.setdefault("FPE_PROJECT_DIR", str(PROJECT_DIR))
    loader = unittest.TestLoader()
    suite = loader.discover(str(TESTS_DIR), pattern="test_*.py", top_level_dir=str(TESTS_DIR))
    runner = unittest.TextTestRunner(verbosity=2 if "-v" in sys.argv else 1)
    result = runner.run(suite)
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    raise SystemExit(main())
