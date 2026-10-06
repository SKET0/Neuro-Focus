// Teacher pages that look across every class: All students (#allStudentsView) and the attendance
// report (#reportView). teacher-classes.js shows and hides them; this module fills them in.
//
// Everything is read with the teacher's existing access to their own classes: the master lists
// (class_members + profiles), live sessions (class_sessions), attendance marks (session_attendance)
// and focus shared during live sessions (attention_sessions). Attendance only counts finished
// sessions: rate = (present + late) / (present + late + absent); excused doesn't count, and a
// student who never joined ("invited") counts as absent, the same as the class Attendance tab.
import { paintAvatar, avatarUrls } from "../shared/avatars.js?v=1";
import { themeColor, withAlpha } from "../shared/appearance.js?v=1";
import { averageFocus, levelFor } from "../student/focus-analysis.js?v=2";
import { selectWithQuality } from "../shared/tracking-states.js?v=1";

const app = await window.neuroFocusReady;

if (app && document.querySelector("#allStudentsView")) {
  const { supabase } = app;
  const $ = (selector) => document.querySelector(selector);
  const DAY = 86400000;
  const LOW_RATE = 75;       // the same line as the class Attendance tab
  const LOW_FOCUS = 50;
  const STUDENT_DAYS = 30;   // All students looks at the last 30 days
  const PAGE = 1000;         // Supabase returns at most this many rows per request
  const SESSIONS_SHOWN = 15;

  let status = window.neuroFocusTeacherStatus || { loaded: false, classes: [] };
  const cache = new Map();   // days -> { at, classKey, data }
  let reportDays = 30;
  let classFilter = "all";
  let sessionsShown = SESSIONS_SHOWN;
  let chart = null;
  let pictures = new Map();
  try {
    const saved = Number(localStorage.getItem(`neuroFocusReportRange:${app.user.id}`));
    if ([7, 30, 90].includes(saved)) reportDays = saved;
  } catch { /* storage unavailable */ }

  // ---------- Helpers ----------
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const plural = (n, word) => `${n} ${n === 1 ? word : word.endsWith("s") ? `${word}es` : `${word}s`}`;
  const pct = (part, whole) => (whole ? Math.round((part / whole) * 100) : null);
  const className = (id) => status.classes.find((item) => item.id === id)?.name || "Former class";
  const actions = () => window.neuroFocusTeacherActions || {};
  const shortDate = (iso) => new Date(iso).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  function ago(iso) {
    if (!iso) return "—";
    const days = Math.floor((Date.now() - new Date(iso)) / DAY);
    return days <= 0 ? "Today" : days === 1 ? "Yesterday" : days < 7 ? `${days} days ago` : shortDate(iso);
  }
  // Each class's colour, the same as on the student pages (student-dashboard.js, student-notes.js).
  const CLASS_COLORS = ["#22d3ee", "#a78bfa", "#4ade80", "#fb923c", "#60a5fa", "#f472b6", "#facc15", "#2dd4bf"];
  const classColor = (id) => CLASS_COLORS[[...String(id)].reduce((total, ch) => (total * 31 + ch.charCodeAt(0)) % 997, 7) % CLASS_COLORS.length];

  function rateCell(rate, detail) {
    const wrap = el("span", "att-rate");
    if (rate === null) { wrap.textContent = "No sessions yet"; wrap.classList.add("muted"); return wrap; }
    wrap.dataset.level = rate >= 90 ? "good" : rate >= LOW_RATE ? "ok" : "low";
    const bar = el("span", "att-bar");
    const fill = el("span");
    fill.style.width = `${rate}%`;
    bar.append(fill);
    wrap.append(bar, `${rate}%`);
    if (detail) wrap.title = detail;
    return wrap;
  }

  function classTag(classId, tab = "students") {
    const tag = el("button", "class-pill", className(classId));
    tag.type = "button";
    tag.style.setProperty("--class-color", classColor(classId));
    tag.title = `Open ${className(classId)}`;
    tag.addEventListener("click", (event) => { event.stopPropagation(); actions().openClass?.(classId, tab); });
    return tag;
  }

  // Spreadsheet cells: quoted, and never read as a formula when opened in a spreadsheet app.
  function downloadCsv(name, rows) {
    const cell = (value) => {
      let text = String(value ?? "");
      if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
      return `"${text.replace(/"/g, '""')}"`;
    };
    const csv = rows.map((row) => row.map(cell).join(",")).join("\r\n");
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob(["﻿", csv], { type: "text/csv;charset=utf-8" }));
    link.download = `${name}-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  // ---------- Data ----------
  // Reads every page of a query (ordered, so pages don't overlap).
  async function fetchAll(makeQuery) {
    const rows = [];
    for (let page = 0; page < 30; page += 1) {
      const { data, error } = await makeQuery().range(page * PAGE, page * PAGE + PAGE - 1);
      if (error) return { data: rows, error };
      rows.push(...(data || []));
      if (!data || data.length < PAGE) break;
    }
    return { data: rows, error: null };
  }

  async function load(days, { force = false } = {}) {
    const ids = status.classes.map((item) => item.id);
    const classKey = ids.slice().sort().join(",");
    const cached = cache.get(days);
    if (!force && cached && cached.classKey === classKey && Date.now() - cached.at < 60000) return cached.data;
    if (!ids.length) {
      const data = { members: [], sessions: [], attendance: [], focus: [], error: null };
      cache.set(days, { at: Date.now(), classKey, data });
      return data;
    }
    const since = new Date(Date.now() - days * DAY).toISOString();
    const members = (fields) => fetchAll(() => supabase.from("class_members")
      .select(`class_id, student_id, profiles(${fields})`).in("class_id", ids).order("class_id").order("student_id"));
    const [roster, sessions, attendance, focus] = await Promise.all([
      members("display_name, avatar_preset, avatar_path").then((result) => (result.error ? members("display_name") : result)),
      fetchAll(() => supabase.from("class_sessions").select("id, class_id, started_at, ended_at")
        .in("class_id", ids).gte("started_at", since).order("started_at", { ascending: false }).order("id")),
      fetchAll(() => supabase.from("session_attendance").select("session_id, class_id, student_id, student_name, status")
        .in("class_id", ids).gte("invited_at", since).order("session_id").order("student_id")),
      selectWithQuality((quality) => fetchAll(() => supabase.from("attention_sessions").select(`id, class_id, student_id, started_at, tracked_seconds, focus_percent${quality}`)
        .in("class_id", ids).gte("started_at", since).gt("tracked_seconds", 4).order("started_at").order("id")))
    ]);
    const data = {
      members: roster.data,
      sessions: sessions.data,
      attendance: attendance.data,
      focus: focus.error ? [] : focus.data,
      error: roster.error || sessions.error || attendance.error
    };
    cache.set(days, { at: Date.now(), classKey, data });
    void loadPictures(data);
    return data;
  }

  // Student pictures are private; storage gives this teacher short-lived links for their own students.
  async function loadPictures(data) {
    const paths = data.members.map((member) => member.profiles?.avatar_path).filter(Boolean);
    if (!paths.length) return;
    pictures = await avatarUrls(supabase, paths);
    document.querySelectorAll("[data-avatar-path]").forEach((node) => {
      const url = pictures.get(node.dataset.avatarPath);
      if (url) paintAvatar(node, { name: node.dataset.name, preset: node.dataset.preset || null, url });
    });
  }

  function avatar(student, size = "sm") {
    const face = el("span", `nf-avatar ${size}`);
    paintAvatar(face, { name: student.name, preset: student.preset, url: pictures.get(student.path) || null });
    if (student.path) Object.assign(face.dataset, { avatarPath: student.path, name: student.name, preset: student.preset || "" });
    return face;
  }

  // Per student: their classes and their attendance and focus in finished sessions.
  function summarize(data) {
    const ended = new Map(data.sessions.filter((s) => s.ended_at).map((s) => [s.id, s]));
    const students = new Map();
    const blank = (id, name) => ({ id, name, preset: null, path: null, classes: new Set(), present: 0, late: 0, absent: 0, excused: 0, lastAttended: null, focusRows: [] });
    data.members.forEach((member) => {
      if (!students.has(member.student_id)) students.set(member.student_id, blank(member.student_id, member.profiles?.display_name || "Student"));
      const student = students.get(member.student_id);
      student.classes.add(member.class_id);
      student.preset = member.profiles?.avatar_preset || student.preset;
      student.path = member.profiles?.avatar_path || student.path;
    });
    data.attendance.forEach((row) => {
      const session = ended.get(row.session_id);
      const student = students.get(row.student_id);
      if (!session || !student) return; // still live, or no longer on a master list
      const mark = row.status === "invited" ? "absent" : row.status;
      if (student[mark] === undefined) return;
      student[mark] += 1;
      if ((mark === "present" || mark === "late") && (!student.lastAttended || session.started_at > student.lastAttended)) student.lastAttended = session.started_at;
    });
    data.focus.forEach((row) => students.get(row.student_id)?.focusRows.push(row));
    students.forEach((student) => {
      student.attended = student.present + student.late;
      student.counted = student.attended + student.absent;
      student.rate = pct(student.attended, student.counted);
      student.focus = averageFocus(student.focusRows);
      const reasons = [];
      if (student.rate !== null && student.counted >= 2 && student.rate < LOW_RATE) reasons.push(`Attended ${student.attended} of ${student.counted} sessions`);
      if (student.focus !== null && student.focus < LOW_FOCUS) reasons.push(`Focus ${student.focus}%`);
      student.reasons = reasons;
    });
    return { students: [...students.values()], ended };
  }

  // ---------- All students ----------
  async function renderStudents({ force = false } = {}) {
    if (!status.loaded) return;
    const data = await load(STUDENT_DAYS, { force });
    const { students } = summarize(data);
    const statusLine = $("#allStudentsStatus");
    statusLine.textContent = data.error ? "Some numbers couldn’t load. Refresh to try again." : "";
    statusLine.dataset.state = data.error ? "error" : "";

    // At a glance
    const flagged = students.filter((student) => student.reasons.length);
    const attended = students.reduce((total, s) => total + s.attended, 0);
    const counted = students.reduce((total, s) => total + s.counted, 0);
    const rate = pct(attended, counted);
    const focus = averageFocus(data.focus);
    $("#allStudentsCount").textContent = `${plural(students.length, "student")} · ${plural(status.classes.length, "class")}`;
    $("#osTotal").textContent = String(students.length);
    const multi = students.filter((s) => s.classes.size > 1).length;
    $("#osTotalNote").textContent = multi ? `${multi} in more than one class` : `Across ${plural(status.classes.length, "class")}`;
    $("#osRate").textContent = rate === null ? "—" : `${rate}%`;
    $("#osRateNote").textContent = rate === null ? "No finished sessions yet" : `${attended} of ${counted} expected, last 30 days`;
    $("#osFocus").textContent = focus === null ? "—" : `${focus}%`;
    $("#osFocusNote").textContent = focus === null ? "Shared during live sessions" : levelFor(focus).label;
    $("#osLow").textContent = String(flagged.length);
    $("#osLowNote").textContent = flagged.length
      ? flagged.slice(0, 2).map((s) => s.name).join(", ") + (flagged.length > 2 ? "…" : "")
      : "Everyone is doing fine";

    // Class filter chips
    const chips = $("#allStudentsChips");
    if (classFilter !== "all" && !status.classes.some((item) => item.id === classFilter)) classFilter = "all";
    const focused = chips.contains(document.activeElement) ? document.activeElement.dataset.value : null;
    const options = [["all", "All classes", students.length], ...status.classes.map((item) => [item.id, item.name, students.filter((s) => s.classes.has(item.id)).length])];
    chips.replaceChildren(...options.map(([value, label, count]) => {
      const chip = el("button", "filter-chip");
      chip.type = "button";
      chip.dataset.value = value;
      chip.setAttribute("aria-pressed", String(value === classFilter));
      chip.setAttribute("aria-label", `${label}, ${plural(count, "student")}`);
      if (value !== "all") chip.style.setProperty("--class-color", classColor(value));
      chip.append(el("span", "", label), el("small", "", String(count)));
      chip.addEventListener("click", () => { classFilter = value; void renderStudents(); });
      return chip;
    }));
    if (focused) chips.querySelector(`[data-value="${CSS.escape(focused)}"]`)?.focus();

    // The list
    const query = $("#allStudentsSearch").value.trim().toLowerCase();
    const sort = $("#allStudentsSort").value;
    const low = (value) => (value === null ? 101 : value);
    const sorters = {
      attention: (a, b) => (b.reasons.length - a.reasons.length) || (low(a.rate) - low(b.rate)) || a.name.localeCompare(b.name),
      name: (a, b) => a.name.localeCompare(b.name),
      attendance: (a, b) => (low(a.rate) - low(b.rate)) || a.name.localeCompare(b.name),
      focus: (a, b) => (low(a.focus) - low(b.focus)) || a.name.localeCompare(b.name),
      recent: (a, b) => String(a.lastAttended || "").localeCompare(String(b.lastAttended || "")) || a.name.localeCompare(b.name)
    };
    const shown = students
      .filter((s) => classFilter === "all" || s.classes.has(classFilter))
      .filter((s) => !query || s.name.toLowerCase().includes(query))
      .sort(sorters[sort] || sorters.attention);
    const body = $("#allStudentsRows");
    if (!shown.length) {
      const row = el("tr");
      const cell = el("td", "empty-cell", !students.length ? "No students yet. Share a class’s join code to fill your master lists." : "No students match.");
      cell.colSpan = 6;
      row.append(cell);
      body.replaceChildren(row);
      return;
    }
    body.replaceChildren(...shown.map((student, index) => {
      const row = el("tr");
      row.style.setProperty("--i", String(Math.min(index, 12)));
      const who = el("td");
      const person = el("div", "person");
      const text = el("div", "person-text");
      text.append(el("b", "", student.name));
      if (student.reasons.length) {
        const flag = el("span", "check-in-flag", student.reasons.join(" · "));
        text.append(flag);
      }
      person.append(avatar(student), text);
      who.append(person);
      const classesCell = el("td");
      const pills = el("div", "class-pills");
      [...student.classes].sort((a, b) => className(a).localeCompare(className(b))).forEach((id) => pills.append(classTag(id)));
      classesCell.append(pills);
      const attendance = el("td");
      attendance.append(rateCell(student.rate, `${student.present} present · ${student.late} late · ${student.absent} absent · ${student.excused} excused`));
      const late = el("td", "num", String(student.late));
      const focusCell = el("td");
      if (student.focus === null) focusCell.append(el("span", "muted", "—"));
      else {
        const level = levelFor(student.focus);
        const chip = el("span", "focus-chip", `${student.focus}%`);
        chip.dataset.level = level.key;
        chip.title = level.label;
        focusCell.append(chip);
      }
      const last = el("td", "muted", ago(student.lastAttended));
      row.append(who, classesCell, attendance, late, focusCell, last);
      return row;
    }));
  }

  $("#allStudentsSearch").addEventListener("input", () => { void renderStudents(); });
  $("#allStudentsSort").addEventListener("change", () => { void renderStudents(); });
  $("#allStudentsDownload").addEventListener("click", async () => {
    const { students } = summarize(await load(STUDENT_DAYS));
    downloadCsv("all-students", [
      ["Student", "Classes", "Present", "Late", "Absent", "Excused", "Attendance %", "Average focus %", "Last attended", "Needs a check-in"],
      ...students.sort((a, b) => a.name.localeCompare(b.name)).map((s) => [
        s.name, [...s.classes].map(className).join("; "), s.present, s.late, s.absent, s.excused,
        s.rate ?? "", s.focus ?? "", s.lastAttended ? new Date(s.lastAttended).toLocaleDateString() : "", s.reasons.join("; ")
      ])
    ]);
  });

  // ---------- Attendance report ----------
  function sessionRows(data) {
    const byId = new Map(data.sessions.filter((s) => s.ended_at).map((s) => [s.id, { ...s, present: 0, late: 0, absent: 0, excused: 0 }]));
    data.attendance.forEach((row) => {
      const session = byId.get(row.session_id);
      const mark = row.status === "invited" ? "absent" : row.status;
      if (session && session[mark] !== undefined) session[mark] += 1;
    });
    return [...byId.values()].map((s) => ({ ...s, rate: pct(s.present + s.late, s.present + s.late + s.absent) }))
      .sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)));
  }

  function renderChart(sessions) {
    const empty = $("#reportChartEmpty");
    empty.hidden = sessions.length > 0;
    if (!window.Chart) {
      empty.hidden = false;
      empty.textContent = "Chart library could not load. Check your internet connection and refresh.";
      return;
    }
    const byDay = new Map();
    sessions.slice().reverse().forEach((s) => {
      const key = new Date(s.started_at).toDateString();
      const day = byDay.get(key) || { label: new Date(s.started_at).toLocaleDateString([], { month: "short", day: "numeric" }), came: 0, counted: 0 };
      day.came += s.present + s.late;
      day.counted += s.present + s.late + s.absent;
      byDay.set(key, day);
    });
    const days = [...byDay.values()];
    const values = days.map((d) => pct(d.came, d.counted));
    const accent = themeColor("--accent", "#00d9ff");
    const muted = themeColor("--text-muted");
    if (chart) {
      chart.data.labels = days.map((d) => d.label);
      chart.data.datasets[0].data = values;
      chart.$days = days;
      chart.update();
      return;
    }
    chart = new window.Chart($("#reportChart"), {
      type: "bar",
      data: { labels: days.map((d) => d.label), datasets: [{ label: "Attendance", data: values, backgroundColor: withAlpha(accent, 0.75), hoverBackgroundColor: accent, maxBarThickness: 26, borderRadius: { topLeft: 4, topRight: 4 }, borderSkipped: false }] },
      options: {
        responsive: true, maintainAspectRatio: false,
        scales: {
          y: { min: 0, max: 100, ticks: { stepSize: 25, color: muted, callback: (v) => `${v}%` }, grid: { color: themeColor("--surface-hover", "#1c1c20") }, border: { display: false } },
          x: { grid: { display: false }, ticks: { color: muted, maxRotation: 0, autoSkipPadding: 10 }, border: { color: themeColor("--border", "#222226") } }
        },
        plugins: {
          legend: { display: false },
          tooltip: { displayColors: false, callbacks: { label: (item) => { const d = chart.$days[item.dataIndex]; return `${item.parsed.y}% · ${d.came} of ${d.counted} came`; } } }
        }
      }
    });
    chart.$days = days;
  }

  async function renderReport({ force = false } = {}) {
    if (!status.loaded) return;
    document.querySelectorAll("[data-report-range]").forEach((button) => button.setAttribute("aria-pressed", String(Number(button.dataset.reportRange) === reportDays)));
    $("#reportRangeLabel").textContent = `Last ${reportDays} days`;
    const days = reportDays;
    const data = await load(days, { force });
    if (days !== reportDays) return; // the range changed while loading
    const sessions = sessionRows(data);
    const { students } = summarize(data);
    const statusLine = $("#reportStatus");
    statusLine.textContent = data.error ? "Some sessions couldn’t load. Refresh to try again." : "";
    statusLine.dataset.state = data.error ? "error" : "";

    // At a glance
    const total = (key) => sessions.reduce((sum, s) => sum + s[key], 0);
    const present = total("present");
    const late = total("late");
    const absent = total("absent");
    const rate = pct(present + late, present + late + absent);
    $("#rpRate").textContent = rate === null ? "—" : `${rate}%`;
    $("#rpRateMeter").style.width = `${rate || 0}%`;
    $("#rpRateNote").textContent = rate === null ? "No finished sessions yet" : `${present + late} of ${present + late + absent} expected came`;
    const lateRate = pct(late, present + late);
    $("#rpLate").textContent = lateRate === null ? "—" : `${lateRate}%`;
    $("#rpLateNote").textContent = late ? `${plural(late, "late arrival")}` : "No one arrived late";
    $("#rpSessions").textContent = String(sessions.length);
    const classCount = new Set(sessions.map((s) => s.class_id)).size;
    $("#rpSessionsNote").textContent = sessions.length ? `Across ${plural(classCount, "class")}` : "Start a live session to take attendance";
    $("#rpAbsent").textContent = String(absent);
    const missers = students.filter((s) => s.absent > 0);
    $("#rpAbsentNote").textContent = absent ? `${plural(missers.length, "student")} missed a session` : "Full attendance";

    renderChart(sessions);

    // Missed the most
    const missed = $("#reportMissed");
    const top = missers.sort((a, b) => (b.absent - a.absent) || (a.rate ?? 101) - (b.rate ?? 101)).slice(0, 6);
    if (!top.length) missed.replaceChildren(el("li", "empty-state", sessions.length ? "No absences in this range. 🎉" : "Nothing to show yet."));
    else missed.replaceChildren(...top.map((student) => {
      const item = el("li");
      const row = el("button", "continue-item");
      row.type = "button";
      const mostMissedClass = [...student.classes][0];
      row.addEventListener("click", () => actions().openClass?.(mostMissedClass, "attendance"));
      const text = el("span", "continue-text");
      text.append(el("b", "", student.name), el("small", "", [...student.classes].map(className).join(" · ")));
      const count = el("span", "missed-count", plural(student.absent, "absence"));
      row.append(avatar(student, ""), text, count);
      item.append(row);
      return item;
    }));

    // By class
    const classBody = $("#reportClassRows");
    const byClass = status.classes.map((item) => {
      const list = sessions.filter((s) => s.class_id === item.id);
      const sum = (key) => list.reduce((total2, s) => total2 + s[key], 0);
      const p = sum("present"), l = sum("late"), a = sum("absent");
      return { item, count: list.length, present: p, late: l, absent: a, excused: sum("excused"), rate: pct(p + l, p + l + a) };
    }).sort((x, y) => (x.rate ?? 101) - (y.rate ?? 101) || x.item.name.localeCompare(y.item.name));
    classBody.replaceChildren(...byClass.map((entry) => {
      const row = el("tr");
      const nameCell = el("td");
      nameCell.append(classTag(entry.item.id, "attendance"));
      row.append(nameCell, ...[entry.count, entry.present, entry.late, entry.absent, entry.excused].map((n) => el("td", "num", String(n))));
      const rateTd = el("td");
      rateTd.append(rateCell(entry.rate));
      row.append(rateTd);
      return row;
    }));
    if (!byClass.length) {
      const row = el("tr");
      const cell = el("td", "empty-cell", "No classes yet.");
      cell.colSpan = 7;
      row.append(cell);
      classBody.replaceChildren(row);
    }

    // Sessions
    const list = $("#reportSessions");
    $("#reportSessionsSub").textContent = sessions.length ? `${plural(sessions.length, "session")}, newest first. Open one to see who came and change any mark.` : "Newest first.";
    if (!sessions.length) list.replaceChildren(el("li", "empty-state", "No finished live sessions in this range."));
    else list.replaceChildren(...sessions.slice(0, sessionsShown).map((session) => {
      const item = el("li");
      const row = el("button", "continue-item report-session");
      row.type = "button";
      row.addEventListener("click", () => actions().openClass?.(session.class_id, "attendance"));
      const when = el("span", "session-when");
      when.append(el("b", "", shortDate(session.started_at)), el("small", "", clock(session.started_at)));
      const text = el("span", "continue-text");
      const name = el("b", "", className(session.class_id));
      name.style.setProperty("--class-color", classColor(session.class_id));
      name.classList.add("dot-name");
      text.append(name, el("small", "", [`${session.present} present`, session.late ? `${session.late} late` : "", session.absent ? `${session.absent} absent` : "", session.excused ? `${session.excused} excused` : ""].filter(Boolean).join(" · ")));
      row.append(when, text, rateCell(session.rate));
      item.append(row);
      return item;
    }));
    const more = $("#reportMore");
    more.hidden = sessions.length <= sessionsShown;
    more.textContent = `Show older sessions (${sessions.length - sessionsShown} more)`;
  }

  document.querySelectorAll("[data-report-range]").forEach((button) => button.addEventListener("click", () => {
    reportDays = Number(button.dataset.reportRange);
    sessionsShown = SESSIONS_SHOWN;
    try { localStorage.setItem(`neuroFocusReportRange:${app.user.id}`, String(reportDays)); } catch { /* storage unavailable */ }
    void renderReport();
  }));
  $("#reportMore").addEventListener("click", () => { sessionsShown += SESSIONS_SHOWN; void renderReport(); });
  $("#reportDownload").addEventListener("click", async () => {
    const sessions = sessionRows(await load(reportDays));
    downloadCsv(`attendance-report-${reportDays}-days`, [
      ["Date", "Time", "Class", "Present", "Late", "Absent", "Excused", "Attendance %"],
      ...sessions.map((s) => [new Date(s.started_at).toLocaleDateString(), clock(s.started_at), className(s.class_id), s.present, s.late, s.absent, s.excused, s.rate ?? ""])
    ]);
  });

  // ---------- When to draw ----------
  const visible = () => window.neuroFocusView;
  function refresh(options) {
    if (visible() === "all-students") void renderStudents(options);
    if (visible() === "report") void renderReport(options);
  }
  window.addEventListener("neurofocus:viewchange", (event) => {
    const name = event.detail?.name;
    if (name !== "all-students" && name !== "report") return;
    // Cards settle in when the page opens (styles/home.css), as on the other pages.
    const page = name === "report" ? $("#reportView") : $("#allStudentsView");
    page.classList.add("is-entering");
    window.setTimeout(() => page.classList.remove("is-entering"), 900);
    refresh();
    if (name === "report") window.requestAnimationFrame(() => chart?.resize());
  });
  // New or deleted classes, or a session that just ended: fresh numbers.
  let lastClassKey = "";
  let wasLive = false;
  window.addEventListener("neurofocus:teacher-status", (event) => {
    status = event.detail;
    const key = status.classes.map((item) => `${item.id}:${item.name}:${item.students}`).join(",");
    const ended = wasLive && !status.live;
    wasLive = Boolean(status.live);
    if (key !== lastClassKey || ended) {
      lastClassKey = key;
      if (ended) cache.clear();
      refresh({ force: ended });
    }
  });
  window.addEventListener("neurofocus:appearance-change", () => { chart?.destroy(); chart = null; refresh(); });
  window.addEventListener("focus", () => refresh());
}
