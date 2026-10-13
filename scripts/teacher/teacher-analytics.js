// Teacher live monitor: real-time attention readings streamed by students in the selected class
// (relayed by teacher-classes.js from Supabase Realtime; numbers only, never video), and the
// class's saved sessions. Real data only.
// Chart colours follow the teacher's theme and accent (styles/theme.css).
import { themeColor, withAlpha } from "../shared/appearance.js?v=1";
import { normalizeReading, describeReading, sampleKind, selectWithQuality, hasQualityInfo, SCORE_BANDS } from "../shared/tracking-states.js?v=1";
import { paintAvatar } from "../shared/avatars.js?v=1";

const HISTORY = 30;      // points kept on the attention curve
const HEAT_COLUMNS = 20; // readings shown in the heatmap
// Score bands and reading meanings are shared with the student pages (tracking-states.js).
// Scores are estimates from face and eye direction; a reading with no usable measurement has no
// score at all (shown as "Tracking unavailable"), never 0.
const FOCUSED = SCORE_BANDS.HIGH;
const DRIFTING = SCORE_BANDS.MIDDLE;
const LIVE_TICK_MS = 1000;
const LIVE_STALE_MS = 5000; // no reading for this long while sharing = no recent data (connection)
const FLAG_AFTER_READINGS = 3;

const $ = (selector) => document.querySelector(selector);
const els = {
  status: $("#liveStatusBadge"),
  avg: $("#statAverage"),
  avgTrend: $("#statAverageTrend"),
  flags: $("#statFlags"),
  flagsSub: $("#statFlagsSub"),
  time: $("#statTime"),
  timeSub: $("#statTimeSub"),
  splitBar: $("#liveSplitBar"),
  splitLegend: $("#liveSplitLegend"),
  board: $("#liveBoard"),
  filters: $("#liveFilters"),
  boardEmpty: $("#liveBoardEmpty"),
  boardEmptyTitle: $("#liveBoardEmptyTitle"),
  boardNone: $("#liveBoardNone"),
  heatmap: $("#engagementHeatmap"),
  alerts: $("#alertFeed"),
  liveClassName: $("#liveClassName")
};

let students = [];       // rendered rows: { name, score (null = not tracking), flagged, heat[] }
let classHistory = [];
let lowHistory = [];
let labels = [];
let tick = 0;
let flagCount = 0;
let timer = null;
let chart = null;

// Live state
const liveReadings = new Map(); // studentId -> { reading (tracking-states.js shape), lastSeen }
const liveStudents = new Map(); // studentId -> { name, score, status, reason, flagged, heat[], distractedTicks }
let liveClassId = window.neuroFocusClass?.id || "";
let liveStartedAt = 0;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const stateFor = (score) => (score >= FOCUSED ? "Focused" : score >= DRIFTING ? "Drifting" : "Distracted");

// ---------- The student board ----------
// Each student's card has one of these states. Measured: focused / mixed / away (by score band).
// Not measured right now: unmeasured (no face, no recent data), break, joined (in the session with
// the camera off). Not in the session: absent (invited, not joined) or offline (no live session).
const BOARD = {
  focused: { label: "Focused", group: "focused", order: 3 },
  mixed: { label: "Mixed", group: "mixed", order: 2 },
  away: { label: "Looking away", group: "attention", order: 1 },
  unmeasured: { label: "Can’t measure", group: "unmeasured", order: 4 },
  break: { label: "On a break", group: "unmeasured", order: 5 },
  joined: { label: "Joined · camera off", group: "unmeasured", order: 6 },
  absent: { label: "Not joined yet", group: "absent", order: 7 },
  offline: { label: "Not in a session", group: "absent", order: 8 }
};
const FILTERS = [
  { key: "all", label: "All" },
  { key: "attention", label: "Needs attention" },
  { key: "mixed", label: "Mixed" },
  { key: "focused", label: "Focused" },
  { key: "unmeasured", label: "Not measured" },
  { key: "absent", label: "Not joined" }
];
// The split bar: how the students in the live session divide right now. Students who haven't
// joined aren't part of it (the board and its "Not joined" filter still list them).
const SPLIT = [
  { key: "focused", label: "focused" },
  { key: "mixed", label: "mixed" },
  { key: "attention", label: "looking away" },
  { key: "unmeasured", label: "can’t measure" }
];
let boardFilter = "all";
const tiles = new Map(); // studentId -> card element
let tileOrder = "";
let attendanceRows = { classId: "", current: new Map() }; // teacher-attendance.js: who joined, who was late

