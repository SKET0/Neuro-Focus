// Teacher class page: the Quizzes tab (teacher-classes.js shows it). Write multiple-choice quizzes,
// open a lobby, run them question by question (reveal, next, finish) and see the saved results.
// Everything is checked again by the database (supabase/migrations/20261011000000_class_quizzes.sql):
// only this class's teacher writes and runs quizzes, answers are scored there (1 point per correct
// answer, no speed bonus), and students only see a question's answer once it has closed.
// Quiz points have nothing to do with attention tracking.
import { confirmAction, notify } from "../shared/class-live.js";
import { el, errorText, infoButton, quizSqlMissing, QUIZ_SETUP_TEXT, CHOICE_LETTERS, secondsLeft, whenText } from "../shared/classroom.js";

const app = await window.neuroFocusReady;

if (app && document.querySelector("#tab-quizzes")) {
  const { supabase } = app;
  const $ = (selector) => document.querySelector(selector);
  const POLL_MS = 1000;
  let classId = window.neuroFocusClass?.id || "";
  let tab = "";
  let quizzes = [];
  let editingId = null;      // the draft being edited (null: a new quiz)
  let hostId = null;         // the quiz being hosted or reviewed
  let hostTimer = null;
  let hostState = null;      // last quiz_state, with fetchedAt
  let busy = false;          // a host button is waiting for the database
  let hostKey = "";          // what the host view currently shows
  const STATUS_TEXT = { draft: "Draft", lobby: "Lobby open", live: "Running", finished: "Finished" };

  const message = (selector, text, isError = false) => {
    const node = $(selector);
    node.textContent = text;
    node.dataset.state = isError ? "error" : text ? "success" : "";
  };
  const showOnly = (section) => {
    $("#quizListCard").hidden = section !== "list";
    $("#quizEditor").hidden = section !== "editor";
    $("#quizHost").hidden = section !== "host";
    if (section !== "host") stopHosting();
  };

  // ---------- List ----------
  async function loadQuizzes() {
    const forClass = classId;
    const { data, error } = await supabase.from("quizzes").select("id, title, status, time_limit_seconds, show_leaderboard, created_at, finished_at")
      .eq("class_id", forClass).order("created_at", { ascending: false }).limit(200);
    if (forClass !== classId) return;
    const missing = quizSqlMissing(error);
    $("#teacherQuizzesSetup").hidden = !missing;
    $("#teacherQuizzesSetup").textContent = missing ? QUIZ_SETUP_TEXT : "";
    $("#newQuiz").disabled = missing;
    const list = $("#teacherQuizList");
    if (error) { list.replaceChildren(el("li", "empty-state", missing ? "Quizzes appear here once the database update is run." : "Couldn’t load quizzes. Refresh to try again.")); return; }
    quizzes = data;
    if (!quizzes.length) { list.replaceChildren(el("li", "empty-state", "No quizzes yet. Press New quiz to write the first one.")); return; }
    list.replaceChildren(...quizzes.map((quiz) => {
      const item = el("li", "quiz-row");
      const text = el("span", "assignment-text");
      text.append(el("b", "", quiz.title), el("small", "", [
        quiz.time_limit_seconds ? `${quiz.time_limit_seconds} s per question` : "No timer",
        quiz.show_leaderboard ? "Leaderboard on" : "Leaderboard off",
        quiz.finished_at ? `Finished ${whenText(quiz.finished_at)}` : ""
      ].filter(Boolean).join(" · ")));
      const chip = el("span", "status-chip-sm", STATUS_TEXT[quiz.status]);
      chip.dataset.state = { draft: "waiting", lobby: "soon", live: "submitted", finished: "marked" }[quiz.status];
      const actions = el("span", "quiz-row-actions");
      const action = (label, className, onClick) => {
        const button = el("button", className, label);
        button.type = "button";
        button.addEventListener("click", onClick);
        actions.append(button);
      };
      if (quiz.status === "draft") {
        action("Edit", "btn-action", () => openEditor(quiz.id));
        action("Open lobby", "btn-primary", () => openLobby(quiz));
        action("Delete", "btn-action danger-action", () => deleteQuiz(quiz));
      } else if (quiz.status === "finished") {
        action("Results", "btn-action", () => host(quiz.id));
        action("Delete", "btn-action danger-action", () => deleteQuiz(quiz));
      } else {
        action(quiz.status === "lobby" ? "Host lobby" : "Host quiz", "btn-primary", () => host(quiz.id));
      }
      item.append(text, chip, actions);
      return item;
    }));
  }

  async function openLobby(quiz) {
    const { error } = await supabase.rpc("quiz_open_lobby", { p_quiz_id: quiz.id });
    if (error) { notify({ title: "Couldn’t open the lobby", text: errorText(error, "Try again."), kind: "error" }); return; }
    await host(quiz.id);
  }

  async function deleteQuiz(quiz) {
    const ok = await confirmAction({
      title: `Delete “${quiz.title}”?`,
      message: quiz.status === "finished" ? "Its saved results are deleted too. This can’t be undone." : "This can’t be undone.",
      confirmLabel: "Delete quiz", danger: true
    });
    if (!ok) return;
    const { error } = await supabase.from("quizzes").delete().eq("id", quiz.id);
    if (error) notify({ title: "Couldn’t delete the quiz", text: errorText(error, "Try again."), kind: "error" });
    await loadQuizzes();
  }

  // ---------- Editor ----------
  function questionBlock(question = { prompt: "", options: ["", ""], correct_index: 0 }) {
    const item = el("li", "quiz-question");
    const head = el("div", "quiz-question-head");
    const number = el("b", "quiz-question-number");
    const remove = el("button", "text-link", "Remove question");
    remove.type = "button";
    remove.addEventListener("click", () => { item.remove(); renumber(); });
    head.append(number, remove);
    const prompt = el("textarea", "field-input quiz-prompt");
    prompt.rows = 2;
    prompt.maxLength = 500;
    prompt.required = true;
    prompt.value = question.prompt;
    const choices = el("div", "quiz-choice-edit");
    const groupName = `correct-${Math.random().toString(36).slice(2)}`;
    const addChoice = (text = "", correct = false) => {
      const row = el("div", "quiz-choice-row");
      const radio = el("input");
      radio.type = "radio";
      radio.name = groupName;
      radio.checked = correct;
      const input = el("input", "field-input");
      input.type = "text";
      input.maxLength = 200;
      input.required = true;
      input.value = text;
      const drop = el("button", "icon-btn", "×");
      drop.type = "button";
      drop.addEventListener("click", () => {
        if (choices.querySelectorAll(".quiz-choice-row").length <= 2) return;
        row.remove();
        relabel();
      });
      row.append(radio, el("span", "quiz-letter"), input, drop);
      choices.append(row);
      relabel();
    };
    const relabel = () => [...choices.querySelectorAll(".quiz-choice-row")].forEach((row, i) => {
      row.querySelector(".quiz-letter").textContent = CHOICE_LETTERS[i];
      row.querySelector("input[type=text]").setAttribute("aria-label", `Choice ${CHOICE_LETTERS[i]}`);
      row.querySelector("input[type=radio]").setAttribute("aria-label", `Choice ${CHOICE_LETTERS[i]} is correct`);
      row.querySelector(".icon-btn").setAttribute("aria-label", `Remove choice ${CHOICE_LETTERS[i]}`);
    });
    question.options.forEach((text, i) => addChoice(text, i === question.correct_index));
    const more = el("button", "text-link", "+ Add choice");
    more.type = "button";
    more.addEventListener("click", () => { if (choices.querySelectorAll(".quiz-choice-row").length < 6) addChoice(); });
    item.append(head, prompt, el("small", "quiz-hint", "Tick the correct choice."), choices, more);
    item.$read = () => {
      const rows = [...choices.querySelectorAll(".quiz-choice-row")];
      return { prompt: prompt.value.trim(), options: rows.map((r) => r.querySelector("input[type=text]").value.trim()), correct_index: rows.findIndex((r) => r.querySelector("input[type=radio]").checked) };
    };
    return item;
  }
  function renumber() {
    [...$("#quizQuestions").children].forEach((item, i) => {
      item.querySelector(".quiz-question-number").textContent = `Question ${i + 1}`;
      item.querySelector(".quiz-prompt").setAttribute("aria-label", `Question ${i + 1}`);
    });
  }

  async function openEditor(quizId = null) {
    editingId = quizId;
    message("#quizEditorMessage", "");
    $("#quizEditorTitle").lastChild.textContent = quizId ? "Edit quiz" : "New quiz";
    const list = $("#quizQuestions");
    list.replaceChildren();
    if (quizId) {
      const quiz = quizzes.find((q) => q.id === quizId);
      $("#quizTitle").value = quiz.title;
      $("#quizTimer").value = quiz.time_limit_seconds ? String(quiz.time_limit_seconds) : "";
      $("#quizLeaderboard").checked = quiz.show_leaderboard;
      const { data } = await supabase.from("quiz_questions").select("position, prompt, options, correct_index").eq("quiz_id", quizId).order("position");
      (data || []).sort((a, b) => a.position - b.position).forEach((q) => list.append(questionBlock(q)));
    } else {
      $("#quizTitle").value = "";
      $("#quizTimer").value = "20";
      $("#quizLeaderboard").checked = true;
    }
    if (!list.children.length) list.append(questionBlock());
    renumber();
    showOnly("editor");
    $("#quizTitle").focus();
  }

  $("#newQuiz").addEventListener("click", () => openEditor(null));
  $("#cancelQuizEdit").addEventListener("click", () => showOnly("list"));
  $("#addQuizQuestion").addEventListener("click", () => {
    $("#quizQuestions").append(questionBlock());
    renumber();
    $("#quizQuestions").lastElementChild.querySelector(".quiz-prompt").focus();
  });

  $("#quizEditor").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const title = $("#quizTitle").value.trim();
    const questions = [...$("#quizQuestions").children].map((item) => item.$read());
    const problem = !title ? "Give the quiz a title."
      : !questions.length ? "Add at least one question."
        : questions.findIndex((q) => !q.prompt) >= 0 ? `Question ${questions.findIndex((q) => !q.prompt) + 1} needs some text.`
          : questions.findIndex((q) => q.options.some((o) => !o)) >= 0 ? `Question ${questions.findIndex((q) => q.options.some((o) => !o)) + 1} has an empty choice.`
            : questions.findIndex((q) => q.correct_index < 0) >= 0 ? `Tick the correct choice for question ${questions.findIndex((q) => q.correct_index < 0) + 1}.`
              : "";
    if (problem) { message("#quizEditorMessage", problem, true); return; }
    const button = form.querySelector("button[type=submit]");
    button.disabled = true;
    message("#quizEditorMessage", "Saving…");
    const fields = { title, time_limit_seconds: $("#quizTimer").value ? Number($("#quizTimer").value) : null, show_leaderboard: $("#quizLeaderboard").checked };
    let quizId = editingId;
    let error = null;
    if (quizId) {
      ({ error } = await supabase.from("quizzes").update(fields).eq("id", quizId));
      if (!error) ({ error } = await supabase.from("quiz_questions").delete().eq("quiz_id", quizId));
    } else {
      const result = await supabase.from("quizzes").insert({ class_id: classId, ...fields }).select("id").single();
      error = result.error;
      quizId = result.data?.id;
    }
    if (!error) ({ error } = await supabase.from("quiz_questions").insert(questions.map((q, position) => ({ quiz_id: quizId, position, ...q }))));
    button.disabled = false;
    if (error) { message("#quizEditorMessage", quizSqlMissing(error) ? QUIZ_SETUP_TEXT : errorText(error, "Couldn’t save the quiz. Try again."), true); return; }
    showOnly("list");
    await loadQuizzes();
    notify({ title: "Quiz saved", text: "It’s a draft: students can’t see it until you open the lobby.", kind: "success" });
  });

  // ---------- Hosting ----------
  function stopHosting() {
    window.clearInterval(hostTimer);
    hostTimer = null;
    hostId = null;
    hostState = null;
    hostKey = "";
  }

  async function host(quizId) {
    stopHosting();
    hostId = quizId;
    message("#quizHostMessage", "");
    showOnly("host");
    await pollHost();
    hostTimer = window.setInterval(() => { void pollHost(); }, POLL_MS);
  }

  let polling = false;
  async function pollHost() {
    const forQuiz = hostId;
    if (!forQuiz || polling) return;
    polling = true;
    const { data, error } = await supabase.rpc("quiz_state", { p_quiz_id: forQuiz });
    polling = false;
    if (forQuiz !== hostId) return;
    if (error) {
      $("#quizHostStatus").textContent = navigator.onLine === false ? "Connection lost · reconnecting…" : `Couldn’t refresh: ${errorText(error, "retrying…")}`;
      return;
    }
    const previous = hostState;
    hostState = { ...data, fetchedAt: Date.now() };
    if (data.quiz.status === "finished") {
      window.clearInterval(hostTimer);
      hostTimer = null;
      if (previous?.quiz.status !== "finished" || !$("#quizHostBody").querySelector(".quiz-results")) await renderResults();
      return;
    }
    renderHost();
  }

  function hostButton(label, className, rpc) {
    const button = el("button", className, label);
    button.type = "button";
    button.disabled = busy;
    button.addEventListener("click", async () => {
      if (busy) return;
      busy = true;
      button.disabled = true;
      const { error } = await supabase.rpc(rpc, { p_quiz_id: hostId });
      busy = false;
      if (error) message("#quizHostMessage", errorText(error, "Try again."), true);
      else message("#quizHostMessage", "");
      await pollHost();
    });
    return button;
  }

  // Rebuilds the host view only when something on it changed (so buttons aren't replaced
  // under the mouse); otherwise just the countdown is updated.
  function renderHost() {
    const state = hostState;
    const { quiz, question } = state;
    const leftNow = secondsLeft(question?.closes_at, state.now, state.fetchedAt);
    const key = [quiz.status, state.participants, (state.participant_names || []).join("|"), question?.id, question?.closed, leftNow === 0, question?.answered, busy].join(":");
    if (key === hostKey) { hostTick(); return; }
    hostKey = key;
    $("#quizHostTitle").textContent = quiz.title;
    const body = $("#quizHostBody");
    const controls = el("div", "quiz-controls");
    if (quiz.status === "lobby") {
      $("#quizHostStatus").textContent = `Lobby open · ${state.participants} joined`;
      const lobby = el("div", "quiz-lobby");
      lobby.append(el("p", "quiz-big", `${state.participants}`), el("p", "panel-sub", state.participants === 1 ? "student has joined" : "students have joined"));
      const names = el("ul", "quiz-names");
      (state.participant_names || []).forEach((name) => names.append(el("li", "", name)));
      if (!state.participant_names?.length) names.append(el("li", "empty-state", "Waiting for students to join from their Quizzes tab…"));
      lobby.append(names);
      controls.append(hostButton(`Start quiz (${quiz.question_count} question${quiz.question_count === 1 ? "" : "s"})`, "btn-primary", "quiz_next_question"), hostButton("End without playing", "btn-action", "quiz_finish"));
      body.replaceChildren(lobby, controls);
      return;
    }
    // Live: the current question, with its answer (the teacher always sees it).
    const left = secondsLeft(question.closes_at, state.now, state.fetchedAt);
    const closed = question.closed || left === 0;
    $("#quizHostStatus").textContent = `Question ${question.number} of ${quiz.question_count} · ${question.answered} of ${state.participants} answered${closed ? " · closed" : ""}`;
    const card = el("div", "quiz-question-card");
    const top = el("div", "quiz-question-top");
    top.append(el("span", "quiz-progress-label", `Question ${question.number} of ${quiz.question_count}`));
    if (left !== null) {
      const timer = el("span", "quiz-timer");
      timer.setAttribute("aria-hidden", "true");
      top.append(timer);
    }
    card.append(top, el("p", "quiz-prompt-text", question.prompt));
    const choices = el("ol", "quiz-choices");
    question.options.forEach((option, i) => {
      const choice = el("li", "quiz-choice static");
      choice.dataset.correct = String(i === question.correct_index);
      choice.append(el("span", "quiz-letter", CHOICE_LETTERS[i]), el("span", "quiz-choice-text", option));
      const count = question.counts?.[i] ?? 0;
      if (closed) {
        const bar = el("span", "quiz-count");
        bar.style.setProperty("--share", `${state.participants ? Math.round((count / state.participants) * 100) : 0}%`);
        bar.textContent = `${count}`;
        choice.append(bar);
      }
      if (i === question.correct_index) choice.append(el("span", "quiz-correct-tag", "Correct"));
      choices.append(choice);
    });
    card.append(choices);
    if (!closed) controls.append(hostButton("Reveal answer", "btn-primary", "quiz_close_question"));
    else controls.append(hostButton(question.number < quiz.question_count ? "Next question" : "Show results", "btn-primary", "quiz_next_question"));
    controls.append(hostButton("End quiz now", "btn-action", "quiz_finish"));
    body.replaceChildren(card, controls);
    hostTick();
  }

  function hostTick() {
    const timer = $("#quizHostBody .quiz-timer");
    if (!timer || !hostState?.question) return;
    const left = secondsLeft(hostState.question.closes_at, hostState.now, hostState.fetchedAt);
    const closed = hostState.question.closed || left === 0;
    timer.textContent = closed ? "Time’s up" : `${left} s`;
    timer.dataset.state = closed ? "done" : left <= 5 ? "low" : "";
  }

  async function renderResults() {
    const forQuiz = hostId;
    const { data, error } = await supabase.rpc("quiz_results", { p_quiz_id: forQuiz });
    if (forQuiz !== hostId) return;
    const quiz = quizzes.find((q) => q.id === forQuiz);
    $("#quizHostTitle").textContent = quiz?.title || hostState?.quiz.title || "Quiz";
    if (error) { $("#quizHostBody").replaceChildren(el("p", "empty-state", errorText(error, "Couldn’t load the results."))); return; }
    $("#quizHostStatus").textContent = `Finished · results saved · ${data.question_count} question${data.question_count === 1 ? "" : "s"}`;
    const wrap = el("div", "quiz-results");
    const rows = data.leaderboard || [];
    if (!rows.length) wrap.append(el("p", "empty-state", "Nobody joined this quiz."));
    else {
      const table = el("table", "data-table");
      table.innerHTML = "<thead><tr><th>#</th><th>Student</th><th class=\"num\">Score</th><th class=\"num\">Answered</th></tr></thead>";
      const tbody = el("tbody");
      rows.forEach((row, i) => {
        const tr = el("tr");
        tr.append(el("td", "", String(i + 1)), el("td", "", row.name), el("td", "num", `${row.score} / ${data.question_count}`), el("td", "num", String(row.answered)));
        tbody.append(tr);
      });
      table.append(tbody);
      const scroll = el("div", "table-scroll");
      scroll.append(table);
      wrap.append(scroll, el("p", "panel-sub", data.show_leaderboard ? "Students see this leaderboard with their own summary." : "The leaderboard is off: each student sees only their own result."));
    }
    $("#quizHostBody").replaceChildren(wrap);
    await loadQuizzes();
  }

  $("#quizHostBack").addEventListener("click", () => { showOnly("list"); void loadQuizzes(); });

  // Between server checks, keep the countdown ticking.
  window.setInterval(() => { if (hostState && hostState.quiz.status === "live" && hostState.question?.closes_at && !busy) renderHost(); }, 250);

  // ---------- When to load ----------
  // Leaving the tab mid-quiz pauses the checks; coming back picks the same quiz up again.
  let resumeId = null;
  function refresh() {
    if (!classId || tab !== "quizzes") {
      if (hostId) resumeId = hostId;
      stopHosting();
      return;
    }
    if (resumeId) { const id = resumeId; resumeId = null; void host(id); return; }
    if (!hostId && $("#quizEditor").hidden) void loadQuizzes();
  }
  window.addEventListener("neurofocus:class-tab", (event) => { tab = event.detail?.tab || ""; refresh(); });
  window.addEventListener("neurofocus:classchange", (event) => {
    classId = event.detail?.id || "";
    resumeId = null;
    showOnly("list");
    refresh();
  });
  window.addEventListener("neurofocus:viewchange", (event) => {
    if (event.detail?.name === "class") return;
    tab = "";
    refresh();
  });
  $("#teacherQuizTips").append(infoButton("running a quiz", "Open the lobby, wait for students to join, then Start. After each question press Reveal answer (or let the timer run out), then Next question. Scores are 1 point per correct answer, worked out by the database, and saved."));
  $("#quizLeaderboardInfo").append(infoButton("the leaderboard", "When on, students see everyone’s scores after the quiz. When off, each student sees only their own result."));
  classId = window.neuroFocusClass?.id || classId;
  if (window.neuroFocusView === "class") tab = window.neuroFocusClassTab || "";
  refresh();
}
