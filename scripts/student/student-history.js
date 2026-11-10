// My progress view: the student's saved track record, kept simple. One summary (time focused,
// the days you focused, sessions, focus score and day streak), a focus-time chart, the Focus
// coach (the same one as Home) and the session list, for the chosen range (7 days, 30 days or
// all time). Live numbers for the session in progress are in Focus session (student-focus.js);
// a session still being recorded is left out here until it is stopped. Reads the student's
// saved attention_sessions, and a session's attention_samples when it is opened.
// Saving happens in student-focus.js, which fires "neurofocus:history-saved" afterwards.
// Shown in the My progress view; colours follow the student's theme.
import { themeColor, withAlpha } from "../shared/appearance.js";
import { hasFocus, focusedSeconds, sum, averageFocus, levelFor, buildCoaching } from "./focus-analysis.js";
import { sampleRuns, selectWithQuality } from "../shared/tracking-states.js";

const app = await window.neuroFocusReady;

if (app) {
  const $ = (selector) => document.querySelector(selector);
  const PAGE_SIZE = 12;
  const SAMPLE_SECONDS = 5; // attention_samples are 5-second windows
  const rangeKey = `neuroFocusHistoryRange:${app.user.id}`;
  const missingTables = (error) => error && (error.code === "PGRST205" || error.code === "42P01" || /attention_sessions|attention_samples/.test(error.message || ""));

  let sessions = []; // newest first, without sessions still in progress
  let inProgressCount = 0;
  let range = "7";
  let shown = PAGE_SIZE;
  let chart = null;
  let refreshTimer = 0;
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

  function dayTitle(date) {
    const key = dayKey(date);
    if (key === dayKey(new Date())) return "Today";
    if (key === dayKey(addDays(new Date(), -1))) return "Yesterday";
    const d = new Date(date);
    return d.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric", ...(d.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}) });
  }


  // ---------- Range ----------
  function rangeInfo() {
    const today = startOfDay(new Date());
    if (range === "all") {
      const oldest = sessions.length ? startOfDay(sessions[sessions.length - 1].started_at) : today;
      return { start: oldest, days: Math.round((today - oldest) / 86400000) + 1, prevStart: null, phrase: "in total", label: "All time", compare: null };
    }
    const days = Number(range);
    const start = addDays(today, -(days - 1));
    return { start, days, prevStart: addDays(start, -days), phrase: `in the last ${days} days`, label: `Last ${days} days`, compare: days === 7 ? "the week before" : "the 30 days before" };
  }
  const between = (list, from, to) => list.filter((s) => { const t = new Date(s.started_at); return t >= from && (!to || t < to); });

  // ---------- Summary ----------
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
    $("#psRange").textContent = info.label;
    $("#hsFocusTime").textContent = focused < 30 ? "0m" : duration(focused);

    // One plain comparison with the period before.
    const compare = $("#hsCompare");
    compare.dataset.trend = "";
    if (!current.length) compare.textContent = sessions.length ? "No sessions yet in this range. A short one counts!" : "Start your first focus session to see your progress here.";
    else if (!info.compare) compare.textContent = `Across ${plural(current.length, "session")}`;
    else if (!previous.length) compare.textContent = `Across ${plural(current.length, "session")}. Nice start!`;
    else {
      const change = Math.round((focused - sum(previous, focusedSeconds)) / 60) * 60;
      compare.textContent = change === 0 ? `The same as ${info.compare}` : `${duration(Math.abs(change))} ${change > 0 ? "more" : "less"} than ${info.compare}`;
      compare.dataset.trend = change > 0 ? "up" : change < 0 ? "down" : "";
    }

    // The days you focused: a dot per day for 7 or 30 days.
    const focusDays = new Set(current.map((s) => dayKey(s.started_at)));
    const dots = $("#psDots");
    if (range === "all") {
      dots.replaceChildren();
      dots.hidden = true;
      $("#psDaysLabel").textContent = "Days you focused";
      $("#hsDaysNote").textContent = `${plural(focusDays.size, "day")} in total`;
    } else {
      dots.hidden = false;
      dots.dataset.size = info.days > 7 ? "small" : "";
      const today = startOfDay(new Date());
      dots.replaceChildren(...Array.from({ length: info.days }, (_, i) => {
        const day = addDays(today, i - info.days + 1);
        const dot = el("span", "ps-dot");
        dot.dataset.on = String(focusDays.has(day.toDateString()));
        if (i === info.days - 1) dot.dataset.today = "true";
        if (info.days <= 7) dot.textContent = day.toLocaleDateString([], { weekday: "narrow" });
        dot.title = `${day.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" })}${focusDays.has(day.toDateString()) ? " · focused" : ""}`;
        return dot;
      }));
      $("#psDaysLabel").textContent = "Days you focused";
      $("#hsDaysNote").textContent = `${focusDays.size} of ${info.days} days`;
    }

    $("#hsSessions").textContent = String(current.length);
    $("#hsAverage").textContent = avg === null ? "—" : `${avg}%`;
    $("#hsAverageNote").textContent = avg === null ? "After a session" : levelFor(avg).label;
    const streak = dayStreaks();
    $("#hsDays").textContent = plural(streak.current, "day");
    const keepGoing = streak.current && !streak.studiedToday;
    $("#hsDays").title = keepGoing ? "Do a session today to keep it going" : `Your best: ${plural(streak.best, "day")}`;
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
    const muted = themeColor("--text-muted");
    const accent = themeColor("--accent", "#00d9ff");
    chart = new window.Chart(canvas, {
      type: "bar",
      data: {
        labels: list.map((b) => b.label),
        datasets: [{
          label: "Minutes focused", data,
          backgroundColor: withAlpha(accent, 0.78), hoverBackgroundColor: accent,
          maxBarThickness: 24, borderRadius: { topLeft: 4, topRight: 4 }, borderSkipped: false
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        scales: {
          y: {
            beginAtZero: true, suggestedMax: 10, grid: { color: themeColor("--surface-hover", "#1c1c20") }, border: { display: false },
            ticks: { color: muted, stepSize, maxTicksLimit: 6, callback: (v) => (v ? duration(v * 60) : "0") }
          },
          x: { grid: { display: false }, border: { color: themeColor("--border", "#222226") }, ticks: { color: muted, maxRotation: 0, autoSkipPadding: 12 } }
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: themeColor("--surface-raised", "#17171b"), borderColor: themeColor("--border-strong", "#2e2e34"), borderWidth: 1, padding: 10, displayColors: false,
            titleColor: themeColor("--text-main", "#f4f4f5"), bodyColor: themeColor("--text-soft", "#b4b4bc"),
            callbacks: {
              title: (items) => chart.$buckets[items[0].dataIndex].title,
              label: (item) => {
                const b = chart.$buckets[item.dataIndex];
                return [`${duration(b.minutes * 60)} focused`, plural(b.count, "session")];
              }
            }
          }
        }
      }
    });
    chart.$buckets = list;
  }

  // ---------- Focus coach (the same as Home's) ----------
  // What's going well and the two most useful things to try, from the last 30 days of sessions.
  // Buttons use Home's controls (student-dashboard.js exposes them as window.neuroFocusCoach).
  function renderCoach() {
    const box = $("#pcTips");
    const coach = window.neuroFocusCoach;
    const coaching = buildCoaching(sessions, coach?.habits?.() || {});
    $("#progressCoachSub").textContent = coaching.stage === "personal" ? "Ideas from your recent sessions." : "General tips to get you started.";
    const win = coaching.wins[0];
    const winBox = $("#pcWin");
    winBox.hidden = !win;
    if (win) winBox.replaceChildren(svgUse("i-check"), el("span", "", `Going well: ${win.title}`));
    box.replaceChildren(...coaching.tips.slice(0, 2).map((tip) => {
      const item = el("li", "pc-tip");
      if (tip.tone) item.dataset.tone = tip.tone;
      const chip = el("span", `chip-icon ${tip.tone || ""}`);
      chip.append(svgUse(tip.icon || "i-spark", ""));
      const body = el("div", "pc-body");
      body.append(el("b", "", tip.title), el("p", "", tip.text));
      if (tip.action) {
        const button = el("button", tip.action.kind === "start" ? "btn-primary pc-action" : "btn-action pc-action", tip.action.label);
        button.type = "button";
        if (tip.action.kind === "start") button.dataset.startFocus = ""; // handled by student-ui.js
        else button.addEventListener("click", () => {
          // Planning a step happens on Home; the others work from anywhere.
          if (tip.action.kind === "step") {
            window.neuroFocusNavigate?.("dashboard");
            window.setTimeout(() => coach?.run?.(tip.action), 300);
          } else coach?.run?.(tip.action);
          window.setTimeout(renderCoach, 400);
        });
        body.append(button);
      }
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

  // One line per session: what it was, when, how long, and roughly how much of it was focused.
  function sessionItem(session) {
    const pct = hasFocus(session) ? session.focus_percent : null;
    const item = el("li", "session-item");
    item.dataset.open = String(openSessions.has(session.id));
    const row = el("button", "session-row");
    row.type = "button";
    row.setAttribute("aria-expanded", item.dataset.open);

    const main = el("span", "session-main");
    const name = session.classes?.name || "Solo focus";
    const title = el("span", "session-title");
    title.append(el("b", "", name), el("span", "session-time", time(session.started_at)));
    const unfinished = !session.ended_at;
    const meta = `${duration(session.tracked_seconds)} session · about ${duration(focusedSeconds(session))} focused${unfinished ? " · not stopped" : ""}`;
    main.append(title, el("span", "session-meta", meta));

    const verdict = pct === null ? el("span") : el("span", "verdict", levelFor(pct).label);
    if (pct !== null) verdict.dataset.level = levelFor(pct).key;
    row.append(focusRing(pct), main, verdict, svgUse("i-chevron", "chevron"));
    row.setAttribute("aria-label", `${name}, ${dayTitle(session.started_at)} at ${time(session.started_at)}, ${duration(session.tracked_seconds)}, about ${duration(focusedSeconds(session))} focused${pct === null ? "" : `, ${pct}%`}. Show details.`);

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

  // The timeline uses three colours only: focused, looking away, and paused (a break, or a moment
  // the camera couldn't see you). Paused time never counts against you.
  const RUN_INFO = {
    "on-screen": { cls: "focused", label: "Focused" },
    "looking-away": { cls: "distracted", label: "Looking away" },
    unavailable: { cls: "paused", label: "Paused" },
    break: { cls: "paused", label: "Paused" },
    gap: { cls: "paused", label: "Paused" }
  };

  async function renderDetail(session, detail) {
    const tiles = el("div", "session-tiles");
    const tile = (label, value) => {
      const box = el("div", "session-tile");
      box.append(el("b", "", value), el("small", "", label));
      return box;
    };
    tiles.append(
      tile("Session length", duration(session.tracked_seconds)),
      tile("Focused", `about ${duration(focusedSeconds(session))}`),
      tile("Longest focus streak", session.best_streak_seconds ? clock(session.best_streak_seconds) : "—")
    );
    const note = el("p", "strip-note", "Loading timeline…");
    detail.replaceChildren(tiles, note);

    let samples;
    try { samples = await loadSamples(session.id); } catch (error) {
      note.textContent = "Couldn’t load this session’s timeline.";
      console.warn("Could not load attention samples", error);
      return;
    }
    if (!samples.length) { note.textContent = "No timeline was saved for this session."; return; }

    // Neighbouring parts of the same colour are joined, so the bar stays simple.
    const runs = [];
    sampleRuns(samples, SAMPLE_SECONDS).forEach((run) => {
      const info = RUN_INFO[run.kind] || RUN_INFO.unavailable;
      const last = runs.at(-1);
      if (last && last.info.cls === info.cls) { last.count += run.count; last.end = run.end; }
      else runs.push({ info, count: run.count, start: run.start, end: run.end });
    });
    const strip = el("div", "focus-strip");
    runs.forEach((run) => {
      const part = el("span", run.info.cls);
      part.style.flexGrow = String(run.count);
      const from = new Date(new Date(run.start).getTime() - SAMPLE_SECONDS * 1000);
      part.title = `${time(from)}–${time(run.end)} · ${run.info.label}`;
      strip.append(part);
    });
    const slots = sum(runs, (r) => r.count);
    const share = (cls) => Math.round(sum(runs.filter((r) => r.info.cls === cls), (r) => r.count) / slots * 100);
    strip.setAttribute("role", "img");
    strip.setAttribute("aria-label", `Session timeline: ${share("focused")}% focused, ${share("distracted")}% looking away, ${share("paused")}% paused.`);

    const axis = el("div", "strip-axis");
    axis.append(el("span", "", time(new Date(new Date(samples[0].recorded_at).getTime() - SAMPLE_SECONDS * 1000))), el("span", "", time(samples[samples.length - 1].recorded_at)));
    const legend = el("div", "strip-legend");
    legend.setAttribute("aria-hidden", "true");
    [["focused", "Focused"], ["distracted", "Looking away"], ["paused", "Paused"]].forEach(([cls, label]) => {
      const key = el("span");
      key.append(el("i", cls), label);
      legend.append(key);
    });
    note.textContent = session.ended_at ? "" : "This session wasn’t stopped, so it shows what was saved.";
    detail.replaceChildren(tiles, strip, axis, legend, ...(note.textContent ? [note] : []));
  }

  function renderList(current, info) {
    const days = $("#historyDays");
    const ongoing = inProgressCount ? `${plural(inProgressCount, "session")} still in progress, added here when stopped` : "";
    $("#historyCount").textContent = current.length
      ? [`${plural(current.length, "session")} ${info.phrase}. Open one to see how it went.`, ongoing].filter(Boolean).join(" · ")
      : ongoing;
    if (!current.length) {
      const empty = el("div", "empty-state");
      const link = el("a", "", "Open Solo focus");
      link.href = "#focus";
      empty.append(`${sessions.length ? `No sessions ${info.phrase}.` : "No sessions yet."} Start a focus session and it shows up here when you stop. `, link);
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
      head.append(el("b", "", dayTitle(items[0].started_at)), el("span", "", `${plural(all.length, "session")} · about ${duration(sum(all, focusedSeconds))} focused`));
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
    renderCoach();
    renderList(current, info);
  }

  async function load() {
    const { data, error } = await selectWithQuality((quality) => app.supabase
      .from("attention_sessions")
      .select(`id, started_at, last_seen_at, ended_at, tracked_seconds, focus_percent, best_streak_seconds, lapses, classes(name)${quality}`)
      .eq("student_id", app.user.id)
      .gt("tracked_seconds", 4)
      .order("started_at", { ascending: false })
      .limit(1000));
    if (error) {
      const status = $("#historyStatus");
      status.textContent = missingTables(error)
        ? "History isn’t being saved yet: run the Phase 2 database update (see README)."
        : "Couldn’t load your history. Refresh to try again.";
      status.dataset.state = "error";
      $("#historyCount").textContent = "";
      $("#pcTips").replaceChildren(el("li", "empty-state", "Tips appear once your sessions load."));
      return;
    }
    const inProgress = window.neuroFocusSessionInProgress
      || ((s) => !s.ended_at && Date.now() - new Date(s.last_seen_at || s.started_at) < 90000);
    sessions = data.filter((s) => !inProgress(s));
    inProgressCount = data.length - sessions.length;
    render();
  }

  document.querySelectorAll("[data-range]").forEach((button) => button.addEventListener("click", () => {
    range = button.dataset.range;
    shown = PAGE_SIZE;
    try { localStorage.setItem(rangeKey, range); } catch { /* storage unavailable */ }
    render();
    // The session list and numbers settle in again for the new range (styles/student.css).
    const view = $("#view-progress");
    view.classList.remove("is-refreshing");
    void view.offsetWidth;
    view.classList.add("is-refreshing");
    window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(() => view.classList.remove("is-refreshing"), 900);
  }));
  $("#historyMore").addEventListener("click", () => {
    shown += PAGE_SIZE;
    const info = rangeInfo();
    renderList(between(sessions, info.start), info);
  });
  // The chart is drawn while its view may be hidden; size it once the view is shown.
  window.addEventListener("neurofocus:viewchange", (event) => {
    if (event.detail?.name !== "progress") return;
    window.requestAnimationFrame(() => chart?.resize());
    renderCoach(); // settings may have changed elsewhere (nudges, timer, steps)
  });
  // A new theme or accent: redraw the chart in the new colours.
  window.addEventListener("neurofocus:appearance-change", () => {
    if (!chart) return;
    chart.destroy();
    chart = null;
    render();
  });
  window.addEventListener("neurofocus:history-saved", () => { void load(); });

  void load();
}
