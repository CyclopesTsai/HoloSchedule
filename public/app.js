"use strict";

(() => {
  const DATA_URL = "data.json";
  const REFRESH_MS = 5 * 60 * 1000;   // re-fetch data.json
  const TICK_MS = 60 * 1000;          // re-render relative labels
  const STALE_MS = 60 * 60 * 1000;    // generated_at older than this → warning
  const SOON_MS = 60 * 60 * 1000;     // "即將開始" window
  const ENDED_AFTER_MS = 30 * 60 * 1000; // not live and started this long ago → treat as ended
  const STORAGE_KEY = "holoschedule:prefs";

  const GROUP_ORDER = ["hololive", "HOLOSTARS", "HOLOSTARS English", "mekPark", "COVER"];
  const GROUP_COLOR = {
    "hololive": "var(--g-hololive)",
    "HOLOSTARS": "var(--g-holostars)",
    "HOLOSTARS English": "var(--g-holostars-english)",
    "mekPark": "var(--g-mekpark)",
    "COVER": "var(--g-cover)",
  };
  const TZ_LABEL = { "Asia/Taipei": "台北時間", "Asia/Tokyo": "東京時間", "local": "瀏覽器本地時間" };

  const $ = (id) => document.getElementById(id);
  const els = {
    status: $("status"),
    stale: $("stale"),
    search: $("search"),
    tz: $("tz"),
    groups: $("groups"),
    hideEnded: $("hide-ended"),
    days: $("days"),
    empty: $("empty"),
    tpl: $("entry-tpl"),
  };

  const state = {
    data: null,          // { generatedAt: Date, items: [...] }
    loadError: null,
    tz: "Asia/Taipei",
    group: "all",
    query: "",
    hideEnded: false,
  };

  // Scroll to "now" after the next render that has data (initial load, or the
  // view changed). Auto-refresh and the per-minute tick never move the page.
  let pendingScroll = true;

  // ---------------------------------------------------------------- prefs

  function loadPrefs() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
      if (saved.tz in TZ_LABEL) state.tz = saved.tz;
      if (typeof saved.group === "string") state.group = saved.group;
      state.hideEnded = saved.hideEnded === true;
    } catch (_) { /* storage unavailable: use defaults */ }
  }

  function savePrefs() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ tz: state.tz, group: state.group, hideEnded: state.hideEnded }));
    } catch (_) { /* ignore */ }
  }

  // ----------------------------------------------------------------- time

  function tzOption() {
    return state.tz === "local" ? {} : { timeZone: state.tz };
  }

  function partsOf(date, opts) {
    const out = {};
    for (const p of new Intl.DateTimeFormat("en-CA", { ...tzOption(), ...opts }).formatToParts(date)) {
      out[p.type] = p.value;
    }
    return out;
  }

  function dayKey(date) {
    const p = partsOf(date, { year: "numeric", month: "2-digit", day: "2-digit" });
    return `${p.year}-${p.month}-${p.day}`;
  }

  function formatTime(date) {
    const p = partsOf(date, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    return `${p.hour}:${p.minute}`;
  }

  function formatDateTime(date) {
    const p = partsOf(date, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    return `${p.year}/${p.month}/${p.day} ${p.hour}:${p.minute}`;
  }

  // "YYYY-MM-DD" → UTC midnight ms, so calendar-day arithmetic ignores timezones.
  function keyToUTC(key) {
    const [y, m, d] = key.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  }

  function dayHeading(key, todayKey) {
    const [, m, d] = key.split("-").map(Number);
    const weekday = new Intl.DateTimeFormat("zh-TW", { weekday: "short", timeZone: "UTC" })
      .format(new Date(keyToUTC(key)));
    const diff = Math.round((keyToUTC(key) - keyToUTC(todayKey)) / 86400000);
    const rel = { "0": "今天", "1": "明天", "2": "後天" }[diff] || "";
    return { text: `${m}/${d}（${weekday.replace("週", "")}）`, rel };
  }

  function relativeAgo(ms) {
    const min = Math.round(ms / 60000);
    if (min < 1) return "剛剛";
    if (min < 60) return `${min} 分鐘前`;
    const h = Math.floor(min / 60);
    if (h < 48) return `${h} 小時前`;
    return `${Math.floor(h / 24)} 天前`;
  }

  // ----------------------------------------------------------------- data

  // Width/case-insensitive and katakana → hiragana, so "すばる" finds "スバル".
  function fold(text) {
    return String(text).normalize("NFKC").toLowerCase()
      .replace(/[\u30a1-\u30f6]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
  }

  function sanitize(raw) {
    if (!raw || !Array.isArray(raw.items)) throw new Error("data.json 格式錯誤");
    const generatedAt = new Date(raw.generated_at);
    const items = [];
    for (const it of raw.items) {
      const start = new Date(it.start);
      if (!it || typeof it.id !== "string" || isNaN(start)) continue;
      const url = typeof it.url === "string" && /^https:\/\/(www\.)?youtube\.com\//.test(it.url)
        ? it.url : `https://www.youtube.com/watch?v=${encodeURIComponent(it.id)}`;
      const thumb = typeof it.thumbnail === "string" && /^https:\/\/(img\.youtube\.com|i\d?\.ytimg\.com)\//.test(it.thumbnail)
        ? it.thumbnail : null;
      items.push({
        id: it.id,
        member: String(it.member || ""),
        group: String(it.group || ""),
        start,
        url,
        thumbnail: thumb,
        isLive: it.is_live === true,
        searchKey: fold(it.member || ""),
      });
    }
    items.sort((a, b) => a.start - b.start);
    return { generatedAt: isNaN(generatedAt) ? null : generatedAt, items };
  }

  let loading = false;
  let lastLoad = 0;

  async function load() {
    if (loading) return;
    loading = true;
    try {
      const res = await fetch(`${DATA_URL}?t=${Date.now()}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      state.data = sanitize(await res.json());
      state.loadError = null;
      lastLoad = Date.now();
      renderGroups();
    } catch (err) {
      state.loadError = err;
      console.error(err);
    } finally {
      loading = false;
      render();
    }
  }

  // --------------------------------------------------------------- render

  // Built once per load; counts are filled in by updateGroupCounts on every render.
  function renderGroups() {
    const groups = [...new Set(state.data.items.map((it) => it.group))].sort((a, b) => {
      const ia = GROUP_ORDER.indexOf(a), ib = GROUP_ORDER.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
    });
    if (state.group !== "all" && !groups.includes(state.group)) state.group = "all";

    const frag = document.createDocumentFragment();
    for (const [value, label] of [["all", "全部"], ...groups.map((g) => [g, g])]) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip";
      b.dataset.group = value;
      b.dataset.label = label;
      b.setAttribute("aria-pressed", String(state.group === value));
      frag.append(b);
    }
    els.groups.replaceChildren(frag);
  }

  function updateGroupCounts(items) {
    const counts = new Map([["all", items.length]]);
    for (const it of items) counts.set(it.group, (counts.get(it.group) || 0) + 1);
    for (const b of els.groups.querySelectorAll(".chip")) {
      b.textContent = `${b.dataset.label} ${counts.get(b.dataset.group) || 0}`;
    }
  }

  function renderStatus(now) {
    const d = state.data;
    if (!d) {
      els.status.textContent = state.loadError ? `讀取失敗：${state.loadError.message}` : "讀取中…";
      els.status.classList.toggle("error", !!state.loadError);
      els.stale.hidden = true;
      return;
    }
    let text = "最後更新：";
    text += d.generatedAt
      ? `${formatDateTime(d.generatedAt)}（${TZ_LABEL[state.tz]}，${relativeAgo(now - d.generatedAt)}）`
      : "未知";
    if (state.loadError) text += "　· 重新讀取失敗，顯示的是先前的資料";
    els.status.textContent = text;
    els.status.classList.toggle("error", !!state.loadError);
    els.stale.hidden = !(d.generatedAt === null || now - d.generatedAt > STALE_MS);
  }

  function buildEntry(it, now) {
    const node = els.tpl.content.firstElementChild.cloneNode(true);
    const untilStart = it.start - now;
    const isSoon = !it.isLive && untilStart >= 0 && untilStart <= SOON_MS;
    const isEnded = !it.isLive && -untilStart > ENDED_AFTER_MS;
    node.classList.toggle("is-live", it.isLive);
    node.classList.toggle("is-soon", isSoon);
    node.classList.toggle("is-ended", isEnded);

    const link = node.querySelector(".entry-link");
    link.href = it.url;
    const status = it.isLive ? "直播中，" : isSoon ? "即將開始，" : "";
    link.setAttribute("aria-label", `${status}${formatTime(it.start)} ${it.member}（${it.group}）在 YouTube 開啟`);

    const img = node.querySelector("img");
    if (it.thumbnail) {
      img.src = it.thumbnail;
      img.addEventListener("error", () => { img.remove(); node.querySelector(".thumb").classList.add("no-img"); }, { once: true });
    } else {
      img.remove();
      node.querySelector(".thumb").classList.add("no-img");
    }
    if (isSoon) {
      const mins = Math.max(1, Math.ceil(untilStart / 60000));
      node.querySelector(".badge-soon").textContent = `${mins} 分鐘後`;
    }

    const time = node.querySelector(".time");
    time.textContent = formatTime(it.start);
    time.dateTime = it.start.toISOString();
    node.querySelector(".member").textContent = it.member;
    node.querySelector(".member").title = it.member;
    const group = node.querySelector(".group");
    group.textContent = it.group;
    group.style.setProperty("--group-color", GROUP_COLOR[it.group] || "var(--border)");
    return node;
  }

  function render() {
    const now = Date.now();
    renderStatus(now);
    if (!state.data) return;

    // Past days are hidden; today's ended streams stay. Live streams always show,
    // even if they started yesterday.
    const todayKey = dayKey(new Date(now));
    const current = state.data.items.filter((it) => it.isLive || dayKey(it.start) >= todayKey);
    updateGroupCounts(current);

    const q = fold(state.query).trim();
    const visible = current.filter((it) =>
      (state.group === "all" || it.group === state.group) &&
      (!q || it.searchKey.includes(q)) &&
      !(state.hideEnded && !it.isLive && now - it.start > ENDED_AFTER_MS));

    const byDay = new Map();
    for (const it of visible) {
      const key = dayKey(it.start);
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key).push(it);
    }

    const lists = new Map();
    const frag = document.createDocumentFragment();
    for (const [key, items] of byDay) {
      const section = document.createElement("section");
      const h = document.createElement("h2");
      h.className = "day-heading";
      const { text, rel } = dayHeading(key, todayKey);
      h.append(text);
      if (rel) {
        const tag = document.createElement("span");
        tag.className = "today";
        tag.textContent = rel;
        if (rel !== "今天") tag.style.background = "var(--muted)";
        h.append(tag);
      }
      const count = document.createElement("span");
      count.className = "count";
      count.textContent = `${items.length} 筆`;
      h.append(count);
      const list = document.createElement("ul");
      list.className = "list";
      for (const it of items) list.append(buildEntry(it, now));
      lists.set(key, list);
      section.append(h, list);
      frag.append(section);
    }
    const nowLine = insertNowLine(visible, lists, todayKey, now);
    els.days.replaceChildren(frag);
    els.empty.hidden = visible.length > 0;

    if (pendingScroll) {
      pendingScroll = false;
      if (nowLine && !state.query) requestAnimationFrame(() => scrollToNow(nowLine));
    }
  }

  // A "現在 HH:MM" row before the first stream that hasn't started yet.
  function insertNowLine(visible, lists, todayKey, now) {
    if (!lists.size) return null;
    const li = document.createElement("li");
    li.className = "now-line";
    const label = document.createElement("span");
    label.textContent = `現在 ${formatTime(new Date(now))}`;
    li.append(label);

    const index = visible.findIndex((it) => it.start > now);
    const next = index >= 0 ? visible[index] : null;
    const todayList = lists.get(todayKey);
    if (next && (dayKey(next.start) === todayKey || !todayList)) {
      // Entries are appended in the same order as `visible`, so count within the day.
      const nextKey = dayKey(next.start);
      const before = visible.slice(0, index).filter((it) => dayKey(it.start) === nextKey).length;
      const list = lists.get(nextKey);
      list.insertBefore(li, list.children[before] || null);
    } else {
      (todayList || [...lists.values()].pop()).append(li);
    }
    return li;
  }

  // Put the "now" row ~40% down the visible area, so the streams that just
  // started (usually the live ones) stay in view above it.
  function scrollToNow(el) {
    const stickyHeight = document.querySelector(".controls").offsetHeight;
    const context = (window.innerHeight - stickyHeight) * 0.4;
    const top = el.getBoundingClientRect().top + window.scrollY - stickyHeight - context;
    window.scrollTo({ top: Math.max(0, top), behavior: "instant" });
  }

  // --------------------------------------------------------------- events

  function bind() {
    els.tz.value = state.tz;
    els.hideEnded.checked = state.hideEnded;

    if ("scrollRestoration" in history) history.scrollRestoration = "manual";

    els.tz.addEventListener("change", () => { state.tz = els.tz.value; savePrefs(); pendingScroll = true; render(); });
    els.hideEnded.addEventListener("change", () => { state.hideEnded = els.hideEnded.checked; savePrefs(); pendingScroll = true; render(); });
    els.search.addEventListener("input", () => { state.query = els.search.value; render(); });
    els.groups.addEventListener("click", (e) => {
      const btn = e.target.closest(".chip");
      if (!btn) return;
      state.group = btn.dataset.group;
      for (const b of els.groups.querySelectorAll(".chip")) b.setAttribute("aria-pressed", String(b === btn));
      savePrefs();
      pendingScroll = true;
      render();
    });

    setInterval(load, REFRESH_MS);
    setInterval(() => { if (!document.hidden) render(); }, TICK_MS);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) return;
      if (Date.now() - lastLoad > REFRESH_MS) load(); else render();
    });
  }

  loadPrefs();
  bind();
  load();
})();
