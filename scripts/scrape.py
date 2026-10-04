#!/usr/bin/env python3
"""Scrape ホロジュール (https://schedule.hololive.tv/) into public/data.json.

The site has one page per group (/lives/hololive, /lives/holostars, ...); together
they cover exactly what /lives/all shows, and fetching them is the only way to know
each stream's group. Pages are fetched one at a time with a short pause in between.

Times on the site are Asia/Tokyo (as long as no timezone cookie is sent, which we
never do). Output times stay in JST with an explicit +09:00 offset; converting to
other timezones is the frontend's job.

On any failure (network, unexpected HTML, zero items) the script exits non-zero and
leaves the existing output file untouched.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import re
import sys
import tempfile
import time
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Callable, Iterable
from urllib.parse import parse_qs, urlparse
from zoneinfo import ZoneInfo

import requests
from bs4 import BeautifulSoup, Tag

BASE_URL = "https://schedule.hololive.tv/"
REPO_URL = "https://github.com/CyclopesTsai/HoloSchedule"
USER_AGENT = f"HoloSchedule/1.0 (personal non-commercial schedule viewer; +{REPO_URL})"
JST = ZoneInfo("Asia/Tokyo")

# (URL slug, display label). Labels follow the site's own menu.
GROUPS: list[tuple[str, str]] = [
    ("hololive", "hololive"),
    ("holostars", "HOLOSTARS"),
    ("holostars_english", "HOLOSTARS English"),
    ("mekpark", "mekPark"),
    ("cover", "COVER"),
]

CONNECT_TIMEOUT = 10
READ_TIMEOUT = 30
MAX_RETRIES = 3          # retries after the first attempt
BACKOFF_BASE = 2.0       # seconds; doubles each retry
PAUSE_BETWEEN_PAGES = 1.5

DEFAULT_OUTPUT = Path(__file__).resolve().parent.parent / "public" / "data.json"

log = logging.getLogger("scrape")

DATE_RE = re.compile(r"(\d{1,2})\s*/\s*(\d{1,2})")
TIME_RE = re.compile(r"(\d{1,2}):(\d{2})")
# The site marks streams that are live now with a red border on the card anchor.
LIVE_RE = re.compile(r"border\s*:\s*\d+px\s+red\b", re.I)
VIDEO_ID_RE = re.compile(r"^[\w-]{11}$")


class ScrapeError(Exception):
    """Fetching failed or the page didn't look like we expect."""


@dataclass
class Item:
    id: str
    member: str
    group: str
    start: datetime
    url: str
    thumbnail: str | None
    is_live: bool

    def to_json(self) -> dict:
        return {
            "id": self.id,
            "member": self.member,
            "group": self.group,
            "start": self.start.isoformat(),
            "url": self.url,
            "thumbnail": self.thumbnail,
            "is_live": self.is_live,
        }


# --------------------------------------------------------------------------- time


def infer_year(month: int, day: int, now: datetime) -> int:
    """Pick the year that puts month/day closest to `now` (JST).

    The schedule only spans a few days around today, so the nearest candidate is
    always right, including across New Year (Dec page in Jan, Jan page in Dec).
    """
    today = now.astimezone(JST).date()
    best: tuple[int, int] | None = None
    for year in (today.year - 1, today.year, today.year + 1):
        try:
            candidate = date(year, month, day)
        except ValueError:  # e.g. 02/29 in a non-leap year
            continue
        distance = abs((candidate - today).days)
        if best is None or distance < best[0]:
            best = (distance, year)
    if best is None:
        raise ScrapeError(f"invalid date header {month:02d}/{day:02d}")
    return best[1]


def make_start(day: date, hour: int, minute: int) -> datetime:
    # Defensive: some schedule sites write 25:00 for 01:00 the next day.
    extra_days, hour = divmod(hour, 24)
    if minute > 59:
        raise ScrapeError(f"invalid time {hour}:{minute}")
    return datetime(day.year, day.month, day.day, hour, minute, tzinfo=JST) + timedelta(days=extra_days)


# ------------------------------------------------------------------------ parsing


def extract_video_id(url: str) -> str | None:
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    candidate = None
    if host.endswith("youtube.com"):
        if parsed.path == "/watch":
            candidate = parse_qs(parsed.query).get("v", [None])[0]
        else:
            m = re.match(r"^/(?:live|shorts|embed)/([^/?#]+)", parsed.path)
            candidate = m.group(1) if m else None
    elif host == "youtu.be":
        candidate = parsed.path.lstrip("/").split("/")[0] or None
    if candidate and VIDEO_ID_RE.match(candidate):
        return candidate
    return None


def _is_date_header(tag: Tag) -> bool:
    classes = tag.get("class") or []
    return tag.name == "div" and "holodule" in classes and "navbar-text" in classes


def _is_entry(tag: Tag) -> bool:
    # Stream cards are <a class="thumbnail"> containing a .datetime cell.
    # Carousel banners share the class but have no .datetime.
    return (
        tag.name == "a"
        and "thumbnail" in (tag.get("class") or [])
        and tag.find(class_="datetime") is not None
    )


def _check_timezone(soup: BeautifulSoup) -> None:
    select = soup.find("select", id="timezoneSelect")
    if select is None:
        return
    chosen = select.find("option", selected=True)
    if chosen is not None and chosen.get("value") not in ("Tokyo", "Asia/Tokyo"):
        raise ScrapeError(f"page is rendered in timezone {chosen.get('value')!r}, expected Tokyo")


