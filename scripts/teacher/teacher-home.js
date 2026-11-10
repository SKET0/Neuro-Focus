// Teacher Home: the page a teacher lands on (unless a live session is running). Kept short on
// purpose: a banner while a session is live, a welcome with quick actions (go live, post,
// assignment, quiz), a class switcher (pick a class, see how it's doing, act on it) beside one
// "Needs your attention" list, and insights plus recent activity folded away under "More".
// Same design as the student Home (styles/home.css).
//
// Everything comes from the teacher's own classes, read with their existing access: live sessions
// (class_sessions), attendance (session_attendance), focus shared during live sessions
// (attention_sessions), the master lists (class_members), assignments and submissions, quizzes and
// posts. Nothing is estimated or invented. Class names, online students and the live session come
// from teacher-classes.js; the class pages are opened through its actions.
import { paintAvatar, avatarUrls, greetingName } from "../shared/avatars.js";
import { averageFocus, sum, levelFor, compareGroups, TIMES, timeOfDay, measuredSeconds } from "../student/focus-analysis.js";
import { selectWithQuality } from "../shared/tracking-states.js";
import { classHue } from "../shared/class-colors.js";

const app = await window.neuroFocusReady;
const view = document.querySelector("#classesView");

if (app && view) {
  const { supabase } = app;
  const $ = (selector) => document.querySelector(selector);
  const DAY = 86400000;
  const ATTENTION_SHOWN = 5;
  const ACTIVITY_SHOWN = 6;
  const PICKED_KEY = "neuroFocusHomeClass";
  const MORE_KEY = "neuroFocusHomeMore";

  let status = window.neuroFocusTeacherStatus || { loaded: false, classes: [], live: null };
  let data = null;          // see loadData() once loaded
  let loadedFor = "";
  let loadedAt = 0;
  let wasLive = Boolean(status.live);
  let loading = false;
  let showAllAttention = false;
  let showAllActivity = false;
  let picked = "";
  try { picked = localStorage.getItem(PICKED_KEY) || ""; } catch { /* storage unavailable */ }

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
  const plural = (n, word) => `${n} ${n === 1 ? word : word.endsWith("s") ? `${word}es` : `${word}s`}`;
  const pct = (part, whole) => (whole ? Math.round((part / whole) * 100) : null);
  const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const shortDate = (iso) => new Date(iso).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  const dueWhen = (iso) => new Date(iso).toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
  const minutes = (seconds) => (seconds >= 3600 ? `${Math.floor(seconds / 3600)}h ${Math.round((seconds % 3600) / 60)}m` : `${Math.max(1, Math.round(seconds / 60))} min`);
  const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const actions = () => window.neuroFocusTeacherActions || {};
  const classroom = () => window.neuroFocusClassroom || {};
  const classById = (id) => status.classes.find((item) => item.id === id);
  const className = (id) => classById(id)?.name || "Class";
  const initialOf = (name) => (name.trim()[0] || "C").toUpperCase();
  const daysAgo = (iso) => Math.floor((Date.now() - new Date(iso)) / DAY);
  const quote = (text) => `“${text}”`;
  const hueOf = classHue;
  const ago = (iso) => {
    const seconds = (Date.now() - new Date(iso)) / 1000;
    if (seconds < 60) return "just now";
    if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
    if (seconds < DAY / 1000) return `${Math.round(seconds / 3600)} h ago`;
    const days = daysAgo(iso);
    return days <= 1 ? "yesterday" : days < 7 ? `${days} days ago` : shortDate(iso);
  };
  // Days until a date, by calendar day (so 9 pm tomorrow is "tomorrow", not "in 1 day").
  const daysUntil = (iso) => {
    const start = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
    return Math.round((start(new Date(iso)) - start(new Date())) / DAY);
  };
  const untilText = (iso) => {
    if (new Date(iso) < Date.now()) return "Closed";
    const days = daysUntil(iso);
    return days <= 0 ? `Today ${clock(iso)}` : days === 1 ? `Tomorrow ${clock(iso)}` : `In ${days} days`;
  };

  const lastKeys = new Map();
  function renderIfChanged(name, key, container, build) {
    if (lastKeys.get(name) === key) return false;
    lastKeys.set(name, key);
    const focusKey = container.contains(document.activeElement) ? document.activeElement.dataset.focusKey : null;
    build();
    if (focusKey) container.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`)?.focus();
    return true;
  }

  // ---------- Data ----------
  const missingSql = (error) => Boolean(error && (error.code === "PGRST205" || error.code === "42P01" || error.code === "42703"));
  const rows = (result) => (result.error ? [] : result.data || []);
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
      data = { sessions: [], attendance: [], focus: [], members: [], assignments: [], submissions: [], quizzes: [], posts: [], missing: false, has: { assignments: true, quizzes: true, posts: true } };
      loading = false;
      renderAll();
      return;
    }
    const since = new Date(Date.now() - 30 * DAY).toISOString();
    const members = (fields) => supabase.from("class_members").select(`class_id, student_id, profiles(${fields})`).in("class_id", ids);
    const [sessions, attendance, focus, roster, assignments, submissions, quizzes, posts] = await Promise.all([
      supabase.from("class_sessions").select("id, class_id, started_at, ended_at").in("class_id", ids).gte("started_at", since).order("started_at", { ascending: false }).limit(300),
      supabase.from("session_attendance").select("session_id, class_id, student_id, student_name, status").in("class_id", ids).gte("invited_at", since).limit(10000),
      selectWithQuality((quality) => supabase.from("attention_sessions").select(`class_id, class_session_id, student_id, started_at, tracked_seconds, focus_percent, lapses${quality}`).in("class_id", ids).gte("started_at", since).gt("tracked_seconds", 4).limit(10000)),
      members("display_name, avatar_preset, avatar_path").then((result) => (result.error ? members("display_name") : result)),
      supabase.from("assignments").select("id, class_id, title, due_at, created_at").in("class_id", ids).order("created_at", { ascending: false }).limit(500),
      supabase.from("assignment_submissions").select("id, assignment_id, class_id, student_id, submitted_at, marked_at").in("class_id", ids).order("submitted_at", { ascending: false }).limit(5000),
      supabase.from("quizzes").select("id, class_id, title, status, created_at, finished_at").in("class_id", ids).order("created_at", { ascending: false }).limit(300),
      supabase.from("class_posts").select("id, class_id, title, body, created_at").in("class_id", ids).order("created_at", { ascending: false }).limit(300)
    ]);
    data = {
      sessions: rows(sessions),
      attendance: rows(attendance),
      focus: rows(focus),
      members: rows(roster),
      assignments: rows(assignments),
      submissions: rows(submissions),
      quizzes: rows(quizzes),
      posts: rows(posts),
      missing: missingSql(sessions.error) || missingSql(attendance.error),
      // Posts, assignments and quizzes need later database updates; without them their items are left out.
      has: { assignments: !assignments.error && !submissions.error, quizzes: !quizzes.error, posts: !posts.error }
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
    lastKeys.delete("attention");
    lastKeys.delete("activity");
    renderAttention();
    renderActivity();
  }
  function face({ name, preset, path }) {
    const node = el("span", "nf-avatar");
    paintAvatar(node, { name: name || "Student", preset, url: pictureUrls.get(path) || null });
    return node;
  }
  const memberOf = (studentId) => data?.members.find((m) => m.student_id === studentId);
  const studentName = (studentId) => memberOf(studentId)?.profiles?.display_name || "A student";
  const studentFace = (studentId) => {
    const profile = memberOf(studentId)?.profiles;
    return face({ name: profile?.display_name, preset: profile?.avatar_preset, path: profile?.avatar_path });
  };

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

  // Submissions still waiting for marks, per assignment (oldest submission first).
  function toMark() {
    if (!data?.has.assignments) return [];
    const waiting = new Map();
    data.submissions.filter((s) => !s.marked_at).forEach((s) => {
      if (!waiting.has(s.assignment_id)) waiting.set(s.assignment_id, []);
      waiting.get(s.assignment_id).push(s);
    });
    return data.assignments
      .filter((a) => waiting.has(a.id))
      .map((a) => ({ assignment: a, count: waiting.get(a.id).length, oldest: waiting.get(a.id).at(-1).submitted_at }))
      .sort((a, b) => new Date(a.oldest) - new Date(b.oldest));
  }
  const submittedCount = (assignmentId) => (data?.submissions || []).filter((s) => s.assignment_id === assignmentId).length;

  // ---------- Opening things (class pages live in teacher-classes.js) ----------
  const later = (run) => requestAnimationFrame(() => requestAnimationFrame(run));
  function open(kind, classId, extra) {
    const go = actions().openClass;
    if (!go || !classId) return;
    if (kind === "live") { go(classId, "live"); later(() => $("#sessionToggle")?.focus()); }
    else if (kind === "post") { go(classId, "posts"); later(() => classroom().newPost?.(extra)); }
    else if (kind === "assignment") { go(classId, "assignments"); later(() => classroom().newAssignment?.()); }
    else if (kind === "mark") { go(classId, "assignments"); classroom().openAssignment?.(extra); }
    else if (kind === "quiz") { go(classId, "quizzes"); later(() => { const add = $("#newQuiz"); if (add && !add.disabled) add.click(); }); }
    else if (kind === "class") go(classId, actions().defaultTab?.(classId));
    else go(classId, kind);
  }

  // Choose the class for a quick action: straight there with one class, a short list with more.
  // The class picked in the switcher is offered first.
  const PICK = {
    live: { title: "Go live in…", sub: "Everyone on the class’s master list is invited when you press Start live session." },
    post: { title: "Post an announcement in…", sub: "Everyone in the class sees it in their Posts tab." },
    assignment: { title: "New assignment for…", sub: "Students in the class see it in their Assignments tab." },
    quiz: { title: "New quiz for…", sub: "Students can’t see a quiz until you open its lobby." }
  };
  function quickAction(kind) {
    if (kind === "live" && status.live) { open("live", status.live.classId); return; }
    if (!status.classes.length) { actions().openNewClass?.(); return; }
    if (status.classes.length === 1) { open(kind, status.classes[0].id); return; }
    const dialog = $("#pickClassDialog");
    $("#pickClassTitle").textContent = PICK[kind].title;
    $("#pickClassSub").textContent = PICK[kind].sub;
    const first = selectedClass()?.id;
    const list = status.classes.slice().sort((a, b) => (b.id === first) - (a.id === first));
    $("#pickClassList").replaceChildren(...list.map((item) => {
      const li = el("li");
      const choice = el("button", "pick-item");
      choice.type = "button";
      choice.style.setProperty("--hue", String(hueOf(item.id)));
      const text = el("span", "pick-text");
      text.append(el("b", "", item.name), el("small", "", `${plural(item.students, "student")}${item.online ? ` · ${item.online} online` : ""}`));
      choice.append(el("span", "cs-badge", initialOf(item.name)), text, icon("i-chevron", "chevron"));
      choice.addEventListener("click", () => { dialog.close(); open(kind, item.id); });
      li.append(choice);
      return li;
    }));
    dialog.showModal();
    $("#pickClassList .pick-item")?.focus();
  }
  document.querySelectorAll("[data-quick]").forEach((node) => node.addEventListener("click", () => quickAction(node.dataset.quick)));

  // ---------- Live banner and welcome ----------
  function renderLive() {
    const item = status.live ? classById(status.live.classId) : null;
    $("#tLiveBanner").hidden = !item;
    if (item) {
      $("#tLiveTitle").textContent = `${item.name} is live`;
      $("#tLiveSub").textContent = `Since ${clock(status.live.since)} · ${status.live.sharing} of ${plural(item.students, "student")} sharing focus`;
    }
    $("#quickLiveLabel").textContent = item ? "Open live session" : "Go live";
    $("#quickLive").dataset.live = String(Boolean(item));
  }
  $("#tLiveOpen").addEventListener("click", () => status.live && open("live", status.live.classId));

  function renderGreeting() {
    const hour = new Date().getHours();
    const greeting = hour < 5 ? "Hello" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
    $("#classesTitle").replaceChildren(`${greeting}, `, el("span", "gradient-name", greetingName(app.profile.display_name)));
    const lead = $("#teacherLead");
    if (!status.loaded) { lead.textContent = "Here’s how your classes are doing."; return; }
    if (!status.classes.length) { lead.textContent = "Welcome! Create your first class to get a join code for your students."; return; }
    const students = sum(status.classes, (c) => c.students);
    const online = sum(status.classes, (c) => c.online);
    const parts = [students ? `${online} of ${plural(students, "student")} online now` : "No students have joined yet"];
    if (data) {
      const marking = sum(toMark(), (m) => m.count);
      const dueSoon = data.assignments.filter((a) => a.due_at && new Date(a.due_at) > Date.now() && daysUntil(a.due_at) < 7).length;
      if (marking) parts.push(`${plural(marking, "submission")} to mark`);
      if (dueSoon) parts.push(`${plural(dueSoon, "deadline")} this week`);
    }
    lead.textContent = `${parts.join(" · ")}.`;
  }

  // ---------- Class switcher ----------
  function selectedClass() {
    return classById(picked) || (status.live && classById(status.live.classId)) || status.classes[0] || null;
  }
  function pick(id, { focus = false } = {}) {
    picked = id;
    try { localStorage.setItem(PICKED_KEY, id); } catch { /* storage unavailable */ }
    renderSwitcher({ animate: true });
    if (focus) $(`#tClassTabs [data-class-id="${CSS.escape(id)}"]`)?.focus();
  }

  // Everything the detail shows about one class.
  function factsFor(item) {
    const live = status.live?.classId === item.id ? status.live : null;
    if (!data) return { item, live, loading: true };
    const finished = finishedSessions().filter((s) => s.class_id === item.id);
    const last = data.sessions.find((s) => s.class_id === item.id && s.ended_at);
    const lastDone = last ? finished.find((s) => s.id === last.id) : null;
    const focusRows = data.focus.filter((f) => f.class_id === item.id);
    const marking = toMark().filter((m) => m.assignment.class_id === item.id);
    const now = Date.now();
    const upcoming = data.assignments
      .filter((a) => a.class_id === item.id && a.due_at && new Date(a.due_at) > now - DAY && new Date(a.due_at) < now + 14 * DAY)
      .sort((a, b) => new Date(a.due_at) - new Date(b.due_at))
      .slice(0, 3)
      .map((a) => ({ id: a.id, title: a.title, due: a.due_at, submitted: submittedCount(a.id) }));
    const quizzes = data.quizzes.filter((q) => q.class_id === item.id && q.status !== "finished").slice(0, 2).map((q) => ({ id: q.id, title: q.title, status: q.status }));
    return {
      item, live,
      rate: pct(sum(finished, attended), sum(finished, counted)),
      bars: finished.slice(0, 8).reverse().map((s) => pct(attended(s), counted(s)) ?? 0),
      sessions: finished.length,
      last: last ? { at: last.started_at, attended: lastDone ? attended(lastDone) : 0, counted: lastDone ? counted(lastDone) : 0 } : null,
      focus: averageFocus(focusRows),
      marking: sum(marking, (m) => m.count),
      markingFirst: marking[0]?.assignment.id || null,
      markingAssignments: marking.length,
      upcoming, quizzes,
      has: data.has
    };
  }

  function renderSwitcher({ animate = false } = {}) {
    const tabs = $("#tClassTabs");
    const detail = $("#tClassDetail");
    if (!status.loaded) return;
    const current = selectedClass();
    const tabsKey = JSON.stringify([status.classes.map((c) => [c.id, c.name, c.online, status.live?.classId === c.id]), current?.id]);
    renderIfChanged("tabs", tabsKey, tabs, () => {
      tabs.replaceChildren(...status.classes.map((item) => {
        const tab = el("button", "cs-tab");
        tab.type = "button";
        tab.setAttribute("role", "tab");
        tab.id = `cs-tab-${item.id}`;
        tab.dataset.classId = item.id;
        tab.dataset.focusKey = `tab-${item.id}`;
        tab.style.setProperty("--hue", String(hueOf(item.id)));
        const selected = item.id === current?.id;
        tab.setAttribute("aria-selected", String(selected));
        tab.setAttribute("aria-controls", "tClassDetail");
        tab.tabIndex = selected ? 0 : -1;
        tab.append(el("span", "cs-badge", initialOf(item.name)), el("span", "cs-name", item.name));
        if (status.live?.classId === item.id) {
          const dot = el("span", "live-dot");
          dot.setAttribute("aria-label", "live now");
          tab.append(dot);
        } else if (item.online) {
          const count = el("span", "cs-online", String(item.online));
          count.setAttribute("aria-label", `${item.online} online`);
          tab.append(count);
        }
        tab.addEventListener("click", () => pick(item.id));
        return tab;
      }));
      tabs.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
    });

    if (!current) {
      renderIfChanged("detail", "empty", detail, () => {
        detail.removeAttribute("aria-labelledby");
        const empty = el("div", "welcome-empty");
        empty.append(chipIcon("i-school"), el("b", "", "Create your first class"),
          el("p", "", "You’ll get a join code to share. Students appear on your master list the moment they join, and you can post, set assignments, run quizzes and go live."),
          button("New class", "btn-primary", () => actions().openNewClass?.(), "i-plus"));
        detail.replaceChildren(empty);
      });
      return;
    }

    const facts = factsFor(current);
    const changed = renderIfChanged("detail", JSON.stringify([facts, Math.floor(Date.now() / 60000)]), detail, () => buildDetail(detail, facts));
    if (changed && animate && !reducedMotion()) {
      detail.classList.remove("is-switching");
      void detail.offsetWidth;
      detail.classList.add("is-switching");
    }
  }

  function buildDetail(detail, facts) {
    const { item, live } = facts;
    detail.setAttribute("aria-labelledby", `cs-tab-${item.id}`);
    detail.style.setProperty("--hue", String(hueOf(item.id)));

    // Name, students and join code
    const head = el("div", "cs-head");
    const title = el("div", "cs-title");
    const meta = el("p");
    meta.append(plural(item.students, "student"));
    if (item.online) meta.append(" · ", el("span", "online", `${item.online} online now`));
    title.append(el("h3", "", item.name), meta);
    const code = button(item.joinCode, "cs-code", null, "i-copy");
    code.dataset.focusKey = "code";
    code.title = "Copy join code";
    code.setAttribute("aria-label", `Copy join code ${item.joinCode}`);
    code.addEventListener("click", async () => {
      await actions().copyCode?.(item.id);
      code.dataset.copied = "true";
      code.lastChild.textContent = "Copied";
      window.setTimeout(() => { code.dataset.copied = ""; code.lastChild.textContent = item.joinCode; }, 1600);
    });
    head.append(el("span", "cs-badge lg", initialOf(item.name)), title, code);

    // Live now, or go live
    const liveRow = el("div", "cs-live");
    liveRow.dataset.live = String(Boolean(live));
    const liveText = el("p");
    if (live) {
      liveText.append(el("span", "live-dot"), el("b", "", "Live now"), ` · since ${clock(live.since)} · ${live.sharing} of ${item.students} sharing focus`);
    } else if (facts.loading) {
      liveText.textContent = "Loading…";
    } else if (facts.last) {
      liveText.append(el("b", "", "Last live "), `${ago(facts.last.at)}${facts.last.counted ? ` · ${facts.last.attended} of ${facts.last.counted} came` : ""}`);
    } else {
      liveText.append(el("b", "", "No live sessions yet. "), "Going live shows each student’s focus and takes attendance for you.");
    }
    const goLive = button(live ? "Open live monitor" : "Go live", live ? "btn-live-sm" : "btn-primary btn-sm", () => open("live", item.id), "i-live");
    goLive.dataset.focusKey = "golive";
    const openIt = button("Open class", "btn-action", () => open("class", item.id));
    openIt.dataset.focusKey = "open";
    const liveButtons = el("div", "cs-live-buttons");
    liveButtons.append(goLive, openIt);
    liveRow.append(liveText, liveButtons);

    // Four numbers, each opening the matching part of the class
    const stats = el("div", "cs-stats");
    const stat = ({ label, value, note, tab, tone, visual, key }) => {
      const node = el("button", "cs-stat");
      node.type = "button";
      node.dataset.focusKey = key;
      if (tone) node.dataset.tone = tone;
      node.append(el("span", "cs-stat-label", label), el("b", "", value));
      if (visual) node.append(visual);
      node.append(el("small", "", note));
      node.addEventListener("click", tab);
      return node;
    };
    let bars = null;
    if (facts.bars?.length) {
      bars = el("span", "cs-bars");
      bars.setAttribute("aria-hidden", "true");
      facts.bars.forEach((value, i) => {
        const bar = el("i");
        bar.style.setProperty("--h", `${Math.max(8, value)}%`);
        bar.style.setProperty("--i", String(i));
        bars.append(bar);
      });
    }
    let meter = null;
    if (facts.focus !== null && facts.focus !== undefined) {
      meter = el("span", "cs-meter");
      meter.setAttribute("aria-hidden", "true");
      const fill = el("i");
      fill.style.width = `${facts.focus}%`;
      meter.append(fill);
    }
    const dash = facts.loading ? "…" : "—";
    stats.append(
      stat({ key: "s-att", label: "Attendance", value: facts.rate === null || facts.rate === undefined ? dash : `${facts.rate}%`, visual: bars,
        note: facts.sessions ? `${plural(facts.sessions, "session")} · 30 days` : "After your first live session", tab: () => open("attendance", item.id) }),
      stat({ key: "s-focus", label: "Focus", value: facts.focus === null || facts.focus === undefined ? dash : `${facts.focus}%`, visual: meter,
        note: facts.focus === null || facts.focus === undefined ? "Shared in live sessions" : levelFor(facts.focus).label, tab: () => open("history", item.id) }),
      stat({ key: "s-mark", label: "To mark", value: facts.loading ? "…" : String(facts.marking || 0), tone: facts.marking ? "amber" : "",
        note: facts.marking ? `${plural(facts.markingAssignments, "assignment")}` : "All caught up",
        tab: () => (facts.markingFirst ? open("mark", item.id, facts.markingFirst) : open("assignments", item.id)) }),
      stat({ key: "s-students", label: "Students", value: String(item.students), note: item.students ? `${item.online} online` : "Share the join code", tab: () => open("students", item.id) })
    );

    // What's coming up in this class
    const next = el("div", "cs-next");
    next.append(el("h4", "", "Coming up"));
    const list = el("ul");
    (facts.upcoming || []).forEach((a) => {
      const li = el("li");
      const row = el("button", "cs-next-item");
      row.type = "button";
      row.dataset.focusKey = `due-${a.id}`;
      const closed = new Date(a.due) < Date.now();
      row.dataset.state = closed ? "closed" : daysUntil(a.due) <= 1 ? "soon" : "";
      const date = el("span", "date-block");
      const d = new Date(a.due);
      date.append(el("small", "", d.toLocaleDateString([], { month: "short" })), el("b", "", String(d.getDate())));
      const text = el("span", "cs-next-text");
      text.append(el("b", "", a.title), el("small", "", `${a.submitted}${item.students ? ` of ${item.students}` : ""} handed in`));
      const progress = el("span", "upcoming-progress");
      progress.style.setProperty("--p", `${item.students ? Math.min(100, Math.round((a.submitted / item.students) * 100)) : 0}%`);
      text.append(progress);
      const when = el("span", "status-chip-sm", untilText(a.due));
      if (row.dataset.state === "soon") when.dataset.state = "soon";
      row.append(date, text, when);
      row.addEventListener("click", () => open("mark", item.id, a.id));
      li.append(row);
      list.append(li);
    });
    (facts.quizzes || []).forEach((q) => {
      const li = el("li");
      const row = el("button", "cs-next-item");
      row.type = "button";
      row.dataset.focusKey = `quiz-${q.id}`;
      const text = el("span", "cs-next-text");
      text.append(el("b", "", q.title), el("small", "", q.status === "draft" ? "Quiz draft, ready when you are" : "Quiz still open"));
      const chip = el("span", "status-chip-sm", q.status === "draft" ? "Draft" : "Open");
      if (q.status !== "draft") chip.dataset.state = "soon";
      row.append(chipIcon("i-quiz", "amber"), text, chip);
      row.addEventListener("click", () => open("quizzes", item.id));
      li.append(row);
      list.append(li);
    });
    if (!list.children.length) {
      const li = el("li", "cs-next-empty");
      li.append(el("span", "", facts.loading ? "Loading…" : "Nothing due in the next two weeks."));
      if (!facts.loading && facts.has?.assignments !== false) {
        const add = button("New assignment", "text-link", () => open("assignment", item.id), "i-plus");
        add.dataset.focusKey = "next-add";
        li.append(add);
      }
      list.append(li);
    }
    next.append(list);

    detail.replaceChildren(head, liveRow, stats, next);
  }

  // Arrow keys, Home and End move between classes (the selected one follows).
  $("#tClassTabs").addEventListener("keydown", (event) => {
    const tabs = [...$("#tClassTabs").querySelectorAll(".cs-tab")];
    const index = tabs.indexOf(document.activeElement);
    if (index < 0) return;
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    let next = null;
    if (step) next = tabs[(index + step + tabs.length) % tabs.length];
    else if (event.key === "Home") next = tabs[0];
    else if (event.key === "End") next = tabs.at(-1);
    if (!next) return;
    event.preventDefault();
    pick(next.dataset.classId, { focus: true });
  });

  // ---------- Needs your attention ----------
  function checkIns() {
    if (!data) return [];
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
      if (statuses.length >= 2 && statuses[0] === "absent" && statuses[1] === "absent") reason = { level: 3, text: "missed the last 2 live sessions", tab: "attendance" };
      else if (statuses.length >= 3 && came / statuses.length < 0.6) reason = { level: 2, text: `came to ${came} of ${statuses.length} sessions`, tab: "attendance" };
      else if (came >= 3 && late / came >= 0.5) reason = { level: 1, text: `joined late to ${late} of ${came} sessions`, tab: "attendance" };
      else if (focus !== null && focus < 50) reason = { level: 1, text: `had ${focus}% focus in recent live sessions`, tab: "history" };
      if (reason) list.push({ ...reason, name, classId: member.class_id, preset: member.profiles?.avatar_preset, path: member.profiles?.avatar_path });
    });
    return list;
  }

  function buildAttention() {
    if (!data) return null;
    const items = [];
    const now = Date.now();
    data.quizzes.filter((q) => q.status === "lobby" || q.status === "live").forEach((q) => items.push({
      level: 5, icon: "i-quiz", tone: "red", title: `${quote(q.title)} is still open`,
      text: `${className(q.class_id)} · finish it so students see their results`,
      action: { label: "Open quiz", run: () => open("quizzes", q.class_id) }
    }));
    toMark().forEach(({ assignment, count, oldest }) => items.push({
      level: daysAgo(oldest) >= 3 ? 4 : 3, icon: "i-assignment", tone: "amber", title: `Mark ${plural(count, "submission")}`,
      text: `${quote(assignment.title)} · ${className(assignment.class_id)} · waiting ${ago(oldest).replace(" ago", "")}`,
      action: { label: "Mark", run: () => open("mark", assignment.class_id, assignment.id) }
    }));
    data.assignments.filter((a) => a.due_at && new Date(a.due_at) > now && new Date(a.due_at) - now < 2 * DAY).forEach((a) => {
      const students = classById(a.class_id)?.students || 0;
      const submitted = submittedCount(a.id);
      if (!students || submitted / students >= 0.5) return;
      items.push({
        level: 3, icon: "i-bell", tone: "amber", title: `Remind ${className(a.class_id)} about ${quote(a.title)}`,
        text: `Due ${untilText(a.due_at).toLowerCase()} · ${submitted} of ${students} handed in`,
        action: { label: "Remind", run: () => open("post", a.class_id, { title: `Reminder: ${a.title}`, body: `A reminder that “${a.title}” is due ${dueWhen(a.due_at)}. You can hand it in from the Assignments tab.` }) }
      });
    });
    checkIns().forEach((entry) => items.push({
      level: entry.level + 0.5, face: entry, tone: entry.level >= 2 ? "amber" : "", title: entry.name,
      text: `${entry.text[0].toUpperCase()}${entry.text.slice(1)} · ${className(entry.classId)}`,
      action: { label: "View", run: () => open(entry.tab, entry.classId) }
    }));
    status.classes.filter((c) => !c.students).forEach((c) => items.push({
      level: 2, icon: "i-users", title: `Invite students to ${c.name}`,
      text: c.joiningOpen === false ? "Joining is closed. Open it in the class settings first." : `No one has joined yet. The join code is ${c.joinCode}.`,
      action: c.joiningOpen === false ? { label: "Settings", run: () => open("settings", c.id) } : { label: "Copy code", run: () => actions().copyCode?.(c.id) }
    }));
    data.quizzes.filter((q) => q.status === "draft").slice(0, 3).forEach((q) => items.push({
      level: 1, icon: "i-quiz", title: `Run ${quote(q.title)}`, text: `Quiz draft in ${className(q.class_id)}`,
      action: { label: "Open", run: () => open("quizzes", q.class_id) }
    }));
    const lastLive = new Map();
    data.sessions.forEach((s) => { if (!lastLive.has(s.class_id)) lastLive.set(s.class_id, s.started_at); });
    status.classes.filter((c) => c.students && status.live?.classId !== c.id).forEach((c) => {
      const last = lastLive.get(c.id);
      if (!last || daysAgo(last) >= 7) items.push({
        level: 0, icon: "i-live", title: `Go live in ${c.name}`,
        text: last ? `Last live session ${daysAgo(last)} days ago` : "No live sessions in the last 30 days",
        action: { label: "Go live", run: () => open("live", c.id) }
      });
    });
    return items.sort((a, b) => b.level - a.level);
  }

  function renderAttention() {
    const box = $("#tTodo");
    const items = buildAttention();
    const marking = sum(toMark(), (m) => m.count);
    const navBadge = $("#navToDo");
    if (navBadge) navBadge.textContent = marking ? String(marking) : "";
    const key = JSON.stringify([items?.map((i) => [i.title, i.text, i.action?.label]), showAllAttention, [...pictureUrls.keys()]]);
    renderIfChanged("attention", key, box, () => {
      const badge = $("#tTodoCount");
      badge.hidden = !items?.length;
      badge.textContent = items?.length ? String(items.length) : "";
      if (!items) { box.replaceChildren(el("li", "empty-state", "Loading…")); return; }
      if (!items.length) {
        const done = el("li", "todo-done");
        done.append(chipIcon("i-check", "green"), el("b", "", "All caught up"), el("small", "", "Nothing to mark, no reminders due and no one to check in with."));
        box.replaceChildren(done);
        return;
      }
      const shown = showAllAttention ? items : items.slice(0, ATTENTION_SHOWN);
      const list = shown.map((entry, index) => {
        const li = el("li", "todo-item");
        if (entry.tone) li.dataset.tone = entry.tone;
        const text = el("div", "todo-text");
        text.append(el("b", "", entry.title), el("small", "", entry.text));
        const action = button(entry.action.label, entry.level >= 3 && !entry.face ? "btn-primary btn-sm" : "btn-action", entry.action.run);
        action.dataset.focusKey = `todo-${index}`;
        li.append(entry.face ? face(entry.face) : chipIcon(entry.icon, entry.tone || ""), text, action);
        return li;
      });
      if (items.length > ATTENTION_SHOWN) {
        const li = el("li", "list-more");
        const more = button(showAllAttention ? "Show fewer" : `Show ${items.length - ATTENTION_SHOWN} more`, "text-link", () => { showAllAttention = !showAllAttention; renderAttention(); });
        more.dataset.focusKey = "todo-more";
        li.append(more);
        list.push(li);
      }
      box.replaceChildren(...list);
    });
  }

  // ---------- More: recent activity ----------
  function buildActivity() {
    const since = Date.now() - 14 * DAY;
    const events = [];
    // Submissions to the same assignment on the same day are grouped into one line.
    const groups = new Map();
    data.submissions.filter((s) => new Date(s.submitted_at) > since).forEach((s) => {
      const key = `${s.assignment_id}:${new Date(s.submitted_at).toDateString()}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(s);
    });
    groups.forEach((list) => {
      const assignment = data.assignments.find((a) => a.id === list[0].assignment_id);
      if (!assignment) return;
      const first = studentName(list[0].student_id);
      events.push({
        at: list[0].submitted_at, student: list[0].student_id,
        title: list.length === 1 ? `${first} handed in ${quote(assignment.title)}` : `${first} and ${plural(list.length - 1, "other")} handed in ${quote(assignment.title)}`,
        sub: className(assignment.class_id), run: () => open("mark", assignment.class_id, assignment.id)
      });
    });
    const finished = new Map(finishedSessions().map((s) => [s.id, s]));
    data.sessions.filter((s) => new Date(s.started_at) > since).forEach((s) => {
      const done = finished.get(s.id);
      const focus = averageFocus(data.focus.filter((f) => f.class_session_id === s.id));
      events.push({
        at: s.ended_at || s.started_at, icon: "i-live", tone: done ? "" : "red",
        title: done ? `Live session in ${className(s.class_id)}` : `${className(s.class_id)} is live now`,
        sub: done
          ? [minutes((new Date(s.ended_at) - new Date(s.started_at)) / 1000), counted(done) ? `${attended(done)} of ${counted(done)} came` : "", focus !== null ? `${focus}% focus` : ""].filter(Boolean).join(" · ")
          : `Since ${clock(s.started_at)}`,
        run: () => open(done ? "attendance" : "live", s.class_id)
      });
    });
    data.posts.filter((p) => new Date(p.created_at) > since).forEach((p) => {
      const label = p.title || (p.body.length > 60 ? `${p.body.slice(0, 57).trim()}…` : p.body);
      events.push({ at: p.created_at, icon: "i-megaphone", title: `You posted ${quote(label)}`, sub: className(p.class_id), run: () => open("posts", p.class_id) });
    });
    data.quizzes.filter((q) => q.finished_at && new Date(q.finished_at) > since).forEach((q) => {
      events.push({ at: q.finished_at, icon: "i-quiz", tone: "amber", title: `Quiz ${quote(q.title)} finished`, sub: className(q.class_id), run: () => open("quizzes", q.class_id) });
    });
    return events.sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 20);
  }

  function renderActivity() {
    const box = $("#tActivity");
    if (!data) return;
    const events = buildActivity();
    const key = JSON.stringify([events.map((e) => [e.at, e.title, e.sub]), showAllActivity, [...pictureUrls.keys()], Math.floor(Date.now() / 60000)]);
    renderIfChanged("activity", key, box, () => {
      if (!events.length) {
        box.replaceChildren(el("li", "empty-state", "Nothing in the last two weeks yet."));
        return;
      }
      const shown = showAllActivity ? events : events.slice(0, ACTIVITY_SHOWN);
      const list = shown.map((event, index) => {
        const li = el("li");
        const row = el("button", "activity-item");
        row.type = "button";
        row.dataset.focusKey = `activity-${index}`;
        const text = el("span", "continue-text");
        text.append(el("b", "", event.title), el("small", "", `${event.sub} · ${ago(event.at)}`));
        row.append(event.student ? studentFace(event.student) : chipIcon(event.icon, event.tone), text, icon("i-chevron", "chevron"));
        row.addEventListener("click", event.run);
        li.append(row);
        return li;
      });
      if (events.length > ACTIVITY_SHOWN) {
        const li = el("li", "list-more");
        const more = button(showAllActivity ? "Show less" : `Show ${events.length - ACTIVITY_SHOWN} more`, "text-link", () => { showAllActivity = !showAllActivity; renderActivity(); });
        more.dataset.focusKey = "activity-more";
        li.append(more);
        list.push(li);
      }
      box.replaceChildren(...list);
    });
    // The folded summary says what's inside.
    const sessions = finishedSessions().length;
    $("#tMoreSub").textContent = sessions || events.length
      ? [sessions ? `${plural(sessions, "live session")} in 30 days` : "", events.length ? `${plural(events.length, "update")} in the last two weeks` : ""].filter(Boolean).join(" · ")
      : "What’s going well, what’s worth a look, and the latest submissions and sessions.";
  }

  // ---------- More: class insights ----------
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

    if (!sessions.length) return { basis: "Insights appear after your first live sessions.", wins, tips };

    if (rate !== null && rate >= 85) wins.push({ icon: "i-attendance", title: `Strong attendance: ${rate}%`, text: `Across ${plural(sessions.length, "live session")} in the last 30 days.` });
    if (lateRate !== null && sum(sessions, attended) >= 5 && lateRate < 10) wins.push({ icon: "i-timer", title: "Students join on time", text: `Only ${lateRate}% of students who joined were late.` });
    if (change !== null && change >= 10) wins.push({ icon: "i-trend", title: "Recorded on-screen time is up", text: `This week’s live sessions were estimated at ${averageFocus(week)}% of measured time on screen, up ${change} points. An estimate, not a measure of learning.` });
    const times = compareGroups(data.focus, timeOfDay);
    if (times) {
      const best = TIMES.find((t) => t.key === times.best.key);
      const worst = TIMES.find((t) => t.key === times.worst.key);
      wins.push({ icon: "i-sun", title: `Higher estimates ${best.phrase}`, text: `${times.best.avg}% of measured time on screen, against ${times.worst.avg}% ${worst.phrase}. A tentative pattern that may also reflect what was taught then.` });
    }

    if (rate !== null && rate < 70) tips.push({ icon: "i-attendance", tone: "amber", title: `Attendance is ${rate}%`, text: "Check in with the students listed under Needs your attention, and send the invite again when you go live." });
    if (lateRate !== null && sum(sessions, attended) >= 5 && lateRate >= 25) {
      tips.push({ icon: "i-timer", tone: "amber", title: `${lateRate}% of students join late`, text: "Post an announcement a couple of minutes before you start, or press Invite again for anyone who hasn’t joined." });
    }
    if (change !== null && change <= -10) tips.push({ icon: "i-flag", tone: "amber", title: "Recorded on-screen time is down this week", text: `Estimated ${averageFocus(week)}% of measured time, down ${Math.abs(change)} points. This can reflect the kind of activity (e.g. writing on paper). If it matches what you saw, shorter activities might be worth trying.` });
    const lengths = compareGroups(data.focus, (s) => (s.tracked_seconds >= 40 * 60 ? "long" : "short"));
    if (lengths && lengths.best.key === "short") {
      tips.push({ icon: "i-timer", title: "Lower estimates in long sessions", text: `${lengths.worst.avg}% of measured time on screen when students track 40+ minutes, against ${lengths.best.avg}% in shorter stretches. A tentative pattern; a short break partway through might be worth trying.` });
    }
    if (!wins.length) wins.push({ icon: "i-check", title: `${plural(sessions.length, "live session")} this month`, text: `${totalCounted ? `${rate}% attendance` : "Attendance is being recorded"} across your classes.` });
    if (!tips.length) tips.push({ icon: "i-check", title: "Nothing stands out", text: "Attendance and punctuality look steady, and the focus estimates show no clear pattern to act on." });
    return { basis: `Based on ${plural(sessions.length, "live session")} in the last 30 days`, wins: wins.slice(0, 3), tips: tips.slice(0, 3) };
  }

  function renderInsights() {
    if (!data) return;
    const insights = buildInsights();
    const key = JSON.stringify([insights.basis, insights.wins, insights.tips]);
    renderIfChanged("insights", key, $("#teacherInsights"), () => {
      $("#tInsightsBasis").textContent = insights.basis;
      const item = (entry, kind) => {
        const li = el("li", `coach-item ${kind}`);
        if (entry.tone) li.dataset.tone = entry.tone;
        const body = el("div", "coach-text");
        body.append(el("b", "", entry.title), el("p", "", entry.text));
        li.append(chipIcon(entry.icon, kind === "win" ? "green" : entry.tone || ""), body);
        return li;
      };
      $("#tWins").replaceChildren(...insights.wins.map((entry) => item(entry, "win")));
      $("#tTips").replaceChildren(...insights.tips.map((entry) => item(entry, "tip")));
    });
  }

  // "More" stays open or closed the way the teacher left it.
  const more = $("#tMore");
  try { more.open = localStorage.getItem(MORE_KEY) === "open"; } catch { /* storage unavailable */ }
  more.addEventListener("toggle", () => {
    try { localStorage.setItem(MORE_KEY, more.open ? "open" : "closed"); } catch { /* storage unavailable */ }
  });

  // ---------- Wiring ----------
  function renderAll() {
    renderLive();
    renderGreeting();
    renderSwitcher();
    renderAttention();
    renderActivity();
    renderInsights();
  }

  window.addEventListener("neurofocus:teacher-status", (event) => {
    const before = loadedFor;
    status = event.detail || status;
    renderAll();
    const ids = status.classes.map((item) => item.id).sort().join(",");
    const endedLive = wasLive && !status.live;
    const startedLive = !wasLive && Boolean(status.live);
    wasLive = Boolean(status.live);
    // New or deleted classes, or a session that started or ended: fetch fresh numbers.
    if (ids !== before || endedLive || startedLive || (data === null && !loading)) void loadData({ force: true });
  });

  // When Home is shown again: settle the cards in and refresh the numbers.
  new MutationObserver(() => {
    if (view.hidden) return;
    view.classList.add("is-entering");
    window.setTimeout(() => view.classList.remove("is-entering"), 900);
    void loadData();
  }).observe(view, { attributes: true, attributeFilter: ["hidden"] });
  // Coming back to the tab: pick up new submissions and posts.
  window.addEventListener("focus", () => { if (!view.hidden) void loadData(); });

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

  // A new name in Profile settings updates the greeting (avatars are repainted by profile.js).
  window.addEventListener("neurofocus:profile-updated", renderGreeting);

  renderAll();
  if (!view.hidden) {
    view.classList.add("is-entering");
    window.setTimeout(() => view.classList.remove("is-entering"), 900);
  }
  if (status.loaded) void loadData({ force: true });
}
