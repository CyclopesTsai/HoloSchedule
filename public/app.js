// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CyclopesTsai
"use strict";

(() => {
  const DATA_URL = "data.json";
  const REFRESH_MS = 60 * 1000;       // re-fetch data.json (unchanged data is skipped)
  const LOAD_TIMEOUT_MS = 20 * 1000;  // give up on a hung data.json request
  const TICK_MS = 60 * 1000;          // re-render relative labels
  const STALE_MS = 60 * 60 * 1000;    // generated_at older than this → warning
  const SOON_MS = 60 * 60 * 1000;     // "即將開始" window
  const ENDED_AFTER_MS = 30 * 60 * 1000; // not live although started this long before the data snapshot → ended
  const STORAGE_KEY = "holoschedule:prefs";

  const GROUP_ORDER = ["hololive", "HOLOSTARS", "HOLOSTARS English", "mekPark", "COVER"];
  // Groups hidden until the user turns them on (⚙). Hidden groups are left out
  // everywhere, including 全部, and get no filter chip.
  const DEFAULT_HIDDEN_GROUPS = ["HOLOSTARS", "HOLOSTARS English"];
  const GROUP_COLOR = {
    "hololive": "var(--g-hololive)",
    "HOLOSTARS": "var(--g-holostars)",
    "HOLOSTARS English": "var(--g-holostars-english)",
    "mekPark": "var(--g-mekpark)",
    "COVER": "var(--g-cover)",
  };
  // Features being tried out, listed in ⚙ → 試驗性功能 as switches (off by
  // default). Entries: { key, label, note? }; check with experimentOn(key).
  // The section is hidden while this list is empty.
  const EXPERIMENTS = [];

  const TZ_LABEL = { "Asia/Taipei": "台北時間", "Asia/Tokyo": "東京時間", "local": "瀏覽器本地時間" };

  const $ = (id) => document.getElementById(id);
  const els = {
    status: $("status"),
    tz: $("tz"),
    groups: $("groups"),
    hideEnded: $("hide-ended"),
    mobileAppRow: $("mobile-app-row"),
    mobileApp: $("mobile-app"),
    player: $("player"),
    playerMember: $("player-member"),
    playerTitle: $("player-title"),
    playerYt: $("player-yt"),
    playerClose: $("player-close"),
    playerVideo: $("player-video"),
    playerChat: $("player-chat"),
    playerResizer: $("player-resizer"),
    playerStatus: $("player-status"),
    gear: $("chip-settings-btn"),
    chipSettings: $("chip-settings"),
    chipSettingsList: $("chip-settings-list"),
    expSection: $("exp-section"),
    expList: $("exp-list"),
    days: $("days"),
    empty: $("empty"),
    tpl: $("entry-tpl"),
  };

  const state = {
    data: null,          // { generatedAt: Date, items: [...] }
    loadError: null,
    tz: "Asia/Taipei",
    group: "all",
    hideEnded: false,
    mobileApp: true,     // touch devices: open YouTube (the app) instead of the side player
    playingId: null,
    playerWidth: null,   // px chosen by dragging; null = CSS default
    hiddenGroups: new Set(DEFAULT_HIDDEN_GROUPS),
    experiments: {},     // key → boolean, only keys listed in EXPERIMENTS
  };

  // Scroll to the first live stream (or "now") after the next render that has
  // data (initial load, or the view changed). Auto-refresh and the per-minute
  // tick never move the page.
  let pendingScroll = true;

  // ---------------------------------------------------------------- prefs

  function loadPrefs() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
      if (saved.tz in TZ_LABEL) state.tz = saved.tz;
      if (typeof saved.group === "string") state.group = saved.group;
      state.hideEnded = saved.hideEnded === true;
      if (typeof saved.mobileApp === "boolean") state.mobileApp = saved.mobileApp;
      if (Number.isFinite(saved.playerWidth)) state.playerWidth = saved.playerWidth;
      if (Array.isArray(saved.hiddenGroups)) state.hiddenGroups = new Set(saved.hiddenGroups.map(String));
      for (const { key } of EXPERIMENTS) {
        if (saved.experiments?.[key] === true) state.experiments[key] = true;
      }
    } catch (_) { /* storage unavailable: use defaults */ }
  }

  function savePrefs() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        tz: state.tz,
        group: state.group,
        hideEnded: state.hideEnded,
        mobileApp: state.mobileApp,
        playerWidth: state.playerWidth,
        hiddenGroups: [...state.hiddenGroups],
        experiments: state.experiments,
      }));
    } catch (_) { /* ignore */ }
  }

  // ----------------------------------------------------------------- time

  // Building an Intl.DateTimeFormat is ~35× slower than using one, and a render
  // formats every row several times, so keep one per (timezone, options).
  const formatters = new Map();

  function formatter(opts) {
    const key = state.tz + JSON.stringify(opts);
    let f = formatters.get(key);
    if (!f) {
      f = new Intl.DateTimeFormat("en-CA", state.tz === "local" ? opts : { ...opts, timeZone: state.tz });
      formatters.set(key, f);
    }
    return f;
  }

  function partsOf(date, opts) {
    const out = {};
    for (const p of formatter(opts).formatToParts(date)) out[p.type] = p.value;
    return out;
  }

  const DAY_OPTS = { year: "numeric", month: "2-digit", day: "2-digit" };
  const TIME_OPTS = { hour: "2-digit", minute: "2-digit", hourCycle: "h23" };
  const DATETIME_OPTS = { ...DAY_OPTS, ...TIME_OPTS };
  const MONTH_DAY_OPTS = { month: "numeric", day: "numeric" };
  const weekdayFormat = new Intl.DateTimeFormat("zh-TW", { weekday: "short", timeZone: "UTC" });

  function dayKey(date) {
    const p = partsOf(date, DAY_OPTS);
    return `${p.year}-${p.month}-${p.day}`;
  }

  function formatTime(date) {
    const p = partsOf(date, TIME_OPTS);
    return `${p.hour}:${p.minute}`;
  }

  function formatDateTime(date) {
    const p = partsOf(date, DATETIME_OPTS);
    return `${p.year}/${p.month}/${p.day} ${p.hour}:${p.minute}`;
  }

  // "YYYY-MM-DD" → UTC midnight ms, so calendar-day arithmetic ignores timezones.
  function keyToUTC(key) {
    const [y, m, d] = key.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  }

  function dayHeading(key, todayKey) {
    const [, m, d] = key.split("-").map(Number);
    const weekday = weekdayFormat.format(new Date(keyToUTC(key)));
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
        title: typeof it.title === "string" && it.title.trim() ? it.title.trim() : null,
      });
    }
    items.sort((a, b) => a.start - b.start);
    return { generatedAt: isNaN(generatedAt) ? null : generatedAt, items };
  }

  let loading = false;
  let lastLoad = 0;
  let lastGeneratedAt = null;

  async function load() {
    if (loading) return;
    loading = true;
    // Without a timeout, one request that never settles (e.g. across a
    // sleep/network change) would leave `loading` set and stop all refreshes.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), LOAD_TIMEOUT_MS);
    let changed = true;
    try {
      const res = await fetch(`${DATA_URL}?t=${Date.now()}`, { cache: "no-store", signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw = await res.json();
      lastLoad = Date.now();
      // Polled every minute but regenerated far less often: same snapshot,
      // nothing to rebuild (the per-minute tick keeps relative times fresh).
      if (state.data && !state.loadError && raw?.generated_at === lastGeneratedAt) {
        changed = false;
        return;
      }
      state.data = sanitize(raw);
      lastGeneratedAt = raw.generated_at;
      pruneEntries();
      pruneOverrides();
      state.loadError = null;
      renderGroups();
    } catch (err) {
      state.loadError = err.name === "AbortError" ? new Error("逾時") : err;
      console.error(err);
    } finally {
      clearTimeout(timer);
      loading = false;
      if (changed) render();
    }
  }

  // --------------------------------------------------------------- render

  // Known groups plus any new ones that show up in the data.
  function allGroups() {
    const names = new Set(GROUP_ORDER);
    for (const it of state.data?.items || []) names.add(it.group);
    return [...names].sort((a, b) => {
      const ia = GROUP_ORDER.indexOf(a), ib = GROUP_ORDER.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
    });
  }

  // Rebuilt on load and when ⚙ settings change.
  function renderGroups() {
    const groups = allGroups().filter((g) => !state.hiddenGroups.has(g));
    if (state.group !== "all" && !groups.includes(state.group)) {
      state.group = "all";
      savePrefs();
    }

    const frag = document.createDocumentFragment();
    for (const [value, label] of [["all", "全部"], ...groups.map((g) => [g, g])]) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip";
      b.dataset.group = value;
      b.textContent = label;
      b.setAttribute("aria-pressed", String(state.group === value));
      frag.append(b);
    }
    els.groups.replaceChildren(frag);
  }

  function experimentOn(key) {
    return state.experiments[key] === true;
  }

  function renderExperiments() {
    els.expSection.hidden = EXPERIMENTS.length === 0;
    const frag = document.createDocumentFragment();
    for (const { key, label, note } of EXPERIMENTS) {
      const row = document.createElement("label");
      row.className = "toggle setting";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.dataset.key = key;
      box.checked = experimentOn(key);
      const text = document.createElement("span");
      text.textContent = label;
      row.append(box, text);
      frag.append(row);
      if (note) {
        const p = document.createElement("p");
        p.className = "chip-settings-note";
        p.textContent = note;
        frag.append(p);
      }
    }
    els.expList.replaceChildren(frag);
  }

  function renderChipSettings() {
    const frag = document.createDocumentFragment();
    for (const g of allGroups()) {
      const label = document.createElement("label");
      label.className = "chip-option";
      label.style.setProperty("--group-color", GROUP_COLOR[g] || "var(--border)");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.value = g;
      box.checked = !state.hiddenGroups.has(g);
      const name = document.createElement("span");
      name.textContent = g;
      label.append(box, name);
      frag.append(label);
    }
    els.chipSettingsList.replaceChildren(frag);
  }

  function setChipSettingsOpen(open) {
    if (open) renderChipSettings();
    els.chipSettings.hidden = !open;
    els.gear.setAttribute("aria-expanded", String(open));
    // Focus the panel, not its first control: focusing a <select> opens the
    // picker on iOS. Tab from here reaches the controls.
    if (open) els.chipSettings.focus({ preventScroll: true });
  }

  function renderStatus(now) {
    const d = state.data;
    if (!d) {
      els.status.textContent = state.loadError ? `讀取失敗：${state.loadError.message}` : "讀取中…";
      els.status.classList.toggle("error", !!state.loadError);
      els.status.classList.remove("is-stale");
      els.status.removeAttribute("title");
      return;
    }
    let text = "最後更新：";
    text += d.generatedAt
      ? `${formatDateTime(d.generatedAt)}（${TZ_LABEL[state.tz]}，${relativeAgo(now - d.generatedAt)}）`
      : "未知";
    if (state.loadError) text += "　· 重新讀取失敗，顯示的是先前的資料";
    els.status.textContent = text;
    els.status.classList.toggle("error", !!state.loadError);
    // Over an hour old: colour the timestamp instead of showing a banner.
    const stale = d.generatedAt === null || now - d.generatedAt > STALE_MS;
    els.status.classList.toggle("is-stale", stale);
    if (stale) els.status.title = "資料超過 1 小時未更新，可能已過期，請以原站為準";
    else els.status.removeAttribute("title");
  }

  // Row nodes are reused across renders (filters, timezone, the per-minute
  // tick) and across data refreshes while their content is unchanged; only the
  // time-dependent parts are updated. Recreating rows made every thumbnail
  // reload and blink once a minute.
  const entryNodes = new Map(); // id → { node, sig }

  function entrySignature(it) {
    return [it.url, it.thumbnail, it.member, it.group, it.title].join("\u0000");
  }

  function entryFor(it) {
    const sig = entrySignature(it);
    let cached = entryNodes.get(it.id);
    if (!cached || cached.sig !== sig) {
      cached = { node: createEntry(it), sig };
      entryNodes.set(it.id, cached);
    }
    return cached.node;
  }

  // Drop rows for streams that are no longer in the data.
  function pruneEntries() {
    const ids = new Set(state.data.items.map((it) => it.id));
    for (const id of entryNodes.keys()) if (!ids.has(id)) entryNodes.delete(id);
  }

  function createEntry(it) {
    const node = els.tpl.content.firstElementChild.cloneNode(true);
    node.dataset.id = it.id;
    node.querySelector(".entry-link").href = it.url;

    const img = node.querySelector("img");
    if (it.thumbnail) {
      img.src = it.thumbnail;
      img.addEventListener("error", () => { img.remove(); node.querySelector(".thumb").classList.add("no-img"); }, { once: true });
    } else {
      img.remove();
      node.querySelector(".thumb").classList.add("no-img");
    }

    const member = node.querySelector(".member");
    member.textContent = it.member;
    member.title = it.member;
    const streamTitle = node.querySelector(".stream-title");
    if (it.title) {
      streamTitle.textContent = it.title;
      streamTitle.title = it.title;
    } else {
      streamTitle.remove();
    }
    const group = node.querySelector(".group");
    group.textContent = it.group;
    group.style.setProperty("--group-color", GROUP_COLOR[it.group] || "var(--border)");
    return node;
  }

  // live: the data marks it live. upcoming: start time still ahead.
  // pending: start time has passed but the data can't tell whether it is
  // running, because the snapshot (generated_at) was taken before the start or
  // within ENDED_AFTER_MS of it. ended: the snapshot was taken more than
  // ENDED_AFTER_MS after the start and it wasn't live then.
  // Judging "ended" against the snapshot rather than the clock means stale
  // data (e.g. a delayed update) never turns a running stream into "ended".
  function streamState(it, now) {
    const ov = overrideFor(it);
    if (ov && it.start <= now) return ov.live ? "live" : "ended";
    if (it.isLive) return "live";
    if (it.start > now) return "upcoming";
    const asOf = state.data?.generatedAt?.getTime() ?? now;
    return it.start.getTime() >= asOf - ENDED_AFTER_MS ? "pending" : "ended";
  }

  // Everything that depends on the clock or the selected timezone.
  function updateEntry(node, it, now, todayKey) {
    const st = streamState(it, now);
    const untilStart = it.start - now;
    const isSoon = st === "pending" || (st === "upcoming" && untilStart <= SOON_MS);
    node.classList.toggle("is-live", st === "live");
    node.classList.toggle("is-soon", isSoon);
    node.classList.toggle("is-ended", st === "ended");
    node.classList.toggle("is-playing", it.id === state.playingId);
    node.querySelector(".badge-soon").textContent =
      // Just past the start → probably about to begin; longer than that → the
      // data is too old to say.
      st === "pending" ? (now - it.start <= ENDED_AFTER_MS ? "即將開始" : "待確認") : isSoon ? `${Math.max(1, Math.ceil(untilStart / 60000))} 分鐘後` : "";

    const timeText = formatTime(it.start);
    const time = node.querySelector(".time");
    time.textContent = timeText;
    time.dateTime = it.start.toISOString();
    if ((st === "live" || st === "pending") && dayKey(it.start) !== todayKey) {
      // A live/pending stream that started on another day is listed under today.
      const day = document.createElement("small");
      day.className = "time-day";
      const p = partsOf(it.start, MONTH_DAY_OPTS);
      day.textContent = `${p.month}/${p.day}`;
      time.prepend(day);
    }

    const status = st === "live" ? "直播中，" : isSoon ? "即將開始，" : "";
    const titlePart = it.title ? `：${it.title}` : "";
    node.querySelector(".entry-link").setAttribute(
      "aria-label", `${status}${timeText} ${it.member}（${it.group}）${titlePart}，在 YouTube 開啟`);
    return node;
  }

  function render() {
    const now = Date.now();
    renderStatus(now);
    if (!state.data) return;

    // Groups turned off in ⚙ are dropped entirely. Past days are hidden; today's
    // ended streams stay. Live and pending streams always show, even if they
    // started yesterday.
    const todayKey = dayKey(new Date(now));
    const visible = state.data.items.filter((it) => {
      if (state.hiddenGroups.has(it.group)) return false;
      if (state.group !== "all" && it.group !== state.group) return false;
      const st = streamState(it, now);
      if (st === "ended") return !state.hideEnded && dayKey(it.start) >= todayKey;
      return st !== "upcoming" || dayKey(it.start) >= todayKey;
    });

    // Today's list reads: ended → live → pending → 現在 → upcoming. Live and
    // pending streams are pulled out of strict time order so an ended stream
    // never sits between two live ones and a late stream never sits above them.
    const NOW = Symbol("now");
    const days = new Map();
    const dayRows = (key) => {
      if (!days.has(key)) days.set(key, []);
      return days.get(key);
    };
    const live = [], pending = [], upcomingToday = [];
    for (const it of visible) {
      const st = streamState(it, now);
      const key = dayKey(it.start);
      if (st === "live") live.push(it);
      else if (st === "pending") pending.push(it);
      else if (st === "upcoming" && key === todayKey) upcomingToday.push(it);
      else dayRows(key).push(it);
    }
    if (live.length || pending.length || upcomingToday.length || days.has(todayKey)) {
      dayRows(todayKey).push(...live, ...pending, NOW, ...upcomingToday);
    } else if (days.size) {
      // Nothing today: mark "now" at the top of the next day.
      days.get([...days.keys()].sort()[0]).unshift(NOW);
    }

    let nowLine = null;
    const frag = document.createDocumentFragment();
    for (const key of [...days.keys()].sort()) {
      const rows = days.get(key);
      const section = document.createElement("section");
      const h = document.createElement("h2");
      h.className = "day-heading";
      const { text, rel } = dayHeading(key, todayKey);
      h.append(text);
      if (rel) {
        const tag = document.createElement("span");
        tag.className = "today";
        tag.textContent = rel;
        if (rel !== "今天") tag.classList.add("later");
        h.append(tag);
      }
      const count = document.createElement("span");
      count.className = "count";
      count.textContent = `${rows.filter((r) => r !== NOW).length} 筆`;
      h.append(count);
      const list = document.createElement("ul");
      list.className = "list";
      for (const row of rows) {
        if (row === NOW) list.append((nowLine = buildNowLine(now)));
        else list.append(updateEntry(entryFor(row), row, now, todayKey));
      }
      section.append(h, list);
      frag.append(section);
    }
    els.days.replaceChildren(frag);
    els.empty.hidden = visible.length > 0;

    if (pendingScroll) {
      pendingScroll = false;
      // Layout is read synchronously, so this works in background tabs too.
      const firstLive = els.days.querySelector(".entry.is-live");
      if (firstLive) scrollToTop(firstLive);
      else if (nowLine) scrollToNow(nowLine);
    }
  }

  function buildNowLine(now) {
    const li = document.createElement("li");
    li.className = "now-line";
    const label = document.createElement("span");
    label.textContent = `現在 ${formatTime(new Date(now))}`;
    li.append(label);
    return li;
  }

  // Scroll so `el` sits `offset` px below the pinned topbar.
  function scrollBelowTopbar(el, offset) {
    const stickyHeight = document.querySelector(".topbar").offsetHeight;
    const top = el.getBoundingClientRect().top + window.scrollY - stickyHeight - offset;
    // Plain (x, y) form: older Safari throws on behavior: "instant".
    window.scrollTo(0, Math.max(0, top));
  }

  // With streams live, start at the topmost one (the live block runs down to
  // the 現在 line).
  function scrollToTop(el) {
    scrollBelowTopbar(el, 8);
  }

  // Nothing live: put the "now" row ~40% down the visible area so the streams
  // that just finished stay in view above it.
  function scrollToNow(el) {
    const stickyHeight = document.querySelector(".topbar").offsetHeight;
    scrollBelowTopbar(el, (window.innerHeight - stickyHeight) * 0.4);
  }

  // ------------------------------------------------------- side player

  const VIDEO_ID_RE = /^[\w-]{11}$/;

  function makeFrame(src, title, allow) {
    const f = document.createElement("iframe");
    f.src = src;
    f.title = title;
    if (allow) f.allow = allow;
    f.referrerPolicy = "strict-origin-when-cross-origin";
    return f;
  }

  function playerNote(text) {
    const p = document.createElement("p");
    p.className = "player-note";
    p.textContent = text;
    return p;
  }

  function openPlayer(it) {
    if (!VIDEO_ID_RE.test(it.id)) return;
    const id = it.id;
    state.playingId = id;
    els.playerMember.textContent = it.member;
    els.playerTitle.textContent = it.title || "";
    els.playerTitle.title = it.title || "";
    els.playerYt.href = it.url;

    stopPlayer();
    const token = playerToken;
    setPlayerStatus("確認 YouTube 狀態中…");
    const holder = document.createElement("div");
    els.playerVideo.replaceChildren(holder);
    loadYouTubeApi().then((YT) => {
      if (token !== playerToken) return;
      // youtube.com (not youtube-nocookie.com): same site as the chat, so one
      // YouTube login covers both.
      ytPlayer = new YT.Player(holder, {
        videoId: id,
        playerVars: { autoplay: 1, rel: 0, playsinline: 1 },
        events: {
          onReady: () => watchStatus(it, token),
          onError: (e) => onPlayerError(e.data, token),
        },
      });
    }).catch(() => {
      if (token !== playerToken) return;
      // No IFrame API: plain embed, no status check.
      els.playerVideo.replaceChildren(makeFrame(
        `https://www.youtube.com/embed/${id}?autoplay=1&rel=0`,
        `${it.member} 的直播`,
        "autoplay; encrypted-media; picture-in-picture; fullscreen",
      ));
      setPlayerStatus("");
    });

    if (streamState(it, Date.now()) === "ended") {
      els.playerChat.replaceChildren(playerNote("直播已結束，無法嵌入聊天室。"));
    } else {
      loadChat(it);
    }

    els.player.hidden = false;
    document.body.classList.add("player-open");
    render();
    // The list got narrower; keep the clicked row in view.
    els.days.querySelector(`.entry[data-id="${id}"]`)?.scrollIntoView({ block: "nearest" });
  }

  // YouTube only frames live chat for the domain named in embed_domain.
  function loadChat(it) {
    const host = location.hostname;
    if (!host) {
      els.playerChat.replaceChildren(playerNote("此環境無法嵌入聊天室。"));
      return;
    }
    els.playerChat.replaceChildren(makeFrame(
      `https://www.youtube.com/live_chat?v=${it.id}&embed_domain=${encodeURIComponent(host)}`,
      `${it.member} 的聊天室`,
    ));
  }

  // ------------------------------------- live status check in the player
  // When a stream is opened, the IFrame Player API reports what YouTube knows
  // about it. The fields used are undocumented, so this is best effort: a
  // verdict is only taken when two polls a second apart agree, and anything
  // unclear leaves the data alone. Observed (2026-10):
  //   live      isLive && isManifestless, duration 0
  //   upcoming  isLive && !isManifestless, duration 0
  //   ended     !isLive, duration > 0 (the archive's length)
  //   unplayable  isPlayable === false (errorCode "auth") or player error
  //               101/150 — e.g. members-only for a non-member, age-restricted
  //               or embedding disabled; the embed can't tell these apart.
  // Verdicts override the data in this browser only, until data.json is
  // regenerated after the check (or OVERRIDE_TTL_MS passes).

  const OVERRIDE_KEY = "holoschedule:overrides";
  const OVERRIDE_TTL_MS = 6 * 60 * 60 * 1000;
  const STATUS_POLL_MS = 1000;
  const STATUS_MAX_POLLS = 20;
  let overrides = new Map(); // id → { live: boolean, at: ms }
  let ytApi = null;
  let ytPlayer = null;
  let statusTimer = null;
  let playerToken = 0; // bumps on every open/close so stale callbacks bail out

  function loadOverrides() {
    try {
      const raw = JSON.parse(localStorage.getItem(OVERRIDE_KEY) || "{}");
      for (const [id, v] of Object.entries(raw)) {
        if (v && typeof v.live === "boolean" && Number.isFinite(v.at)) overrides.set(id, v);
      }
    } catch (_) { /* ignore */ }
  }

  function saveOverrides() {
    try {
      localStorage.setItem(OVERRIDE_KEY, JSON.stringify(Object.fromEntries(overrides)));
    } catch (_) { /* ignore */ }
  }

  function pruneOverrides() {
    const dataAt = state.data?.generatedAt?.getTime() ?? 0;
    const cutoff = Date.now() - OVERRIDE_TTL_MS;
    let changed = false;
    for (const [id, v] of overrides) {
      if (v.at <= dataAt || v.at < cutoff) { overrides.delete(id); changed = true; }
    }
    if (changed) saveOverrides();
  }

  function overrideFor(it) {
    const v = overrides.get(it.id);
    if (!v) return null;
    if (v.at <= (state.data?.generatedAt?.getTime() ?? 0) || v.at < Date.now() - OVERRIDE_TTL_MS) return null;
    return v;
  }

  function loadYouTubeApi() {
    if (window.YT?.Player) return Promise.resolve(window.YT);
    if (!ytApi) {
      ytApi = new Promise((resolve, reject) => {
        const prev = window.onYouTubeIframeAPIReady;
        window.onYouTubeIframeAPIReady = () => { prev?.(); resolve(window.YT); };
        const s = document.createElement("script");
        s.src = "https://www.youtube.com/iframe_api";
        s.onerror = reject;
        document.head.append(s);
        setTimeout(() => reject(new Error("YouTube IFrame API timeout")), 10000);
      }).catch((e) => { ytApi = null; throw e; });
    }
    return ytApi;
  }

  function setPlayerStatus(text) {
    els.playerStatus.textContent = text;
    els.playerStatus.hidden = !text;
  }

  function classify(id) {
    try {
      const vd = ytPlayer?.getVideoData?.();
      if (!vd || vd.video_id !== id) return null;
      if (vd.isPlayable === false || vd.errorCode) return "unplayable";
      const duration = ytPlayer.getDuration?.() || 0;
      if (vd.isLive && vd.isManifestless) return "live";
      if (vd.isLive) return "upcoming";
      if (duration > 0) return "ended";
    } catch (_) { /* player not ready */ }
    return null;
  }

  function watchStatus(it, token) {
    // A late onReady from a player that was already replaced must not touch
    // the current player's timer.
    if (token !== playerToken) return;
    let last = null;
    let polls = 0;
    clearInterval(statusTimer);
    statusTimer = setInterval(() => {
      if (token !== playerToken) { clearInterval(statusTimer); return; }
      const verdict = classify(it.id);
      if (verdict && verdict === last) {
        clearInterval(statusTimer);
        applyVerdict(it, verdict);
        return;
      }
      last = verdict;
      if (++polls >= STATUS_MAX_POLLS) {
        clearInterval(statusTimer);
        setPlayerStatus("無法確認 YouTube 狀態");
      }
    }, STATUS_POLL_MS);
  }

  const UNPLAYABLE_TEXT = "無法在這裡播放：可能為會員限定或不允許嵌入，請點「YouTube ↗」觀看";

  function showUnplayable(text) {
    setPlayerStatus(text);
    els.playerYt.classList.add("is-primary");
  }

  // YouTube player errors: 100 not found/private, 101/150 not embeddable
  // (members-only streams for non-members land here too), 2/5 bad request.
  function onPlayerError(code, token) {
    if (token !== playerToken) return;
    clearInterval(statusTimer);
    if (code === 101 || code === 150) showUnplayable(UNPLAYABLE_TEXT);
    else if (code === 100) showUnplayable("影片不存在或已設為私人");
    else showUnplayable(`播放器發生錯誤（代碼 ${code}），請點「YouTube ↗」觀看`);
  }

  function applyVerdict(it, verdict) {
    if (verdict === "unplayable") {
      showUnplayable(UNPLAYABLE_TEXT);
      return; // says nothing about whether it is live
    }
    setPlayerStatus({ live: "YouTube 狀態：直播中", ended: "YouTube 狀態：已結束", upcoming: "YouTube 狀態：尚未開始" }[verdict]);
    if (verdict === "upcoming" || it.start > Date.now()) return;
    const live = verdict === "live";
    const before = streamState(it, Date.now());
    overrides.set(it.id, { live, at: Date.now() });
    saveOverrides();
    if (live && before === "ended") loadChat(it); // chat was skipped as "ended"
    if (streamState(it, Date.now()) !== before) render();
  }

  // Tears down the current video/status check (not the panel itself).
  function stopPlayer() {
    playerToken++;
    clearInterval(statusTimer);
    try { ytPlayer?.destroy(); } catch (_) { /* ignore */ }
    ytPlayer = null;
    setPlayerStatus("");
    els.playerYt.classList.remove("is-primary");
  }

  // Player width: dragged/keyed by the user, kept within what leaves the list usable.
  const PLAYER_MIN_W = 320;
  const LIST_MIN_W = 420;

  function clampPlayerWidth(w) {
    const max = Math.max(PLAYER_MIN_W, Math.min(window.innerWidth - LIST_MIN_W, window.innerWidth * 0.75));
    return Math.round(Math.min(Math.max(w, PLAYER_MIN_W), max));
  }

  function applyPlayerWidth() {
    const root = document.documentElement.style;
    if (state.playerWidth === null) root.removeProperty("--player-w");
    else root.setProperty("--player-w", `${clampPlayerWidth(state.playerWidth)}px`);
  }

  function bindPlayerResizer() {
    const handle = els.playerResizer;
    handle.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      // Iframes would swallow pointer events mid-drag; .resizing disables them.
      document.body.classList.add("resizing");
    });
    handle.addEventListener("pointermove", (e) => {
      if (!handle.hasPointerCapture(e.pointerId)) return;
      state.playerWidth = clampPlayerWidth(window.innerWidth - e.clientX);
      applyPlayerWidth();
    });
    const stop = (e) => {
      if (!handle.hasPointerCapture(e.pointerId)) return;
      handle.releasePointerCapture(e.pointerId);
      document.body.classList.remove("resizing");
      savePrefs();
    };
    handle.addEventListener("pointerup", stop);
    handle.addEventListener("pointercancel", stop);
    handle.addEventListener("dblclick", () => {
      state.playerWidth = null;
      applyPlayerWidth();
      savePrefs();
    });
    handle.addEventListener("keydown", (e) => {
      const step = e.shiftKey ? 80 : 20;
      const current = els.player.getBoundingClientRect().width;
      if (e.key === "ArrowLeft") state.playerWidth = clampPlayerWidth(current + step);
      else if (e.key === "ArrowRight") state.playerWidth = clampPlayerWidth(current - step);
      else return;
      e.preventDefault();
      applyPlayerWidth();
      savePrefs();
    });
    window.addEventListener("resize", applyPlayerWidth);
  }

  function closePlayer() {
    if (state.playingId === null) return;
    state.playingId = null;
    stopPlayer();
    els.playerVideo.replaceChildren();
    els.playerChat.replaceChildren();
    els.player.hidden = true;
    document.body.classList.remove("player-open");
    render();
  }

  // Touch-first device (phone/tablet): no hover and a coarse pointer.
  function isMobileDevice() {
    return window.matchMedia("(hover: none) and (pointer: coarse)").matches;
  }

  // ------------------------------------------------------ pull to refresh
  // Safari has its own pull-to-refresh, but a page opened from the home
  // screen (standalone) doesn't, so provide one there only.

  const PTR_THRESHOLD = 70; // px of indicator travel needed to trigger
  const PTR_MAX = 110;

  function isStandalone() {
    return navigator.standalone === true || window.matchMedia("(display-mode: standalone)").matches;
  }

  function bindPullToRefresh() {
    const ptr = $("ptr");
    const text = ptr.querySelector(".ptr-text");
    let startY = null;
    let pull = 0;

    const reset = () => {
      pull = 0;
      ptr.classList.remove("is-pulling", "is-ready");
      ptr.style.transform = "";
    };

    document.addEventListener("touchstart", (e) => {
      startY = null;
      if (!isStandalone() || ptr.classList.contains("is-refreshing")) return;
      // Only from the very top, one finger, with no overlay open.
      if (window.scrollY > 0 || e.touches.length !== 1 || !els.player.hidden || !els.chipSettings.hidden) return;
      startY = e.touches[0].clientY;
      ptr.style.top = `${document.querySelector(".topbar").offsetHeight}px`;
    }, { passive: true });

    document.addEventListener("touchmove", (e) => {
      if (startY === null) return;
      const dy = e.touches[0].clientY - startY;
      if (dy <= 0 || window.scrollY > 0) { // scrolling the list, not pulling
        if (pull) reset();
        return;
      }
      e.preventDefault(); // no rubber-band while pulling
      pull = Math.min(PTR_MAX, dy * 0.5);
      const ready = pull >= PTR_THRESHOLD;
      ptr.classList.add("is-pulling");
      ptr.classList.toggle("is-ready", ready);
      ptr.style.transform = `translateY(${pull}px)`;
      text.textContent = ready ? "放開以重新整理" : "下拉以重新整理";
    }, { passive: false });

    document.addEventListener("touchend", () => {
      if (startY === null) return;
      startY = null;
      if (pull < PTR_THRESHOLD) { reset(); return; }
      ptr.classList.remove("is-pulling");
      ptr.classList.add("is-refreshing");
      ptr.style.transform = `translateY(${PTR_THRESHOLD}px)`;
      text.textContent = "重新整理中…";
      location.reload(); // fresh data and, after a deploy, fresh code
    });

    document.addEventListener("touchcancel", () => { startY = null; reset(); });
  }

  // --------------------------------------------------------------- events

  function bind() {
    els.tz.value = state.tz;
    els.hideEnded.checked = state.hideEnded;
    els.mobileApp.checked = state.mobileApp;
    els.mobileAppRow.hidden = !isMobileDevice();
    renderExperiments();
    applyPlayerWidth();
    bindPlayerResizer();

    if ("scrollRestoration" in history) history.scrollRestoration = "manual";

    els.tz.addEventListener("change", () => { state.tz = els.tz.value; savePrefs(); pendingScroll = true; render(); });
    els.days.addEventListener("click", (e) => {
      if (!state.data) return;
      const link = e.target.closest(".entry-link");
      // Modified clicks keep the browser's own behaviour (new tab/window).
      if (!link || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      // On phones/tablets let the link through: iOS/Android hand youtube.com
      // links to the YouTube app. (The live-status check needs the side player,
      // so it doesn't run in this mode.)
      if (state.mobileApp && isMobileDevice()) return;
      const it = state.data.items.find((x) => x.id === link.closest(".entry").dataset.id);
      if (!it) return;
      e.preventDefault();
      if (it.id !== state.playingId) openPlayer(it);
    });
    els.playerClose.addEventListener("click", closePlayer);
    els.mobileApp.addEventListener("change", () => { state.mobileApp = els.mobileApp.checked; savePrefs(); });
    els.hideEnded.addEventListener("change", () => { state.hideEnded = els.hideEnded.checked; savePrefs(); pendingScroll = true; render(); });
    els.groups.addEventListener("click", (e) => {
      const btn = e.target.closest(".chip");
      if (!btn) return;
      state.group = btn.dataset.group;
      for (const b of els.groups.querySelectorAll(".chip")) b.setAttribute("aria-pressed", String(b === btn));
      savePrefs();
      pendingScroll = true;
      render();
    });

    els.gear.addEventListener("click", () => setChipSettingsOpen(els.chipSettings.hidden));
    els.expList.addEventListener("change", (e) => {
      const key = e.target.dataset.key;
      if (!key) return;
      if (e.target.checked) state.experiments[key] = true;
      else delete state.experiments[key];
      savePrefs();
      render();
    });
    els.chipSettingsList.addEventListener("change", (e) => {
      const box = e.target;
      if (box.checked) state.hiddenGroups.delete(box.value);
      else state.hiddenGroups.add(box.value);
      savePrefs();
      if (state.data) {
        renderGroups();
        render();
      }
    });
    document.addEventListener("click", (e) => {
      if (!els.chipSettings.hidden && !els.chipSettings.contains(e.target) && !els.gear.contains(e.target)) {
        setChipSettingsOpen(false);
      }
    });
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (!els.chipSettings.hidden) {
        setChipSettingsOpen(false);
        els.gear.focus();
      } else if (state.playingId !== null) {
        closePlayer();
      }
    });

    // Hidden tabs neither fetch nor render; visibilitychange catches up.
    setInterval(() => { if (!document.hidden) load(); }, REFRESH_MS);
    setInterval(() => { if (!document.hidden) render(); }, TICK_MS);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) return;
      if (Date.now() - lastLoad > REFRESH_MS) load(); else render();
    });
  }

  loadPrefs();
  loadOverrides();
  if (isStandalone()) document.documentElement.classList.add("standalone");
  bindPullToRefresh();
  bind();
  load();
})();