const STATUS_TEXT = { stale: "No recent data", unavailable: "Can’t measure", break: "On a break" };
const clockLabel = (ms) => {
  const seconds = Math.floor(ms / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
};
const elapsedLabel = () => clockLabel(liveStartedAt ? Date.now() - liveStartedAt : 0);

function rosterMembers() {
  // The open class's roster, published by teacher-classes.js
  return Array.isArray(window.neuroFocusRoster) ? window.neuroFocusRoster : [];
}

// Whether the teacher has a live session running in the open class (teacher-classes.js)
// teacher-classes.js may have announced the session before this script started listening.
let sessionLive = window.neuroFocusLiveSession?.classId === liveClassId && Boolean(window.neuroFocusLiveSession?.live);
let sessionSince = sessionLive ? window.neuroFocusLiveSession.since : null;
let sessionId = sessionLive ? window.neuroFocusLiveSession.sessionId || null : null;
window.addEventListener("neurofocus:live-session", (event) => {
  const detail = event.detail || {};
  if (detail.classId && detail.classId !== liveClassId) return;
  const nextId = detail.live ? detail.sessionId || null : null;
  const newSession = Boolean(detail.live) && (!sessionLive || nextId !== sessionId);
  sessionLive = Boolean(detail.live);
  sessionSince = detail.since || null;
  sessionId = nextId;
  if (newSession) {
    // A new live session starts with a clean slate.
    clearData();
    resetLive();
    void seedLiveFromSaved(liveClassId, rosterMembers());
  }
  render();
});

function selectedClassName() {
  return window.neuroFocusClass?.name || "";
}

// ---------- Live classroom ----------
function liveStep() {
  tick += 1;
  const now = Date.now();
  const roster = rosterMembers();
  const ids = new Set(roster.map((member) => member.id));
  [...liveStudents.keys()].forEach((id) => { if (!ids.has(id)) liveStudents.delete(id); });

  students = roster.map(({ id, name, avatarPreset = null, avatarUrl = null }) => {
    const student = liveStudents.get(id) || { name, score: null, status: "off", flagged: false, heat: [], distractedTicks: 0 };
    Object.assign(student, { id, name, avatarPreset, avatarUrl });
    const entry = liveReadings.get(id);
    const tracking = entry?.reading.tracking || "off";
    // Sharing, but nothing arrived for a while: the connection dropped (or the page froze).
    student.status = tracking !== "off" && now - entry.lastSeen >= LIVE_STALE_MS ? "stale" : tracking === "active" ? "active" : tracking;
    student.reason = student.status === "unavailable" ? entry.reading.reason : null;
    student.score = student.status === "active" ? entry.reading.score : null;
    // Flags only ever come from measured readings; anything else resets the count without a flag.
    if (student.status === "active") updateFlagState(student);
    else { student.distractedTicks = 0; student.flagged = false; }
    pushHeat(student, student.score);
    liveStudents.set(id, student);
    return student;
  });

  const activeScores = students.filter((student) => student.score !== null).map((student) => student.score);
  if (activeScores.length && !liveStartedAt) liveStartedAt = now;
  pushHistory(activeScores);
  render();
}

function resetLive() {
  liveReadings.clear();
  liveStudents.clear();
  liveStartedAt = 0;
}

window.addEventListener("neurofocus:attendance", (event) => {
  const detail = event.detail || {};
  if (detail.classId) attendanceRows = { classId: detail.classId, current: detail.current || new Map() };
});

window.addEventListener("neurofocus:live-attention", (event) => {
  const reading = event.detail || {};
  if (!reading.studentId || reading.classId !== liveClassId) return;
  // normalizeReading keeps a missing score missing (an older student page's "Away" reading,
  // saved as 0, is read as unavailable too).
  liveReadings.set(reading.studentId, { reading: normalizeReading(reading), lastSeen: Date.now() });
});

// Classes whose live channel is currently refused (teacher-classes.js); clears when Supabase reconnects.
const blockedClasses = new Set();
window.addEventListener("neurofocus:live-channel-error", (event) => {
  blockedClasses.add(event.detail?.classId);
  render();
});
window.addEventListener("neurofocus:live-channel-ok", (event) => {
  blockedClasses.delete(event.detail?.classId);
  render();
});

window.addEventListener("neurofocus:classchange", (event) => {
  const nextId = event.detail?.id || "";
  if (nextId === liveClassId) return;
  liveClassId = nextId;
  window.neuroFocusRoster = [];
  clearData();
  resetLive();
  render();
});

// ---------- Saved history (Supabase) ----------
// After a refresh the live view is rebuilt from the last 10 minutes of saved samples
// (one per student every 5 seconds), and the Session History card lists saved sessions.
const appReady = window.neuroFocusReady;
const historyEls = { rows: $("#sessionHistoryRows"), status: $("#sessionHistoryStatus") };
const SETUP_HINT = "Saved history needs the Phase 2 database update (see README).";
const missingTables = (error) => error && (error.code === "PGRST205" || error.code === "42P01" || /attention_sessions|attention_samples/.test(error.message || ""));
const shortTime = (date) => date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

function setHistoryStatus(text, isError = false) {
  historyEls.status.textContent = text;
  historyEls.status.dataset.state = isError ? "error" : "";
}

// After a refresh mid-session, rebuild the live view from this session's saved samples only.
let seededKey = "";
async function seedLiveFromSaved(classId, members) {
  const app = await appReady;
  if (!app || classId !== liveClassId || !sessionLive) return;
  const key = `${classId}:${sessionId || sessionSince}`;
  if (key === seededKey) return;
  seededKey = key;
  let query = app.supabase.from("attention_samples")
    .select("student_id, recorded_at, score, state")
    .eq("class_id", classId)
    .order("recorded_at", { ascending: true })
    .limit(3000);
  if (sessionId) {
    const { data: linked, error: linkError } = await app.supabase.from("attention_sessions").select("id").eq("class_session_id", sessionId);
    if (linkError || !linked?.length) return;
    query = query.in("session_id", linked.map((row) => row.id));
  } else {
    query = query.gte("recorded_at", sessionSince || new Date(Date.now() - 10 * 60 * 1000).toISOString());
  }
  const { data, error } = await query;
  if (classId !== liveClassId || error || !data?.length) return;

  // Attention curve: class average and lowest learner per 5-second slot
  // Samples without a measurement (tracking unavailable, a break, or an older "no face" sample
  // saved as 0) are gaps: they never pull the class average down.
  const slots = new Map();
  data.forEach((sample) => {
    const slot = Math.floor(new Date(sample.recorded_at).getTime() / 5000) * 5000;
    const entry = slots.get(slot) || { sum: 0, n: 0, min: 100 };
    const { score } = sampleKind(sample);
    if (score !== null) {
      entry.sum += score;
      entry.n += 1;
      entry.min = Math.min(entry.min, score);
    }
    slots.set(slot, entry);
  });
  const points = [...slots.entries()].sort((a, b) => a[0] - b[0]).slice(-HISTORY);
  classHistory.length = 0;
  lowHistory.length = 0;
  labels.length = 0;
  points.forEach(([slot, entry]) => {
    classHistory.push(entry.n ? entry.sum / entry.n : null);
    lowHistory.push(entry.n ? entry.min : null);
    labels.push(shortTime(new Date(slot)));
  });
  liveStartedAt = new Date(data[0].recorded_at).getTime();

  // Heatmap rows and distraction alerts per student (2+ unfocused samples in a row = 10s+)
  const names = new Map(members.map((member) => [member.id, member.name]));
  const byStudent = new Map();
  data.forEach((sample) => {
    if (!byStudent.has(sample.student_id)) byStudent.set(sample.student_id, []);
    byStudent.get(sample.student_id).push(sample);
  });
  const alerts = [];
  byStudent.forEach((samples, id) => {
    const name = names.get(id) || "Student";
    const student = liveStudents.get(id) || { name, score: null, status: "off", flagged: false, heat: [], distractedTicks: 0 };
    student.heat = samples.slice(-HEAT_COLUMNS).map((sample) => sampleKind(sample).score);
    liveStudents.set(id, student);
    // Two measured "looking away" samples in a row (10s+). Unavailable or break samples end a run.
    let run = 0;
    samples.forEach((sample) => {
      const { kind, score } = sampleKind(sample);
      run = kind === "looking-away" ? run + 1 : 0;
      if (run === 2) alerts.push({ name, score, at: new Date(sample.recorded_at) });
    });
  });
  alerts.sort((a, b) => a.at - b.at).forEach((alert) => {
    addAlert(alert.name, alert.score, "10s+ (saved)", alert.at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
  });
  render();
}

async function loadSessionHistory() {
  const app = await appReady;
  const classId = window.neuroFocusClass?.id;
  if (!app || !classId) {
    historyEls.rows.replaceChildren();
    setHistoryStatus("Select a class to see its saved sessions.");
    return;
  }
  const columns = "id, student_id, started_at, last_seen_at, ended_at, tracked_seconds, focus_percent, average_score, lapses, profiles(display_name)";
  const select = (cols) => selectWithQuality((quality) => app.supabase.from("attention_sessions").select(`${cols}${quality}`)
    .eq("class_id", classId).gt("tracked_seconds", 4).order("started_at", { ascending: false }).limit(25));
  let { data, error } = await select(`${columns}, class_session_id`);
  if (error && /class_session_id/.test(error.message || "")) ({ data, error } = await select(columns));
  // Which live session each record came from.
  const liveSessions = new Map();
  const sessionIds = [...new Set((data || []).map((row) => row.class_session_id).filter(Boolean))];
  if (sessionIds.length) {
    const { data: rows } = await app.supabase.from("class_sessions").select("id, started_at").in("id", sessionIds);
    (rows || []).forEach((row) => liveSessions.set(row.id, row.started_at));
  }
  if (classId !== window.neuroFocusClass?.id) return;
  historyEls.rows.replaceChildren();
  if (error) {
    setHistoryStatus(missingTables(error) ? SETUP_HINT : "Couldn’t load saved sessions. Refresh to try again.", true);
    return;
  }
  setHistoryStatus(data.length
    ? `Last ${data.length} saved session${data.length === 1 ? "" : "s"} in ${window.neuroFocusClass.name}. Updates every minute.`
    : `No saved sessions in ${window.neuroFocusClass.name} yet. They appear once students track their attention.`);
  data.forEach((session) => {
    const live = !session.ended_at && Date.now() - new Date(session.last_seen_at).getTime() < 30000;
    const minutes = Math.floor(session.tracked_seconds / 60);
    const liveStart = liveSessions.get(session.class_session_id);
    const cells = [
      session.profiles?.display_name || "Student",
      liveStart ? new Date(liveStart).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—",
      new Date(session.started_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
      `${minutes}:${String(session.tracked_seconds % 60).padStart(2, "0")}`,
      // Estimated share of measured time on screen. Older records (before tracking-quality checks)
      // counted time with no face in view as not focused, so they're marked.
      session.focus_percent === null ? (hasQualityInfo(session) ? "Not enough measured" : "—")
        : hasQualityInfo(session) ? `${session.focus_percent}% of ${Math.round(session.usable_seconds / 60)} min measured`
          : `${session.focus_percent}% (older method)`,
      session.average_score === null ? "—" : `${session.average_score}%`,
      String(session.lapses)
    ];
    const row = document.createElement("tr");
    cells.forEach((text) => {
      const cell = document.createElement("td");
      cell.textContent = text;
      row.append(cell);
    });
    const statusCell = document.createElement("td");
    const pill = document.createElement("span");
    pill.className = "state-pill";
    pill.dataset.state = live ? "Focused" : "Offline";
    pill.textContent = live ? "Live now" : "Ended";
    statusCell.append(pill);
    row.append(statusCell);
    historyEls.rows.append(row);
  });
}

window.addEventListener("neurofocus:roster-loaded", (event) => {
  const { classId, members } = event.detail;
  void seedLiveFromSaved(classId, members);
  void loadSessionHistory();
});
// A student stopping tracking finishes a session, so refresh the list shortly after.
window.addEventListener("neurofocus:live-attention", (event) => {
  if (event.detail?.state === "Stopped") window.setTimeout(() => { void loadSessionHistory(); }, 2500);
});
window.addEventListener("neurofocus:classchange", () => { if (!window.neuroFocusClass) void loadSessionHistory(); });
window.setInterval(() => { void loadSessionHistory(); }, 60000);

// ---------- Shared ----------
function updateFlagState(student) {
  const state = stateFor(student.score);
  student.distractedTicks = state === "Distracted" ? student.distractedTicks + 1 : 0;
  if (student.distractedTicks === FLAG_AFTER_READINGS) raiseFlag(student);
  if (state === "Focused") student.flagged = false;
}

function pushHeat(student, score) {
  student.heat.push(score);
  if (student.heat.length > HEAT_COLUMNS) student.heat.shift();
}

function pushHistory(scores) {
  classHistory.push(scores.length ? scores.reduce((sum, value) => sum + value, 0) / scores.length : null);
  lowHistory.push(scores.length ? Math.min(...scores) : null);
  labels.push(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
  if (classHistory.length > HISTORY) { classHistory.shift(); lowHistory.shift(); labels.shift(); }
}

function raiseFlag(student) {
  student.flagged = true;
  addAlert(student.name, student.score, `${FLAG_AFTER_READINGS}+ readings`,
    new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
}

function addAlert(name, score, duration, timeText) {
  flagCount += 1;
  const item = document.createElement("li");
  const dot = document.createElement("span");
  dot.className = "alert-dot";
  const body = document.createElement("div");
  const title = document.createElement("strong");
  title.textContent = `${name} may need a check-in`;
  const detail = document.createElement("small");
  detail.textContent = `Attention ${Math.round(score)}% for ${duration} · may be reading notes`;
  body.append(title, detail);
  const time = document.createElement("time");
  time.textContent = timeText;
  item.append(dot, body, time);
  els.alerts.querySelector(".empty-state")?.remove();
  els.alerts.prepend(item);
  while (els.alerts.children.length > 6) els.alerts.lastElementChild.remove();
}

function render() {
  const active = students.filter((student) => student.score !== null);
  const latest = [...classHistory].reverse().find((value) => value !== null);
  const recent = classHistory.slice(-6).filter((value) => value !== null);

  els.avg.textContent = latest === undefined || !active.length || !sessionLive ? "—" : `${Math.round(latest)}%`;
  if (sessionLive && active.length && recent.length > 1) {
    const delta = recent.at(-1) - recent[0];
    const span = `${recent.length - 1}s`;
    els.avgTrend.textContent = `${delta >= 0 ? "↗" : "↘"} ${Math.abs(delta).toFixed(1)} pts vs. ${span} ago`;
    els.avgTrend.dataset.trend = delta >= 0 ? "up" : "down";
  } else {
    els.avgTrend.textContent = sessionLive ? "Waiting for students to join" : "Start a live session to see scores";
    els.avgTrend.dataset.trend = "";
  }
  els.flags.textContent = String(flagCount);
  els.flagsSub.textContent = `Below ${DRIFTING}% for ${FLAG_AFTER_READINGS}+ readings in a row`;
  els.time.textContent = sessionLive ? elapsedLabel() : "—";
  els.timeSub.textContent = sessionLive ? "Live session time" : "No session running";

  const className = selectedClassName();
  const since = sessionSince ? new Date(sessionSince).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
  els.liveClassName.textContent = blockedClasses.has(liveClassId)
    ? "Live updates are blocked: run the Phase 2 database updates (see README), then refresh."
    : !className ? "Open a class to watch it live."
      : sessionLive ? `Live session in ${className}${since ? ` since ${since}` : ""} · ${active.length} of ${students.length} sharing attention.`
        : `${className} isn’t live. Press Start live session to begin.`;
  els.status.textContent = !sessionLive ? "Not live" : active.length ? `Live · ${active.length} sharing` : "Live · waiting for students";
  els.status.dataset.state = sessionLive ? "live" : "";

  renderBoard();
  renderHeatmap();
  if (chart) {
    chart.data.labels = labels;
    chart.data.datasets[0].data = classHistory;
    chart.data.datasets[1].data = lowHistory;
    chart.update("none");
  }
}

// One student's state on the board, and the line under their name.
function boardState(student) {
  if (student.score !== null) {
    const band = stateFor(student.score);
    const key = band === "Focused" ? "focused" : band === "Drifting" ? "mixed" : "away";
    // A flag means low readings several times in a row: they need attention even if just recovering.
    const group = student.flagged ? "attention" : BOARD[key].group;
    const text = student.flagged ? `${BOARD[key].label} · check in?` : BOARD[key].label;
    return { key, group, text, order: student.flagged ? 0 : BOARD[key].order };
  }
  const row = attendanceRows.classId === liveClassId ? attendanceRows.current.get(student.id) : null;
  if (student.status === "unavailable" || student.status === "stale") {
    const reason = student.status === "stale" ? STATUS_TEXT.stale : describeReading({ tracking: "unavailable", reason: student.reason }).detail || STATUS_TEXT.unavailable;
    return { key: "unmeasured", group: "unmeasured", text: reason, order: BOARD.unmeasured.order };
  }
  if (student.status === "break") return { key: "break", group: "unmeasured", text: BOARD.break.label, order: BOARD.break.order };
  if (!sessionLive) return { key: "offline", group: "absent", text: BOARD.offline.label, order: BOARD.offline.order };
  if (row?.joined_at) return { key: "joined", group: "unmeasured", text: BOARD.joined.label, order: BOARD.joined.order };
  return { key: "absent", group: "absent", text: BOARD.absent.label, order: BOARD.absent.order };
}

function renderBoard() {
  const states = new Map(students.map((student) => [student.id, boardState(student)]));
  renderSplit(states);
  renderFilters(states);

  // Not live: the steps to start, instead of a board of empty cards.
  const showBoard = sessionLive && students.length > 0;
  els.board.hidden = !showBoard;
  els.boardEmpty.hidden = showBoard;
  els.boardEmptyTitle.textContent = !students.length
    ? "No students in this class yet. Share its join code from the Master list tab."
    : `${selectedClassName() || "This class"} isn’t live`;
  if (!showBoard) { els.boardNone.hidden = true; return; }

  // Cards are kept and updated in place (no flicker); they're only re-ordered when the order changes.
  // Order: needs attention first, then mixed, focused, not measured, not joined; by name within each.
  const ids = new Set(students.map((student) => student.id));
  [...tiles.keys()].forEach((id) => { if (!ids.has(id)) { tiles.get(id).remove(); tiles.delete(id); } });
  const sorted = [...students].sort((a, b) => states.get(a.id).order - states.get(b.id).order || a.name.localeCompare(b.name));
  sorted.forEach((student) => updateTile(student, states.get(student.id)));
  const order = sorted.map((student) => student.id).join(",");
  if (order !== tileOrder) {
    tileOrder = order;
    els.board.append(...sorted.map((student) => tiles.get(student.id)));
  }
  let shown = 0;
  sorted.forEach((student) => {
    const visible = boardFilter === "all" || states.get(student.id).group === boardFilter;
    tiles.get(student.id).hidden = !visible;
    if (visible) shown += 1;
  });
  els.boardNone.hidden = shown > 0;
}

function updateTile(student, state) {
  let tile = tiles.get(student.id);
  if (!tile) {
    tile = document.createElement("article");
    tile.className = "live-tile";
    tile.dataset.rosterRow = "";
    tile.innerHTML = '<div class="lt-top"><span class="mini-avatar lt-avatar"></span><div class="lt-who"><b class="lt-name"></b><small class="lt-status"></small></div><strong class="lt-score"></strong></div><div class="lt-spark" aria-hidden="true"></div>';
    const spark = tile.querySelector(".lt-spark");
    for (let i = 0; i < HEAT_COLUMNS; i += 1) spark.append(document.createElement("span"));
    tiles.set(student.id, tile);
  }
  const tracking = student.score !== null;
  const score = tracking ? `${Math.round(student.score)}%` : "—";
  const late = attendanceRows.classId === liveClassId && attendanceRows.current.get(student.id)?.status === "late";
  tile.dataset.state = state.key;
  tile.dataset.group = state.group;
  tile.toggleAttribute("data-flagged", Boolean(student.flagged));
  // Read by the Export CSV button (scripts/shared/app.js).
  tile.dataset.name = student.name;
  tile.dataset.score = score;
  tile.dataset.status = state.text;
  tile.querySelector(".lt-name").textContent = student.name;
  tile.querySelector(".lt-status").textContent = late && sessionLive ? `${state.text} · late` : state.text;
  tile.querySelector(".lt-score").textContent = score;
  tile.setAttribute("aria-label", `${student.name}: ${tracking ? `attention ${score}, ` : ""}${state.text}`);
  const avatar = tile.querySelector(".lt-avatar");
  const look = `${student.avatarPreset || ""}|${student.avatarUrl || ""}|${student.name}`;
  if (avatar.dataset.look !== look) {
    avatar.dataset.look = look;
    paintAvatar(avatar, { name: student.name, preset: student.avatarPreset, url: student.avatarUrl });
  }
  // The last 20 readings as small bars (empty = not measured).
  const bars = tile.querySelector(".lt-spark").children;
  const offset = HEAT_COLUMNS - student.heat.length;
  for (let i = 0; i < HEAT_COLUMNS; i += 1) {
    const value = i >= offset ? student.heat[i - offset] : null;
    const bar = bars[i];
    if (value === null || value === undefined) {
      bar.removeAttribute("data-state");
      bar.style.height = "";
    } else {
      bar.dataset.state = stateFor(value);
      bar.style.height = `${Math.max(12, Math.round(value))}%`;
    }
  }
}

function renderSplit(states) {
  if (!sessionLive) {
    els.splitBar.replaceChildren();
    els.splitLegend.replaceChildren(Object.assign(document.createElement("li"), { className: "split-idle", textContent: "Start a live session to see how the class splits." }));
    return;
  }
  const counts = Object.fromEntries(SPLIT.map(({ key }) => [key, 0]));
  states.forEach((state) => { if (counts[state.group] !== undefined) counts[state.group] += 1; });
  const inSession = SPLIT.reduce((sum, { key }) => sum + counts[key], 0);
  if (!inSession) {
    els.splitBar.replaceChildren();
    els.splitLegend.replaceChildren(Object.assign(document.createElement("li"), { className: "split-idle", textContent: "Waiting for students to join the session." }));
    return;
  }
  const total = inSession;
  els.splitBar.replaceChildren(...SPLIT.filter(({ key }) => counts[key]).map(({ key }) => {
    const part = document.createElement("span");
    part.dataset.group = key;
    part.style.flexGrow = String(counts[key]);
    part.style.flexBasis = `${(counts[key] / total) * 100}%`;
    return part;
  }));
  els.splitLegend.replaceChildren(...SPLIT.map(({ key, label }) => {
    const item = document.createElement("li");
    item.dataset.group = key;
    const value = document.createElement("b");
    value.textContent = String(counts[key]);
    item.append(value, ` ${label}`);
    return item;
  }), Object.assign(document.createElement("li"), { className: "split-total", textContent: `of ${inSession} in the session` }));
}

function renderFilters(states) {
  const counts = { all: students.length };
  states.forEach((state) => { counts[state.group] = (counts[state.group] || 0) + 1; });
  if (!els.filters.children.length) {
    FILTERS.forEach(({ key, label }) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "filter-chip";
      button.dataset.filter = key;
      button.append(label, Object.assign(document.createElement("span"), { className: "filter-count" }));
      button.addEventListener("click", () => { boardFilter = key; render(); });
      els.filters.append(button);
    });
  }
  els.filters.hidden = !sessionLive || !students.length;
  [...els.filters.children].forEach((button) => {
    const key = button.dataset.filter;
    button.setAttribute("aria-pressed", String(key === boardFilter));
    button.querySelector(".filter-count").textContent = String(counts[key] || 0);
    button.dataset.alert = key === "attention" && counts.attention ? "true" : "";
  });
}

function renderHeatmap() {
  els.heatmap.replaceChildren();
  students.forEach((student) => {
    const label = document.createElement("div");
    label.className = "heat-label";
    label.textContent = student.name;
    els.heatmap.append(label);
    const offset = HEAT_COLUMNS - student.heat.length;
    for (let i = 0; i < HEAT_COLUMNS; i += 1) {
      const cell = document.createElement("div");
      cell.className = "heat-cell";
      const score = i >= offset ? student.heat[i - offset] : null;
      if (score !== null && score !== undefined) {
        cell.dataset.state = stateFor(score);
        cell.style.setProperty("--level", (0.25 + (score / 100) * 0.75).toFixed(2));
        cell.title = `${student.name}: ${Math.round(score)}%`;
      }
      els.heatmap.append(cell);
    }
  });
}

function setupChart() {
  if (!window.Chart) {
    $("#attentionChart").replaceWith(Object.assign(document.createElement("p"), {
      className: "empty-state",
      textContent: "Chart library could not load. Check your internet connection and refresh."
    }));
    return;
  }
  chart = new window.Chart($("#attentionChart"), {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Class average", data: classHistory, borderWidth: 2, tension: 0.35,
          pointRadius: 0, fill: true
        },
        {
          label: "Lowest student", data: lowHistory, borderWidth: 1.5, borderDash: [4, 4],
          tension: 0.35, pointRadius: 0, fill: false
        }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: "index", intersect: false },
      scales: {
        y: { min: 0, max: 100, ticks: { callback: (v) => `${v}%`, stepSize: 25 }, grid: {}, border: { display: false } },
        x: { ticks: { maxTicksLimit: 6 }, grid: { display: false }, border: {} }
      },
      plugins: {
        legend: { labels: { boxWidth: 10, boxHeight: 10, usePointStyle: true } },
        tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${Math.round(ctx.parsed.y)}%` } }
      }
    }
  });
  paintChart();
  window.addEventListener("neurofocus:appearance-change", paintChart);
}

// Colours from the current theme; repainted when the teacher previews or saves a new look.
function paintChart() {
  if (!chart) return;
  const accent = themeColor("--accent", "#00d9ff");
  const muted = themeColor("--text-muted");
  const [average, lowest] = chart.data.datasets;
  average.borderColor = accent;
  average.backgroundColor = withAlpha(accent, 0.1);
  lowest.borderColor = themeColor("--red", "#ef4444");
  chart.options.scales.y.ticks.color = muted;
  chart.options.scales.x.ticks.color = muted;
  chart.options.scales.y.grid.color = themeColor("--surface-hover", "#1c1c20");
  chart.options.scales.x.border.color = themeColor("--border", "#222226");
  chart.options.plugins.legend.labels.color = themeColor("--text-main", "#f4f4f5");
  chart.update("none");
}

function clearData() {
  tick = 0;
  flagCount = 0;
  students = [];
  tiles.forEach((tile) => tile.remove());
  tiles.clear();
  tileOrder = "";
  boardFilter = "all";
  classHistory.length = 0;
  lowHistory.length = 0;
  labels.length = 0;
  els.alerts.replaceChildren(Object.assign(document.createElement("p"), {
    className: "empty-state", textContent: "No check-in alerts yet."
  }));
}

// Live readings are collected every second while the dashboard is open.
function startLive() {
  clearData();
  resetLive();
  window.clearInterval(timer);
  timer = window.setInterval(liveStep, LIVE_TICK_MS);
  liveStep();
  seededKey = "";
  if (liveClassId) void seedLiveFromSaved(liveClassId, rosterMembers());
}

setupChart();
try { localStorage.removeItem("neuroFocusTeacherMode"); } catch { /* storage unavailable */ }
startLive();
// teacher-classes.js may have picked a class before this script started listening.
void loadSessionHistory();
