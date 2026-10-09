// Student class page: the Quizzes tab (student-classroom.js switches the tabs). Students join a
// quiz their teacher has opened, answer each question once and get a summary at the end. The
// database does the checking and scoring (supabase/migrations/20261011000000_class_quizzes.sql):
// class members only, one answer per question while it's open, 1 point per correct answer, and
// the correct answer is only sent once the question has closed. Quiz points never use attention
// scores. If the connection drops, the page keeps retrying and picks up where the quiz is now.
import { el, errorText, infoButton, quizSqlMissing, QUIZ_SETUP_TEXT, CHOICE_LETTERS, secondsLeft } from "../shared/classroom.js?v=2";

const app = await window.neuroFocusReady;

if (app && document.querySelector("#classPanelQuizzes")) {
  const { supabase } = app;
  const $ = (selector) => document.querySelector(selector);
  const POLL_MS = 1000;
  const STATUS_TEXT = { lobby: "Lobby open", live: "Running now", finished: "Finished" };
  let classId = null;
  let active = false;        // the Quizzes tab is showing
  let quizzes = [];
  let playId = null;         // the quiz being played or reviewed
  let pollTimer = null;
  let state = null;          // last quiz_state, with fetchedAt
  let shownKey = "";         // what the play area currently shows, so polls don't rebuild it needlessly
  let sending = false;       // an answer is on its way
  let failures = 0;
  let joinOnOpen = false;    // the student pressed Join quiz in the list
  let listSignature = "";    // what the quiz list currently shows

  const status = (text) => { $("#studentQuizStatus").textContent = text; };
  const showOnly = (section) => {
    $("#studentQuizListCard").hidden = section !== "list";
    $("#studentQuizPlay").hidden = section !== "play";
    if (section !== "play") stopPlaying();
  };

  // ---------- List ----------
  async function loadQuizzes() {
    const forClass = classId;
    const { data, error } = await supabase.from("quizzes").select("id, title, status, time_limit_seconds, show_leaderboard, started_at, finished_at, created_at")
      .eq("class_id", forClass).neq("status", "draft").order("created_at", { ascending: false }).limit(100);
    if (forClass !== classId) return;
    const missing = quizSqlMissing(error);
    $("#studentQuizzesSetup").hidden = !missing;
    $("#studentQuizzesSetup").textContent = missing ? QUIZ_SETUP_TEXT : "";
    const list = $("#studentQuizList");
    if (error) { listSignature = ""; list.replaceChildren(el("li", "empty-state", missing ? "Quizzes appear here once your teacher’s database is updated." : "Couldn’t load quizzes. Refresh to try again.")); return; }
    // Rebuild only when something changed, so the buttons aren't replaced under the pointer.
    const signature = JSON.stringify(data.map((q) => [q.id, q.status, q.title]));
    if (signature === listSignature) { quizzes = data; return; }
    listSignature = signature;
    quizzes = data;
    if (!quizzes.length) { list.replaceChildren(el("li", "empty-state", "No quizzes yet. When your teacher opens one, it appears here.")); return; }
    // Open quizzes first, then finished ones.
    const order = { live: 0, lobby: 1, finished: 2 };
    list.replaceChildren(...[...quizzes].sort((a, b) => order[a.status] - order[b.status]).map((quiz) => {
      const item = el("li", "quiz-row");
      const text = el("span", "assignment-text");
      text.append(el("b", "", quiz.title), el("small", "", quiz.status === "finished"
        ? "See your score and the answers"
        : quiz.time_limit_seconds ? `${quiz.time_limit_seconds} s per question` : "No timer"));
      const chip = el("span", "status-chip-sm", STATUS_TEXT[quiz.status]);
      chip.dataset.state = { lobby: "soon", live: "submitted", finished: "marked" }[quiz.status];
      // An open quiz is joined straight from here (the student's own click); a finished one shows results.
      const button = el("button", quiz.status === "finished" ? "btn-action" : "btn-primary", quiz.status === "finished" ? "Results" : "Join quiz");
      button.type = "button";
      button.setAttribute("aria-label", `${button.textContent}: ${quiz.title}`);
      button.addEventListener("click", () => play(quiz.id, { join: quiz.status !== "finished" }));
      const actions = el("span", "quiz-row-actions");
      actions.append(button);
      item.append(text, chip, actions);
      return item;
    }));
  }

  // ---------- Playing ----------
  function stopPlaying() {
    window.clearTimeout(pollTimer);
    pollTimer = null;
    playId = null;
    state = null;
    shownKey = "";
    failures = 0;
  }

  async function play(quizId, { join = false } = {}) {
    stopPlaying();
    joinOnOpen = join;
    showOnly("play");
    playId = quizId;
    const quiz = quizzes.find((q) => q.id === quizId);
    $("#studentQuizTitle").textContent = quiz?.title || "Quiz";
    $("#studentQuizBody").replaceChildren(el("p", "empty-state", "Loading…"));
    status("");
    $("#studentQuizBack").focus();
    await poll();
  }

  // Asks the database where the quiz is now. Runs every second while a quiz is open; after a
  // dropped connection it simply keeps asking, so a student who reconnects lands on the current question.
  async function poll() {
    window.clearTimeout(pollTimer);
    const forQuiz = playId;
    if (!forQuiz) return;
    const { data, error } = await supabase.rpc("quiz_state", { p_quiz_id: forQuiz });
    if (forQuiz !== playId) return;
    if (error) {
      failures += 1;
      if (failures >= 2 || navigator.onLine === false) status("Connection lost · reconnecting… Your answers are safe.");
      if (error.code === "42501") { $("#studentQuizBody").replaceChildren(el("p", "empty-state", errorText(error, "This quiz isn’t available."))); return; }
    } else {
      if (failures) status("");
      failures = 0;
      state = { ...data, fetchedAt: Date.now() };
      await render();
    }
    if (playId === forQuiz && state?.quiz.status !== "finished") pollTimer = window.setTimeout(poll, POLL_MS);
  }

  async function render() {
    const { quiz, question } = state;
    $("#studentQuizTitle").textContent = quiz.title;
    if (quiz.status === "finished") { if (shownKey !== "finished") { shownKey = "finished"; await renderSummary(); } return; }
    if (!state.joined) {
      if (shownKey === "join") return;
      shownKey = "join";
      status(quiz.status === "lobby" ? "The lobby is open." : "This quiz has already started. You can still join for the remaining questions.");
      const box = el("div", "quiz-lobby");
      const join = el("button", "btn-primary quiz-join", "Join quiz");
      join.type = "button";
      join.addEventListener("click", async () => {
        join.disabled = true;
        join.textContent = "Joining…";
        const { error } = await supabase.rpc("join_quiz", { p_quiz_id: playId });
        if (error) { join.disabled = false; join.textContent = "Join quiz"; status(errorText(error, "Couldn’t join. Try again.")); return; }
        shownKey = "";
        await poll();
      });
      box.append(el("p", "panel-sub", `${quiz.question_count} question${quiz.question_count === 1 ? "" : "s"}${quiz.time_limit_seconds ? ` · ${quiz.time_limit_seconds} s each` : ""} · 1 point per correct answer`), join);
      $("#studentQuizBody").replaceChildren(box);
      if (joinOnOpen && quiz.status !== "finished") { joinOnOpen = false; join.click(); return; }
      join.focus();
      return;
    }
    if (quiz.status === "lobby") {
      status("You’re in the lobby. The first question appears here when your teacher starts.");
      if (shownKey === "lobby") { $("#studentQuizBody .quiz-big").textContent = String(state.participants); return; }
      shownKey = "lobby";
      const box = el("div", "quiz-lobby");
      const pulse = el("span", "quiz-waiting");
      pulse.setAttribute("aria-hidden", "true");
      box.append(pulse, el("p", "quiz-lobby-title", "You’re in!"), el("p", "panel-sub", "Waiting for your teacher to start. Students in the lobby:"), el("p", "quiz-big", String(state.participants)));
      $("#studentQuizBody").replaceChildren(box);
      return;
    }
    // Live question.
    const left = secondsLeft(question.closes_at, state.now, state.fetchedAt);
    const closed = question.closed;
    const timeUp = !closed && left === 0;
    // question.answered is how many students have answered; my_choice is this student's answer.
    const iAnswered = question.my_choice !== null && question.my_choice !== undefined;
    const key = `q:${question.id}:${closed}:${iAnswered}:${timeUp}`;
    if (key === shownKey) { tick(); return; }
    const isNewQuestion = !shownKey.startsWith(`q:${question.id}:`);
    shownKey = key;
    const card = el("div", "quiz-question-card");
    const top = el("div", "quiz-question-top");
    top.append(el("span", "quiz-progress-label", `Question ${question.number} of ${quiz.question_count}`));
    if (question.closes_at && !closed) {
      const timer = el("span", "quiz-timer");
      timer.setAttribute("aria-hidden", "true");
      top.append(timer);
    }
    const prompt = el("p", "quiz-prompt-text", question.prompt);
    prompt.id = "studentQuizPrompt";
    prompt.tabIndex = -1;
    card.append(top, prompt);
    const choices = el("div", "quiz-choices");
    choices.setAttribute("role", "group");
    choices.setAttribute("aria-labelledby", "studentQuizPrompt");
    question.options.forEach((option, i) => {
      const button = el("button", "quiz-choice");
      button.type = "button";
      button.append(el("span", "quiz-letter", CHOICE_LETTERS[i]), el("span", "quiz-choice-text", option));
      const mine = question.my_choice === i;
      if (mine) button.dataset.mine = "true";
      if (closed && question.correct_index !== null && question.correct_index !== undefined) {
        button.dataset.correct = String(i === question.correct_index);
        if (i === question.correct_index) button.append(el("span", "quiz-correct-tag", "Correct answer"));
      }
      if (mine) button.append(el("span", "quiz-mine-tag", "Your answer"));
      button.disabled = closed || timeUp || iAnswered;
      button.setAttribute("aria-pressed", String(mine));
      button.addEventListener("click", () => answer(question, i));
      choices.append(button);
    });
    card.append(choices);
    const note = el("p", "quiz-note");
    note.setAttribute("aria-live", "polite");
    if (closed) {
      note.dataset.state = question.my_correct ? "right" : iAnswered ? "wrong" : "";
      note.textContent = question.my_correct ? "Correct! +1 point." : iAnswered ? `Not this time. The answer was ${CHOICE_LETTERS[question.correct_index]}.` : `You didn’t answer this one. The answer was ${CHOICE_LETTERS[question.correct_index]}.`;
      status(question.number < quiz.question_count ? "Waiting for the next question…" : "That was the last question. Waiting for the results…");
    } else if (iAnswered) {
      note.textContent = `Answer locked in: ${CHOICE_LETTERS[question.my_choice]}. The correct answer shows when the question closes.`;
      status("Answer saved.");
    } else if (timeUp) {
      note.textContent = "Time’s up.";
      status("Time’s up. Waiting for your teacher…");
    } else {
      note.textContent = "Pick one answer. You can’t change it once it’s in.";
      status("");
    }
    card.append(note);
    $("#studentQuizBody").replaceChildren(card);
    tick();
    if (isNewQuestion) prompt.focus();
  }

  // Updates just the countdown between polls.
  function tick() {
    const timer = $("#studentQuizBody .quiz-timer");
    if (!timer || !state?.question) return;
    const left = secondsLeft(state.question.closes_at, state.now, state.fetchedAt);
    timer.textContent = left === 0 ? "Time’s up" : `${left} s`;
    timer.dataset.state = left === 0 ? "done" : left <= 5 ? "low" : "";
    if (left === 0 && !state.question.closed) {
      $("#studentQuizBody").querySelectorAll(".quiz-choice").forEach((button) => { button.disabled = true; });
    }
  }
  window.setInterval(() => { if (playId && state?.quiz.status === "live") tick(); }, 250);

  async function answer(question, choice) {
    if (sending || !playId) return;
    sending = true;
    const buttons = [...$("#studentQuizBody").querySelectorAll(".quiz-choice")];
    buttons.forEach((button) => { button.disabled = true; });
    buttons[choice]?.setAttribute("data-sending", "true");
    status("Sending your answer…");
    const { data, error } = await supabase.rpc("submit_quiz_answer", { p_quiz_id: playId, p_question_id: question.id, p_choice: choice });
    sending = false;
    buttons[choice]?.removeAttribute("data-sending");
    if (error) {
      // The answer may or may not have arrived (e.g. the connection dropped mid-way). Ask the
      // database: if it was saved, the next poll shows it; if not, the buttons come back.
      status(`${errorText(error, "Couldn’t send your answer.")} Checking…`);
      shownKey = "";
      await poll();
      return;
    }
    if (data && !data.accepted && data.reason !== "already_answered") status("That answer wasn’t accepted. The question may have just closed.");
    shownKey = "";
    await poll();
  }

  async function renderSummary() {
    const forQuiz = playId;
    const { data, error } = await supabase.rpc("quiz_results", { p_quiz_id: forQuiz });
    if (forQuiz !== playId) return;
    if (error) { shownKey = ""; status(`Couldn’t load your results: ${errorText(error, "retrying…")}`); pollTimer = window.setTimeout(poll, 3000); return; }
    const body = $("#studentQuizBody");
    const mine = data.mine || {};
    if (!mine.joined) {
      status("This quiz has finished.");
      body.replaceChildren(el("p", "empty-state", "You didn’t take part in this quiz."));
    } else {
      status(`Quiz finished · you scored ${mine.score} out of ${data.question_count}.`);
      const score = el("div", "class-quiz-score");
      score.append(el("span", "class-quiz-score-num", `${mine.score}`), el("span", "class-quiz-score-of", `out of ${data.question_count}`));
      const list = el("ol", "class-quiz-review");
      (mine.questions || []).forEach((q) => {
        const item = el("li", "class-quiz-review-item");
        item.dataset.state = q.correct ? "right" : "wrong";
        const answerText = q.my_choice === null || q.my_choice === undefined ? "No answer" : `${CHOICE_LETTERS[q.my_choice]}. ${q.options[q.my_choice]}`;
        item.append(el("b", "", `${q.number}. ${q.prompt}`), el("small", "", `Your answer: ${answerText}`));
        if (!q.correct) item.append(el("small", "", `Correct: ${CHOICE_LETTERS[q.correct_index]}. ${q.options[q.correct_index]}`));
        list.append(item);
      });
      body.replaceChildren(score, list);
    }
    if (data.leaderboard?.length) {
      const board = el("div", "quiz-leaderboard");
      board.append(el("h3", "quiz-sub-title", "Leaderboard"));
      const rows = el("ol", "quiz-board");
      data.leaderboard.forEach((row) => {
        const item = el("li", row.is_me ? "is-me" : "");
        item.append(el("span", "", row.is_me ? `${row.name} (you)` : row.name), el("b", "", `${row.score}`));
        rows.append(item);
      });
      board.append(rows);
      body.append(board);
    } else if (mine.joined && !data.show_leaderboard) {
      body.append(el("p", "panel-sub", "Your teacher kept the leaderboard private for this quiz."));
    }
  }

  $("#studentQuizBack").addEventListener("click", () => { showOnly("list"); void loadQuizzes(); });

  // ---------- When to load ----------
  function followRoute() {
    const onTab = window.neuroFocusView === "class" && window.neuroFocusRouteClassTab === "quizzes";
    const nextClass = window.neuroFocusView === "class" ? window.neuroFocusRouteClassId || null : classId;
    if (nextClass !== classId) { classId = nextClass; quizzes = []; listSignature = ""; showOnly("list"); }
    active = onTab && Boolean(classId);
    if (!active) { if (playId) showOnly("list"); return; }
    if (!playId) void loadQuizzes();
  }
  window.addEventListener("neurofocus:viewchange", followRoute);
  window.addEventListener("focus", () => { if (active && !playId) void loadQuizzes(); });
  // A quiz the teacher opens appears without the student having to refresh.
  window.setInterval(() => { if (active && !playId && document.visibilityState === "visible") void loadQuizzes(); }, 5000);
  document.addEventListener("visibilitychange", () => { if (active && !playId && document.visibilityState === "visible") void loadQuizzes(); });
  $("#studentQuizTips").append(infoButton("quizzes", "Press Join quiz when your teacher opens one. Each question can be answered once, and the correct answer shows when the question closes. Points are 1 per correct answer — your focus and attention scores are never used."));
  followRoute();
}