def parse_page(html: str, group: str, now: datetime) -> list[Item]:
    """Parse one ホロジュール listing page into Items (document order)."""
    soup = BeautifulSoup(html, "html.parser")
    if soup.find(class_="holodule") is None:
        raise ScrapeError(f"[{group}] page does not look like ホロジュール (no .holodule element)")
    _check_timezone(soup)

    items: list[Item] = []
    current_day: date | None = None
    skipped = 0

    for tag in soup.find_all(lambda t: _is_date_header(t) or _is_entry(t)):
        if _is_date_header(tag):
            m = DATE_RE.search(tag.get_text(" ", strip=True))
            if not m:
                raise ScrapeError(f"[{group}] unparseable date header: {tag.get_text(' ', strip=True)!r}")
            month, day_num = int(m.group(1)), int(m.group(2))
            current_day = date(infer_year(month, day_num, now), month, day_num)
            continue

        if current_day is None:
            raise ScrapeError(f"[{group}] stream card found before any date header")

        url = (tag.get("href") or "").strip()
        video_id = extract_video_id(url)
        if video_id is None:
            skipped += 1
            log.warning("[%s] skipping non-YouTube entry: %s", group, url)
            continue

        time_text = tag.find(class_="datetime").get_text(" ", strip=True)
        tm = TIME_RE.search(time_text)
        if not tm:
            raise ScrapeError(f"[{group}] no time in card {url}: {time_text!r}")

        name_tag = tag.find(class_="name")
        member = name_tag.get_text(" ", strip=True) if name_tag else ""
        if not member:
            raise ScrapeError(f"[{group}] no member name in card {url}")

        thumbnail = None
        for img in tag.find_all("img"):
            src = img.get("src") or ""
            if "img.youtube.com/vi/" in src or "ytimg.com/vi/" in src:
                thumbnail = src.replace("http://", "https://", 1)
                break

        items.append(
            Item(
                id=video_id,
                member=member,
                group=group,
                start=make_start(current_day, int(tm.group(1)), int(tm.group(2))),
                url=f"https://www.youtube.com/watch?v={video_id}",
                thumbnail=thumbnail,
                is_live=bool(LIVE_RE.search(tag.get("style") or "")),
            )
        )

    log.info("[%s] parsed %d items (%d skipped)", group, len(items), skipped)
    return items


def merge_items(groups: Iterable[list[Item]]) -> list[Item]:
    """Dedupe by video id (first occurrence wins, live flag is OR-ed) and sort."""
    by_id: dict[str, Item] = {}
    for items in groups:
        for item in items:
            existing = by_id.get(item.id)
            if existing is None:
                by_id[item.id] = item
            else:
                existing.is_live = existing.is_live or item.is_live
    return sorted(by_id.values(), key=lambda i: (i.start, i.member, i.id))


# ----------------------------------------------------------------------- fetching


def make_session() -> requests.Session:
    session = requests.Session()
    session.headers.update(
        {
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml",
            "Accept-Language": "ja,en;q=0.8",
        }
    )
    return session


def fetch(session: requests.Session, url: str, sleep: Callable[[float], None] = time.sleep) -> str:
    last_error: Exception | None = None
    for attempt in range(MAX_RETRIES + 1):
        if attempt:
            delay = BACKOFF_BASE * 2 ** (attempt - 1)
            log.warning("retrying %s in %.0fs (attempt %d/%d)", url, delay, attempt + 1, MAX_RETRIES + 1)
            sleep(delay)
        try:
            resp = session.get(url, timeout=(CONNECT_TIMEOUT, READ_TIMEOUT))
        except requests.RequestException as e:
            last_error = e
            continue
        if resp.status_code == 429 or resp.status_code >= 500:
            last_error = ScrapeError(f"HTTP {resp.status_code} from {url}")
            continue
        if resp.status_code != 200:
            raise ScrapeError(f"HTTP {resp.status_code} from {url}")
        resp.encoding = resp.encoding or "utf-8"
        return resp.text
    raise ScrapeError(f"giving up on {url}: {last_error}")


def scrape(
    fetcher: Callable[[str], str],
    now: datetime,
    sleep: Callable[[float], None] = time.sleep,
) -> list[Item]:
    per_group: list[list[Item]] = []
    for index, (slug, label) in enumerate(GROUPS):
        if index:
            sleep(PAUSE_BETWEEN_PAGES)
        html = fetcher(f"{BASE_URL}lives/{slug}")
        per_group.append(parse_page(html, label, now))
    return merge_items(per_group)


# ------------------------------------------------------------------------- output


def build_payload(items: list[Item], generated_at: datetime) -> dict:
    return {
        "generated_at": generated_at.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "source": BASE_URL,
        "items": [item.to_json() for item in items],
    }


def write_atomic(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".data-", suffix=".json", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=1)
            f.write("\n")
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def run(
    output: Path,
    fetcher: Callable[[str], str] | None = None,
    now: datetime | None = None,
    sleep: Callable[[float], None] = time.sleep,
) -> int:
    now = now or datetime.now(timezone.utc)
    if fetcher is None:
        session = make_session()
        fetcher = lambda url: fetch(session, url, sleep)  # noqa: E731

    try:
        items = scrape(fetcher, now, sleep)
    except ScrapeError as e:
        log.error("scrape failed, keeping existing %s: %s", output, e)
        return 1
    if not items:
        log.error("parsed 0 items, keeping existing %s", output)
        return 2

    write_atomic(output, build_payload(items, now))
    live = sum(i.is_live for i in items)
    log.info("wrote %d items (%d live) to %s", len(items), live, output)
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("-o", "--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    return run(args.output)


if __name__ == "__main__":
    sys.exit(main())
