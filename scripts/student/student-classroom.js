// Student class page: the tabs (Overview, Live focus, Posts, Assignments, Quizzes) and the Posts and
// Assignments panels. Overview is student-class-overview.js; Live focus itself is student-classes.js. Students read their teacher's posts and
// assignments, upload one file per assignment (replaceable until the deadline) and see their own
// marks and feedback. They never see classmates' submissions: the database only returns their
// own (supabase/migrations/20261010000000_class_posts_assignments.sql), and every upload is checked
// again there (class member, before the deadline, own folder, allowed type and size).
import { notify } from "../shared/class-live.js?v=9";
import {
  checkFile, fileType, fileSize, submissionPath, uploadFile, removeFiles, downloadFile, dueText, whenText, el,
  classroomSqlMissing, SETUP_TEXT, errorText, ACCEPT, FILE_RULES_TEXT, infoButton
} from "../shared/classroom.js?v=2";

const app = await window.neuroFocusReady;

if (app && document.querySelector("#view-class")) {
  const { supabase } = app;
  const $ = (selector) => document.querySelector(selector);
  const TABS = ["overview", "live", "posts", "assignments", "quizzes"];
  const PANELS = { overview: "#classPanelOverview", live: "#classPanelLive", posts: "#classPanelPosts", assignments: "#classPanelAssignments", quizzes: "#classPanelQuizzes" };
  let classId = null;
  let tab = "overview";
  let revealId = null; // an assignment to open and scroll to (from the Overview's "Open")
  let assignments = [];
  let mine = new Map(); // assignment id -> my submission
  const openCards = new Set();
  // Refreshing rebuilds the assignment cards, which would drop a file the student has chosen but
  // not submitted yet. Choosing a file opens the browser's file picker, and closing it gives the
  // window focus, so focus refreshes wait while a file is being picked, chosen or uploaded.
  let pickingUntil = 0;
  let uploading = false;
  const choosingFile = () => uploading || Date.now() < pickingUntil
    || [...document.querySelectorAll("#studentAssignmentList input[type=file]")].some((input) => input.files.length > 0);

  // ---------- Tabs ----------
  function showTab() {
    document.querySelectorAll("[data-class-tab]").forEach((button) => {
      const selected = button.dataset.classTab === tab;
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
    });
    TABS.forEach((name) => { $(PANELS[name]).hidden = name !== tab; });
    if (tab === "posts") void loadPosts();
    if (tab === "assignments") void loadAssignments();
  }
  document.querySelectorAll("[data-class-tab]").forEach((button) => {
    button.addEventListener("click", () => { if (classId) window.location.hash = `class/${classId}/${button.dataset.classTab}`; });
  });
  $(".class-hub-tabs").addEventListener("keydown", (event) => {
    const step = { ArrowRight: 1, ArrowLeft: -1, Home: -99, End: 99 }[event.key];
    if (!step || !classId) return;
    event.preventDefault();
    const index = Math.max(0, Math.min(TABS.length - 1, step === -99 ? 0 : step === 99 ? TABS.length - 1 : (TABS.indexOf(tab) + step + TABS.length) % TABS.length));
    document.querySelector(`[data-class-tab="${TABS[index]}"]`)?.focus();
    window.location.hash = `class/${classId}/${TABS[index]}`;
  });
  // The class page and tab come from the address (student-ui.js). This module may load after the
  // page has already been opened, so it also reads the address once when it starts.
  function followRoute() {
    if (window.neuroFocusView !== "class") return;
    const nextClass = window.neuroFocusRouteClassId || null;
    if (nextClass !== classId) { openCards.clear(); assignments = []; mine = new Map(); }
    classId = nextClass;
    tab = TABS.includes(window.neuroFocusRouteClassTab) ? window.neuroFocusRouteClassTab : "overview";
    showTab();
    showLiveDot();
  }
  // A dot on the Live focus tab while this class's live session is on, whichever tab is open.
  function showLiveDot() {
    const item = window.neuroFocusClassStatus?.classes?.find((entry) => entry.id === classId);
    $("#classTabLiveDot").hidden = !(item?.live && !item.removed);
  }
  window.addEventListener("neurofocus:class-status", showLiveDot);
  $("#classNotesButton").addEventListener("click", () => { if (classId) window.neuroFocusOpenClassNotes?.(classId); });
  window.addEventListener("neurofocus:viewchange", followRoute);
  // The Overview's "Open" on an assignment: show the Assignments tab with that card open.
  window.addEventListener("neurofocus:open-assignment", (event) => {
    const { classId: forClass, id } = event.detail || {};
    if (!forClass || !id) return;
    openCards.add(id);
    revealId = id;
    if (window.neuroFocusRouteClassId === forClass && window.neuroFocusRouteClassTab === "assignments") { void loadAssignments(); return; }
    window.location.hash = `class/${forClass}/assignments`;
  });
  window.addEventListener("focus", () => {
    if (window.neuroFocusView !== "class" || !classId) return;
    if (tab === "assignments" && choosingFile()) return;
    showTab();
  });

  // ---------- Posts ----------
  async function loadPosts() {
    const forClass = classId;
    const list = $("#studentPostList");
    const { data, error } = await supabase.from("class_posts").select("id, title, body, created_at").eq("class_id", forClass).order("created_at", { ascending: false }).limit(100);
    if (forClass !== classId) return;
    const missing = classroomSqlMissing(error);
    $("#studentPostsSetup").hidden = !missing;
    $("#studentPostsSetup").textContent = missing ? SETUP_TEXT : "";
    if (error) { list.replaceChildren(el("li", "empty-state", missing ? "Posts appear here once your school runs the database update." : "Couldn’t load posts. Refresh to try again.")); return; }
    if (!data.length) { list.replaceChildren(el("li", "empty-state", "No posts yet. Announcements from your teacher appear here.")); return; }
    list.replaceChildren(...data.map((post) => {
      const item = el("li", "post-item");
      const head = el("div", "post-head");
      head.append(el("b", "post-title", post.title || "Announcement"), el("time", "post-time", whenText(post.created_at)));
      item.append(head, el("p", "post-body", post.body));
      return item;
    }));
  }

  // ---------- Assignments ----------
  async function loadAssignments() {
    const forClass = classId;
    const [assignmentResult, mineResult] = await Promise.all([
      supabase.from("assignments").select("*").eq("class_id", forClass).order("created_at", { ascending: false }).limit(200),
      supabase.from("assignment_submissions").select("*").eq("class_id", forClass).eq("student_id", app.user.id).limit(500)
    ]);
    if (forClass !== classId) return;
    const error = assignmentResult.error || mineResult.error;
    const missing = classroomSqlMissing(error);
    $("#studentAssignmentsSetup").hidden = !missing;
    $("#studentAssignmentsSetup").textContent = missing ? SETUP_TEXT : "";
    if (error) {
      $("#studentAssignmentList").replaceChildren(el("li", "empty-state", missing ? "Assignments appear here once your school runs the database update." : "Couldn’t load assignments. Refresh to try again."));
      return;
    }
    assignments = assignmentResult.data;
    mine = new Map(mineResult.data.map((row) => [row.assignment_id, row]));
    renderAssignments();
  }

  // What to show for one assignment: "Not submitted", "Submitted", "Marked: 8/10", "Missing".
  function statusOf(assignment) {
    const sub = mine.get(assignment.id);
    const due = dueText(assignment.due_at);
    if (sub?.marked_at && sub.marks !== null) return { key: "marked", text: `Marked: ${Number(sub.marks)}${assignment.max_marks ? ` / ${Number(assignment.max_marks)}` : ""}` };
    if (sub?.marked_at) return { key: "marked", text: "Feedback given" };
    if (sub) return { key: "submitted", text: "Submitted" };
    if (due.closed) return { key: "missing", text: "Not submitted · closed" };
    return { key: due.soon ? "soon" : "waiting", text: due.soon ? "Not submitted · due soon" : "Not submitted" };
  }

  function renderAssignments() {
    const list = $("#studentAssignmentList");
    if (!assignments.length) { list.replaceChildren(el("li", "empty-state", "No assignments yet. When your teacher sets one, it appears here.")); return; }
    list.replaceChildren(...assignments.map(assignmentCard));
    if (revealId) {
      const card = list.querySelector(`[data-assignment-id="${revealId}"]`);
      revealId = null;
      card?.scrollIntoView({ behavior: "smooth", block: "start" });
      card?.querySelector(".assignment-toggle")?.focus({ preventScroll: true });
    }
  }

  function assignmentCard(assignment) {
    const item = el("li", "assignment-card");
    item.dataset.assignmentId = assignment.id;
    const status = statusOf(assignment);
    const due = dueText(assignment.due_at);
    const bodyId = `assignment-body-${assignment.id}`;
    const toggle = el("button", "assignment-toggle");
    toggle.type = "button";
    toggle.setAttribute("aria-expanded", String(openCards.has(assignment.id)));
    toggle.setAttribute("aria-controls", bodyId);
    const text = el("span", "assignment-text");
    text.append(el("b", "", assignment.title), el("small", "", due.text));
    const chip = el("span", "status-chip-sm", status.text);
    chip.dataset.state = status.key;
    const chevron = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    chevron.setAttribute("class", "icon chevron");
    chevron.setAttribute("aria-hidden", "true");
    chevron.innerHTML = '<use href="#i-chevron"/>';
    toggle.append(text, chip, chevron);
    const body = el("div", "assignment-card-body");
    body.id = bodyId;
    body.hidden = !openCards.has(assignment.id);
    toggle.addEventListener("click", () => {
      const open = body.hidden;
      body.hidden = !open;
      toggle.setAttribute("aria-expanded", String(open));
      if (open) openCards.add(assignment.id); else openCards.delete(assignment.id);
    });
    fillCard(body, assignment);
    item.append(toggle, body);
    return item;
  }

  function fileButton(path, name, size, label) {
    const button = el("button", "file-chip");
    button.type = "button";
    button.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-paperclip"/></svg>';
    button.append(el("span", "", name || "File"), el("small", "", size ? fileSize(size) : ""));
    button.setAttribute("aria-label", `${label}: ${name || "file"}`);
    button.addEventListener("click", async () => {
      const error = await downloadFile(supabase, path, name);
      if (error) notify({ title: "Couldn’t open the file", text: errorText(error, "Try again."), kind: "error" });
    });
    return button;
  }

  function fillCard(body, assignment) {
    const sub = mine.get(assignment.id);
    const due = dueText(assignment.due_at);
    body.replaceChildren();
    if (assignment.instructions) body.append(el("p", "assignment-instructions", assignment.instructions));
    if (assignment.attachment_path) body.append(fileButton(assignment.attachment_path, assignment.attachment_name, assignment.attachment_size, "Download your teacher’s attachment"));

    // Your submission
    const box = el("div", "submission-box");
    box.append(el("b", "submission-heading", "Your submission"));
    if (sub) {
      box.append(fileButton(sub.file_path, sub.file_name, sub.file_size, "Download your file"), el("small", "submission-when", `Submitted ${whenText(sub.submitted_at)}`));
    } else {
      box.append(el("p", "submission-none", due.closed ? "Nothing was submitted before the deadline." : "Nothing submitted yet."));
    }
    if (sub?.marked_at) {
      const result = el("div", "submission-result");
      if (sub.marks !== null) result.append(el("b", "", `Marks: ${Number(sub.marks)}${assignment.max_marks ? ` / ${Number(assignment.max_marks)}` : ""}`));
      if (sub.feedback) result.append(el("p", "submission-feedback", sub.feedback));
      box.append(result);
    }

    // Upload or replace (until the deadline). Errors stay visible next to the control.
    if (due.closed) {
      box.append(el("p", "submission-closed", "The deadline has passed, so files can no longer be submitted or replaced."));
    } else {
      const inputId = `upload-${assignment.id}`;
      const form = el("form", "upload-form");
      const label = el("label", "field-label", sub ? "Replace your file" : "Choose your file");
      label.htmlFor = inputId;
      const input = el("input", "field-input file-input");
      input.type = "file";
      input.id = inputId;
      input.accept = ACCEPT;
      const button = el("button", "btn-primary", sub ? "Replace file" : "Submit file");
      button.type = "submit";
      const note = el("p", "form-message");
      note.setAttribute("aria-live", "polite");
      input.addEventListener("click", () => { pickingUntil = Date.now() + 120000; });
      input.addEventListener("cancel", () => { pickingUntil = 0; });
      input.addEventListener("change", () => {
        pickingUntil = 0;
        const file = input.files[0];
        const problem = file ? checkFile(file) : "";
        // Say which file is ready, so it's clear it still needs submitting.
        note.textContent = problem || (file ? `Selected: ${file.name} (${fileSize(file.size)}). Press ${button.textContent} to upload it.` : "");
        note.dataset.state = problem ? "error" : "";
      });
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        await submit(assignment, input.files[0], button, note);
      });
      const row = el("div", "upload-row");
      row.append(input, button);
      label.append(" ", infoButton("allowed files", `Allowed: ${FILE_RULES_TEXT} Only you and your teacher can see your file.`));
      form.append(label, row, note);
      box.append(form);
    }
    body.append(box);
  }

  // Upload to the student's own folder, then record it with submit_assignment(). The replaced
  // file is removed afterwards; a file that couldn't be recorded is removed again.
  async function submit(assignment, file, button, note) {
    const problem = checkFile(file);
    const say = (text, isError = false) => { note.textContent = text; note.dataset.state = isError ? "error" : text ? "success" : ""; };
    if (problem) { say(problem, true); return; }
    if (dueText(assignment.due_at).closed) { say("The deadline has passed, so this can no longer be submitted.", true); return; }
    button.disabled = true;
    uploading = true;
    try {
      await uploadAndRecord(assignment, file, button, say);
    } finally {
      uploading = false;
    }
  }

  async function uploadAndRecord(assignment, file, button, say) {
    say(`Uploading ${file.name}…`);
    const path = submissionPath(assignment.class_id, assignment.id, app.user.id, file);
    const uploadError = await uploadFile(supabase, path, file);
    if (uploadError) {
      button.disabled = false;
      say(classroomSqlMissing(uploadError) ? SETUP_TEXT : `Upload failed: ${errorText(uploadError, "check your connection and try again.")}`, true);
      return;
    }
    const { data, error } = await supabase.rpc("submit_assignment", {
      p_assignment_id: assignment.id, p_file_path: path, p_file_name: file.name, p_file_size: file.size, p_file_type: fileType(file)
    });
    if (error) {
      await removeFiles(supabase, [path]);
      button.disabled = false;
      say(errorText(error, "Couldn’t submit. Try again."), true);
      return;
    }
    if (data?.previous_path) await removeFiles(supabase, [data.previous_path]);
    openCards.add(assignment.id);
    await loadAssignments();
    window.dispatchEvent(new CustomEvent("neurofocus:assignments-changed", { detail: { classId } }));
    notify({ title: mine.get(assignment.id) && data?.previous_path ? "File replaced" : "Submitted", text: `“${file.name}” is saved for ${assignment.title}. Only you and your teacher can see it.`, kind: "success" });
  }

  $("#studentAssignmentsInfo").append(infoButton("assignments", `You can submit one file per assignment and replace it until the deadline. Allowed: ${FILE_RULES_TEXT}`));
  followRoute();
}
