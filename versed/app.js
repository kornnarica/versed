(() => {
  "use strict";
  const CFG = window.VERSED_CONFIG || {};
  const $ = (s) => document.querySelector(s);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };

  // ---------- helpers ----------
  const norm = (s) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\p{L}\p{N}]/gu, "");
  const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
  const dayNumber = (dateStr) => {
    const [y, m, d] = dateStr.split("-").map(Number);
    const [ly, lm, ld] = (CFG.LAUNCH_DATE || "2026-11-08").split("-").map(Number);
    return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(ly, lm - 1, ld)) / 86400000);
  };
  const looseEq = (a, b) => { const x = norm(a), y = norm(b); return x.includes(y) || y.includes(x); };

  async function getJSON(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Request failed (${r.status})`);
    return r.json();
  }

  // ---------- data sources ----------
  const LRCLIB = "https://lrclib.net/api";
  const usable = (x) => !x.instrumental && (x.syncedLyrics || x.plainLyrics);
  const rank = (list) => list.filter(usable).sort((a, b) => (!!b.syncedLyrics) - (!!a.syncedLyrics));

  async function findLyrics(title, artist) {
    const p = new URLSearchParams({ track_name: title, artist_name: artist });
    let list = rank(await getJSON(`${LRCLIB}/search?${p}`));
    if (!list.length) list = rank(await getJSON(`${LRCLIB}/search?${new URLSearchParams({ q: `${title} ${artist}` })}`));
    return list[0] || null;
  }

  function dedupe(list) {
    const seen = new Set(), out = [];
    for (const x of rank(list)) {
      const k = norm(x.trackName) + "|" + norm(x.artistName);
      if (!seen.has(k)) { seen.add(k); out.push(x); }
    }
    return out;
  }

  async function itunesLookup(title, artist) {
    try {
      const p = new URLSearchParams({ term: `${artist} ${title}`, entity: "song", limit: "10" });
      const d = await getJSON(`https://itunes.apple.com/search?${p}`);
      const res = d.results || [];
      return res.find((r) => looseEq(r.artistName, artist) && looseEq(r.trackName, title))
        || res.find((r) => looseEq(r.artistName, artist)) || null;
    } catch { return null; }
  }

  // ---------- parsing ----------
  function parseLyrics(rec) {
    const lines = [];
    if (rec.syncedLyrics) {
      const stamps = [];
      for (const raw of rec.syncedLyrics.split("\n")) {
        const tags = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
        if (!tags.length) continue;
        const text = raw.replace(/\[[^\]]*\]/g, "").trim();
        for (const t of tags) stamps.push({ t: +t[1] * 60 + +t[2], text });
      }
      stamps.sort((a, b) => a.t - b.t);
      stamps.forEach((s, i) => {
        if (!s.text) return;
        const next = stamps[i + 1];
        lines.push({ text: s.text, start: s.t, end: next ? next.t : Math.min(s.t + 6, rec.duration || s.t + 6) });
      });
    } else {
      for (const raw of rec.plainLyrics.split("\n")) {
        const text = raw.trim();
        if (text && !/^\[.*\]$/.test(text)) lines.push({ text, start: null, end: null });
      }
    }
    return lines.map((l) => ({
      ...l,
      words: l.text.split(/\s+/).filter(Boolean).map((raw) => ({ raw, n: norm(raw) })),
    }));
  }

  // ---------- state ----------
  let mode = "daily";
  let G = null; // current game
  let timerId = null;

  function newGame(rec, meta) {
    const lines = parseLyrics(rec);
    const index = new Map();
    let total = 0;
    lines.forEach((line) => line.words.forEach((w) => {
      if (!w.n) { w.on = true; return; }
      total++;
      if (!index.has(w.n)) index.set(w.n, []);
      index.get(w.n).push(w);
    }));
    return {
      ...meta, title: rec.trackName, artist: rec.artistName, synced: !!rec.syncedLyrics,
      lines, index, total, found: 0, foundSet: new Set(), secs: 0, started: false, ended: false,
    };
  }

  // ---------- rendering ----------
  function renderGame() {
    $("#game").classList.remove("hidden");
    $("#puzzle-no").textContent = G.daily ? `Daily #${G.puzzleNo} · ${G.date}` : (mode === "artist" ? "Artist mode" : "Free play");
    $("#song-title").textContent = G.title;
    $("#song-artist").textContent = G.artist;
    $("#total").textContent = G.total;

    const box = $("#lyrics");
    box.textContent = "";
    G.lines.forEach((line, li) => {
      const row = el("div", "line");
      const play = el("button", "line-play hidden", "▶");
      play.title = "Hear this part";
      play.setAttribute("aria-label", `Play line ${li + 1}`);
      play.addEventListener("click", () => playLine(li, play));
      row.append(play);
      const words = el("div", "words");
      line.words.forEach((w) => {
        const span = el("span", "w" + (w.on ? " on" : ""), w.raw);
        if (!w.on) span.style.minWidth = `${Math.max(1.4, w.raw.length * 0.62)}em`;
        w.el = span;
        words.append(span);
      });
      row.append(words);
      line.playBtn = play;
      box.append(row);
    });
    updateHud();
    updateLinePlayButtons();
  }

  function updateHud() {
    $("#found").textContent = G.found;
    $("#bar-fill").style.width = `${G.total ? (G.found / G.total) * 100 : 0}%`;
    $("#timer").textContent = fmtTime(G.secs);
    $("#in-guess").disabled = G.ended;
    $("#btn-giveup").disabled = G.ended;
  }

  function revealWord(n, silent) {
    const ws = G.index.get(n);
    if (!ws || G.foundSet.has(n)) return 0;
    G.foundSet.add(n);
    ws.forEach((w) => { w.on = true; w.el.classList.add("on"); });
    G.found += ws.length;
    if (!silent) { flash(`+${ws.length}`); updateHud(); saveProgress(); }
    if (G.found >= G.total && !G.ended) endGame(false);
    return ws.length;
  }

  function flash(text, bad) {
    const f = $("#flash");
    f.textContent = text;
    f.style.color = bad ? "var(--muted)" : "var(--green)";
    clearTimeout(flash.t);
    flash.t = setTimeout(() => (f.textContent = ""), 1200);
  }

  function startTimer() {
    if (G.started || G.ended) return;
    G.started = true;
    clearInterval(timerId);
    timerId = setInterval(() => { G.secs++; $("#timer").textContent = fmtTime(G.secs); if (G.secs % 5 === 0) saveProgress(); }, 1000);
  }

  // ---------- guessing ----------
  const guess = $("#in-guess");
  const isPrefixOfUnfound = (n) => {
    for (const k of G.index.keys()) if (k !== n && k.startsWith(n) && !G.foundSet.has(k)) return true;
    return false;
  };
  guess.addEventListener("input", () => {
    if (!G || G.ended) return;
    startTimer();
    const v = guess.value;
    const n = norm(v);
    const submitted = /\s$/.test(v);
    if (!n) { if (submitted) guess.value = ""; return; }
    if (G.index.has(n) && !G.foundSet.has(n) && (submitted || !isPrefixOfUnfound(n))) {
      revealWord(n); guess.value = "";
    } else if (submitted) {
      flash(G.foundSet.has(n) ? "Already found" : "Not in this song", true);
      guess.value = "";
    }
  });
  guess.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || !G || G.ended) return;
    const n = norm(guess.value);
    if (!n) return;
    if (G.index.has(n) && !G.foundSet.has(n)) revealWord(n);
    else flash(G.foundSet.has(n) ? "Already found" : "Not in this song", true);
    guess.value = "";
  });

  $("#btn-giveup").addEventListener("click", () => {
    if (!G || G.ended) return;
    if (G.found === 0 && !confirm("Give up and see the lyrics?")) return;
    endGame(true);
  });

  // ---------- ending & sharing ----------
  function lineScores() {
    return G.lines.map((l) => {
      const ws = l.words.filter((w) => w.n);
      return ws.length ? ws.filter((w) => G.foundSet.has(w.n)).length / ws.length : 1;
    });
  }
  function emojiGrid() {
    const scores = lineScores();
    const per = Math.ceil(scores.length / 30) || 1; // keep the grid to ~30 squares
    const sq = [];
    for (let i = 0; i < scores.length; i += per) {
      const chunk = scores.slice(i, i + per);
      const avg = chunk.reduce((a, b) => a + b, 0) / chunk.length;
      sq.push(avg >= 0.9 ? "🟩" : avg >= 0.5 ? "🟨" : "🟥");
    }
    const rows = [];
    for (let i = 0; i < sq.length; i += 6) rows.push(sq.slice(i, i + 6).join(""));
    return rows.join("\n");
  }
  const pct = () => (G.total ? Math.round((G.found / G.total) * 100) : 0);

  function endGame(gaveUp, restoring) {
    G.ended = true;
    clearInterval(timerId);
    G.lines.forEach((l) => l.words.forEach((w) => { if (!w.on) w.el.classList.add("missed"); }));
    updateHud();
    if (!restoring) { saveProgress(); if (G.daily) recordDailyStat(); }
    showResult(gaveUp);
  }

  function showResult() {
    const p = pct();
    $("#res-title").textContent = p === 100 ? "Perfect! 🎉" : p >= 75 ? "So close!" : p >= 40 ? "Not bad!" : "Keep listening 🎧";
    $("#res-score").textContent = `${p}%`;
    $("#res-detail").textContent = `${G.found} of ${G.total} words in ${fmtTime(G.secs)}`;
    $("#res-grid").textContent = emojiGrid();
    $("#res-next").textContent = G.daily ? "A new song arrives at midnight." : "";
    $("#dlg-result").showModal();
  }

  $("#btn-close-res").addEventListener("click", () => $("#dlg-result").close());
  $("#btn-share").addEventListener("click", async () => {
    const head = G.daily ? `Versed #${G.puzzleNo} 🎤 ${pct()}% (${fmtTime(G.secs)})` : `Versed 🎤 "${G.title}" by ${G.artist}: ${pct()}%`;
    const text = `${head}\n${emojiGrid()}\n${location.origin}${location.pathname}`;
    try {
      if (navigator.share && matchMedia("(pointer: coarse)").matches) await navigator.share({ text });
      else { await navigator.clipboard.writeText(text); $("#btn-share").textContent = "Copied!"; setTimeout(() => ($("#btn-share").textContent = "Share"), 1500); }
    } catch {}
  });

  // ---------- persistence ----------
  function saveProgress() {
    if (!G || !G.daily) return;
    store.set(`versed-day-${G.date}`, { found: [...G.foundSet], secs: G.secs, ended: G.ended });
  }
  function recordDailyStat() {
    const h = store.get("versed-history", {});
    h[G.date] = pct();
    store.set("versed-history", h);
  }
  function renderStats() {
    const h = store.get("versed-history", {});
    const days = Object.keys(h).sort();
    const avg = days.length ? Math.round(days.reduce((a, d) => a + h[d], 0) / days.length) : 0;
    const best = days.length ? Math.max(...days.map((d) => h[d])) : 0;
    const set = new Set(days.map(dayNumber));
    let streak = 0, n = dayNumber(todayStr());
    if (!set.has(n)) n--;
    while (set.has(n)) { streak++; n--; }
    let max = 0, run = 0, prev = null;
    [...set].sort((a, b) => a - b).forEach((d) => { run = prev === d - 1 ? run + 1 : 1; max = Math.max(max, run); prev = d; });
    const s = $("#stats");
    s.textContent = "";
    [[days.length, "Played"], [`${avg}%`, "Average"], [streak, "Streak"], [max, "Best streak"]].forEach(([v, l]) => {
      const c = el("div"); c.append(el("b", null, String(v)), el("span", null, l)); s.append(c);
    });
    if (best) s.after(Object.assign(el("p", "muted center", `Best score: ${best}%`), { id: "best-line" }));
  }
  $("#btn-stats").addEventListener("click", () => { $("#best-line")?.remove(); renderStats(); $("#dlg-stats").showModal(); });
  $("#btn-help").addEventListener("click", () => $("#dlg-help").showModal());

  // ---------- loading songs ----------
  function showLoading(on, msg) {
    $("#loading").textContent = msg || "Loading song…";
    $("#loading").classList.toggle("hidden", !on);
  }
  function showError(msg) {
    $("#error").textContent = msg || "";
    $("#error").classList.toggle("hidden", !msg);
  }

  async function startSong(rec, meta = {}) {
    stopAll();
    showError("");
    G = newGame(rec, meta);
    if (!G.total) { showError("This song has no lyrics to guess. Try another one."); return; }
    renderGame();
    resetYouTube();
    loadPreview();
    if (G.daily) {
      const saved = store.get(`versed-day-${G.date}`, null);
      if (saved) {
        saved.found.forEach((n) => revealWord(n, true));
        G.secs = saved.secs || 0;
        updateHud();
        if (saved.ended) endGame(false, true);
      }
    }
    if (!G.ended) guess.focus({ preventScroll: true });
  }

  async function loadDaily() {
    const date = todayStr();
    const num = dayNumber(date);
    const list = window.DAILY_SONGS;
    showLoading(true);
    $("#game").classList.add("hidden");
    // If a song can't be found, fall through to the next one so the day always has a puzzle.
    for (let k = 0; k < 5; k++) {
      const [title, artist] = list[(((num + k) % list.length) + list.length) % list.length];
      try {
        const rec = await findLyrics(title, artist);
        if (rec) { showLoading(false); if (mode === "daily") startSong(rec, { daily: true, date, puzzleNo: num + 1 }); return; }
      } catch (e) { if (k === 4) break; }
    }
    showLoading(false);
    showError("Couldn't load today's song. Check your connection and refresh.");
  }

  function renderResults(container, list, emptyMsg) {
    container.textContent = "";
    if (!list.length) { container.append(el("p", "muted", emptyMsg)); return; }
    list.forEach((rec) => {
      const b = el("button", "result");
      const left = el("span"); left.append(el("b", null, rec.trackName), document.createElement("br"), el("small", null, rec.artistName + (rec.albumName ? ` · ${rec.albumName}` : "")));
      b.append(left, el("small", null, rec.syncedLyrics ? "🎧 timed" : "text only"));
      b.addEventListener("click", () => { container.closest(".picker").classList.add("hidden"); startSong(rec); });
      container.append(b);
    });
  }

  $("#form-search").addEventListener("submit", async (e) => {
    e.preventDefault();
    const q = $("#in-search").value.trim();
    if (!q) return;
    const box = $("#search-results");
    box.textContent = "Searching…";
    try { renderResults(box, dedupe(await getJSON(`${LRCLIB}/search?${new URLSearchParams({ q })}`)).slice(0, 25), "No songs found. Try different words."); }
    catch { box.textContent = "Search failed. Try again in a moment."; }
  });

  $("#form-artist").addEventListener("submit", async (e) => {
    e.preventDefault();
    const a = $("#in-artist").value.trim();
    if (!a) return;
    const box = $("#artist-results");
    box.textContent = "Finding songs…";
    try {
      const d = await getJSON(`${LRCLIB}/search?${new URLSearchParams({ q: a })}`);
      const songs = dedupe(d).filter((x) => looseEq(x.artistName, a));
      box.textContent = "";
      if (songs.length) {
        const rnd = el("button", "btn", `🎲 Random ${songs[0].artistName} song`);
        rnd.addEventListener("click", () => { box.closest(".picker").classList.add("hidden"); startSong(songs[Math.floor(Math.random() * songs.length)]); });
        box.append(rnd);
        const holder = el("div", "results"); box.append(holder);
        renderResults(holder, songs, "");
      } else box.append(el("p", "muted", "No songs found for that artist. Check the spelling?"));
    } catch { box.textContent = "Search failed. Try again in a moment."; }
  });

  // ---------- modes ----------
  document.querySelectorAll(".modes button").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
  function setMode(m) {
    mode = m;
    document.querySelectorAll(".modes button").forEach((b) => b.classList.toggle("active", b.dataset.mode === m));
    stopAll();
    showError("");
    $("#game").classList.add("hidden");
    $("#picker-artist").classList.toggle("hidden", m !== "artist");
    $("#picker-search").classList.toggle("hidden", m !== "search");
    if (m === "daily") loadDaily();
    else $(m === "artist" ? "#in-artist" : "#in-search").focus();
  }

  // ---------- 30s preview ----------
  const audio = new Audio();
  const prevBtn = $("#btn-preview");
  async function loadPreview() {
    const g = G;
    prevBtn.disabled = true; prevBtn.textContent = "▶ 30s clip";
    $("#art").classList.add("hidden");
    const it = await itunesLookup(g.title, g.artist);
    if (g !== G || !it) { if (g === G) prevBtn.textContent = "No clip"; return; }
    if (it.artworkUrl100) { $("#art").src = it.artworkUrl100.replace("100x100", "300x300"); $("#art").classList.remove("hidden"); }
    if (it.previewUrl) { audio.src = it.previewUrl; prevBtn.disabled = false; }
  }
  prevBtn.addEventListener("click", () => {
    if (audio.paused) { stopLine(); audio.play(); prevBtn.textContent = "❚❚ Pause"; }
    else { audio.pause(); prevBtn.textContent = "▶ 30s clip"; }
  });
  audio.addEventListener("ended", () => (prevBtn.textContent = "▶ 30s clip"));

  // ---------- YouTube: play any line ----------
  let ytApi = null, player = null, ytReady = false, lineTimer = null, offset = 0;
  function loadYTApi() {
    if (ytApi) return ytApi;
    ytApi = new Promise((res) => {
      window.onYouTubeIframeAPIReady = () => res(window.YT);
      const s = document.createElement("script"); s.src = "https://www.youtube.com/iframe_api"; document.head.append(s);
    });
    return ytApi;
  }
  const ytId = (url) => {
    const m = String(url).match(/(?:youtu\.be\/|v=|\/embed\/|\/shorts\/|\/live\/)([\w-]{11})/) || String(url).match(/^([\w-]{11})$/);
    return m ? m[1] : null;
  };
  const ytKey = () => `versed-yt-${norm(G.title)}-${norm(G.artist)}`;

  function resetYouTube() {
    stopLine();
    if (player) { try { player.destroy(); } catch {} player = null; }
    ytReady = false;
    const wrap = $("#yt-player-wrap"); wrap.textContent = ""; wrap.append(Object.assign(el("div"), { id: "yt-player" }));
    $("#offset-row").classList.add("hidden");
    $("#yt-stage").classList.add("hidden");
    $("#yt-cover").classList.remove("hidden");
    $("#in-yt").value = "";
    offset = store.get(ytKey() + "-off", 0);
    $("#in-offset").value = offset; $("#offset-val").textContent = `${(+offset).toFixed(1)}s`;
    if (!G.synced) {
      $("#yt-status").textContent = "This version of the song has no line timings, so per-line playback isn't available. Use the 30s clip instead.";
      $("#form-yt").classList.add("hidden");
      return;
    }
    $("#form-yt").classList.remove("hidden");
    $("#yt-status").textContent = "Paste a YouTube link for this song and a ▶ button appears on every line, so you can replay that part.";
    const saved = store.get(ytKey(), null);
    if (saved) linkVideo(saved);
    else if (CFG.YOUTUBE_API_KEY) autoFindVideo();
  }

  async function autoFindVideo() {
    const g = G;
    $("#yt-status").textContent = "Finding the song on YouTube…";
    try {
      const p = new URLSearchParams({ part: "snippet", type: "video", maxResults: "1", videoEmbeddable: "true", q: `${g.artist} ${g.title} official audio`, key: CFG.YOUTUBE_API_KEY });
      const d = await getJSON(`https://www.googleapis.com/youtube/v3/search?${p}`);
      const id = d.items?.[0]?.id?.videoId;
      if (g === G && id) linkVideo(id);
      else if (g === G) $("#yt-status").textContent = "Couldn't find it automatically. Paste a YouTube link instead.";
    } catch { if (g === G) $("#yt-status").textContent = "Couldn't find it automatically. Paste a YouTube link instead."; }
  }

  async function linkVideo(id) {
    const g = G;
    const YT = await loadYTApi();
    if (g !== G) return;
    if (player) { player.loadVideoById({ videoId: id }); player.pauseVideo(); }
    else player = new YT.Player("yt-player", {
      videoId: id, width: 220, height: 124,
      playerVars: { playsinline: 1, cc_load_policy: 0, iv_load_policy: 3, rel: 0, modestbranding: 1 },
      events: { onReady: () => { ytReady = true; updateLinePlayButtons(); } },
    });
    store.set(ytKey(), id);
    $("#yt-status").textContent = "Linked! Press ▶ next to any line to hear that part. If it's off, drag the timing slider.";
    $("#offset-row").classList.remove("hidden");
    $("#yt-stage").classList.remove("hidden");
    updateLinePlayButtons();
  }
  $("#yt-cover").addEventListener("click", () => $("#yt-cover").classList.add("hidden"));

  $("#form-yt").addEventListener("submit", (e) => {
    e.preventDefault();
    const id = ytId($("#in-yt").value.trim());
    if (!id) { $("#yt-status").textContent = "That doesn't look like a YouTube link."; return; }
    linkVideo(id);
  });
  $("#in-offset").addEventListener("input", (e) => {
    offset = +e.target.value;
    $("#offset-val").textContent = `${offset.toFixed(1)}s`;
    store.set(ytKey() + "-off", offset);
  });

  function updateLinePlayButtons() {
    if (!G) return;
    const show = G.synced && ytReady;
    G.lines.forEach((l) => l.playBtn && l.playBtn.classList.toggle("hidden", !show));
  }

  function playLine(i, btn) {
    if (!player || !ytReady) return;
    const line = G.lines[i];
    const wasThis = btn.classList.contains("playing");
    stopLine();
    if (wasThis) return;
    audio.pause(); prevBtn.textContent = "▶ 30s clip";
    const start = Math.max(0, line.start + offset - 0.15);
    const end = line.end + offset + 0.25;
    player.seekTo(start, true);
    player.playVideo();
    btn.classList.add("playing"); btn.textContent = "■";
    lineTimer = setInterval(() => {
      const t = player.getCurrentTime?.() || 0;
      if (t >= end || t < start - 1) stopLine();
    }, 80);
  }
  function stopLine() {
    clearInterval(lineTimer); lineTimer = null;
    try { player && ytReady && player.pauseVideo(); } catch {}
    document.querySelectorAll(".line-play.playing").forEach((b) => { b.classList.remove("playing"); b.textContent = "▶"; });
  }
  function stopAll() { stopLine(); audio.pause(); prevBtn.textContent = "▶ 30s clip"; clearInterval(timerId); }

  // ---------- boot ----------
  if (!store.get("versed-seen-help", false)) { $("#dlg-help").showModal(); store.set("versed-seen-help", true); }
  setMode("daily");
})();
