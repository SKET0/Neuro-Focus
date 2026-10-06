// Teacher Home: the page a teacher lands on (unless a live session is running). A welcome, one
// main action, "at a glance" analytics, their classes, students to check in with, recent live
// sessions and class insights, in the same design as the student Home (styles/home.css).
//
// Everything comes from the teacher's own classes, read with their existing access: live sessions
// (class_sessions), attendance (session_attendance), focus shared during live sessions
// (attention_sessions) and the master lists (class_members). Nothing is estimated or invented.
// Class names, online students and the live session come from teacher-classes.js.
import { paintAvatar, avatarUrls, greetingName } from "../shared/avatars.js?v=1";
import { averageFocus, sum, levelFor, compareGroups, TIMES, timeOfDay, measuredSeconds } from "../student/focus-analysis.js?v=2";
import { selectWithQuality } from "../shared/tracking-states.js?v=1";

const app = await window.neuroFocusReady;
const view = document.querySelector("#classesView");

if (app && view) {
  const { supabase } = app;
  const $ = (selector) => document.querySelector(selector);
  const DAY = 86400000;
  const SCORE_RING = 2 * Math.PI * 50;

  let status = window.neuroFocusTeacherStatus || { loaded: false, classes: [], live: null };
  let data = null;          // { sessions, attendance, focus, members, missing } once loaded
  let loadedFor = "";
  let loadedAt = 0;
  let wasLive = Boolean(status.live);
  let loading = false;

  // ---------- Helpers ----------
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const icon = (id, className = "") => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    if (className) svg.setAttribute("class", className);
    svg.setAttribute("aria-hidden", "true");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", `#${id}`);
    svg.append(use);
    return svg;
  };
  const chipIcon = (id, tone = "") => {
    const chip = el("span", `chip-icon${tone ? ` ${tone}` : ""}`);
    chip.append(icon(id));
    return chip;
  };
  const button = (label, className, onClick, iconId) => {
    const node = el("button", className);
    node.type = "button";
    if (iconId) node.append(icon(iconId, "icon"));
    node.append(label);
    if (onClick) node.addEventListener("click", onClick);
    return node;
  };
  const liveDot = () => {
    const dot = el("span", "live-dot static");
    dot.setAttribute("aria-hidden", "true");
    return dot;
  };
  const plural = (n, word) => `${n} ${n === 1 ? word : word.endsWith("s") ? `${word}es` : `${word}s`}`;
  const pct = (part, whole) => (whole ? Math.round((part / whole) * 100) : null);
  const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const shortDate = (iso) => new Date(iso).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  const minutes = (seconds) => (seconds >= 3600 ? `${Math.floor(seconds / 3600)}h ${Math.round((seconds % 3600) / 60)}m` : `${Math.max(1, Math.round(seconds / 60))} min`);
  const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const actions = () => window.neuroFocusTeacherActions || {};
  const className = (id) => status.classes.find((item) => item.id === id)?.name || "Class";
  const daysAgo = (iso) => Math.floor((Date.now() - new Date(iso)) / DAY);

  const lastKeys = new Map();
  function renderIfChanged(name, key, container, build) {
    if (lastKeys.get(name) === key) return;
    lastKeys.set(name, key);
    const focusKey = container.contains(document.activeElement) ? document.activeElement.dataset.focusKey : null;
    build();
    if (focusKey) container.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`)?.focus();
  }

  function countTo(node, target, format) {
    const from = Number(node.dataset.value || 0);
    node.dataset.value = String(target);
    if (reducedMotion() || from === target) { node.textContent = format(target); return; }
    const started = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - started) / 900);
      node.textContent = format(Math.round(from + (target - from) * (1 - (1 - t) ** 3)));
      if (t < 1 && Number(node.dataset.value) === target) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // ---------- Data ----------
  const missingSql = (error) => Boolean(error && (error.code === "PGRST205" || error.code === "42P01" || error.code === "42703"));
  async function loadData({ force = false } = {}) {
    const ids = status.classes.map((item) => item.id);
    const key = ids.slice().sort().join(",");
    if (!status.loaded) return;
    if (!force && key === loadedFor && Date.now() - loadedAt < 30000) return;
    if (loading && !force) return;
    loading = true;
    loadedFor = key;
    loadedAt = Date.now();
    if (!ids.length) {
      data = { sessions: [], attendance: [], focus: [], members: [], missing: false };
      loading = false;
      renderAll();
      return;
    }
    const since = new Date(Date.now() - 30 * DAY).toISOString();
    const members = (fields) => supabase.from("class_members").select(`class_id, student_id, profiles(${fields})`).in("class_id", ids);
    const [sessions, attendance, focus, roster] = await Promise.all([
      supabase.from("class_sessions").select("id, class_id, started_at, ended_at").in("class_id", ids).gte("started_at", since).order("started_at", { ascending: false }).limit(300),
      supabase.from("session_attendance").select("session_id, class_id, student_id, student_name, status").in("class_id", ids).gte("invited_at", since).limit(10000),
      selectWithQuality((quality) => supabase.from("attention_sessions").select(`class_id, class_session_id, student_id, started_at, tracked_seconds, focus_percent, lapses${quality}`).in("class_id", ids).gte("started_at", since).gt("tracked_seconds", 4).limit(10000)),
      members("display_name, avatar_preset, avatar_path").then((result) => (result.error ? members("display_name") : result))
    ]);
    data = {
      sessions: sessions.error ? [] : sessions.data || [],
      attendance: attendance.error ? [] : attendance.data || [],
      focus: focus.error ? [] : focus.data || [],
      members: roster.error ? [] : roster.data || [],
      missing: missingSql(sessions.error) || missingSql(attendance.error)
    };
    loading = false;
    renderAll();
    void loadPictures();
  }

  // Student pictures are private; storage gives this teacher short-lived links for their own students.
  let pictureUrls = new Map();
  async function loadPictures() {
    const paths = (data?.members || []).map((member) => member.profiles?.avatar_path).filter(Boolean);
    if (!paths.length) return;
    pictureUrls = await avatarUrls(supabase, paths);
    lastKeys.delete("checkin");
    renderCheckIn();
  }

  // Finished sessions and their attendance, newest first.
  function finishedSessions() {
    const byId = new Map();
    (data?.sessions || []).filter((s) => s.ended_at).forEach((s) => byId.set(s.id, { ...s, present: 0, late: 0, absent: 0, excused: 0 }));
    (data?.attendance || []).forEach((row) => {
      const session = byId.get(row.session_id);
      if (session && session[row.status] !== undefined) session[row.status] += 1;
    });
    return [...byId.values()];
  }
  const attended = (s) => s.present + s.late;
  const counted = (s) => s.present + s.late + s.absent;

  // ---------- Welcome ----------
  function renderGreeting() {
    const hour = new Date().getHours();
    const greeting = hour < 5 ? "Hello" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
    $("#classesTitle").replaceChildren(`${greeting}, `, el("span", "gradient-name", greetingName(app.profile.display_name)));
    const online = status.classes.reduce((total, item) => total + item.online, 0);
    const liveClass = status.live ? className(status.live.classId) : "";
    $("#teacherLead").textContent = !status.loaded ? "Here’s how your classes are doing."
      : liveClass ? `Your live session in ${liveClass} is running.`
      : !status.classes.length ? "Welcome! Create your first class to get a join code for your students."
      : `${plural(online, "student")} online now across ${plural(status.classes.length, "class")}.`;
  }

  // ---------- The one main action ----------
  function chooseNext() {
    if (!status.loaded) return { kind: "loading" };
    if (status.live) {
      const item = status.classes.find((entry) => entry.id === status.live.classId);
      if (item) return { kind: "live", item, live: status.live };
    }
    if (!status.classes.length) return { kind: "create" };
    const empty = status.classes.find((item) => !item.students);
    if (empty) return { kind: "share", item: empty };
    let last = "";
    try { last = localStorage.getItem("neuroFocusCurrentClassId") || ""; } catch { /* storage unavailable */ }
    const item = status.classes.find((entry) => entry.id === last)
      || status.classes.slice().sort((a, b) => b.online - a.online)[0];
    return { kind: "golive", item };
  }

  function renderNext() {
    const next = chooseNext();
    const card = $("#teacherNext");
    const key = JSON.stringify([next.kind, next.item?.id, next.item?.name, next.item?.students, next.item?.online, next.live?.since, next.live?.sharing]);
    renderIfChanged("next", key, card, () => {
      const kicker = $("#tNextKicker");
      const title = $("#tNextTitle");
      const sub = $("#tNextSub");
      const buttons = $("#tNextButtons");
      kicker.replaceChildren();
      buttons.replaceChildren();
      card.dataset.kind = next.kind === "live" ? "live" : next.kind;
      card.setAttribute("aria-busy", String(next.kind === "loading"));
      const setIcon = (id) => $("#tNextIcon").replaceChildren(icon(id));
      if (next.kind === "live") {
        setIcon("i-live");
        kicker.append(liveDot(), `Live now · since ${clock(next.live.since)}`);
        title.textContent = `${next.item.name} is live`;
        sub.textContent = `${next.live.sharing} of ${plural(next.item.students, "student")} ${next.live.sharing === 1 ? "is" : "are"} sharing their focus right now.`;
        buttons.append(button("Open live monitor", "btn-primary", () => actions().openClass?.(next.item.id, "live"), "i-live"));
      } else if (next.kind === "create") {
        setIcon("i-school");
        kicker.textContent = "Get started";
        title.textContent = "Create your first class";
        sub.textContent = "You’ll get a join code to share. Students appear on your master list the moment they join.";
        buttons.append(button("New class", "btn-primary", () => actions().openNewClass?.(), "i-plus"));
      } else if (next.kind === "share") {
        setIcon("i-users");
        kicker.textContent = "Invite your students";
        title.textContent = `Share the join code for ${next.item.name}`;
        sub.textContent = `No one has joined yet. Students join with ${next.item.joinCode}.`;
        buttons.append(
          button("Copy join code", "btn-primary", () => actions().copyCode?.(next.item.id), "i-copy"),
          button("Open class", "btn-action", () => actions().openClass?.(next.item.id, "students"))
        );
      } else if (next.kind === "golive") {
        setIcon("i-live");
        kicker.textContent = "Ready when you are";
        title.textContent = `Go live in ${next.item.name}`;
        sub.textContent = `${next.item.online} of ${plural(next.item.students, "student")} online now. A live session shows their focus and takes attendance.`;
        buttons.append(button(`Open ${next.item.name}`, "btn-primary", () => actions().openClass?.(next.item.id, "live"), "i-live"));
      } else {
        setIcon("i-spark");
        kicker.textContent = "Up next";
        title.textContent = "Getting your classes ready…";
        sub.textContent = "";
        buttons.append(el("span", "next-skeleton"), el("span", "next-skeleton short"));
      }
      if (lastKeys.size > 1 && next.kind !== "loading") {
        card.classList.remove("is-updating");
        void card.offsetWidth;
        card.classList.add("is-updating");
      }
    });
  }

  // ---------- At a glance ----------
  function renderGlance() {
    // Online meter and live sharing come straight from teacher-classes.js.
    const students = status.classes.reduce((total, item) => total + item.students, 0);
    const online = status.classes.reduce((total, item) => total + item.online, 0);
    $("#tOnlineBar").style.width = `${students ? Math.round((online / students) * 100) : 0}%`;
    const sharing = status.live ? `${plural(status.live.sharing, "student")} sharing focus` : "";
    if ($("#tLiveSharing").textContent !== sharing) $("#tLiveSharing").textContent = sharing || " ";
    $("#sumLiveCard").href = status.live ? "#teacherNext" : "#teacherClassesPanel";

    if (!data) return;
    const now = Date.now();
    const week = data.focus.filter((s) => now - new Date(s.started_at) < 7 * DAY);
    const before = data.focus.filter((s) => { const age = now - new Date(s.started_at); return age >= 7 * DAY && age < 14 * DAY; });
    const source = week.length ? week : data.focus;
    const score = averageFocus(source);
    const previous = week.length ? averageFocus(before) : null;
    const sessions = finishedSessions();
    const rate = pct(sum(sessions, attended), sum(sessions, counted));
    const recent = sessions.slice(0, 7).reverse();

    const key = JSON.stringify([score, previous, rate, recent.map((s) => [s.id, attended(s), counted(s)]), data.missing]);
    renderIfChanged("glance", key, $(".glance"), () => {
      const ring = $("#tScoreRing");
      ring.style.strokeDasharray = String(SCORE_RING);
      ring.style.strokeDashoffset = String(SCORE_RING * (1 - (score ?? 0) / 100));
      const value = $("#tScoreValue");
      const tile = $("#classesView .score-tile");
      if (score === null) {
        value.textContent = "—";
        value.dataset.value = "0";
        $("#tScoreLevel").textContent = "No data yet";
        $("#tScoreNote").textContent = "Shown after students share focus in a live session";
        delete tile.dataset.level;
      } else {
        countTo(value, score, String);
        $("#tScoreLevel").textContent = levelFor(score).label;
        tile.dataset.level = levelFor(score).key;
        const change = previous === null ? null : score - previous;
        const note = $("#tScoreNote");
        note.textContent = !week.length ? "From live sessions in the last 30 days"
          : change === null ? "From this week’s live sessions"
          : change === 0 ? "Same as last week"
          : `${change > 0 ? "▲" : "▼"} ${Math.abs(change)} pts vs last week`;
        note.dataset.trend = change > 0 ? "up" : change < 0 ? "down" : "";
      }

      const attendanceValue = $("#tAttendance");
      if (rate === null) {
        attendanceValue.textContent = "—";
        attendanceValue.dataset.value = "0";
      } else countTo(attendanceValue, rate, (n) => `${n}%`);
      $("#tAttendanceBars").replaceChildren(...(recent.length ? recent : [null]).map((s, i) => {
        const bar = el("span", "glance-bar");
        const value = s ? pct(attended(s), counted(s)) ?? 0 : 0;
        bar.style.setProperty("--h", `${Math.max(6, value)}%`);
        bar.style.setProperty("--i", String(i));
        if (!s || !counted(s)) bar.dataset.empty = "true";
        if (s) bar.title = `${className(s.class_id)} · ${shortDate(s.started_at)}: ${attended(s)} of ${counted(s)} attended`;
        return bar;
      }));
      $("#tAttendanceNote").textContent = data.missing ? "Needs the attendance database update"
        : !sessions.length ? "Shown after your first live session"
        : `Last ${plural(Math.min(7, sessions.length), "session")} · ${plural(sessions.length, "session")} in 30 days`;
    });
  }

  // ---------- Students to check in with ----------
  function checkIns() {
    if (!data) return null;
    const sessionsByClass = new Map();
    finishedSessions().forEach((s) => {
      if (!sessionsByClass.has(s.class_id)) sessionsByClass.set(s.class_id, []);
      sessionsByClass.get(s.class_id).push(s);
    });
    const marks = new Map(); // `${class}:${student}` -> Map(sessionId -> status)
    data.attendance.forEach((row) => {
      const key = `${row.class_id}:${row.student_id}`;
      if (!marks.has(key)) marks.set(key, new Map());
      marks.get(key).set(row.session_id, row.status);
    });
    const list = [];
    data.members.forEach((member) => {
      const name = member.profiles?.display_name || "Student";
      const key = `${member.class_id}:${member.student_id}`;
      const theirMarks = marks.get(key) || new Map();
      const sessions = (sessionsByClass.get(member.class_id) || []).filter((s) => ["present", "late", "absent"].includes(theirMarks.get(s.id)));
      const statuses = sessions.map((s) => theirMarks.get(s.id)); // newest first
      const came = statuses.filter((s) => s === "present" || s === "late").length;
      const late = statuses.filter((s) => s === "late").length;
      const focusRows = data.focus.filter((f) => f.class_id === member.class_id && f.student_id === member.student_id && Date.now() - new Date(f.started_at) < 14 * DAY);
      const focus = sum(focusRows, (f) => f.tracked_seconds) >= 600 && focusRows.length >= 2 ? averageFocus(focusRows) : null;
      let reason = null;
      if (statuses.length >= 2 && statuses[0] === "absent" && statuses[1] === "absent") reason = { level: 3, text: "Missed the last 2 live sessions", tab: "attendance", icon: "i-attendance" };
      else if (statuses.length >= 3 && came / statuses.length < 0.6) reason = { level: 2, text: `Attended ${came} of ${statuses.length} sessions`, tab: "attendance", icon: "i-attendance" };
      else if (came >= 3 && late / came >= 0.5) reason = { level: 1, text: `Joined late to ${late} of ${came} sessions`, tab: "attendance", icon: "i-timer" };
      else if (focus !== null && focus < 50) reason = { level: 1, text: `${focus}% focus in recent live sessions`, tab: "history", icon: "i-eye" };
      if (reason) list.push({ ...reason, name, classId: member.class_id, studentId: member.student_id, preset: member.profiles?.avatar_preset, path: member.profiles?.avatar_path });
    });
    return list.sort((a, b) => b.level - a.level || a.name.localeCompare(b.name)).slice(0, 6);
  }

  function renderCheckIn() {
    const box = $("#checkInList");
    const list = checkIns();
    const key = JSON.stringify([list, Boolean(data?.sessions.length), [...pictureUrls.keys()]]);
    renderIfChanged("checkin", key, box, () => {
      if (!list) { box.replaceChildren(el("li", "empty-state", "Loading…")); return; }
      if (!list.length) {
        box.replaceChildren(el("li", "empty-state", data.sessions.length
          ? "Everyone’s on track: no missed sessions or low focus in the last 30 days."
          : "After a few live sessions, students who might need a check-in show up here."));
        return;
      }
      box.replaceChildren(...list.map((entry, index) => {
        const item = el("li", "coach-item tip checkin-item");
        item.dataset.tone = entry.level >= 2 ? "amber" : "";
        const face = el("span", "nf-avatar");
        paintAvatar(face, { name: entry.name, preset: entry.preset, url: pictureUrls.get(entry.path) || null });
        const body = el("div", "coach-text");
        const reason = el("p", "checkin-reason");
        reason.append(icon(entry.icon, "icon"), entry.text);
        body.append(el("b", "", entry.name), el("small", "checkin-class", className(entry.classId)), reason);
        const open = button("Open", "btn-action", () => actions().openClass?.(entry.classId, entry.tab));
        open.dataset.focusKey = `checkin-${index}`;
        open.setAttribute("aria-label", `Open ${className(entry.classId)} to see ${entry.name}`);
        item.append(face, body, open);
        return item;
      }));
    });
  }

  // ---------- Recent sessions ----------
  function renderRecent() {
    const list = $("#recentSessionList");
    if (!data) return;
    const finished = new Map(finishedSessions().map((s) => [s.id, s]));
    const focusBySession = new Map();
    data.focus.forEach((f) => {
      if (!f.class_session_id) return;
      if (!focusBySession.has(f.class_session_id)) focusBySession.set(f.class_session_id, []);
      focusBySession.get(f.class_session_id).push(f);
    });
    const rows = data.sessions.slice(0, 5);
    const key = JSON.stringify([rows.map((s) => [s.id, s.ended_at]), [...finished.values()].map((s) => [s.id, attended(s), s.absent]), data.missing]);
    renderIfChanged("recent", key, list, () => {
      if (!rows.length) {
        list.replaceChildren(el("li", "empty-state", data.missing
          ? "Saving sessions needs the sessions and attendance database update (see README)."
          : "No live sessions in the last 30 days. Open a class and press Start live session."));
        return;
      }
      list.replaceChildren(...rows.map((session, index) => {
        const item = el("li");
        const node = el("button", "continue-item");
        node.type = "button";
        node.dataset.focusKey = `session-${index}`;
        const done = finished.get(session.id);
        const focus = averageFocus(focusBySession.get(session.id) || []);
        const length = session.ended_at ? minutes((new Date(session.ended_at) - new Date(session.started_at)) / 1000) : "";
        const detail = done
          ? [length, `${done.present + done.late} of ${counted(done)} attended`, done.late ? `${done.late} late` : "", focus !== null ? `${focus}% focus` : ""].filter(Boolean).join(" · ")
          : `Live now · since ${clock(session.started_at)}`;
        const text = el("span", "continue-text");
        text.append(el("b", "", `${className(session.class_id)} · ${shortDate(session.started_at)}, ${clock(session.started_at)}`), el("small", "", detail));
        node.append(chipIcon(done ? "i-attendance" : "i-live", done ? "" : "red"), text, icon("i-chevron", "chevron"));
        node.addEventListener("click", () => actions().openClass?.(session.class_id, done ? "attendance" : "live"));
        item.append(node);
        return item;
      }));
    });
  }

  // ---------- Class insights ----------
  function buildInsights() {
    const sessions = finishedSessions();
    const wins = [];
    const tips = [];
    const totalCounted = sum(sessions, counted);
    const rate = pct(sum(sessions, attended), totalCounted);
    const lateRate = pct(sum(sessions, (s) => s.late), sum(sessions, attended));
    const now = Date.now();
    const week = data.focus.filter((s) => now - new Date(s.started_at) < 7 * DAY);
    const before = data.focus.filter((s) => { const age = now - new Date(s.started_at); return age >= 7 * DAY && age < 14 * DAY; });
    // Focus figures are estimates of on-screen time; a change is only mentioned with 60+ measured
    // minutes on each side and a difference of 10 points or more.
    const enoughToCompare = sum(week, measuredSeconds) >= 3600 && sum(before, measuredSeconds) >= 3600;
    const change = enoughToCompare ? averageFocus(week) - averageFocus(before) : null;

    if (!status.classes.length) {
      tips.push({ icon: "i-school", title: "Create your first class", text: "You’ll get a join code to share with your students.", action: { label: "New class", run: () => actions().openNewClass?.() } });
      return { basis: "Insights appear once you’ve run live sessions.", wins, tips };
    }
    if (!sessions.length) {
      const item = status.classes.find((c) => c.students) || status.classes[0];
      tips.push({ icon: "i-live", title: "Run your first live session", text: `Open ${item.name} and press Start live session. You’ll see each student’s focus live and attendance is taken for you.`, action: { label: `Open ${item.name}`, run: () => actions().openClass?.(item.id, "live") } });
      if (status.classes.some((c) => !c.students)) {
        const empty = status.classes.find((c) => !c.students);
        tips.push({ icon: "i-users", title: `Invite students to ${empty.name}`, text: `Share the join code ${empty.joinCode}.`, action: { label: "Copy join code", run: () => actions().copyCode?.(empty.id) } });
      }
      return { basis: "Insights appear after your first live session.", wins, tips };
    }

    if (rate !== null && rate >= 85) wins.push({ icon: "i-attendance", title: `Strong attendance: ${rate}%`, text: `Across ${plural(sessions.length, "live session")} in the last 30 days.` });
    if (lateRate !== null && sum(sessions, attended) >= 5 && lateRate < 10) wins.push({ icon: "i-timer", title: "Students join on time", text: `Only ${lateRate}% of students who joined were late.` });
    if (change !== null && change >= 10) wins.push({ icon: "i-trend", title: "Recorded on-screen time is up", text: `This week’s live sessions were estimated at ${averageFocus(week)}% of measured time on screen, up ${change} points. An estimate, not a measure of learning.` });
    const times = compareGroups(data.focus, timeOfDay);
    if (times) {
      const best = TIMES.find((t) => t.key === times.best.key);
      const worst = TIMES.find((t) => t.key === times.worst.key);
      wins.push({ icon: "i-sun", title: `Higher estimates ${best.phrase}`, text: `${times.best.avg}% of measured time on screen, against ${times.worst.avg}% ${worst.phrase}. A tentative pattern that may also reflect what was taught then.` });
    }

    if (rate !== null && rate < 70) tips.push({ icon: "i-attendance", tone: "amber", title: `Attendance is ${rate}%`, text: "Check in with the students listed above, and send the invite again when you go live." });
    if (lateRate !== null && sum(sessions, attended) >= 5 && lateRate >= 25) {
      tips.push({ icon: "i-timer", tone: "amber", title: `${lateRate}% of students join late`, text: "Announce the session a couple of minutes before you start, or press Invite again for anyone who hasn’t joined." });
    }
    if (change !== null && change <= -10) tips.push({ icon: "i-flag", tone: "amber", title: "Recorded on-screen time is down this week", text: `Estimated ${averageFocus(week)}% of measured time, down ${Math.abs(change)} points. This can reflect the kind of activity (e.g. writing on paper). If it matches what you saw, shorter activities might be worth trying.` });
    const lengths = compareGroups(data.focus, (s) => (s.tracked_seconds >= 40 * 60 ? "long" : "short"));
    if (lengths && lengths.best.key === "short") {
      tips.push({ icon: "i-timer", title: "Lower estimates in long sessions", text: `${lengths.worst.avg}% of measured time on screen when students track 40+ minutes, against ${lengths.best.avg}% in shorter stretches. A tentative pattern; a short break partway through might be worth trying.` });
    }
    const lastByClass = new Map();
    data.sessions.forEach((s) => { if (!lastByClass.has(s.class_id)) lastByClass.set(s.class_id, s.started_at); });
    status.classes.filter((c) => c.students).forEach((c) => {
      const last = lastByClass.get(c.id);
      const days = last ? daysAgo(last) : null;
      if (days === null || days >= 7) {
        tips.push({ icon: "i-live", title: days === null ? `No live sessions in ${c.name} this month` : `${c.name}: last live session ${days} days ago`, text: `${plural(c.students, "student")} are waiting. A short live session keeps attendance and focus records up to date.`, action: { label: `Open ${c.name}`, run: () => actions().openClass?.(c.id, "live") } });
      }
    });
    if (!wins.length) wins.push({ icon: "i-check", title: `${plural(sessions.length, "live session")} this month`, text: `${totalCounted ? `${rate}% attendance` : "Attendance is being recorded"} across your classes.` });
    if (!tips.length) tips.push({ icon: "i-check", title: "Nothing stands out", text: "Attendance and punctuality look steady, and the focus estimates show no clear pattern to act on." });
    return { basis: `Based on ${plural(sessions.length, "live session")} in the last 30 days`, wins: wins.slice(0, 3), tips: tips.slice(0, 3) };
  }

  function renderInsights() {
    if (!data) return;
    const insights = buildInsights();
    const key = JSON.stringify([insights.basis, insights.wins, insights.tips.map((t) => [t.title, t.text, t.action?.label])]);
    renderIfChanged("insights", key, $("#teacherInsights"), () => {
      $("#tInsightsBasis").textContent = insights.basis;
      const item = (entry, kind, index) => {
        const li = el("li", `coach-item ${kind}`);
        if (entry.tone) li.dataset.tone = entry.tone;
        const body = el("div", "coach-text");
        body.append(el("b", "", entry.title), el("p", "", entry.text));
        if (entry.action) {
          const action = button(entry.action.label, "btn-action", entry.action.run);
          action.dataset.focusKey = `insight-${kind}-${index}`;
          body.append(action);
        }
        li.append(chipIcon(entry.icon, kind === "win" ? "green" : entry.tone || ""), body);
        return li;
      };
      $("#tWins").replaceChildren(...(insights.wins.length
        ? insights.wins.map((entry, index) => item(entry, "win", index))
        : [el("li", "empty-state", "What’s going well shows up after your first live sessions.")]));
      $("#tTips").replaceChildren(...insights.tips.map((entry, index) => item(entry, "tip", index)));
    });
  }

  // ---------- Wiring ----------
  function renderAll() {
    renderGreeting();
    renderNext();
    renderGlance();
    renderCheckIn();
    renderRecent();
    renderInsights();
  }

  window.addEventListener("neurofocus:teacher-status", (event) => {
    const before = loadedFor;
    status = event.detail || status;
    renderAll();
    const ids = status.classes.map((item) => item.id).sort().join(",");
    const endedLive = wasLive && !status.live;
    wasLive = Boolean(status.live);
    // New or deleted classes, or a session that just ended: fetch fresh numbers.
    if (ids !== before || endedLive || (data === null && !loading)) void loadData({ force: true });
  });

  // When Home is shown again: settle the cards in and refresh the numbers.
  new MutationObserver(() => {
    if (view.hidden) return;
    view.classList.add("is-entering");
    window.setTimeout(() => view.classList.remove("is-entering"), 900);
    void loadData();
  }).observe(view, { attributes: true, attributeFilter: ["hidden"] });

  // A soft spotlight follows the pointer across Home's cards.
  let spotFrame = 0;
  view.addEventListener("pointermove", (event) => {
    if (event.pointerType !== "mouse") return;
    const card = event.target.closest(".home-card, .home-hero");
    if (!card) return;
    cancelAnimationFrame(spotFrame);
    spotFrame = requestAnimationFrame(() => {
      const box = card.getBoundingClientRect();
      card.style.setProperty("--mx", `${event.clientX - box.left}px`);
      card.style.setProperty("--my", `${event.clientY - box.top}px`);
    });
  });

  // A new name in My profile updates the greeting (avatars are repainted by profile.js).
  window.addEventListener("neurofocus:profile-updated", renderGreeting);

  renderAll();
  if (!view.hidden) {
    view.classList.add("is-entering");
    window.setTimeout(() => view.classList.remove("is-entering"), 900);
  }
  if (status.loaded) void loadData({ force: true });
}
