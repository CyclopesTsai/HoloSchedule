# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 CyclopesTsai
from pathlib import Path

import stamp_assets

PUBLIC = Path(__file__).resolve().parent.parent / "public"


def make_site(tmp_path: Path, html: str) -> Path:
    (tmp_path / "style.css").write_text("body{}", encoding="utf-8")
    (tmp_path / "app.js").write_text("1;", encoding="utf-8")
    (tmp_path / "index.html").write_text(html, encoding="utf-8")
    return tmp_path


def test_stamps_local_assets(tmp_path):
    site = make_site(tmp_path, '<link rel="stylesheet" href="style.css"><script src="app.js" defer></script>')
    assert stamp_assets.main([str(site)]) == 0
    html = (site / "index.html").read_text(encoding="utf-8")
    css_v = stamp_assets.content_hash(site / "style.css")
    js_v = stamp_assets.content_hash(site / "app.js")
    assert f'href="style.css?v={css_v}"' in html
    assert f'src="app.js?v={js_v}"' in html


def test_version_follows_content(tmp_path):
    site = make_site(tmp_path, '<script src="app.js"></script>')
    before = stamp_assets.content_hash(site / "app.js")
    (site / "app.js").write_text("2;", encoding="utf-8")
    assert stamp_assets.content_hash(site / "app.js") != before


def test_restamping_replaces_old_version(tmp_path):
    site = make_site(tmp_path, '<script src="app.js?v=old123"></script>')
    html, _ = stamp_assets.stamp((site / "index.html").read_text(encoding="utf-8"), site)
    assert "old123" not in html
    assert html.count("?v=") == 1


def test_leaves_external_and_missing_files_alone(tmp_path):
    original = (
        '<a href="https://example.com/x.js">x</a>'
        '<script src="missing.js"></script>'
        '<link href="https://fonts.example/a.css">'
    )
    site = make_site(tmp_path, original)
    html, stamped = stamp_assets.stamp(original, site)
    assert html == original and stamped == []
    assert stamp_assets.main([str(site)]) == 1


def test_real_index_references_are_stamped():
    html, stamped = stamp_assets.stamp((PUBLIC / "index.html").read_text(encoding="utf-8"), PUBLIC)
    assert sorted(s.split("?")[0] for s in stamped) == ["app.js", "style.css"]
    assert 'href="style.css?v=' in html and 'src="app.js?v=' in html
