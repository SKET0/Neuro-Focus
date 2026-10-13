// A class's Overview tab, where a class page opens: the live session (join in one click), what's
// still to hand in, the latest posts, open quizzes, the student's own attendance and focus in this
// class, and a quick way to ask NeuroBuddy about it. It also puts small counts on the class tabs.
// Everything shown is the student's own or the class's (the database only returns those); the
// tabs themselves (student-classroom.js) still hold the full lists.
import { dueText, whenText, el, classroomSqlMissing, quizSqlMissing } from "../shared/classroom.js?v=2";
import { selectWithQuality } from "../shared/tracking-states.js?v=1";
import { averageFocus, hasFocus } from "./focus-analysis.js?v=3";

const app = await window.neuroFocusReady;

if (app && document.querySelector("#classPanelOverview")) {
  const { supabase } = app;
  const $ = (selector) => document.querySelector(selector);
  const QUIZ_STATUS = { lobby: "Lobby open", live: "In progress", finished: "Finished" };
  let classId = null;
  let data = null;      // the loaded class: { assignments, mine, posts, quizzes, sessions, notes }
  let loading = null;   // the class id being loaded

  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const time = (iso) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const status = () => window.neuroFocusClassStatus?.classes?.find((item) => item.id === classId) || null;
  const className = () => status()?.name || (window.neuroFocusClasses || []).find((item) => item.id === classId)?.name || "this class";
  const tabHref = (tab) => `#class/${classId}/${tab}`;
  function icon(id) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "icon");
    svg.setAttribute("aria-hidden", "true");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", `#${id}`);
    svg.append(use);
    return svg;
  }
  function button(label, className, onClick) {
    const node = el("button", className, label);
    node.type = "button";
    node.addEventListener("click", onClick);
    return node;
  }
  function link(label, className, href) {
    const node = el("a", className, label);
    node.href = href;
    return node;
  }

  // ---------- Loading ----------
  async function load() {
    const forClass = classId;
    if (!forClass || loading === forClass) return;
    loading = forClass;
    const [assignments, mine, posts, quizzes, sessions, notes] = await Promise.all([
      supabase.from("assignments").select("id, title, due_at, max_marks, created_at").eq("class_id", forClass).order("created_at", { ascending: false }).limit(200),
      supabase.from("assignment_submissions").select("assignment_id, submitted_at, marked_at, marks").eq("class_id", forClass).eq("student_id", app.user.id).limit(500),
      supabase.from("class_posts").select("id, title, body, created_at").eq("class_id", forClass).order("created_at", { ascending: false }).limit(2),
      supabase.from("quizzes").select("id, title, status, finished_at, created_at").eq("class_id", forClass).neq("status", "draft").order("created_at", { ascending: false }).limit(20),
      selectWithQuality((quality) => supabase.from("attention_sessions").select(`id, started_at, ended_at, tracked_seconds, focus_percent${quality}`)
        .eq("class_id", forClass).eq("student_id", app.user.id).gt("tracked_seconds", 4).order("started_at", { ascending: false }).limit(200)),
      supabase.from("student_notes").select("id", { count: "exact", head: true }).eq("class_id", forClass).eq("student_id", app.user.id)
    ]);
    if (loading === forClass) loading = null;
    if (forClass !== classId) return;
    data = {
      assignments: assignments.error ? null : assignments.data,
      mine: mine.error ? new Map() : new Map(mine.data.map((row) => [row.assignment_id, row])),
      classroomMissing: classroomSqlMissing(assignments.error) || classroomSqlMissing(posts.error),
      posts: posts.error ? null : posts.data,
      quizzes: quizzes.error ? null : quizzes.data,
      quizzesMissing: quizSqlMissing(quizzes.error),
      // A session still being recorded (this page, or another tab) isn't history yet.
      sessions: sessions.error ? [] : sessions.data.filter((row) => row.ended_at || !window.neuroFocusSessionInProgress?.(row)),
      notes: notes.error ? null : notes.count ?? 0
    };
    render();
  }

  // ---------- What's still to hand in ----------
  // Not submitted and not closed, soonest deadline first (no deadline last).
  function toDo() {
    if (!data?.assignments) return [];
    return data.assignments
      .filter((item) => !data.mine.has(item.id) && !dueText(item.due_at).closed)
      .sort((a, b) => (a.due_at ? new Date(a.due_at) : Infinity) - (b.due_at ? new Date(b.due_at) : Infinity));
  }
  function recentlyMarked() {
    if (!data?.assignments) return [];
    return data.assignments
      .filter((item) => data.mine.get(item.id)?.marked_at)
      .sort((a, b) => new Date(data.mine.get(b.id).marked_at) - new Date(data.mine.get(a.id).marked_at));
  }

  // Opens one assignment on the Assignments tab (student-classroom.js opens its card).
  function openAssignment(id) {
    window.dispatchEvent(new CustomEvent("neurofocus:open-assignment", { detail: { classId, id } }));
  }

  // ---------- Rendering ----------
  function render() {
    renderLive();
    if (!data) return;
    renderGlance();
    renderNext();
    renderPosts();
    renderQuizzes();
    renderStudy();
    renderTabCounts();
  }

  // The live session, from the class status (student-classes.js), which updates on its own.
  function renderLive() {
    const strip = $("#ovLive");
    const item = status();
    const actions = $("#ovLiveActions");
    actions.replaceChildren();
    const joined = window.neuroFocusClassStatus?.joinedClassId === classId;
    let state = "idle";
    let title = "No live session right now";
    let sub = item?.teacherName ? `When ${item.teacherName} starts one, you’ll get a notification here.` : "When your teacher starts one, you’ll get a notification here.";
    if (item?.blocked) {
      state = "error";
      title = "Live sessions can’t connect";
      sub = "Your school needs to finish a database update. Everything else here still works.";
    } else if (item?.live && item.removed) {
      state = "error";
      title = "Removed from today’s live session";
      sub = "Your teacher removed you from this session. You’re still in the class and will be invited to the next one.";
    } else if (item?.live && (joined || item.inSession)) {
      state = "joined";
      title = "You’re in the live session";
      sub = "Your teacher sees your attention score, never your video.";
      actions.append(link("Open Live focus", "btn-primary", tabHref("live")));
    } else if (item?.live) {
      state = "live";
      title = item.since ? `Live session now · started ${time(item.since)}` : "Live session now";
      sub = "Join to take part. Only your attention score is shared while you’re in, never video.";
      actions.append(button("Join live session", "btn-primary", () => window.neuroFocusClassActions?.joinSession?.(classId)));
    }
    strip.dataset.state = state;
    $("#ovLiveTitle").textContent = title;
    $("#ovLiveSub").textContent = sub;
    $("#ovLiveIcon use")?.setAttribute("href", state === "error" ? "#i-flag" : "#i-video");
  }

  function renderGlance() {
    const due = toDo();
    const soon = due.filter((item) => dueText(item.due_at).soon).length;
    $("#ovDue").textContent = data.assignments ? String(due.length) : "—";
    const dueNote = $("#ovDueNote");
    dueNote.textContent = !data.assignments ? "Not available yet"
      : soon ? `${soon} due within a day`
      : due.length ? `${plural(due.length, "assignment")} to hand in`
      : data.assignments.length ? "All handed in" : "No assignments yet";
    dueNote.dataset.trend = soon ? "down" : data.assignments?.length && !due.length ? "up" : "";

    const attendance = status()?.attendance;
    $("#ovAttendance").textContent = attendance ? `${attendance.attended}/${attendance.counted}` : "—";
    $("#ovAttendanceNote").textContent = attendance ? "live sessions attended" : "No live sessions yet";

    const scored = data.sessions.filter(hasFocus);
    const focus = averageFocus(data.sessions);
    $("#ovFocus").textContent = focus === null ? "—" : `${focus}%`;
    $("#ovFocusNote").textContent = focus === null
      ? "Shown after a live session"
      : `on screen · ${plural(scored.length, "session")}`;
  }

  function renderNext() {
    const list = $("#ovNextList");
    if (!data.assignments) {
      list.replaceChildren(el("li", "empty-state", data.classroomMissing ? "Assignments appear here once your school runs the database update." : "Couldn’t load assignments. Refresh to try again."));
      return;
    }
    const due = toDo();
    const rows = due.slice(0, 4).map((item) => {
      const when = dueText(item.due_at);
      return row(item.title, when.text, when.soon ? "soon" : "waiting", when.soon ? "Due soon" : "To do", "Open", () => openAssignment(item.id));
    });
    if (!rows.length) {
      // Nothing to hand in: show the latest marks instead.
      recentlyMarked().slice(0, 2).forEach((item) => {
        const sub = data.mine.get(item.id);
        const marks = sub.marks !== null ? `${Number(sub.marks)}${item.max_marks ? ` / ${Number(item.max_marks)}` : ""}` : "Feedback";
        rows.push(row(item.title, `Marked ${whenText(sub.marked_at)}`, "marked", marks, "View", () => openAssignment(item.id)));
      });
      list.replaceChildren(el("li", "ov-done", data.assignments.length ? "You’re all caught up. Nothing left to hand in." : "No assignments yet. When your teacher sets one, it shows up here."), ...rows);
      return;
    }
    if (due.length > 4) rows.push(el("li", "ov-more", `+ ${plural(due.length - 4, "more")} on the Assignments tab`));
    list.replaceChildren(...rows);
  }

  function row(title, meta, chipState, chipText, actionLabel, onClick) {
    const item = el("li", "ov-row");
    const text = el("span", "ov-row-text");
    text.append(el("b", "", title), el("small", "", meta));
    const chip = el("span", "status-chip-sm", chipText);
    chip.dataset.state = chipState;
    const action = button(actionLabel, "btn-action", onClick);
    action.setAttribute("aria-label", `${actionLabel}: ${title}`);
    item.append(text, chip, action);
    return item;
  }

  function renderPosts() {
    const list = $("#ovPostList");
    if (!data.posts) {
      list.replaceChildren(el("li", "empty-state", data.classroomMissing ? "Posts appear here once your school runs the database update." : "Couldn’t load posts. Refresh to try again."));
      return;
    }
    if (!data.posts.length) { list.replaceChildren(el("li", "empty-state", "No posts yet. Announcements from your teacher appear here.")); return; }
    list.replaceChildren(...data.posts.map((post) => {
      const item = el("li", "ov-post");
      const head = el("div", "post-head");
      head.append(el("b", "post-title", post.title || "Announcement"), el("time", "post-time", whenText(post.created_at)));
      item.append(head, el("p", "ov-post-body", post.body));
      return item;
    }));
  }

  function renderQuizzes() {
    const list = $("#ovQuizList");
    if (!data.quizzes) {
      list.replaceChildren(el("li", "empty-state", data.quizzesMissing ? "Quizzes appear here once your teacher’s database is updated." : "Couldn’t load quizzes. Refresh to try again."));
      return;
    }
    const open = data.quizzes.filter((quiz) => quiz.status === "lobby" || quiz.status === "live");
    const done = data.quizzes.filter((quiz) => quiz.status === "finished");
    if (!data.quizzes.length) { list.replaceChildren(el("li", "empty-state", "No quizzes yet. When your teacher opens one, it shows up here.")); return; }
    const rows = [
      ...open.map((quiz) => {
        const item = el("li", "ov-row ov-quiz-open");
        const text = el("span", "ov-row-text");
        text.append(el("b", "", quiz.title), el("small", "", quiz.status === "lobby" ? "Your teacher is letting people in" : "Happening now: join for the remaining questions"));
        const chip = el("span", "status-chip-sm", QUIZ_STATUS[quiz.status]);
        chip.dataset.state = quiz.status === "lobby" ? "soon" : "submitted";
        item.append(text, chip, link("Go to quiz", "btn-primary", tabHref("quizzes")));
        return item;
      }),
      ...done.slice(0, open.length ? 1 : 2).map((quiz) => {
        const item = el("li", "ov-row");
        const text = el("span", "ov-row-text");
        text.append(el("b", "", quiz.title), el("small", "", quiz.finished_at ? `Finished ${whenText(quiz.finished_at)}` : "Finished"));
        const chip = el("span", "status-chip-sm", "Finished");
        chip.dataset.state = "marked";
        item.append(text, chip, link("Results", "btn-action", tabHref("quizzes")));
        return item;
      })
    ];
    list.replaceChildren(...rows);
  }

  function renderStudy() {
    const name = className();
    $("#ovBuddyInput").placeholder = `Ask NeuroBuddy about ${name}…`;
    $("#ovNotesCount").textContent = data.notes === null ? "" : data.notes ? ` (${data.notes})` : "";
  }

  // Small counts on the tabs: assignments to hand in, and a dot while a quiz is open.
  function renderTabCounts() {
    const count = $("#classTabAssignmentsCount");
    const due = toDo().length;
    count.hidden = !due;
    count.textContent = String(due);
    count.setAttribute("aria-label", `${plural(due, "assignment")} to hand in`);
    $("#classTabQuizzesDot").hidden = !data.quizzes?.some((quiz) => quiz.status === "lobby" || quiz.status === "live");
  }

  // ---------- Study this class: NeuroBuddy with this class as context ----------
  function askBuddy(text, send) {
    const forClass = classId;
    window.addEventListener("neurofocus:viewchange", () => {
      window.dispatchEvent(new CustomEvent("neurofocus:buddy-prompt", { detail: { text, send, classId: forClass } }));
    }, { once: true });
    window.neuroFocusNavigate?.("buddy");
  }
  $("#ovBuddyForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const input = $("#ovBuddyInput");
    const text = input.value.trim();
    if (!text) { input.focus(); return; }
    input.value = "";
    askBuddy(text, true);
  });
  document.querySelectorAll("[data-ov-ask]").forEach((chip) => chip.addEventListener("click", () => askBuddy(chip.dataset.ovAsk, false)));
  $("#ovNotesButton").addEventListener("click", () => { if (classId) window.neuroFocusOpenClassNotes?.(classId); });

  // ---------- Following the page ----------
  function follow() {
    if (window.neuroFocusView !== "class") return;
    const next = window.neuroFocusRouteClassId || null;
    document.querySelectorAll("[data-ov-tab]").forEach((anchor) => { anchor.href = `#class/${next}/${anchor.dataset.ovTab}`; });
    if (next !== classId) {
      classId = next;
      data = null;
      ["#ovNextList", "#ovPostList", "#ovQuizList"].forEach((id) => $(id).replaceChildren(el("li", "empty-state", "Loading…")));
      ["#ovDue", "#ovAttendance", "#ovFocus"].forEach((id) => { $(id).textContent = "—"; });
      $("#classTabAssignmentsCount").hidden = true;
      $("#classTabQuizzesDot").hidden = true;
      renderLive();
    }
    void load();
  }
  window.addEventListener("neurofocus:viewchange", follow);
  window.addEventListener("neurofocus:class-status", () => { if (window.neuroFocusView === "class") { renderLive(); if (data) { renderGlance(); renderStudy(); } } });
  // A submission, or a quiz opening, made elsewhere shows up when the tab regains focus.
  window.addEventListener("focus", () => { if (window.neuroFocusView === "class" && classId) void load(); });
  window.addEventListener("neurofocus:assignments-changed", () => { if (classId) void load(); });
  follow();
}
