# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 CyclopesTsai
import json
from collections import Counter
from datetime import date, datetime
from pathlib import Path

import pytest

import scrape
from scrape import JST, Item, ScrapeError

FIXTURES = Path(__file__).parent / "fixtures"
# The fixtures were saved around 2026-10-04 13:50 JST.
FIXTURE_NOW = datetime(2026, 10, 4, 13, 50, tzinfo=JST)


def load(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


@pytest.fixture(scope="module")
def hololive_items():
    return scrape.parse_page(load("lives_hololive_20261004.html"), "hololive", FIXTURE_NOW)


# ---------------------------------------------------------------- real fixtures


def test_item_count(hololive_items):
    assert len(hololive_items) == 109
    assert len({i.id for i in hololive_items}) == 109


def test_first_item_fields(hololive_items):
    first = hololive_items[0].to_json()
    assert first == {
        "id": "nUBmqJrE2Ek",
        "member": "アキロゼ",
        "group": "hololive",
        "start": "2026-10-03T01:10:00+09:00",
        "url": "https://www.youtube.com/watch?v=nUBmqJrE2Ek",
        "thumbnail": "https://img.youtube.com/vi/nUBmqJrE2Ek/mqdefault.jpg",
        "is_live": False,
    }


def test_dates_follow_headers_across_days(hololive_items):
    per_day = Counter(i.start.date() for i in hololive_items)
    assert per_day == {date(2026, 10, 3): 66, date(2026, 10, 4): 36, date(2026, 10, 5): 7}
    # Document order is chronological, so the header switch must never go backwards.
    starts = [i.start for i in hololive_items]
    assert starts == sorted(starts)
    assert hololive_items[-1].start.isoformat() == "2026-10-05T23:40:00+09:00"


def test_times_are_jst_with_offset(hololive_items):
    for item in hololive_items:
        assert item.start.utcoffset().total_seconds() == 9 * 3600
        assert item.to_json()["start"].endswith("+09:00")


def test_is_live(hololive_items):
    live = {i.id: i for i in hololive_items if i.is_live}
    assert set(live) == {"d3_-HSxjShc", "BOjKLly-bLQ"}
    assert live["d3_-HSxjShc"].member == "博衣こより"
    assert live["d3_-HSxjShc"].start.isoformat() == "2026-10-04T12:30:00+09:00"


def test_thumbnails(hololive_items):
    for item in hololive_items:
        assert item.thumbnail == f"https://img.youtube.com/vi/{item.id}/mqdefault.jpg"


def test_carousel_banners_are_ignored():
    html = load("lives_hololive_20261004.html")
    assert "hololivepro.com/" in html  # the page has promo banners using class="thumbnail"
    items = scrape.parse_page(html, "hololive", FIXTURE_NOW)
    assert all("youtube.com" in i.url for i in items)


def test_small_group_page():
    items = scrape.parse_page(load("lives_holostars_20261004.html"), "HOLOSTARS", FIXTURE_NOW)
    assert [i.member for i in items][0] == "アステル・レダ"
    assert len(items) == 4
    assert {i.group for i in items} == {"HOLOSTARS"}
    assert items[0].start.isoformat() == "2026-10-03T00:02:00+09:00"


# ----------------------------------------------------------------- year handling


@pytest.mark.parametrize(
    "month, day, now, expected",
    [
        (10, 3, datetime(2026, 10, 4, tzinfo=JST), 2026),
        (12, 31, datetime(2027, 1, 1, 10, tzinfo=JST), 2026),  # January run, December header
        (1, 1, datetime(2026, 12, 31, 20, tzinfo=JST), 2027),  # December run, January header
        (1, 2, datetime(2026, 12, 31, 20, tzinfo=JST), 2027),
        (2, 29, datetime(2028, 2, 28, tzinfo=JST), 2028),
    ],
)
def test_infer_year(month, day, now, expected):
    assert scrape.infer_year(month, day, now) == expected


def test_infer_year_uses_jst_not_utc():
    # 2026-12-31 15:30 UTC is already 2027-01-01 00:30 in Tokyo.
    # 07/02 is 182 days from whichever "today" is used and 183 from the other,
    # so the answer flips depending on which calendar date counts as today.
    now_utc = datetime(2026, 12, 31, 15, 30).replace(tzinfo=scrape.timezone.utc)
    assert scrape.infer_year(7, 2, now_utc) == 2027
    assert scrape.infer_year(1, 1, now_utc) == 2027


def card(video_id: str, hhmm: str, name: str, live: bool = False) -> str:
    border = "border: 3px red\n        solid;" if live else "border: 0;"
    return f"""
    <a href="https://www.youtube.com/watch?v={video_id}" class="thumbnail" target="_blank"
       style="color:#212529;border-radius: 4px; {border}">
      <div class="col-4 text-left datetime">
        <img src="https://schedule.hololive.tv/dist/images/icons/youtube.png"> {hhmm}
      </div>
      <div class="col text-right name"> {name} </div>
      <img src="https://img.youtube.com/vi/{video_id}/mqdefault.jpg">
    </a>"""


def header(mmdd: str, dow: str) -> str:
    return f'<div class="holodule navbar-text" style="letter-spacing: 0.3em;">\n {mmdd}\n ({dow})\n</div>'


def page(*parts: str) -> str:
    return "<html><body><div class='holodule'></div>" + "".join(parts) + "</body></html>"


def test_cross_year_page():
    html = page(
        header("12/31", "木"),
        card("aaaaaaaaaaa", "23:30", "メンバーA"),
        header("01/01", "金"),
        card("bbbbbbbbbbb", "00:00", "メンバーB", live=True),
    )
    items = scrape.parse_page(html, "hololive", datetime(2027, 1, 1, 0, 10, tzinfo=JST))
    assert [i.start.isoformat() for i in items] == [
        "2026-12-31T23:30:00+09:00",
        "2027-01-01T00:00:00+09:00",
    ]
    assert [i.is_live for i in items] == [False, True]


def test_hour_past_24_rolls_over():
    html = page(header("10/04", "日"), card("ccccccccccc", "25:30", "メンバーC"))
    (item,) = scrape.parse_page(html, "hololive", FIXTURE_NOW)
    assert item.start.isoformat() == "2026-10-05T01:30:00+09:00"


# ------------------------------------------------------------- structure checks


def test_non_holodule_page_is_rejected():
    with pytest.raises(ScrapeError):
        scrape.parse_page("<html><body>Service Unavailable</body></html>", "hololive", FIXTURE_NOW)


def test_card_before_header_is_rejected():
    with pytest.raises(ScrapeError):
        scrape.parse_page(page(card("ddddddddddd", "10:00", "X")), "hololive", FIXTURE_NOW)


def test_card_without_time_is_rejected():
    with pytest.raises(ScrapeError):
        scrape.parse_page(page(header("10/04", "日"), card("eeeeeeeeeee", "", "X")), "hololive", FIXTURE_NOW)


def test_non_tokyo_timezone_is_rejected():
    html = page(
        '<select id="timezoneSelect"><option value="Tokyo">default</option>'
        '<option value="Asia/Taipei" selected>Asia/Taipei</option></select>',
        header("10/04", "日"),
        card("fffffffffff", "10:00", "X"),
    )
    with pytest.raises(ScrapeError):
        scrape.parse_page(html, "hololive", FIXTURE_NOW)


def test_non_youtube_entries_are_skipped():
    html = page(header("10/04", "日"), card("ggggggggggg", "10:00", "X")).replace(
        "https://www.youtube.com/watch?v=ggggggggggg", "https://www.twitch.tv/someone"
    )
    assert scrape.parse_page(html, "hololive", FIXTURE_NOW) == []


@pytest.mark.parametrize(
    "url, expected",
    [
        ("https://www.youtube.com/watch?v=d3_-HSxjShc", "d3_-HSxjShc"),
        ("https://youtube.com/watch?feature=x&v=d3_-HSxjShc", "d3_-HSxjShc"),
        ("https://youtu.be/d3_-HSxjShc", "d3_-HSxjShc"),
        ("https://www.youtube.com/live/d3_-HSxjShc?si=x", "d3_-HSxjShc"),
        ("https://www.youtube.com/channel/UC1234567890", None),
        ("https://example.com/watch?v=d3_-HSxjShc", None),
    ],
)
def test_extract_video_id(url, expected):
    assert scrape.extract_video_id(url) == expected


# ------------------------------------------------------------------ merge + run


def make_item(vid: str, group: str, hour: int, live: bool = False) -> Item:
    return Item(vid, "m", group, datetime(2026, 10, 4, hour, tzinfo=JST), "u", None, live)


def test_merge_dedupes_and_sorts():
    merged = scrape.merge_items(
        [
            [make_item("b", "hololive", 12), make_item("a", "hololive", 10)],
            [make_item("a", "HOLOSTARS", 10, live=True)],
        ]
    )
    assert [i.id for i in merged] == ["a", "b"]
    assert merged[0].group == "hololive" and merged[0].is_live is True


def fake_fetcher(pages: dict[str, str]):
    def fetch(url: str) -> str:
        slug = url.rsplit("/", 1)[-1]
        if slug not in pages:
            raise ScrapeError(f"boom {url}")
        return pages[slug]

    return fetch


ALL_PAGES = {
    "hololive": load("lives_hololive_20261004.html"),
    "holostars": load("lives_holostars_20261004.html"),
    "holostars_english": page(),
    "mekpark": page(),
    "cover": page(),
}


def test_run_writes_payload(tmp_path):
    out = tmp_path / "data.json"
    code = scrape.run(out, fake_fetcher(ALL_PAGES), FIXTURE_NOW, sleep=lambda s: None)
    assert code == 0
    data = json.loads(out.read_text(encoding="utf-8"))
    assert data["source"] == "https://schedule.hololive.tv/"
    assert data["generated_at"] == "2026-10-04T04:50:00Z"
    assert len(data["items"]) == 113
    assert {i["group"] for i in data["items"]} == {"hololive", "HOLOSTARS"}
    assert set(data["items"][0]) == {"id", "member", "group", "start", "url", "thumbnail", "is_live"}


@pytest.mark.parametrize(
    "pages",
    [
        {k: v for k, v in ALL_PAGES.items() if k != "mekpark"},  # one request fails
        {**ALL_PAGES, "holostars": "<html>maintenance</html>"},  # broken structure
        {k: page() for k in ALL_PAGES},  # zero items
    ],
    ids=["fetch-error", "bad-html", "zero-items"],
)
def test_run_failure_keeps_existing_file(tmp_path, pages):
    out = tmp_path / "data.json"
    out.write_text('{"previous": true}', encoding="utf-8")
    code = scrape.run(out, fake_fetcher(pages), FIXTURE_NOW, sleep=lambda s: None)
    assert code != 0
    assert out.read_text(encoding="utf-8") == '{"previous": true}'
    assert [p.name for p in tmp_path.iterdir()] == ["data.json"]


class FakeResponse:
    def __init__(self, status: int, text: str = "ok"):
        self.status_code = status
        self.text = text
        self.encoding = "utf-8"


class FakeSession:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = 0

    def get(self, url, timeout):
        assert timeout == (scrape.CONNECT_TIMEOUT, scrape.READ_TIMEOUT)
        self.calls += 1
        r = self.responses.pop(0)
        if isinstance(r, Exception):
            raise r
        return r


def test_fetch_retries_then_succeeds():
    session = FakeSession([scrape.requests.ConnectionError("x"), FakeResponse(503), FakeResponse(200, "hi")])
    delays = []
    assert scrape.fetch(session, "u", sleep=delays.append) == "hi"
    assert delays == [2.0, 4.0]


def test_fetch_gives_up_after_three_retries():
    session = FakeSession([FakeResponse(503)] * 10)
    delays = []
    with pytest.raises(ScrapeError):
        scrape.fetch(session, "u", sleep=delays.append)
    assert session.calls == 1 + scrape.MAX_RETRIES
    assert delays == [2.0, 4.0, 8.0]


def test_fetch_does_not_retry_client_errors():
    session = FakeSession([FakeResponse(403)])
    with pytest.raises(ScrapeError):
        scrape.fetch(session, "u", sleep=lambda s: None)
    assert session.calls == 1
