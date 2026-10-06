// Teacher class page: the Posts and Assignments tabs (teacher-classes.js shows them).
// Posts are announcements for the class. Assignments have instructions, an optional deadline,
// "marks out of" and attachment; students each submit one file; the teacher downloads them and
// gives optional marks and feedback. Everything is checked again by the database
// (supabase/migrations/20261010000000_class_posts_assignments.sql): only this class's teacher
// writes posts and assignments, files stay private, and marking goes through mark_submission().
import { confirmAction, notify } from "../shared/class-live.js?v=9";
import {
  checkFile, fileType, fileSize, attachmentPath, uploadFile, removeFiles, downloadFile, dueText, whenText, el,
  classroomSqlMissing, SETUP_TEXT, errorText, ACCEPT, FILE_RULES_TEXT, infoButton
} from "../shared/classroom.js?v=2";

const app = await window.neuroFocusReady;

if (app && document.querySelector("#tab-posts")) {
  const { supabase } = app;
  const $ = (selector) => document.querySelector(selector);
  let tab = "";
  let classId = window.neuroFocusClass?.id || "";
  let assignments = [];
  let submissions = [];
  let openAssignmentId = null;
  // Marks or feedback typed but not saved yet: a background refresh would rebuild the table and
  // lose them, so focus refreshes wait until they're saved (or the teacher leaves the assignment).
  let unsavedMarks = false;
  const editingMarks = () => unsavedMarks || Boolean(document.activeElement?.closest?.("#submissionRows"));
  const roster = () => (Array.isArray(window.neuroFocusRoster) ? window.neuroFocusRoster : []);
  const message = (selector, text, isError = false) => {
    const node = $(selector);
    node.textContent = text;
    node.dataset.state = isError ? "error" : text ? "success" : "";
  };
  function setupMissing(which, missing) {
    const note = $(which === "posts" ? "#teacherPostsSetup" : "#teacherAssignmentsSetup");
    note.hidden = !missing;
    note.textContent = missing ? SETUP_TEXT : "";
    $(which === "posts" ? "#postForm" : "#assignmentComposer").hidden = missing;
  }

  // ---------- Posts ----------
  async function loadPosts() {
    const forClass = classId;
    const list = $("#teacherPostList");
    const { data, error } = await supabase.from("class_posts").select("id, title, body, created_at").eq("class_id", forClass).order("created_at", { ascending: false }).limit(100);
    if (forClass !== classId) return;
    setupMissing("posts", classroomSqlMissing(error));
    if (error) {
      list.replaceChildren(el("li", "empty-state", classroomSqlMissing(error) ? "Posts appear here once the database update is run." : "Couldn’t load posts. Refresh to try again."));
      return;
    }
    if (!data.length) {
      list.replaceChildren(el("li", "empty-state", "No posts yet. Your first announcement will appear here and in your students’ Posts tab."));
      return;
    }
    list.replaceChildren(...data.map((post) => {
      const item = el("li", "post-item");
      const head = el("div", "post-head");
      head.append(el("b", "post-title", post.title || "Announcement"), el("time", "post-time", whenText(post.created_at)));
      const remove = el("button", "icon-btn danger", "");
      remove.type = "button";
      remove.title = "Delete post";
      remove.setAttribute("aria-label", `Delete post “${post.title || post.body.slice(0, 40)}”`);
      remove.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-trash"/></svg>';
      remove.addEventListener("click", async () => {
        const ok = await confirmAction({ title: "Delete this post?", message: "Students won’t see it any more. This can’t be undone.", confirmLabel: "Delete post", danger: true });
        if (!ok) return;
        const { error: deleteError } = await supabase.from("class_posts").delete().eq("id", post.id);
        if (deleteError) notify({ title: "Couldn’t delete the post", text: errorText(deleteError, "Try again."), kind: "error" });
        void loadPosts();
      });
      head.append(remove);
      item.append(head, el("p", "post-body", post.body));
      return item;
    }));
  }

  $("#postForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const title = $("#postTitle").value.trim();
    const body = $("#postBody").value.trim();
    if (!body) { message("#postMessage", "Write a message first.", true); return; }
    const button = form.querySelector("button[type='submit']");
    button.disabled = true;
    message("#postMessage", "Posting…");
    const { error } = await supabase.from("class_posts").insert({ class_id: classId, title: title || null, body });
    button.disabled = false;
    if (error) {
      message("#postMessage", classroomSqlMissing(error) ? SETUP_TEXT : errorText(error, "Couldn’t post. Try again."), true);
      return;
    }
    form.reset();
    message("#postMessage", "Posted. Your students can see it now.");
    void loadPosts();
  });

  // ---------- Assignments ----------
  const counts = (assignmentId) => {
    const rows = submissions.filter((s) => s.assignment_id === assignmentId);
    return { submitted: rows.length, marked: rows.filter((s) => s.marked_at).length };
  };

  async function loadAssignments() {
    const forClass = classId;
    const [assignmentsResult, submissionsResult] = await Promise.all([
      supabase.from("assignments").select("*").eq("class_id", forClass).order("created_at", { ascending: false }).limit(200),
      supabase.from("assignment_submissions").select("id, assignment_id, student_id, file_path, file_name, file_size, file_type, submitted_at, marks, feedback, marked_at").eq("class_id", forClass).limit(5000)
    ]);
    if (forClass !== classId) return;
    const error = assignmentsResult.error || submissionsResult.error;
    setupMissing("assignments", classroomSqlMissing(error));
    if (error) {
      $("#teacherAssignmentList").replaceChildren(el("li", "empty-state", classroomSqlMissing(error) ? "Assignments appear here once the database update is run." : "Couldn’t load assignments. Refresh to try again."));
      return;
    }
    assignments = assignmentsResult.data;
    submissions = submissionsResult.data;
    renderAssignmentList();
    if (openAssignmentId && assignments.some((a) => a.id === openAssignmentId)) renderDetail();
    else closeDetail();
  }

  function renderAssignmentList() {
    const list = $("#teacherAssignmentList");
    if (!assignments.length) {
      list.replaceChildren(el("li", "empty-state", "No assignments yet. Use New assignment to set the first one."));
      return;
    }
    const studentCount = roster().length;
    list.replaceChildren(...assignments.map((assignment) => {
      const item = el("li");
      const button = el("button", "assignment-item");
      button.type = "button";
      const due = dueText(assignment.due_at);
      const { submitted, marked } = counts(assignment.id);
      const text = el("span", "assignment-text");
      text.append(el("b", "", assignment.title), el("small", "", [due.text, assignment.attachment_name ? "1 attachment" : ""].filter(Boolean).join(" · ")));
      const status = el("span", "assignment-count", `${submitted}${studentCount ? ` of ${studentCount}` : ""} submitted${marked ? ` · ${marked} marked` : ""}`);
      button.dataset.state = due.closed ? "closed" : due.soon ? "soon" : "open";
      button.append(text, status);
      button.addEventListener("click", () => { openAssignmentId = assignment.id; message("#submissionMessage", ""); renderDetail(); });
      item.append(button);
      return item;
    }));
  }

  function closeDetail() {
    openAssignmentId = null;
    $("#assignmentDetail").hidden = true;
    $("#assignmentListCard").hidden = false;
    $("#assignmentComposer").hidden = $("#teacherAssignmentsSetup").hidden === false;
  }

  function renderDetail() {
    unsavedMarks = false;
    const assignment = assignments.find((a) => a.id === openAssignmentId);
    if (!assignment) { closeDetail(); return; }
    $("#assignmentListCard").hidden = true;
    $("#assignmentComposer").hidden = true;
    $("#assignmentDetail").hidden = false;
    $("#assignmentDetailTitle").textContent = assignment.title;
    $("#assignmentDetailDue").textContent = [dueText(assignment.due_at).text, assignment.max_marks ? `Marked out of ${Number(assignment.max_marks)}` : "No marks set"].join(" · ");
    const body = $("#assignmentDetailBody");
    body.replaceChildren();
    if (assignment.instructions) body.append(el("p", "assignment-instructions", assignment.instructions));
    if (assignment.attachment_path) body.append(fileButton(assignment.attachment_path, assignment.attachment_name, assignment.attachment_size, "Download attachment"));

    // One row per student on the master list, plus anyone who submitted and has since left.
    const byStudent = new Map(submissions.filter((s) => s.assignment_id === assignment.id).map((s) => [s.student_id, s]));
    const people = roster().map((m) => ({ id: m.id, name: m.name, left: false }));
    byStudent.forEach((s, id) => { if (!people.some((p) => p.id === id)) people.push({ id, name: "Former student", left: true }); });
    const rows = $("#submissionRows");
    if (!people.length) {
      const row = el("tr");
      const cell = el("td", "empty-state", "No students in this class yet.");
      cell.colSpan = 5;
      row.append(cell);
      rows.replaceChildren(row);
      return;
    }
    rows.replaceChildren(...people.sort((a, b) => a.name.localeCompare(b.name)).map((person) => {
      const sub = byStudent.get(person.id);
      const row = el("tr");
      row.append(el("td", "", person.name));
      const fileCell = el("td");
      if (sub) {
        const chip = el("span", "status-chip-sm", sub.marked_at ? "Marked" : "Submitted");
        chip.dataset.state = sub.marked_at ? "marked" : "submitted";
        fileCell.append(chip, el("small", "submission-when", whenText(sub.submitted_at)), fileButton(sub.file_path, sub.file_name, sub.file_size, "Download"));
        if (sub.marked_at && new Date(sub.submitted_at) > new Date(sub.marked_at)) fileCell.append(el("small", "submission-note", "Replaced after marking"));
      } else {
        const chip = el("span", "status-chip-sm", dueText(assignment.due_at).closed ? "Missing" : "Not submitted");
        chip.dataset.state = dueText(assignment.due_at).closed ? "missing" : "waiting";
        fileCell.append(chip);
      }
      const marksCell = el("td");
      const marks = el("input", "field-input marks-input");
      marks.type = "number";
      marks.min = "0";
      marks.max = String(assignment.max_marks ? Number(assignment.max_marks) : 1000);
      marks.step = "0.5";
      marks.inputMode = "decimal";
      marks.disabled = !sub;
      marks.value = sub?.marks ?? "";
      marks.setAttribute("aria-label", `Marks for ${person.name}${assignment.max_marks ? ` out of ${Number(assignment.max_marks)}` : ""}`);
      marksCell.append(marks);
      if (assignment.max_marks) marksCell.append(el("small", "marks-of", `/ ${Number(assignment.max_marks)}`));
      const feedbackCell = el("td");
      const feedback = el("textarea", "field-input feedback-input");
      feedback.rows = 2;
      feedback.maxLength = 5000;
      feedback.disabled = !sub;
      feedback.value = sub?.feedback || "";
      feedback.setAttribute("aria-label", `Feedback for ${person.name}`);
      feedbackCell.append(feedback);
      const saveCell = el("td");
      const save = el("button", "btn-action", "Save");
      save.type = "button";
      save.disabled = !sub;
      save.setAttribute("aria-label", `Save marks and feedback for ${person.name}`);
      save.addEventListener("click", async () => {
        const value = marks.value.trim() === "" ? null : Number(marks.value);
        const max = assignment.max_marks ? Number(assignment.max_marks) : 1000;
        if (value !== null && (!Number.isFinite(value) || value < 0 || value > max)) {
          message("#submissionMessage", `Marks for ${person.name} must be between 0 and ${max}.`, true);
          marks.focus();
          return;
        }
        save.disabled = true;
        const { error } = await supabase.rpc("mark_submission", { p_submission_id: sub.id, p_marks: value, p_feedback: feedback.value });
        save.disabled = false;
        if (error) { message("#submissionMessage", errorText(error, "Couldn’t save. Try again."), true); return; }
        message("#submissionMessage", `Saved for ${person.name}.`);
        await loadAssignments();
      });
      saveCell.append(save);
      row.append(fileCell, marksCell, feedbackCell, saveCell);
      return row;
    }));
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

  $("#assignmentBack").addEventListener("click", () => { closeDetail(); renderAssignmentList(); });
  $("#assignmentDelete").addEventListener("click", async () => {
    const assignment = assignments.find((a) => a.id === openAssignmentId);
    if (!assignment) return;
    const { submitted } = counts(assignment.id);
    const ok = await confirmAction({
      title: `Delete “${assignment.title}”?`,
      message: submitted ? `This also deletes ${submitted} student submission${submitted === 1 ? "" : "s"}, with their files, marks and feedback. It can’t be undone.` : "It can’t be undone.",
      confirmLabel: "Delete assignment",
      danger: true
    });
    if (!ok) return;
    const paths = [assignment.attachment_path, ...submissions.filter((s) => s.assignment_id === assignment.id).map((s) => s.file_path)];
    const { error } = await supabase.from("assignments").delete().eq("id", assignment.id);
    if (error) { notify({ title: "Couldn’t delete the assignment", text: errorText(error, "Try again."), kind: "error" }); return; }
    await removeFiles(supabase, paths);
    closeDetail();
    await loadAssignments();
  });

  // New assignment
  $("#assignmentFile").accept = ACCEPT;
  $("#assignmentFileInfo").append(infoButton("attachment files", `Allowed: ${FILE_RULES_TEXT} Files are private to this class.`));
  $("#assignmentFile").addEventListener("change", (event) => {
    const file = event.currentTarget.files[0];
    message("#assignmentMessage", file ? checkFile(file) : "", Boolean(file && checkFile(file)));
  });
  $("#assignmentForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const title = $("#assignmentTitle").value.trim();
    const dueValue = $("#assignmentDue").value;
    const due = dueValue ? new Date(dueValue) : null;
    const maxValue = $("#assignmentMax").value.trim();
    const max = maxValue === "" ? null : Number(maxValue);
    const file = $("#assignmentFile").files[0] || null;
    if (!title) { message("#assignmentMessage", "Give the assignment a title.", true); return; }
    if (due && (Number.isNaN(due.getTime()) || due <= new Date())) { message("#assignmentMessage", "The deadline must be in the future.", true); return; }
    if (max !== null && (!Number.isFinite(max) || max <= 0 || max > 1000)) { message("#assignmentMessage", "Marks out of must be between 1 and 1000.", true); return; }
    if (file && checkFile(file)) { message("#assignmentMessage", checkFile(file), true); return; }
    const button = form.querySelector("button[type='submit']");
    button.disabled = true;
    message("#assignmentMessage", "Creating…");
    const { data, error } = await supabase.from("assignments").insert({
      class_id: classId, title, instructions: $("#assignmentInstructions").value.trim(), due_at: due ? due.toISOString() : null, max_marks: max
    }).select("id").single();
    if (error) {
      button.disabled = false;
      message("#assignmentMessage", classroomSqlMissing(error) ? SETUP_TEXT : errorText(error, "Couldn’t create the assignment. Try again."), true);
      return;
    }
    let note = "Assignment created. Your students can see it now.";
    if (file) {
      message("#assignmentMessage", `Uploading ${file.name}…`);
      const path = attachmentPath(classId, data.id, file);
      const uploadError = await uploadFile(supabase, path, file);
      const saveError = uploadError ? null : (await supabase.from("assignments").update({
        attachment_path: path, attachment_name: file.name.slice(0, 255), attachment_size: file.size, attachment_type: fileType(file)
      }).eq("id", data.id)).error;
      if (uploadError || saveError) note = `Assignment created, but the attachment couldn’t be added (${errorText(uploadError || saveError, "upload failed")}). Delete and recreate it to try again.`;
    }
    button.disabled = false;
    form.reset();
    message("#assignmentMessage", note, note.startsWith("Assignment created, but"));
    $("#assignmentComposer").open = false;
    await loadAssignments();
  });

  // ---------- When to load ----------
  function refresh() {
    if (!classId) return;
    if (tab === "posts") void loadPosts();
    if (tab === "assignments") void loadAssignments();
  }
  window.addEventListener("neurofocus:class-tab", (event) => { tab = event.detail?.tab || ""; refresh(); });
  window.addEventListener("neurofocus:classchange", (event) => {
    classId = event.detail?.id || "";
    openAssignmentId = null;
    closeDetail();
    message("#postMessage", "");
    message("#assignmentMessage", "");
    refresh();
  });
  // The master list arrives after the class opens: counts and rows use it.
  // (teacher-classes.js reloads it when the window regains focus, so unsaved marks are kept.)
  window.addEventListener("neurofocus:roster-loaded", () => {
    if (tab !== "assignments") return;
    renderAssignmentList();
    if (openAssignmentId && !editingMarks()) renderDetail();
  });
  $("#submissionRows").addEventListener("input", () => { unsavedMarks = true; });
  window.addEventListener("focus", () => {
    if (tab === "assignments" && openAssignmentId && editingMarks()) return;
    refresh();
  });
  // The class page may have opened before this module loaded: start from where it is now.
  classId = window.neuroFocusClass?.id || classId;
  if (window.neuroFocusView === "class") tab = window.neuroFocusClassTab || "";
  refresh();
}
