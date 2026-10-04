// Attendance for the open class: summary numbers, attendance by student, and every saved live
// session with editable marks (present, late, absent, excused), plus a spreadsheet download.
// Marks are taken automatically by the database (see 20261005000000_sessions_attendance.sql).
// It also publishes "neurofocus:attendance" so the master list (teacher-classes.js) can show
// each student's attendance and who has joined the live session.
import { confirmAction, notify, isMissingSql } from "../shared/class-live.js?v=8";

const app = await window.neuroFocusReady;

if (app) {
  const { supabase } = app;
  const $ = (selector) => document.querySelector(selector);
  const PAGE = 1000;           // Supabase returns at most 1,000 rows per request
  const SESSIONS_SHOWN = 10;
  const LIVE_POLL_MS = 8000;
  const LOW_RATE = 75;
  const STATUS_LABELS = { present: "Present", late: "Late", absent: "Absent", excused: "Excused", invited: "Not joined yet" };

  let classId = window.neuroFocusClass?.id || "";
  let liveSession = window.neuroFocusLiveSession || null;
  let sessions = [];            // newest first
  let rows = [];                // all attendance rows for the class
  let focus = new Map();        // "sessionId:studentId" -> { tracked, focused } seconds shared in that session
  let missing = false;
  let loadedFor = "";
  let shown = SESSIONS_SHOWN;
  const openSessions = new Set();
  let loadToken = 0;
  let pollTimer;

  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const time = (iso) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const day = (iso) => new Date(iso).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", ...(new Date(iso).getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}) });
  const minutes = (seconds) => (seconds < 60 ? (seconds > 0 ? "<1 min" : "—") : `${Math.round(seconds / 60)} min`);
  const roster = () => (Array.isArray(window.neuroFocusRoster) ? window.neuroFocusRoster : []);
  const isOpen = (session) => !session.ended_at;

  // ---------- Data ----------
  async function fetchAll(build) {
    const all = [];
    for (let page = 0; page < 20; page += 1) {
      const { data, error } = await build().range(page * PAGE, page * PAGE + PAGE - 1);
      if (error) throw error;
      all.push(...data);
      if (data.length < PAGE) break;
    }
    return all;
  }

  async function load() {
    const token = ++loadToken;
    const target = classId;
    if (!target) return;
    try {
      const [sessionData, rowData] = await Promise.all([
        fetchAll(() => supabase.from("class_sessions").select("id, started_at, ended_at, late_after_minutes").eq("class_id", target).order("started_at", { ascending: false })),
        fetchAll(() => supabase.from("session_attendance")
          .select("session_id, student_id, student_name, status, joined_at, last_seen_at, attended_seconds, removed_at, marked_by_teacher")
          .eq("class_id", target).order("session_id").order("student_id"))
      ]);
      // Attention each student shared during each live session (needs the live-workflow SQL).
      const linked = await supabase.from("attention_sessions")
        .select("class_session_id, student_id, tracked_seconds, focus_percent")
        .eq("class_id", target).not("class_session_id", "is", null).limit(5000);
      if (token !== loadToken || target !== classId) return;
      missing = false;
      sessions = sessionData;
      rows = rowData;
      focus = new Map();
      (linked.error ? [] : linked.data).forEach((row) => {
        const key = `${row.class_session_id}:${row.student_id}`;
        const entry = focus.get(key) || { tracked: 0, focused: 0 };
        entry.tracked += row.tracked_seconds || 0;
        entry.focused += ((row.tracked_seconds || 0) * (row.focus_percent ?? 0)) / 100;
        focus.set(key, entry);
      });
    } catch (error) {
      if (token !== loadToken) return;
      missing = isMissingSql(error);
      if (!missing) console.warn("Could not load attendance", error);
      sessions = [];
      rows = [];
      $("#attendanceStatus").textContent = missing
        ? "Attendance needs a database update: run supabase/migrations/20261005000000_sessions_attendance.sql (see README)."
        : "Couldn’t load attendance. Refresh to try again.";
    }
    loadedFor = target;
    render();
    schedulePoll();
  }

  // While this class is live, keep its session's marks fresh (who has joined, minutes present).
  async function refreshLiveRows() {
    const sessionId = liveSession?.live && liveSession.classId === classId ? liveSession.sessionId : null;
    if (!sessionId || missing) return;
    const { data, error } = await supabase.from("session_attendance")
      .select("session_id, student_id, student_name, status, joined_at, last_seen_at, attended_seconds, removed_at, marked_by_teacher")
      .eq("session_id", sessionId);
    if (error || classId !== loadedFor) return;
    if (!sessions.some((session) => session.id === sessionId)) { void load(); return; }
    rows = rows.filter((row) => row.session_id !== sessionId).concat(data);
    render();
  }

  function schedulePoll() {
    window.clearInterval(pollTimer);
    if (liveSession?.live && liveSession.classId === classId && liveSession.sessionId) {
      pollTimer = window.setInterval(() => { if (document.visibilityState === "visible") void refreshLiveRows(); }, LIVE_POLL_MS);
    }
  }

  // ---------- Numbers ----------
  // Attendance rate = (present + late) / (present + late + absent) over ended sessions; excused don't count.
  function summarize() {
    const ended = new Set(sessions.filter((session) => !isOpen(session)).map((session) => session.id));
    const names = new Map(roster().map((member) => [member.id, member.name]));
    const byStudent = new Map();
    roster().forEach((member) => byStudent.set(member.id, { id: member.id, name: member.name, inClass: true, present: 0, late: 0, absent: 0, excused: 0 }));
    rows.forEach((row) => {
      if (!byStudent.has(row.student_id)) {
        byStudent.set(row.student_id, { id: row.student_id, name: names.get(row.student_id) || row.student_name, inClass: names.has(row.student_id), present: 0, late: 0, absent: 0, excused: 0 });
      }
      if (!ended.has(row.session_id)) return;
      const stats = byStudent.get(row.student_id);
      const status = row.status === "invited" ? "absent" : row.status;
      stats[status] += 1;
    });
    byStudent.forEach((stats) => {
      stats.attended = stats.present + stats.late;
      stats.counted = stats.attended + stats.absent;
      stats.rate = stats.counted ? Math.round((stats.attended / stats.counted) * 100) : null;
    });
    const openId = liveSession?.live && liveSession.classId === classId ? liveSession.sessionId : null;
    const current = new Map(rows.filter((row) => row.session_id === openId).map((row) => [row.student_id, row]));
    return { byStudent, current, endedCount: ended.size };
  }

  function publish(summary) {
    window.dispatchEvent(new CustomEvent("neurofocus:attendance", {
      detail: { classId: loadedFor, current: summary.current, byStudent: summary.byStudent }
    }));
  }

  // ---------- Rendering ----------
  function render() {
    if (loadedFor !== classId) return;
    const summary = summarize();
    publish(summary);
    const content = $("#attendanceContent");
    content.hidden = missing;
    if (missing) return;
    renderStats(summary);
    renderStudents(summary);
    renderSessions();
    const live = sessions.find(isOpen);
    $("#attendanceStatus").textContent = !sessions.length
      ? "No live sessions yet. Start one and attendance is taken automatically: everyone on the master list is invited, and students are marked present when they join."
      : `${plural(summary.endedCount, "finished session")}${live ? " · 1 live now" : ""}. Students are marked late if they join more than ${plural(live?.late_after_minutes ?? sessions[0].late_after_minutes, "minute")} after the start; change any mark below.`;
  }

  function renderStats(summary) {
    const students = [...summary.byStudent.values()];
    const attended = students.reduce((sum, stats) => sum + stats.attended, 0);
    const counted = students.reduce((sum, stats) => sum + stats.counted, 0);
    const late = students.reduce((sum, stats) => sum + stats.late, 0);
    const low = students.filter((stats) => stats.inClass && stats.rate !== null && stats.rate < LOW_RATE);
    const lastEnded = sessions.find((session) => !isOpen(session));
    $("#attSessions").textContent = String(summary.endedCount);
    $("#attSessionsNote").textContent = lastEnded ? `Last: ${day(lastEnded.started_at)}` : "None finished yet";
    $("#attRate").textContent = counted ? `${Math.round((attended / counted) * 100)}%` : "—";
    $("#attRateNote").textContent = counted ? `${attended} of ${plural(counted, "expected attendance")}` : "Across finished sessions";
    $("#attLate").textContent = attended ? `${Math.round((late / attended) * 100)}%` : "—";
    $("#attLateNote").textContent = attended ? `${plural(late, "late arrival")}` : "Of students who came";
    $("#attLow").textContent = String(low.length);
    $("#attLowNote").textContent = low.length ? `Below ${LOW_RATE}%: ${low.slice(0, 2).map((stats) => stats.name).join(", ")}${low.length > 2 ? "…" : ""}` : `No one below ${LOW_RATE}%`;
  }

  function rateBar(rate) {
    const wrap = el("span", "att-rate");
    if (rate === null) { wrap.append(el("span", "muted", "—")); return wrap; }
    wrap.dataset.level = rate >= 90 ? "good" : rate >= LOW_RATE ? "ok" : "low";
    const bar = el("span", "att-bar");
    const fill = el("span");
    fill.style.width = `${rate}%`;
    bar.append(fill);
    wrap.append(bar, `${rate}%`);
    return wrap;
  }

  function renderStudents(summary) {
    const body = $("#attStudentRows");
    const students = [...summary.byStudent.values()]
      .sort((a, b) => (a.rate ?? 101) - (b.rate ?? 101) || a.name.localeCompare(b.name));
    if (!students.length) {
      const row = el("tr");
      const cell = el("td", "empty-state", "No students on the master list yet.");
      cell.colSpan = 6;
      row.append(cell);
      body.replaceChildren(row);
      return;
    }
    body.replaceChildren(...students.map((stats) => {
      const row = el("tr");
      const name = el("td");
      name.append(stats.name);
      if (!stats.inClass) name.append(el("span", "left-tag", "Left class"));
      const rate = el("td");
      rate.append(rateBar(stats.rate));
      row.append(name, el("td", "num", String(stats.present)), el("td", "num", String(stats.late)), el("td", "num", String(stats.absent)), el("td", "num", String(stats.excused)), rate);
      return row;
    }));
  }

  function counts(sessionId) {
    const result = { present: 0, late: 0, absent: 0, excused: 0, invited: 0 };
    rows.forEach((row) => { if (row.session_id === sessionId) result[row.status] += 1; });
    return result;
  }

  function renderSessions() {
    const list = $("#attSessionList");
    if (!sessions.length) {
      list.replaceChildren(el("li", "empty-state", "Sessions you run appear here with their attendance."));
      $("#attMore").hidden = true;
      return;
    }
    list.replaceChildren(...sessions.slice(0, shown).map(sessionItem));
    const more = $("#attMore");
    more.hidden = sessions.length <= shown;
    more.textContent = `Show older sessions (${sessions.length - shown})`;
  }

  function chip(kind, value, label) {
    const node = el("span", `att-chip ${kind}`);
    node.append(el("b", "", String(value)), ` ${label}`);
    return node;
  }

  function sessionItem(session) {
    const item = el("li", "att-session");
    const open = openSessions.has(session.id);
    item.dataset.open = String(open);
    const button = el("button", "att-session-row");
    button.type = "button";
    button.setAttribute("aria-expanded", String(open));
    const c = counts(session.id);
    const when = el("span", "att-when");
    const title = el("b", "", day(session.started_at));
    if (isOpen(session)) {
      const live = el("span", "live-pill");
      live.append(el("span", "live-dot"), "Live");
      title.append(live);
    }
    const length = session.ended_at ? Math.round((new Date(session.ended_at) - new Date(session.started_at)) / 60000) : null;
    when.append(title, el("small", "", `${time(session.started_at)}${session.ended_at ? ` – ${time(session.ended_at)} · ${length} min` : " · in progress"}`));
    const chips = el("span", "att-chips");
    chips.append(chip("present", c.present, "present"), chip("late", c.late, "late"));
    if (isOpen(session)) chips.append(chip("invited", c.invited, "not joined"));
    else chips.append(chip("absent", c.absent, "absent"));
    if (c.excused) chips.append(chip("excused", c.excused, "excused"));
    const expected = c.present + c.late + c.absent + (isOpen(session) ? c.invited : 0);
    const rate = expected ? Math.round(((c.present + c.late) / expected) * 100) : null;
    const chevron = el("span", "att-chevron", "›");
    chevron.setAttribute("aria-hidden", "true");
    // A session still in progress shows how many have joined rather than a (low-looking) rate.
    const summary = isOpen(session) ? el("span", "att-rate muted", `${c.present + c.late} of ${expected} joined`) : rateBar(rate);
    button.append(when, chips, summary, chevron);

    const detail = el("div", "att-detail");
    detail.hidden = !open;
    button.addEventListener("click", () => {
      const next = item.dataset.open !== "true";
      item.dataset.open = String(next);
      button.setAttribute("aria-expanded", String(next));
      detail.hidden = !next;
      if (next) { openSessions.add(session.id); renderDetail(session, detail); } else openSessions.delete(session.id);
    });
    if (open) renderDetail(session, detail);
    item.append(button, detail);
    return item;
  }

  function renderDetail(session, detail) {
    const names = new Map(roster().map((member) => [member.id, member.name]));
    const sessionRows = rows.filter((row) => row.session_id === session.id)
      .map((row) => ({ ...row, name: names.get(row.student_id) || row.student_name, inClass: names.has(row.student_id) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const table = el("table", "data-table att-table");
    const head = el("thead");
    const headRow = el("tr");
    ["Student", "Mark", "Joined", "Time in session", "Focus", ""].forEach((label) => headRow.append(el("th", "", label)));
    head.append(headRow);
    const body = el("tbody");
    if (!sessionRows.length) {
      const row = el("tr");
      const cell = el("td", "empty-state", "No one was on the master list for this session.");
      cell.colSpan = 6;
      row.append(cell);
      body.append(row);
    }
    sessionRows.forEach((row) => {
      const tr = el("tr");
      const name = el("td");
      name.append(row.name);
      if (!row.inClass) name.append(el("span", "left-tag", "Left class"));
      const markCell = el("td");
      const select = el("select", "field-select att-mark");
      select.dataset.status = row.status;
      select.setAttribute("aria-label", `Attendance for ${row.name}`);
      const options = row.status === "invited" ? ["invited", "present", "late", "absent", "excused"] : ["present", "late", "absent", "excused"];
      options.forEach((value) => {
        const option = el("option", "", STATUS_LABELS[value]);
        option.value = value;
        if (value === "invited") option.disabled = true;
        select.append(option);
      });
      select.value = row.status;
      select.addEventListener("change", () => { void setMark(session, row, select); });
      markCell.append(select);
      if (row.marked_by_teacher) markCell.append(el("span", "edited-tag", "edited"));
      const notes = el("td", "muted");
      if (row.removed_at) notes.textContent = `Removed from session ${time(row.removed_at)}`;
      const shared = focus.get(`${session.id}:${row.student_id}`);
      const focusText = shared?.tracked >= 5 ? `${Math.round((shared.focused / shared.tracked) * 100)}% of ${minutes(shared.tracked)}` : "—";
      const focusCell = el("td", shared?.tracked >= 5 ? "" : "muted", focusText);
      focusCell.title = shared?.tracked >= 5 ? "Share of tracked time spent looking at the screen" : "No attention was shared in this session";
      tr.append(name, markCell, el("td", "", row.joined_at ? time(row.joined_at) : "—"), el("td", "", minutes(row.attended_seconds)), focusCell, notes);
      body.append(tr);
    });
    table.append(head, body);
    const scroll = el("div", "table-scroll");
    scroll.style.maxHeight = "none";
    scroll.append(table);
    const foot = el("div", "att-detail-foot");
    foot.append(el("span", "muted", isOpen(session)
      ? "Marks update as students join. Anyone who hasn’t joined by the end is marked absent."
      : "Change a mark if it isn’t right, for example to excuse an absence."));
    if (!isOpen(session)) {
      const remove = el("button", "btn-remove", "Delete this session");
      remove.type = "button";
      remove.addEventListener("click", () => { void deleteSession(session); });
      foot.append(remove);
    }
    detail.replaceChildren(scroll, foot);
  }

  // ---------- Actions ----------
  async function setMark(session, row, select) {
    const next = select.value;
    const previous = row.status;
    select.disabled = true;
    const { error } = await supabase.rpc("set_attendance", { p_session_id: session.id, p_student_id: row.student_id, p_status: next });
    select.disabled = false;
    if (error) {
      select.value = previous;
      notify({ title: "Couldn’t change the mark", text: error.message, kind: "error", timeoutMs: 9000 });
      return;
    }
    const stored = rows.find((item) => item.session_id === session.id && item.student_id === row.student_id);
    if (stored) { stored.status = next; stored.marked_by_teacher = true; }
    render();
  }

  async function deleteSession(session) {
    const ok = await confirmAction({
      title: "Delete this session’s attendance?",
      message: `The ${day(session.started_at)} ${time(session.started_at)} session and its attendance marks will be removed. This can’t be undone.`,
      confirmLabel: "Delete session",
      danger: true
    });
    if (!ok) return;
    const { error, count } = await supabase.from("class_sessions").delete({ count: "exact" }).eq("id", session.id);
    if (error || !count) {
      notify({ title: "Couldn’t delete the session", text: error?.message || "Try again.", kind: "error", timeoutMs: 9000 });
      return;
    }
    notify({ title: "Session deleted", kind: "success" });
    await load();
  }

  // Spreadsheet: one row per student, one column per session, then totals.
  function downloadCsv() {
    const summary = summarize();
    const chronological = sessions.slice().reverse();
    const marks = new Map(rows.map((row) => [`${row.session_id}:${row.student_id}`, row.status]));
    const header = ["Student", ...chronological.map((session) => `${day(session.started_at)} ${time(session.started_at)}${isOpen(session) ? " (live)" : ""}`), "Present", "Late", "Absent", "Excused", "Attendance %"];
    const lines = [...summary.byStudent.values()].sort((a, b) => a.name.localeCompare(b.name)).map((stats) => [
      stats.inClass ? stats.name : `${stats.name} (left class)`,
      ...chronological.map((session) => STATUS_LABELS[marks.get(`${session.id}:${stats.id}`)] || ""),
      stats.present, stats.late, stats.absent, stats.excused, stats.rate === null ? "" : stats.rate
    ]);
    const csv = [header, ...lines].map((line) => line.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(",")).join("\r\n");
    const name = (window.neuroFocusClass?.name || "class").replace(/[^\w-]+/g, "-").replace(/^-|-$/g, "").toLowerCase();
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob(["﻿", csv], { type: "text/csv;charset=utf-8" }));
    link.download = `attendance-${name || "class"}-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  // ---------- Wiring ----------
  $("#attDownload").addEventListener("click", () => {
    if (!sessions.length) {
      notify({ title: "No attendance yet", text: "Run a live session first, then download its attendance." });
      return;
    }
    downloadCsv();
  });
  $("#attMore").addEventListener("click", () => {
    shown += SESSIONS_SHOWN;
    renderSessions();
  });

  window.addEventListener("neurofocus:classchange", (event) => {
    const next = event.detail?.id || "";
    if (next === classId) return;
    classId = next;
    shown = SESSIONS_SHOWN;
    openSessions.clear();
    sessions = [];
    rows = [];
    loadedFor = "";
    if (classId) void load();
    else window.clearInterval(pollTimer);
  });
  window.addEventListener("neurofocus:live-session", (event) => {
    const before = liveSession?.sessionId;
    liveSession = event.detail || null;
    if (liveSession?.sessionId && liveSession.sessionId !== before) openSessions.add(liveSession.sessionId);
    void load();
  });
  window.addEventListener("neurofocus:attendance-refresh", () => { void load(); });
  window.addEventListener("neurofocus:roster-loaded", () => render());
  window.addEventListener("focus", () => { if (classId) void load(); });

  if (classId) void load();
}
