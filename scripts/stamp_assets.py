#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 CyclopesTsai
"""Add ?v=<content hash> to the local CSS/JS references in index.html.

GitHub Pages serves every file with `Cache-Control: max-age=600` and custom
headers aren't possible, so a browser can pair a new index.html with an old
cached app.js/style.css. Versioned URLs change whenever the file content does,
which forces a fresh download, while unchanged files stay cacheable.

Run in CI on the deploy copy only (it edits index.html in place).
"""

from __future__ import annotations

import argparse
import hashlib
import re
import sys
from pathlib import Path

DEFAULT_SITE = Path(__file__).resolve().parent.parent / "public"
# href="style.css" / src="app.js" (optionally already carrying ?v=...)
ASSET_RE = re.compile(r'(?P<attr>\b(?:href|src))="(?P<path>[\w./-]+\.(?:css|js))(?:\?v=[\w-]*)?"')


def content_hash(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()[:10]


def stamp(html: str, site: Path) -> tuple[str, list[str]]:
    stamped: list[str] = []

    def replace(m: re.Match) -> str:
        rel = m.group("path")
        target = site / rel
        if rel.startswith(("/", "http")) or not target.is_file():
            return m.group(0)
        version = content_hash(target)
        stamped.append(f"{rel}?v={version}")
        return f'{m.group("attr")}="{rel}?v={version}"'

    return ASSET_RE.sub(replace, html), stamped


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("site", nargs="?", type=Path, default=DEFAULT_SITE)
    args = parser.parse_args(argv)

    index = args.site / "index.html"
    html, stamped = stamp(index.read_text(encoding="utf-8"), args.site)
    if not stamped:
        print("no local CSS/JS references found in index.html", file=sys.stderr)
        return 1
    index.write_text(html, encoding="utf-8")
    for s in stamped:
        print(f"stamped {s}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
