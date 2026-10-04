// Class notes: many private notes per student, each filed under one of their classes or kept
// personal (student_notes table). Notes are written in a formatting editor and saved as
// Markdown. NeuroBuddy can turn rough notes into a new organized note (shown as it writes)
// and quiz the student on a note with flashcards.
import { streamAssistant } from "./assistant-api.js?v=1";
import { renderMarkdown, toMarkdown, markdownToPlain, markdownToHtml } from "./markdown.js?v=1";
import { confirmAction } from "./class-live.js?v=8";

const app = await window.neuroFocusReady;

if (app) {
  const { supabase } = app;
  const $ = (selector) => document.querySelector(selector);
  const els = {
    list: $("#noteList"), search: $("#noteSearch"), filter: $("#noteFilter"),
    empty: $("#noteEmpty"), wrap: $("#noteEditorWrap"), title: $("#noteTitle"), state: $("#noteSaveState"),
    classSelect: $("#noteClass"), info: $("#noteInfo"), editor: $("#noteEditor"), writing: $("#noteWriting"),
    toolbar: $(".note-toolbar"), message: $("#notesMessage")
  };
  const PERSONAL = "personal";
  const SAVE_DELAY_MS = 700;
  const QUIZ_SIZE = 5;
  const filterKey = `neuroFocusNotesFilter:${app.user.id}`;
  const lastNoteKey = `neuroFocusLastNote:${app.user.id}`;
  const SETUP_TEXT = "Notes need a quick database update: run supabase/migrations/20261004000000_student_notes.sql (see README).";
  const missingTable = (error) => error && (error.code === "PGRST205" || error.code === "42P01" || /student_notes/.test(error.message || ""));

  let notes = []; // { key, id, class_id, title, body, created_at, updated_at, writing }
  let activeKey = null;
  let classes = window.neuroFocusClasses || [];
  let filter = "all";
  let setupMissing = false;
  let tempCount = 0;
  const saveTimers = new Map(); // note key -> pending save
  const dirty = new Set();
  try { filter = localStorage.getItem(filterKey) || "all"; } catch { /* storage unavailable */ }

  // ---------- Helpers ----------
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const active = () => notes.find((note) => note.key === activeKey) || null;
  const className = (id) => (id ? classes.find((item) => item.id === id)?.name || "Former class" : "Personal");
  const knownClass = (id) => Boolean(id && classes.some((item) => item.id === id));
  const message = (text, isError = false) => {
    els.message.textContent = text;
    els.message.dataset.state = isError ? "error" : "";
  };
  const setState = (text, isError = false) => {
    els.state.textContent = text;
    els.state.dataset.state = isError ? "error" : "";
  };

  function relativeTime(iso) {
    const date = new Date(iso);
    const seconds = (Date.now() - date) / 1000;
    if (seconds < 45) return "just now";
    if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
    if (date.toDateString() === new Date().toDateString()) return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    return date.toLocaleDateString([], { month: "short", day: "numeric", ...(date.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}) });
  }

  function fillClassSelect(select, value, { includeAll = false } = {}) {
    const options = includeAll ? [["all", "All notes"]] : [];
    classes.forEach((item) => options.push([item.id, item.name]));
    options.push([PERSONAL, includeAll ? "Personal notes" : "Personal (no class)"]);
    if (!includeAll && value !== PERSONAL && !knownClass(value)) options.push([value, "Former class"]);
    select.replaceChildren(...options.map(([optionValue, label]) => {
      const option = el("option", "", label);
      option.value = optionValue;
      return option;
    }));
    select.value = options.some(([optionValue]) => optionValue === value) ? value : options[0][0];
  }

  // New notes go under the class being viewed, else the class picked in the sidebar.
  function defaultClassId() {
    if (filter === PERSONAL) return null;
    if (knownClass(filter)) return filter;
    return window.neuroFocusClass?.id || null;
  }

  // ---------- List ----------
  function visibleNotes() {
    const query = els.search.value.trim().toLowerCase();
    return notes
      .filter((note) => (filter === "all" ? true : filter === PERSONAL ? !note.class_id : note.class_id === filter))
      .filter((note) => !query || `${note.title} ${markdownToPlain(note.body)}`.toLowerCase().includes(query))
      .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
  }

  function renderList() {
    const items = visibleNotes();
    if (!items.length) {
      const text = setupMissing ? SETUP_TEXT
        : els.search.value.trim() ? "No notes match your search."
        : notes.length ? "No notes here yet."
        : "No notes yet. Start a blank note, or organize rough notes from class.";
      els.list.replaceChildren(el("li", "empty-state", text));
      return;
    }
    els.list.replaceChildren(...items.map((note) => {
      const item = el("li");
      const button = el("button", "note-item");
      button.type = "button";
      if (note.key === activeKey) button.setAttribute("aria-current", "true");
      const meta = el("span", "note-item-meta");
      meta.append(el("span", "class-tag", className(note.class_id)), el("span", "", relativeTime(note.updated_at)));
      button.append(
        el("b", "", note.title.trim() || "Untitled note"),
        el("span", "note-snippet", note.writing ? "NeuroBuddy is writing…" : markdownToPlain(note.body).slice(0, 160) || "Empty note"),
        meta
      );
      button.addEventListener("click", () => openNote(note.key, { scroll: true }));
      item.append(button);
      return item;
    }));
  }

  // ---------- Editor ----------
  function updateEmpty() {
    els.editor.classList.toggle("is-empty", !els.editor.textContent.trim() && !els.editor.querySelector("li, hr"));
  }

  function updateInfo(note) {
    const words = markdownToPlain(note.body).split(" ").filter(Boolean).length;
    els.info.textContent = `${plural(words, "word")} · edited ${relativeTime(note.updated_at)}`;
  }

  function setEditable(editable) {
    els.editor.contentEditable = editable ? "true" : "false";
    els.title.disabled = !editable;
    els.classSelect.disabled = !editable;
    els.writing.hidden = editable;
    els.toolbar.querySelectorAll("button").forEach((button) => { button.disabled = !editable; });
    ["#quizButton", "#copyNote", "#deleteNote"].forEach((id) => { $(id).disabled = !editable; });
  }

  function renderEditor() {
    const note = active();
    els.empty.hidden = Boolean(note);
    els.wrap.hidden = !note;
    if (!note) return;
    els.title.value = note.title;
    fillClassSelect(els.classSelect, note.class_id || PERSONAL);
    if (note.body.trim()) els.editor.replaceChildren(renderMarkdown(note.body));
    else els.editor.innerHTML = "<p><br></p>"; // gives the caret a paragraph to type in
    setEditable(!note.writing);
    setState(note.writing ? "Writing…" : dirty.has(note.key) ? "Saving…" : "Saved");
    updateEmpty();
    updateInfo(note);
    updateToolbar();
  }

  function openNote(key, { scroll = false } = {}) {
    if (activeKey && activeKey !== key) leaveNote(activeKey);
    activeKey = key;
    const note = active();
    try { if (note?.id) localStorage.setItem(lastNoteKey, note.id); } catch { /* storage unavailable */ }
    renderEditor();
    renderList();
    if (scroll && window.matchMedia("(max-width: 1100px)").matches) els.wrap.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // Blank notes the student never wrote in are removed when they move on.
  function leaveNote(key) {
    flushSave(key);
    const note = notes.find((item) => item.key === key);
    if (note && !note.writing && !note.title.trim() && !markdownToPlain(note.body)) void removeNote(note, { quiet: true });
  }

  // ---------- Saving ----------
  function touch(note, { now = false } = {}) {
    note.updated_at = new Date().toISOString();
    dirty.add(note.key);
    if (note.key === activeKey) { setState("Saving…"); updateInfo(note); }
    window.clearTimeout(saveTimers.get(note.key));
    saveTimers.set(note.key, window.setTimeout(() => { void save(note); }, now ? 0 : SAVE_DELAY_MS));
  }

  function flushSave(key) {
    if (!saveTimers.has(key)) return;
    window.clearTimeout(saveTimers.get(key));
    const note = notes.find((item) => item.key === key);
    if (note) void save(note);
  }

  async function save(note) {
    saveTimers.delete(note.key);
    if (!dirty.has(note.key) || note.deleted) return;
    if (note.saving) { note.saveAgain = true; return; }
    dirty.delete(note.key);
    note.saving = true;
    const row = { title: note.title.trim().slice(0, 200), body: note.body.slice(0, 50000), class_id: note.class_id, updated_at: note.updated_at };
    let error;
    if (note.id) {
      ({ error } = await supabase.from("student_notes").update(row).eq("id", note.id));
    } else {
      const result = await supabase.from("student_notes").insert(row).select("id, created_at").single();
      error = result.error;
      if (!error) {
        note.id = result.data.id;
        note.created_at = result.data.created_at;
        if (note.deleted) await supabase.from("student_notes").delete().eq("id", note.id);
        else if (note.key === activeKey) { try { localStorage.setItem(lastNoteKey, note.id); } catch { /* storage unavailable */ } }
      }
    }
    note.saving = false;
    if (error) {
      dirty.add(note.key);
      if (missingTable(error)) {
        setupMissing = true;
        message(SETUP_TEXT, true);
      } else {
        message("Couldn’t save this note. Check your connection; it will keep trying.", true);
        saveTimers.set(note.key, window.setTimeout(() => { void save(note); }, 5000));
      }
      if (note.key === activeKey) setState("Not saved", true);
      return;
    }
    if (els.message.dataset.state === "error" && !setupMissing) message("");
    if (note.saveAgain || dirty.has(note.key)) {
      note.saveAgain = false;
      if (!saveTimers.has(note.key)) void save(note);
    } else if (note.key === activeKey) setState("Saved");
    renderList();
  }

  async function removeNote(note, { quiet = false } = {}) {
    window.clearTimeout(saveTimers.get(note.key));
    saveTimers.delete(note.key);
    dirty.delete(note.key);
    note.deleted = true;
    if (note.id) {
      const { error } = await supabase.from("student_notes").delete().eq("id", note.id);
      if (error) {
        note.deleted = false;
        if (!quiet) message("Couldn’t delete this note. Try again.", true);
        return;
      }
    }
    notes = notes.filter((item) => item !== note);
    if (activeKey === note.key) { activeKey = null; renderEditor(); }
    renderList();
    if (!quiet) message("Note deleted.");
  }

  // Save everything before the page is hidden or closed.
  const flushAll = () => [...saveTimers.keys()].forEach(flushSave);
  window.addEventListener("pagehide", flushAll);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flushAll(); });

  // ---------- Editing ----------
  document.execCommand("defaultParagraphSeparator", false, "p");

  function blockOf(node) {
    let current = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
    while (current && current !== els.editor) {
      if (/^(P|DIV|H[1-6]|LI|BLOCKQUOTE|PRE)$/.test(current.tagName)) return current;
      current = current.parentElement;
    }
    return null;
  }

  // Typing "- ", "1. " or "# " at the start of an empty line turns it into a list or heading.
  function applyShortcut() {
    const selection = window.getSelection();
    if (!selection.rangeCount || !selection.isCollapsed) return;
    const block = blockOf(selection.anchorNode);
    if (!block || block.tagName === "LI") return;
    const match = block.textContent.replace(/\u00a0/g, " ").match(/^(#{1,3}|[-*]|1[.)]) $/);
    if (!match) return;
    block.replaceChildren(document.createElement("br"));
    const range = document.createRange();
    range.setStart(block, 0);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    const marker = match[1];
    if (marker.startsWith("#")) document.execCommand("formatBlock", false, marker.length === 3 ? "h3" : "h2");
    else document.execCommand(/\d/.test(marker) ? "insertOrderedList" : "insertUnorderedList");
  }

  function handleEdit() {
    const note = active();
    if (!note || note.writing) return;
    note.body = toMarkdown(els.editor);
    updateEmpty();
    touch(note);
  }

  els.editor.addEventListener("input", (event) => {
    if (event.inputType === "insertText" && event.data?.endsWith(" ")) applyShortcut();
    handleEdit();
  });

  // Pasted text keeps its structure (and any Markdown), but never outside styling.
  els.editor.addEventListener("paste", (event) => {
    const text = event.clipboardData?.getData("text/plain");
    if (!text) return;
    event.preventDefault();
    document.execCommand("insertHTML", false, markdownToHtml(text));
  });

  els.editor.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      if (activeKey) flushSave(activeKey);
    }
  });

  function currentBlockTag() {
    const selection = window.getSelection();
    if (!selection.rangeCount || !els.editor.contains(selection.anchorNode)) return "";
    return blockOf(selection.anchorNode)?.tagName || "";
  }

  function updateToolbar() {
    const inEditor = els.editor.contains(window.getSelection()?.anchorNode || null);
    const block = currentBlockTag();
    const states = {
      h2: block === "H2",
      h3: block === "H3",
      bold: inEditor && document.queryCommandState("bold"),
      italic: inEditor && document.queryCommandState("italic"),
      ul: inEditor && document.queryCommandState("insertUnorderedList"),
      ol: inEditor && document.queryCommandState("insertOrderedList")
    };
    els.toolbar.querySelectorAll("[data-format]").forEach((button) => button.setAttribute("aria-pressed", String(Boolean(states[button.dataset.format]))));
  }
  document.addEventListener("selectionchange", () => { if (!els.wrap.hidden) updateToolbar(); });

  // Keep the text selection in the editor when a toolbar button is pressed.
  els.toolbar.addEventListener("mousedown", (event) => { if (event.target.closest("button")) event.preventDefault(); });
  els.toolbar.addEventListener("click", (event) => {
    const button = event.target.closest("[data-format]");
    if (!button || button.disabled) return;
    if (!els.editor.contains(window.getSelection()?.anchorNode || null)) els.editor.focus();
    const format = button.dataset.format;
    if (format === "bold" || format === "italic") document.execCommand(format);
    else if (format === "ul") document.execCommand("insertUnorderedList");
    else if (format === "ol") document.execCommand("insertOrderedList");
    else document.execCommand("formatBlock", false, currentBlockTag() === format.toUpperCase() ? "p" : format);
    handleEdit();
    updateToolbar();
  });

  els.title.addEventListener("input", () => {
    const note = active();
    if (!note) return;
    note.title = els.title.value;
    touch(note);
  });
  els.title.addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); els.editor.focus(); }
  });

  els.classSelect.addEventListener("change", () => {
    const note = active();
    if (!note) return;
    note.class_id = els.classSelect.value === PERSONAL ? null : els.classSelect.value;
    touch(note, { now: true });
    renderList();
  });

  // ---------- Creating notes ----------
  function createLocalNote(fields = {}) {
    const now = new Date().toISOString();
    const note = { key: `new-${++tempCount}`, id: null, class_id: defaultClassId(), title: "", body: "", created_at: now, updated_at: now, writing: false, ...fields };
    notes.unshift(note);
    // Make sure the new note is visible in the list.
    els.search.value = "";
    if (filter !== "all" && (filter === PERSONAL ? note.class_id : note.class_id !== filter)) setFilter("all", { remember: true });
    return note;
  }

  function newNote() {
    if (setupMissing) { message(SETUP_TEXT, true); return; }
    const note = createLocalNote();
    openNote(note.key, { scroll: true });
    els.title.focus();
  }

  // ---------- Organize rough notes ----------
  const organize = {
    dialog: $("#organizeDialog"), form: $("#organizeForm"), input: $("#organizeInput"),
    classSelect: $("#organizeClass"), count: $("#organizeCount"), message: $("#organizeMessage")
  };
  const updateCount = () => { organize.count.textContent = `${organize.input.value.length.toLocaleString()} / 12,000`; };

  function openOrganize() {
    if (setupMissing) { message(SETUP_TEXT, true); return; }
    fillClassSelect(organize.classSelect, defaultClassId() || PERSONAL);
    updateCount();
    organize.dialog.showModal();
    organize.input.focus();
  }
  organize.input.addEventListener("input", updateCount);
  $("#organizeCancel").addEventListener("click", () => organize.dialog.close());

  // The draft's first "# Title" line becomes the note title.
  function splitTitle(markdown) {
    const match = markdown.match(/^\s*#\s+([^\n]*)(\n|$)/);
    return match ? { title: match[1].replace(/[*_`]/g, "").trim(), body: markdown.slice(match[0].length).replace(/^\s*\n/, "") } : { title: "", body: markdown };
  }

  organize.form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = organize.input.value.trim();
    if (!text) { organize.input.focus(); return; }
    const classId = organize.classSelect.value === PERSONAL ? null : organize.classSelect.value;
    organize.dialog.close();

    const note = createLocalNote({ class_id: classId, title: "Organizing…", writing: true });
    openNote(note.key, { scroll: true });
    message("NeuroBuddy is organizing your notes. It only uses the text you gave it.");
    let lastPaint = 0;
    const paint = () => {
      if (note.key !== activeKey) return;
      els.title.value = note.title;
      els.editor.replaceChildren(renderMarkdown(note.body));
      updateEmpty();
    };
    try {
      const draft = await streamAssistant(supabase, { task: "notes", ...(knownClass(classId) ? { classId } : {}), studentInput: text }, (soFar) => {
        const parts = splitTitle(soFar);
        note.title = parts.title || "Organizing…";
        note.body = parts.body;
        if (Date.now() - lastPaint > 60) { lastPaint = Date.now(); paint(); }
      });
      const parts = splitTitle(draft);
      note.title = parts.title || "Organized notes";
      note.body = parts.body;
      note.writing = false;
      organize.input.value = "";
      touch(note, { now: true });
      if (note.key === activeKey) renderEditor();
      renderList();
      message("Done! Check the draft and fix anything that isn’t right. When you’re ready, press Quiz me.");
    } catch (error) {
      notes = notes.filter((item) => item !== note);
      if (activeKey === note.key) { activeKey = null; renderEditor(); }
      renderList();
      message(`${error instanceof Error ? error.message : "Couldn’t organize your notes."} Your rough notes are still in Organize rough notes.`, true);
    }
  });

  // ---------- Quiz me ----------
  const quiz = {
    dialog: $("#quizDialog"), title: $("#quizTitle"), sub: $("#quizSub"), bar: $("#quizBar"),
    card: $("#quizCard"), actions: $("#quizActions"), controller: null
  };

  function parseCards(text) {
    const cards = [];
    const pattern = /Q:\s*([\s\S]*?)\n\s*A:\s*([\s\S]*?)(?=\n\s*Q:|$)/g;
    let match;
    while ((match = pattern.exec(text))) {
      const question = markdownToPlain(match[1]);
      const answer = markdownToPlain(match[2]);
      if (question && answer) cards.push({ question, answer });
    }
    return cards;
  }

  function button(label, className, onClick) {
    const node = el("button", className, label);
    node.type = "button";
    node.addEventListener("click", onClick);
    return node;
  }

  function showQuizCard(cards, index, missed) {
    const card = cards[index];
    quiz.sub.textContent = `Card ${index + 1} of ${cards.length}`;
    quiz.bar.style.width = `${(index / cards.length) * 100}%`;
    const question = el("p", "quiz-q", card.question);
    quiz.card.replaceChildren(el("span", "quiz-label", "Question"), question);
    const next = (knewIt) => {
      if (!knewIt) missed.push(card);
      if (index + 1 < cards.length) showQuizCard(cards, index + 1, missed);
      else showQuizResult(cards, missed);
    };
    const reveal = button("Show answer", "btn-primary", () => {
      const answer = el("div", "quiz-answer");
      answer.append(el("span", "quiz-label", "Answer"), el("p", "", card.answer));
      quiz.card.append(answer);
      const knew = button("I knew it", "btn-join", () => next(true));
      quiz.actions.replaceChildren(button("Still learning", "btn-action", () => next(false)), knew);
      knew.focus();
    });
    quiz.actions.replaceChildren(reveal);
    reveal.focus();
  }

  function showQuizResult(cards, missed) {
    quiz.bar.style.width = "100%";
    quiz.sub.textContent = "Quiz complete";
    const known = cards.length - missed.length;
    const score = el("div", "quiz-score", `${known} / ${cards.length}`);
    score.append(el("small", "", missed.length
      ? known >= cards.length / 2 ? "Nice work. Look over the ones you’re still learning:" : "Good effort. These are worth another look:"
      : "You knew every one. Great job!"));
    quiz.card.replaceChildren(score);
    if (missed.length) {
      const review = el("ul", "quiz-review");
      review.append(...missed.map((card) => {
        const item = el("li");
        item.append(el("b", "", card.question), el("span", "", card.answer));
        return item;
      }));
      quiz.card.append(review);
    }
    const done = button("Done", "btn-primary", () => quiz.dialog.close());
    quiz.actions.replaceChildren(
      ...(missed.length ? [button(`Practice the ${missed.length} again`, "btn-action", () => showQuizCard(missed.slice(), 0, []))] : []),
      button("New questions", "btn-action", () => { void startQuiz(); }),
      done
    );
    done.focus();
  }

  async function startQuiz() {
    const note = active();
    if (!note) return;
    if (markdownToPlain(note.body).length < 40) {
      message("Write a bit more in this note first, then NeuroBuddy can quiz you on it.", true);
      return;
    }
    quiz.controller?.abort();
    const controller = new AbortController();
    quiz.controller = controller;
    quiz.title.textContent = `Quiz: ${note.title.trim() || "Untitled note"}`;
    quiz.sub.textContent = "Flashcards from this note";
    quiz.bar.style.width = "0%";
    const loading = el("div", "quiz-loading");
    const status = el("span", "", "NeuroBuddy is writing questions from your note…");
    loading.append(el("span", "writing-dot"), status);
    quiz.card.replaceChildren(loading);
    quiz.actions.replaceChildren(button("Cancel", "btn-action", () => quiz.dialog.close()));
    if (!quiz.dialog.open) quiz.dialog.showModal();
    try {
      const text = await streamAssistant(supabase, {
        task: "quiz",
        noteText: `${note.title}\n\n${note.body}`.slice(0, 20000),
        count: QUIZ_SIZE,
        ...(knownClass(note.class_id) ? { classId: note.class_id } : {})
      }, (soFar) => {
        const ready = Math.max(0, parseCards(soFar).length - 1);
        status.textContent = ready ? `Writing questions… ${Math.min(ready, QUIZ_SIZE)} of ${QUIZ_SIZE} ready` : "NeuroBuddy is writing questions from your note…";
      }, { signal: controller.signal });
      const cards = parseCards(text);
      if (!cards.length) throw new Error("NeuroBuddy couldn’t make questions from this note. Try again.");
      if (quiz.controller === controller) showQuizCard(cards, 0, []);
    } catch (error) {
      if (error?.name === "AbortError" || quiz.controller !== controller) return;
      quiz.card.replaceChildren(el("p", "", error instanceof Error ? error.message : "Couldn’t make a quiz. Try again."));
      quiz.actions.replaceChildren(button("Close", "btn-action", () => quiz.dialog.close()), button("Try again", "btn-primary", () => { void startQuiz(); }));
    }
  }
  quiz.dialog.addEventListener("close", () => { quiz.controller?.abort(); quiz.controller = null; });
  $("#quizClose").addEventListener("click", () => quiz.dialog.close());
  $("#quizButton").addEventListener("click", () => { flushSave(activeKey); void startQuiz(); });

  // ---------- Copy + delete ----------
  $("#copyNote").addEventListener("click", async () => {
    const note = active();
    if (!note) return;
    const title = note.title.trim();
    const plain = [title, els.editor.innerText.trim()].filter(Boolean).join("\n\n");
    const heading = el("h1", "", title);
    const html = `${title ? heading.outerHTML : ""}${els.editor.innerHTML}`;
    try {
      if (window.ClipboardItem && navigator.clipboard.write) {
        await navigator.clipboard.write([new ClipboardItem({
          "text/plain": new Blob([plain], { type: "text/plain" }),
          "text/html": new Blob([html], { type: "text/html" })
        })]);
      } else await navigator.clipboard.writeText(plain);
      message("Copied with formatting. Paste it into Google Docs, Word or an email.");
    } catch {
      message("Couldn’t copy. Select the text and copy it instead.", true);
    }
  });

  $("#deleteNote").addEventListener("click", async () => {
    const note = active();
    if (!note) return;
    const confirmed = await confirmAction({
      title: "Delete this note?",
      message: `“${note.title.trim() || "Untitled note"}” will be deleted for good. This can’t be undone.`,
      confirmLabel: "Delete note",
      danger: true
    });
    if (confirmed) await removeNote(note);
  });

  // ---------- Filter, search, page actions ----------
  // Until the class list arrives, a remembered class filter is kept as it is.
  function setFilter(value, { remember = false } = {}) {
    filter = value;
    fillClassSelect(els.filter, filter, { includeAll: true });
    if (window.neuroFocusClasses) filter = els.filter.value;
    if (remember) { try { localStorage.setItem(filterKey, filter); } catch { /* storage unavailable */ } }
  }
  els.filter.addEventListener("change", () => { setFilter(els.filter.value, { remember: true }); renderList(); });
  els.search.addEventListener("input", renderList);
  document.querySelectorAll("[data-notes-action]").forEach((node) => node.addEventListener("click", () => {
    if (node.dataset.notesAction === "new") newNote();
    else openOrganize();
  }));

  window.addEventListener("neurofocus:classlist", (event) => {
    classes = event.detail || [];
    setFilter(filter);
    const note = active();
    if (note && !note.writing) fillClassSelect(els.classSelect, note.class_id || PERSONAL);
    renderList();
  });

  // ---------- Load ----------
  async function load() {
    setFilter(filter);
    const { data, error } = await supabase
      .from("student_notes")
      .select("id, class_id, title, body, created_at, updated_at")
      .eq("student_id", app.user.id)
      .order("updated_at", { ascending: false })
      .limit(500);
    if (error) {
      setupMissing = missingTable(error);
      message(setupMissing ? SETUP_TEXT : "Couldn’t load your notes. Refresh to try again.", true);
      renderList();
      return;
    }
    notes = data.map((row) => ({ ...row, key: row.id, writing: false }));
    let lastId = null;
    try { lastId = localStorage.getItem(lastNoteKey); } catch { /* storage unavailable */ }
    if (lastId && notes.some((note) => note.id === lastId)) openNote(lastId);
    else renderList();
  }
  void load();
}
