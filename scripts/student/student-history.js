// Focus history view: summary stats, a focus-time chart, plain-language insights and the
// session list, all for the chosen range (7 days, 30 days or all time). Reads the student's
// saved attention_sessions, and a session's attention_samples when it is opened.
// Saving happens in student-focus.js, which fires "neurofocus:history-saved" afterwards.

const app = await window.neuroFocusReady;

if (app) {
  const $ = (selector) => document.querySelector(selector);
  const PAGE_SIZE = 12;
  const MIN_SESSIONS_FOR_INSIGHTS = 3;
  const SAMPLE_SECONDS = 5; // attention_samples are 5-second windows
  const rangeKey = `neuroFocusHistoryRange:${app.user.id}`;
  const missingTables = (error) => error && (error.code === "PGRST205" || error.code === "42P01" || /attention_sessions|attention_samples/.test(error.message || ""));

  let sessions = []; // newest first
  let range = "7";
  let shown = PAGE_SIZE;
  let chart = null;
  const openSessions = new Set();
  const sampleCache = new Map();
  try { if (["7", "30", "all"].includes(localStorage.getItem(rangeKey))) range = localStorage.getItem(rangeKey); } catch { /* storage unavailable */ }

  // ---------- Small helpers ----------
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const svgUse = (id, className = "icon") => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", className);
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", `#${id}`);
    svg.append(use);
    return svg;
  };
  const startOfDay = (date) => { const d = new Date(date); d.setHours(0, 0, 0, 0); return d; };
  const addDays = (date, days) => { const d = new Date(date); d.setDate(d.getDate() + days); return d; };
  const startOfWeek = (date) => { const d = startOfDay(date); return addDays(d, -((d.getDay() + 6) % 7)); }; // Monday
  const dayKey = (date) => startOfDay(date).toDateString();
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

  // "40s", "24m", "1h 20m"
  function duration(seconds) {
    if (seconds < 60) return `${Math.round(seconds)}s`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    return `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`;
  }
  // Streaks read like a stopwatch: "6:12"
  const clock = (seconds) => {
    const s = Math.floor(seconds);
    return s >= 3600 ? duration(s) : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };
  const time = (date) => new Date(date).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const shortDate = (date) => new Date(date).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });

  function dayTitle(date) {
    const key = dayKey(date);
    if (key === dayKey(new Date())) return "Today";
    if (key === dayKey(addDays(new Date(), -1))) return "Yesterday";
    const d = new Date(date);
    return d.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric", ...(d.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}) });
  }

  const hasFocus = (s) => s.focus_percent !== null && s.focus_percent !== undefined;
  const focusedSeconds = (s) => (hasFocus(s) ? (s.tracked_seconds * s.focus_percent) / 100 : 0);
  const sum = (list, fn) => list.reduce((total, item) => total + fn(item), 0);
  // Average focus weighted by how long each session was, so a 1-minute session doesn't count like a 40-minute one.
  function averageFocus(list) {
    const scored = list.filter(hasFocus);
    const tracked = sum(scored, (s) => s.tracked_seconds);
    return tracked ? Math.round(sum(scored, focusedSeconds) / tracked * 100) : null;
  }

  const LEVELS = [
    { min: 80, key: "great", label: "Great focus", color: "#22c55e" },
    { min: 60, key: "good", label: "Good focus", color: "#00d9ff" },
    { min: 40, key: "mixed", label: "Up and down", color: "#f5b748" },
    { min: 0, key: "tough", label: "Hard to focus", color: "#ef4444" }
  ];
  const levelFor = (pct) => LEVELS.find((level) => pct >= level.min);

  // ---------- Range ----------
  function rangeInfo() {
    const today = startOfDay(new Date());
    if (range === "all") {
      const oldest = sessions.length ? startOfDay(sessions[sessions.length - 1].started_at) : today;
      return { start: oldest, days: Math.round((today - oldest) / 86400000) + 1, prevStart: null, phrase: "in total", compare: null };
    }
    const days = Number(range);
    const start = addDays(today, -(days - 1));
    return { start, days, prevStart: addDays(start, -days), phrase: `in the last ${days} days`, compare: days === 7 ? "previous week" : "previous 30 days" };
  }
  const between = (list, from, to) => list.filter((s) => { const t = new Date(s.started_at); return t >= from && (!to || t < to); });

  // ---------- Summary stats ----------
  function delta(value, unit, label) {
    const span = el("span", `delta ${value > 0 ? "up" : value < 0 ? "down" : ""}`);
    span.textContent = value === 0 ? `No change vs ${label}` : `${value > 0 ? "▲" : "▼"} ${unit(Math.abs(value))} vs ${label}`;
    return span;
  }

  function dayStreaks() {
    const days = new Set(sessions.map((s) => dayKey(s.started_at)));
    let cursor = startOfDay(new Date());
    if (!days.has(cursor.toDateString())) cursor = addDays(cursor, -1);
    let current = 0;
    while (days.has(cursor.toDateString())) { current += 1; cursor = addDays(cursor, -1); }
    const sorted = [...days].map((d) => new Date(d)).sort((a, b) => a - b);
    let best = 0;
    let run = 0;
    sorted.forEach((d, i) => {
      run = i && Math.round((d - sorted[i - 1]) / 86400000) === 1 ? run + 1 : 1;
      best = Math.max(best, run);
    });
    return { current, best, studiedToday: days.has(dayKey(new Date())) };
  }

  function renderStats(current, previous, info) {
    const focused = sum(current, focusedSeconds);
    const avg = averageFocus(current);
    const hasPrev = info.compare && previous.length > 0;

    $("#hsFocusTime").textContent = current.length ? duration(focused) : "0m";
    const timeNote = $("#hsFocusTimeNote");
    if (hasPrev && current.length) timeNote.replaceChildren(delta(Math.round((focused - sum(previous, focusedSeconds)) / 60) * 60, duration, info.compare));
    else timeNote.textContent = current.length ? `Across ${plural(current.length, "session")}` : `No sessions ${info.phrase}`;

    $("#hsAverage").textContent = avg === null ? "—" : `${avg}%`;
    const avgNote = $("#hsAverageNote");
    const prevAvg = hasPrev ? averageFocus(previous) : null;
    if (avg !== null && prevAvg !== null) avgNote.replaceChildren(delta(avg - prevAvg, (n) => `${n} pts`, info.compare));
    else avgNote.textContent = avg === null ? "Time spent looking at your work" : levelFor(avg).label;

    const best = current.reduce((top, s) => (!top || s.best_streak_seconds > top.best_streak_seconds ? s : top), null);
    $("#hsStreak").textContent = best && best.best_streak_seconds ? clock(best.best_streak_seconds) : "—";
    $("#hsStreakNote").textContent = best && best.best_streak_seconds ? `Focused without a break · ${shortDate(best.started_at)}` : "Your longest focused stretch";

    const streak = dayStreaks();
    $("#hsDays").textContent = plural(streak.current, "day");
    const activeDays = new Set(current.map((s) => dayKey(s.started_at))).size;
    $("#hsDaysNote").textContent = streak.current && !streak.studiedToday
      ? "Do a session today to keep it going"
      : range === "all" ? `Best run: ${plural(streak.best, "day")}` : `Studied ${activeDays} of the last ${info.days} days`;
  }

  // ---------- Focus time chart ----------
  function buckets(current, info) {
    const list = [];
    const weekly = range === "all" && info.days > 45;
    let cursor = weekly ? startOfWeek(info.start) : new Date(info.start);
    const today = startOfDay(new Date());
    if (weekly && (today - cursor) / 86400000 > 26 * 7) cursor = addDays(startOfWeek(today), -25 * 7);
    while (cursor <= today) {
      const next = addDays(cursor, weekly ? 7 : 1);
      const items = between(current, cursor, next);
      const d = new Date(cursor);
      list.push({
        label: weekly || info.days > 7 ? d.toLocaleDateString([], { month: "short", day: "numeric" }) : d.toLocaleDateString([], { weekday: "short" }),
        title: weekly ? `Week of ${d.toLocaleDateString([], { month: "short", day: "numeric" })}` : d.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" }),
        minutes: Math.round(sum(items, focusedSeconds) / 6) / 10,
        avg: averageFocus(items),
        count: items.length
      });
      cursor = next;
    }
    return { list, weekly };
  }

  function renderChart(current, info) {
    const { list, weekly } = buckets(current, info);
    $("#dailyChartName").textContent = weekly ? "Focus time per week" : "Focus time per day";
    $("#dailyFocusEmpty").hidden = current.length > 0;
    const canvas = $("#dailyFocusChart");
    const total = sum(current, focusedSeconds);
    canvas.setAttribute("aria-label", `Focus time per ${weekly ? "week" : "day"}: ${duration(total)} ${info.phrase}. Full details are in the session list below.`);
    if (!window.Chart) {
      $("#dailyFocusEmpty").hidden = false;
      $("#dailyFocusEmpty").textContent = "Chart library could not load. Check your internet connection and refresh.";
      return;
    }
    const data = list.map((b) => (b.minutes > 0 ? b.minutes : null));
    // Round axis steps: 5m, 15m, 30m or whole hours.
    const top = Math.max(10, ...list.map((b) => b.minutes));
    const stepSize = top <= 20 ? 5 : top <= 60 ? 15 : top <= 180 ? 30 : 60;
    if (chart) {
      chart.options.scales.y.ticks.stepSize = stepSize;
      chart.data.labels = list.map((b) => b.label);
      chart.data.datasets[0].data = data;
      chart.$buckets = list;
      chart.update();
      return;
    }
    const muted = "#82828c";
    chart = new window.Chart(canvas, {
      type: "bar",
      data: {
        labels: list.map((b) => b.label),
        datasets: [{
          label: "Minutes focused", data,
          backgroundColor: "rgba(0, 217, 255, 0.78)", hoverBackgroundColor: "#00d9ff",
          maxBarThickness: 24, borderRadius: { topLeft: 4, topRight: 4 }, borderSkipped: false
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        scales: {
          y: {
            beginAtZero: true, suggestedMax: 10, grid: { color: "#1c1c20" }, border: { display: false },
            ticks: { color: muted, stepSize, maxTicksLimit: 6, callback: (v) => (v ? duration(v * 60) : "0") }
          },
          x: { grid: { display: false }, border: { color: "#222226" }, ticks: { color: muted, maxRotation: 0, autoSkipPadding: 12 } }
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: "#17171b", borderColor: "#2e2e34", borderWidth: 1, padding: 10, displayColors: false,
            titleColor: "#f4f4f5", bodyColor: "#b4b4bc",
            callbacks: {
              title: (items) => chart.$buckets[items[0].dataIndex].title,
              label: (item) => {
                const b = chart.$buckets[item.dataIndex];
                return [`${duration(b.minutes * 60)} focused`, `${b.avg}% average focus`, plural(b.count, "session")];
              }
            }
          }
        }
      }
    });
    chart.$buckets = list;
  }

  // ---------- Insights ----------
  const TIMES = [
    { key: "morning", from: 5, to: 12, phrase: "in the morning" },
    { key: "afternoon", from: 12, to: 17, phrase: "in the afternoon" },
    { key: "evening", from: 17, to: 21, phrase: "in the evening" },
    { key: "night", from: 21, to: 29, phrase: "late at night" }
  ];
  const LENGTHS = [
    { max: 15 * 60, phrase: "sessions under 15 minutes", title: "Shorter sessions work best for you", tip: "Short focus-timer blocks with breaks suit you." },
    { max: 30 * 60, phrase: "15–30 minute sessions", title: "Your sweet spot is 15–30 minutes", tip: "Plan your work in blocks of about that length." },
    { max: Infinity, phrase: "sessions over 30 minutes", title: "You stay focused in longer sessions", tip: "Long, deep-work sessions are a strength of yours." }
  ];

  // Compares groups (time of day, session length) and returns the best and worst with enough data.
  function compareGroups(list, groupOf) {
    const groups = new Map();
    list.filter(hasFocus).forEach((s) => {
      const key = groupOf(s);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(s);
    });
    const scored = [...groups].filter(([, items]) => sum(items, (s) => s.tracked_seconds) >= 180)
      .map(([key, items]) => ({ key, avg: averageFocus(items) }))
      .sort((a, b) => b.avg - a.avg);
    return scored.length >= 2 && scored[0].avg - scored[scored.length - 1].avg >= 5 ? { best: scored[0], worst: scored[scored.length - 1] } : null;
  }

  function buildInsights(current) {
    const insights = [];
    const chronological = current.filter(hasFocus).slice().reverse();

    if (chronological.length >= 4) {
      const half = Math.floor(chronological.length / 2);
      const before = averageFocus(chronological.slice(0, half));
      const after = averageFocus(chronological.slice(half));
      if (after - before >= 5) insights.push({ tone: "green", icon: "i-trend", title: "Your focus is improving", text: `Your recent sessions average ${after}% focus, up from ${before}% before.` });
      else if (before - after >= 5) insights.push({ tone: "amber", icon: "i-flag", title: "Your focus has dipped lately", text: `Recent sessions average ${after}%, down from ${before}%. A quieter spot or shorter sessions can help.` });
      else insights.push({ tone: "", icon: "i-target", title: "Your focus is steady", text: `Your sessions stay around ${averageFocus(chronological)}% focus.` });
    }

    const hour = (s) => { const h = new Date(s.started_at).getHours(); return h < 5 ? h + 24 : h; };
    const times = compareGroups(current, (s) => TIMES.find((t) => hour(s) >= t.from && hour(s) < t.to).key);
    if (times) {
      const best = TIMES.find((t) => t.key === times.best.key);
      const worst = TIMES.find((t) => t.key === times.worst.key);
      insights.push({ tone: "", icon: "i-sun", title: `You focus best ${best.phrase}`, text: `${times.best.avg}% focus, compared with ${times.worst.avg}% ${worst.phrase}. Try saving harder work for then.` });
    }

    const lengths = compareGroups(current, (s) => LENGTHS.findIndex((l) => s.tracked_seconds < l.max));
    if (lengths) {
      const best = LENGTHS[lengths.best.key];
      const worst = LENGTHS[lengths.worst.key];
      insights.push({ tone: "", icon: "i-timer", title: best.title, text: `${best.phrase[0].toUpperCase()}${best.phrase.slice(1)} average ${lengths.best.avg}% focus, versus ${lengths.worst.avg}% for ${worst.phrase}. ${best.tip}` });
    }

    const lapses = sum(current, (s) => s.lapses);
    const minutes = sum(current, (s) => s.tracked_seconds) / 60;
    if (minutes >= 5) {
      if (!lapses) insights.push({ tone: "green", icon: "i-check", title: "No distractions recorded", text: "You stayed on task through every session in this range. Nice work." });
      else {
        const every = Math.max(1, Math.round(minutes / lapses));
        insights.push(every >= 10
          ? { tone: "green", icon: "i-check", title: `You lose focus about once every ${every} minutes`, text: "That's a strong stretch of attention. Short breaks will help you keep it up." }
          : { tone: "amber", icon: "i-flag", title: `You lose focus about once every ${every} minute${every === 1 ? "" : "s"}`, text: "That's common, and it's okay. Gentle nudges and small micro-goals help you get back on track faster." });
      }
    }
    return insights.slice(0, 4);
  }

  function renderInsights(current, info) {
    const list = $("#insightList");
    const counted = current.filter(hasFocus).length;
    if (counted < MIN_SESSIONS_FOR_INSIGHTS) {
      const item = el("li", "insight");
      const icon = el("span", "chip-icon");
      icon.append(svgUse("i-spark", ""));
      const body = el("div");
      body.append(
        el("b", "", `Complete ${MIN_SESSIONS_FOR_INSIGHTS} sessions to unlock insights`),
        el("p", "", `You have ${counted} ${info.phrase}. Once there's enough to compare, this shows when and how you focus best.`)
      );
      const meter = el("div", "unlock-meter");
      const fill = el("span");
      fill.style.width = `${Math.round((counted / MIN_SESSIONS_FOR_INSIGHTS) * 100)}%`;
      meter.append(fill);
      body.append(meter);
      item.append(icon, body);
      list.replaceChildren(item);
      return;
    }
    const insights = buildInsights(current);
    if (!insights.length) {
      list.replaceChildren(el("li", "empty-state", "Keep going: a few more sessions at different times will reveal your patterns."));
      return;
    }
    list.replaceChildren(...insights.map(({ tone, icon, title, text }) => {
      const item = el("li", "insight");
      const chip = el("span", `chip-icon ${tone}`);
      chip.append(svgUse(icon, ""));
      const body = el("div");
      body.append(el("b", "", title), el("p", "", text));
      item.append(chip, body);
      return item;
    }));
  }

  // ---------- Session list ----------
  function focusRing(pct) {
    const wrap = el("span", "focus-ring");
    const r = 18;
    const c = 2 * Math.PI * r;
    wrap.innerHTML = `<svg viewBox="0 0 44 44" aria-hidden="true"><circle class="track" cx="22" cy="22" r="${r}"/><circle class="fill" cx="22" cy="22" r="${r}" stroke-dasharray="${c.toFixed(2)}"/></svg>`;
    const fill = wrap.querySelector(".fill");
    if (pct === null) fill.style.display = "none";
    else {
      fill.style.stroke = levelFor(pct).color;
      fill.setAttribute("stroke-dashoffset", (c * (1 - pct / 100)).toFixed(2));
    }
    wrap.append(el("b", "", pct === null ? "—" : `${pct}%`));
    return wrap;
  }

  function sessionItem(session) {
    const pct = hasFocus(session) ? session.focus_percent : null;
    const item = el("li", "session-item");
    item.dataset.open = String(openSessions.has(session.id));
    const row = el("button", "session-row");
    row.type = "button";
    row.setAttribute("aria-expanded", item.dataset.open);

    const main = el("span", "session-main");
    const title = el("span", "session-title", `${time(session.started_at)} · ${duration(session.tracked_seconds)}`);
    if (session.classes?.name) title.append(el("span", "class-tag", session.classes.name));
    const lapses = session.lapses ? plural(session.lapses, "distraction") : "no distractions";
    main.append(title, el("span", "session-meta", `${duration(focusedSeconds(session))} focused · ${lapses}`));

    const verdict = pct === null ? el("span") : el("span", "verdict", levelFor(pct).label);
    if (pct !== null) verdict.dataset.level = levelFor(pct).key;
    row.append(focusRing(pct), main, verdict, svgUse("i-chevron", "chevron"));
    row.setAttribute("aria-label", `${dayTitle(session.started_at)} at ${time(session.started_at)}, ${duration(session.tracked_seconds)}, ${pct === null ? "no focus score" : `${pct}% focus, ${levelFor(pct).label}`}. Show details.`);

    const detail = el("div", "session-detail");
    detail.hidden = !openSessions.has(session.id);
    row.addEventListener("click", () => {
      const open = item.dataset.open !== "true";
      item.dataset.open = String(open);
      row.setAttribute("aria-expanded", String(open));
      detail.hidden = !open;
      if (open) { openSessions.add(session.id); void renderDetail(session, detail); } else openSessions.delete(session.id);
    });
    if (!detail.hidden) void renderDetail(session, detail);
    item.append(row, detail);
    return item;
  }

  async function loadSamples(sessionId) {
    if (sampleCache.has(sessionId)) return sampleCache.get(sessionId);
    const rows = [];
    for (let page = 0; page < 5; page += 1) {
      const { data, error } = await app.supabase.from("attention_samples")
        .select("recorded_at, state").eq("session_id", sessionId)
        .order("recorded_at", { ascending: true }).range(page * 1000, page * 1000 + 999);
      if (error) throw error;
      rows.push(...data);
      if (data.length < 1000) break;
    }
    sampleCache.set(sessionId, rows);
    return rows;
  }

  const canHover = window.matchMedia("(hover: hover)").matches;
  const STATE_INFO = { Focused: { cls: "focused", label: "Focused" }, Distracted: { cls: "distracted", label: "Looked away" }, Away: { cls: "away", label: "Not at screen" } };

  async function renderDetail(session, detail) {
    const facts = el("div", "session-facts");
    const fact = (label, value) => { const span = el("span", "", `${label} `); span.append(el("b", "", value)); return span; };
    const end = session.ended_at || session.last_seen_at;
    facts.append(
      fact("Time", `${time(session.started_at)} – ${time(end)}`),
      fact("Focused for", `${duration(focusedSeconds(session))} of ${duration(session.tracked_seconds)}`),
      fact("Longest streak", clock(session.best_streak_seconds))
    );
    const note = el("p", "strip-note", "Loading timeline…");
    detail.replaceChildren(facts, note);

    let samples;
    try { samples = await loadSamples(session.id); } catch (error) {
      note.textContent = "Couldn’t load this session’s timeline.";
      console.warn("Could not load attention samples", error);
      return;
    }
    if (!samples.length) { note.textContent = "No timeline was saved for this session."; return; }

    // Merge neighbouring samples with the same state into runs.
    const runs = [];
    samples.forEach((sample) => {
      const last = runs[runs.length - 1];
      if (last && last.state === sample.state) { last.count += 1; last.end = sample.recorded_at; } else runs.push({ state: sample.state, count: 1, start: sample.recorded_at, end: sample.recorded_at });
    });
    const strip = el("div", "focus-strip");
    runs.forEach((run) => {
      const info = STATE_INFO[run.state] || STATE_INFO.Away;
      const part = el("span", info.cls);
      part.style.flexGrow = String(run.count);
      const from = new Date(new Date(run.start).getTime() - SAMPLE_SECONDS * 1000);
      part.title = `${time(from)}–${time(run.end)} · ${info.label} (${duration(run.count * SAMPLE_SECONDS)})`;
      strip.append(part);
    });
    const share = (state) => Math.round(sum(runs.filter((r) => r.state === state), (r) => r.count) / samples.length * 100);
    strip.setAttribute("role", "img");
    strip.setAttribute("aria-label", `Session timeline: ${share("Focused")}% focused, ${share("Distracted")}% looking away, ${share("Away")}% not at the screen.`);

    const axis = el("div", "strip-axis");
    axis.append(el("span", "", time(new Date(new Date(samples[0].recorded_at).getTime() - SAMPLE_SECONDS * 1000))), el("span", "", time(samples[samples.length - 1].recorded_at)));

    const longest = runs.filter((r) => r.state === "Focused").sort((a, b) => b.count - a.count)[0];
    note.textContent = longest && longest.count * SAMPLE_SECONDS >= 30
      ? `Your longest focused stretch started at ${time(new Date(new Date(longest.start).getTime() - SAMPLE_SECONDS * 1000))}.${canHover ? " Hover the bar to see each part." : ""}`
      : canHover ? "Hover the bar to see when you were focused." : "";
    detail.replaceChildren(facts, strip, axis, note);
  }

  function renderList(current, info) {
    const days = $("#historyDays");
    $("#historyCount").textContent = current.length ? `${plural(current.length, "session")} ${info.phrase}` : "";
    if (!current.length) {
      const empty = el("div", "empty-state");
      const link = el("a", "", "Go to dashboard");
      link.href = "#dashboard";
      empty.append(`${sessions.length ? `No sessions ${info.phrase}.` : "No saved sessions yet."} Start attention tracking on the dashboard and your session shows up here when you stop. `, link);
      days.replaceChildren(empty);
      $("#historyMore").hidden = true;
      return;
    }
    const visible = current.slice(0, shown);
    const groups = new Map();
    visible.forEach((s) => {
      const key = dayKey(s.started_at);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(s);
    });
    days.replaceChildren(...[...groups].map(([key, items]) => {
      const all = current.filter((s) => dayKey(s.started_at) === key);
      const section = el("section", "history-day");
      const head = el("div", "day-head");
      head.append(el("b", "", dayTitle(items[0].started_at)), el("span", "", `${duration(sum(all, focusedSeconds))} focused · ${plural(all.length, "session")}`));
      const list = el("ul", "session-list");
      list.append(...items.map(sessionItem));
      section.append(head, list);
      return section;
    }));
    const more = $("#historyMore");
    more.hidden = current.length <= shown;
    more.textContent = `Show more sessions (${current.length - shown} left)`;
  }

  // ---------- Render + load ----------
  function render() {
    document.querySelectorAll("[data-range]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.range === range)));
    const info = rangeInfo();
    const current = between(sessions, info.start);
    const previous = info.prevStart ? between(sessions, info.prevStart, info.start) : [];
    renderStats(current, previous, info);
    renderChart(current, info);
    renderInsights(current, info);
    renderList(current, info);
  }

  async function load() {
    const { data, error } = await app.supabase
      .from("attention_sessions")
      .select("id, started_at, last_seen_at, ended_at, tracked_seconds, focus_percent, best_streak_seconds, lapses, classes(name)")
      .eq("student_id", app.user.id)
      .gt("tracked_seconds", 4)
      .order("started_at", { ascending: false })
      .limit(1000);
    if (error) {
      const status = $("#historyStatus");
      status.textContent = missingTables(error)
        ? "History isn’t being saved yet: run the Phase 2 database update (see README)."
        : "Couldn’t load your history. Refresh to try again.";
      status.dataset.state = "error";
      $("#historyCount").textContent = "";
      $("#insightList").replaceChildren(el("li", "empty-state", "Insights appear once your history loads."));
      return;
    }
    sessions = data;
    render();
  }

  document.querySelectorAll("[data-range]").forEach((button) => button.addEventListener("click", () => {
    range = button.dataset.range;
    shown = PAGE_SIZE;
    try { localStorage.setItem(rangeKey, range); } catch { /* storage unavailable */ }
    render();
  }));
  $("#historyMore").addEventListener("click", () => {
    shown += PAGE_SIZE;
    const info = rangeInfo();
    renderList(between(sessions, info.start), info);
  });
  // The chart is drawn while its view may be hidden; size it once the view is shown.
  window.addEventListener("hashchange", () => {
    if (window.location.hash === "#history") window.requestAnimationFrame(() => chart?.resize());
  });
  window.addEventListener("neurofocus:history-saved", () => { void load(); });

  void load();
}
