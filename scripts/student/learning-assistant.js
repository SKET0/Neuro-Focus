// NeuroBuddy: chats like a chat app. A list of chats (new, search, rename, delete) beside the open
// chat; each chat can have a class for context, files the student adds (read on this device by
// buddy-files.js and kept with the chat) and flashcard decks (buddy-flashcards.js). The explanation
// style is a menu in the message box. Chats are saved on this device per account (buddy-store.js).
// Answers stream in as they are written and render simple formatting (markdown.js).
import { streamAssistant } from "../services/assistant-api.js";
import { renderMarkdown } from "../shared/markdown.js";
import { confirmAction, notify } from "../shared/class-live.js";
import { loadChats, saveChats, newId, titleFrom, LIMITS } from "./buddy-store.js";
import { readFile, kindOf, ACCEPT, FILE_TYPES_TEXT } from "./buddy-files.js";
import { createFlashcards } from "./buddy-flashcards.js";
import { createMascot, followPointer } from "./buddy-mascot.js";
import { greetingName } from "../shared/avatars.js";

const app = await window.neuroFocusReady;

if (app && document.querySelector("#buddyApp")) {
  const { supabase } = app;
  const $ = (selector) => document.querySelector(selector);
  const userId = app.user.id;
  const STYLES = { simple: "Direct & simple", "step-by-step": "Step by step", examples: "With examples", short: "Short answers" };
  const HISTORY_SENT = 10;
  const DOCUMENT_CHARS_SENT = 60000;
  const PICTURES_PER_MESSAGE = 3;
  const STARTERS = [
    { icon: "i-spark", label: "Explain a topic", note: "Plain words and an everyday example", text: "Explain this simply, with one everyday example: " },
    { icon: "i-rocket", label: "Help me start", note: "Tiny first steps when you’re stuck", text: "I'm stuck getting started. Break this task into tiny first steps: " },
    { icon: "i-paperclip", label: "Summarise a file", note: "PDF, Word, slides or a photo", action: "attach" },
    { icon: "i-cards", label: "Make flashcards", note: "From a topic, file or this chat", action: "cards" },
    { icon: "i-help", label: "Quiz me", note: "Three quick questions, one at a time", text: "Quiz me with 3 quick questions, one at a time, about " }
  ];
  // What NeuroBuddy can do, shown one line at a time on the welcome screen.
  const CAN_DO = ["explain tricky topics step by step", "summarise your PDFs, slides and notes", "turn anything into flashcards", "help you start when you’re stuck", "quiz you so it sticks"];
  let stopFollowing = null;
  let rotateTimer = 0;

  const els = {
    list: $("#buddyChatList"), search: $("#buddySearch"), chats: $("#buddyChats"), title: $("#buddyChatTitle"), classPick: $("#buddyClass"),
    shelf: $("#buddyShelf"), thread: $("#tutorConversation"), form: $("#tutorForm"), input: $("#tutorPrompt"), send: $("#buddySend"),
    pending: $("#buddyPending"), fileInput: $("#buddyFileInput"), status: $("#tutorMessage"),
    styleButton: $("#buddyStyleButton"), styleLabel: $("#buddyStyleLabel"), styleMenu: $("#buddyStyleMenu")
  };
  const currentKey = `neuroFocusBuddyCurrent:${userId}`;
  const styleKey = `neuroFocusBuddyStyle:${userId}`;
  const store = (key, value) => { try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch { /* storage unavailable */ } };
  const read = (key) => { try { return localStorage.getItem(key); } catch { return null; } };

  let chats = loadChats(userId);
  let current = null;          // the open chat; a new chat isn't saved until it has something in it
  let pendingFiles = [];       // [{ id, name, kind, status: "reading" | "ready" | "error", result?, error? }]
  let sending = null;          // AbortController while an answer is coming in
  let serverVersion = null;    // "" = the first NeuroBuddy function, which can't read files
  let style = STYLES[read(styleKey)] ? read(styleKey) : "step-by-step";

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const icon = (id, className = "icon") => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", className);
    svg.setAttribute("aria-hidden", "true");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", `#${id}`);
    svg.append(use);
    return svg;
  };
  function iconButton(iconId, label, onClick, className = "icon-btn") {
    const node = el("button", className);
    node.type = "button";
    node.setAttribute("aria-label", label);
    node.title = label;
    node.append(icon(iconId));
    node.addEventListener("click", onClick);
    return node;
  }
  function say(text, isError = false) {
    els.status.textContent = text;
    els.status.dataset.state = isError ? "error" : "";
  }

  const classes = () => window.neuroFocusClasses || [];
  const className = (id) => classes().find((item) => item.id === id)?.name || "";
  const blankChat = () => ({ id: null, title: "New chat", classId: window.neuroFocusClass?.id || "", createdAt: "", updatedAt: "", messages: [], documents: [], decks: [] });
  const isSaved = (chat) => Boolean(chat?.id && chats.some((entry) => entry.id === chat.id));

  function persist() {
    const problem = saveChats(userId, chats);
    if (problem) notify({ title: "Couldn’t save", text: problem, kind: "error", timeoutMs: 9000 });
    return !problem;
  }
  // A new chat is saved once it has a message, a file or a deck.
  function keep(chat) {
    const now = new Date().toISOString();
    chat.updatedAt = now;
    if (!chat.id) {
      chat.id = newId();
      chat.createdAt = now;
      chats.unshift(chat);
      store(currentKey, chat.id);
    }
    persist();
    renderList();
  }

  // ---------- Chat list ----------
  function groupOf(iso) {
    const date = new Date(iso);
    const today = new Date();
    const days = Math.floor((new Date(today.toDateString()) - new Date(date.toDateString())) / 86400000);
    return days <= 0 ? "Today" : days === 1 ? "Yesterday" : days < 7 ? "Previous 7 days" : days < 30 ? "Previous 30 days" : "Older";
  }
  function renderList() {
    const query = els.search.value.trim().toLowerCase();
    const shown = [...chats]
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
      .filter((chat) => !query || chat.title.toLowerCase().includes(query) || chat.messages.some((message) => message.content.toLowerCase().includes(query)));
    if (!shown.length) {
      els.list.replaceChildren(el("li", "buddy-list-empty", query ? "No chats match that search." : "No chats yet. Ask a question to start one."));
      return;
    }
    let lastGroup = "";
    const items = [];
    shown.forEach((chat) => {
      const group = groupOf(chat.updatedAt);
      if (group !== lastGroup) {
        lastGroup = group;
        items.push(el("li", "buddy-list-group", group));
      }
      const item = el("li", "buddy-chat-item");
      item.dataset.chatId = chat.id;
      const open = el("button", "buddy-chat-open");
      open.type = "button";
      if (current?.id === chat.id) open.setAttribute("aria-current", "page");
      const text = el("span", "buddy-chat-text");
      text.append(el("b", "", chat.title));
      const details = [className(chat.classId), chat.documents.length ? `${chat.documents.length} file${chat.documents.length === 1 ? "" : "s"}` : "", chat.decks.length ? `${chat.decks.length} deck${chat.decks.length === 1 ? "" : "s"}` : ""].filter(Boolean);
      if (details.length) text.append(el("small", "", details.join(" · ")));
      open.append(text);
      open.addEventListener("click", () => openChat(chat.id));
      const tools = el("span", "buddy-chat-tools");
      tools.append(
        iconButton("i-pencil", `Rename “${chat.title}”`, () => renameChat(chat, item)),
        iconButton("i-trash", `Delete “${chat.title}”`, () => deleteChat(chat), "icon-btn danger")
      );
      item.append(open, tools);
      items.push(item);
    });
    els.list.replaceChildren(...items);
  }

  // Renaming (from the chat list or the open chat's title). A new chat is saved once it has a name.
  function setTitle(chat, value) {
    const title = String(value || "").trim().replace(/\s+/g, " ").slice(0, 80);
    if (!title || title === chat.title) return false;
    chat.title = title;
    if (isSaved(chat)) persist();
    else keep(chat);
    if (current === chat) {
      els.title.textContent = chat.title;
      if (window.neuroFocusView === "buddy") document.title = `${chat.title} · NeuroBuddy`;
    }
    renderList();
    say(`Chat renamed to “${chat.title}”.`);
    return true;
  }

  // An inline name box in place of `target` (a list item or the header title).
  function editName(chat, { replace, restore, focusAfter }) {
    const form = el("form", "buddy-rename");
    const input = el("input", "field-input");
    input.value = chat.title === "New chat" ? "" : chat.title;
    input.placeholder = "Name this chat";
    input.maxLength = 80;
    input.setAttribute("aria-label", "Chat name. Press Enter to save or Escape to cancel");
    form.append(input);
    replace(form);
    input.focus();
    input.select();
    let done = false;
    const finish = (saveIt) => {
      if (done) return;
      done = true;
      if (saveIt) setTitle(chat, input.value);
      restore(form);
      focusAfter?.();
    };
    form.addEventListener("submit", (event) => { event.preventDefault(); finish(true); });
    input.addEventListener("keydown", (event) => { if (event.key === "Escape") { event.preventDefault(); finish(false); } });
    input.addEventListener("blur", () => finish(true));
  }

  function renameChat(chat, item) {
    editName(chat, {
      replace: (form) => item.replaceChildren(form),
      restore: () => renderList(),
      focusAfter: () => [...els.list.querySelectorAll(".buddy-chat-item")].find((li) => li.dataset.chatId === chat.id)?.querySelector(".buddy-chat-open")?.focus()
    });
  }

  const titleWrap = $("#buddyTitleWrap");
  const renameButton = $("#buddyRename");
  function renameOpenChat() {
    if (titleWrap.querySelector(".buddy-rename")) return;
    editName(current, {
      replace: (form) => { els.title.hidden = true; renameButton.hidden = true; titleWrap.prepend(form); },
      restore: (form) => { form.remove(); els.title.hidden = false; renameButton.hidden = false; },
      focusAfter: () => renameButton.focus()
    });
  }
  renameButton.addEventListener("click", renameOpenChat);
  els.title.addEventListener("click", renameOpenChat);

  async function deleteChat(chat) {
    const ok = await confirmAction({
      title: `Delete “${chat.title}”?`,
      message: `Its messages${chat.documents.length ? ", files" : ""}${chat.decks.length ? " and flashcards" : ""} are removed from this device. This can’t be undone.`,
      confirmLabel: "Delete chat", danger: true
    });
    if (!ok) return;
    chats = chats.filter((entry) => entry.id !== chat.id);
    persist();
    if (current?.id === chat.id) startChat();
    else renderList();
    say("Chat deleted.");
  }

  // ---------- The open chat ----------
  function openChat(id) {
    const chat = chats.find((entry) => entry.id === id);
    if (!chat) return;
    if (sending) sending.abort();
    current = chat;
    store(currentKey, chat.id);
    clearPending();
    renderChat();
    renderList();
    closeDrawer();
    els.input.focus();
  }

  function startChat({ classId } = {}) {
    if (sending) sending.abort();
    current = blankChat();
    if (classId !== undefined) current.classId = classId;
    store(currentKey, null);
    clearPending();
    renderChat();
    renderList();
    closeDrawer();
    els.input.focus();
  }

  function renderClassPick() {
    const options = [["", "No class · general help"], ...classes().map((item) => [item.id, item.name])];
    if (current.classId && !options.some(([id]) => id === current.classId)) options.push([current.classId, "Former class"]);
    els.classPick.replaceChildren(...options.map(([value, label]) => {
      const option = el("option", "", label);
      option.value = value;
      return option;
    }));
    els.classPick.value = current.classId || "";
  }

  function renderShelf() {
    const items = [];
    current.documents.forEach((doc) => {
      const chip = el("span", "buddy-file-chip");
      chip.append(icon(doc.docKind === "pdf" ? "i-assignment" : "i-note"), el("span", "", doc.name));
      if (doc.truncated) chip.append(el("small", "", "first part"));
      chip.append(iconButton("i-close", `Remove ${doc.name} from this chat`, () => removeDocument(doc)));
      items.push(chip);
    });
    current.decks.forEach((deck) => {
      const chip = el("span", "buddy-deck-chip");
      const open = el("button", "buddy-deck-open");
      open.type = "button";
      open.append(icon("i-cards"), el("span", "", `${deck.title} · ${deck.cards.length} cards`));
      open.setAttribute("aria-label", `Practise flashcards: ${deck.title}, ${deck.cards.length} cards`);
      open.addEventListener("click", () => flashcards.practise(deck));
      chip.append(open, iconButton("i-close", `Delete flashcards: ${deck.title}`, () => removeDeck(deck)));
      items.push(chip);
    });
    els.shelf.hidden = !items.length;
    els.shelf.replaceChildren(...(items.length ? [el("span", "buddy-shelf-label", "In this chat"), ...items] : []));
  }

  function greeting() {
    const hour = new Date().getHours();
    const part = hour < 5 ? "Hi" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
    const name = greetingName(app.profile?.display_name || "");
    return { part, name: name === "there" || name === "Student" ? "" : name };
  }

  // The welcome screen of a new chat: the mascot, a greeting, what NeuroBuddy can do and recent chats.
  function renderEmpty() {
    stopFollowing?.();
    window.clearInterval(rotateTimer);
    const home = el("div", "buddy-home");
    const hero = el("div", "buddy-hero");
    const mascot = createMascot();
    const hello = el("div", "buddy-hello");
    const { part, name } = greeting();
    const title = el("h3", "buddy-greeting");
    title.append(`${part}${name ? ", " : "!"}`);
    if (name) title.append(el("span", "buddy-name", name), "!");
    const classLabel = className(current.classId);
    const kicker = el("p", "buddy-kicker", classLabel ? `NeuroBuddy · working on ${classLabel}` : "NeuroBuddy · your study buddy");
    const line = el("p", "buddy-cando");
    const sr = el("span", "sr-only", `I can ${CAN_DO.join(", ")}.`);
    const shown = el("span", "buddy-cando-text");
    shown.setAttribute("aria-hidden", "true");
    let index = 0;
    shown.textContent = CAN_DO[0];
    line.append("I can ", shown, sr);
    hello.append(kicker, title, line);
    hero.append(mascot, hello);

    const grid = el("div", "buddy-actions");
    STARTERS.forEach((starter, i) => {
      const card = el("button", "buddy-action");
      card.type = "button";
      card.style.setProperty("--i", String(i));
      const tile = el("span", "buddy-action-icon");
      tile.append(icon(starter.icon));
      const text = el("span", "buddy-action-text");
      text.append(el("b", "", starter.label), el("small", "", starter.note));
      card.append(tile, text);
      card.addEventListener("click", () => {
        if (starter.action === "attach") els.fileInput.click();
        else if (starter.action === "cards") openFlashcards();
        else fillInput(starter.text);
      });
      grid.append(card);
    });
    home.append(hero, grid);

    const recent = [...chats].filter((chat) => chat.id !== current.id && chat.messages.length)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, 3);
    if (recent.length) {
      const section = el("div", "buddy-recent");
      section.append(el("p", "buddy-recent-label", "Pick up where you left off"));
      const row = el("div", "buddy-recent-row");
      recent.forEach((chat, i) => {
        const card = el("button", "buddy-recent-card");
        card.type = "button";
        card.style.setProperty("--i", String(i + STARTERS.length));
        card.append(icon("i-history"), el("span", "", chat.title));
        card.setAttribute("aria-label", `Open chat: ${chat.title}`);
        card.addEventListener("click", () => openChat(chat.id));
        row.append(card);
      });
      section.append(row);
      home.append(section);
    }

    // One "can do" line at a time (screen readers get the whole list once).
    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      rotateTimer = window.setInterval(() => {
        if (!shown.isConnected) { window.clearInterval(rotateTimer); return; }
        shown.classList.add("is-leaving");
        window.setTimeout(() => {
          index = (index + 1) % CAN_DO.length;
          shown.textContent = CAN_DO[index];
          shown.classList.remove("is-leaving");
        }, 280);
      }, 3200);
    }
    stopFollowing = followPointer(mascot, els.thread);
    return home;
  }

  function messageNode(message) {
    if (message.role === "user") {
      const bubble = el("div", "chat-bubble student-bubble");
      if (message.files?.length) {
        const files = el("div", "bubble-files");
        message.files.forEach((file) => {
          const chip = el("span", "bubble-file");
          chip.append(icon(file.kind === "picture" ? "i-eye" : "i-paperclip"), el("span", "", file.name));
          files.append(chip);
        });
        bubble.append(files);
      }
      bubble.append(el("p", "", message.content));
      return bubble;
    }
    if (message.role === "note") return el("p", "buddy-note", message.content);
    const bubble = el("div", "chat-bubble assistant-bubble rich");
    bubble.append(renderMarkdown(message.content));
    const tools = el("div", "bubble-tools");
    tools.append(iconButton("i-copy", "Copy answer", async (event) => {
      const button = event.currentTarget;
      try {
        await navigator.clipboard.writeText(message.content);
        button.title = "Copied";
        say("Answer copied.");
      } catch { say("Couldn’t copy. Select the text instead.", true); }
    }, "icon-btn bubble-tool"));
    bubble.append(tools);
    return bubble;
  }

  function renderChat() {
    els.title.textContent = current.title;
    renderClassPick();
    renderShelf();
    if (!current.messages.length) els.thread.replaceChildren(renderEmpty());
    else els.thread.replaceChildren(...current.messages.map(messageNode));
    // A new chat's welcome starts at the top; a conversation at its latest message.
    els.thread.scrollTop = current.messages.length ? els.thread.scrollHeight : 0;
    if (window.neuroFocusView === "buddy") document.title = current.title === "New chat" ? "NeuroBuddy · Neuro-Focus" : `${current.title} · NeuroBuddy`;
  }

  els.classPick.addEventListener("change", () => {
    current.classId = els.classPick.value;
    if (isSaved(current)) keep(current);
    if (!current.messages.length) renderChat();
    say(current.classId ? `NeuroBuddy will use ${className(current.classId)} for context.` : "No class picked: general help.");
  });

  function removeDocument(doc) {
    current.documents = current.documents.filter((entry) => entry.id !== doc.id);
    keep(current);
    renderShelf();
    say(`${doc.name} removed from this chat.`);
  }
  async function removeDeck(deck) {
    const ok = await confirmAction({ title: `Delete “${deck.title}”?`, message: `Its ${deck.cards.length} flashcards are removed from this chat.`, confirmLabel: "Delete flashcards", danger: true });
    if (!ok) return;
    current.decks = current.decks.filter((entry) => entry.id !== deck.id);
    keep(current);
    renderShelf();
  }

  // ---------- Files waiting to be sent ----------
  function clearPending() {
    pendingFiles = [];
    renderPending();
  }
  function renderPending() {
    els.pending.hidden = !pendingFiles.length;
    els.pending.replaceChildren(...pendingFiles.map((file) => {
      const chip = el("span", "buddy-file-chip");
      chip.dataset.state = file.status;
      chip.append(icon(file.kind === "picture" ? "i-eye" : "i-paperclip"), el("span", "", file.name));
      if (file.status === "reading") chip.append(el("small", "", "Reading…"));
      if (file.status === "error") chip.append(el("small", "", file.error));
      chip.append(iconButton("i-close", `Remove ${file.name}`, () => {
        pendingFiles = pendingFiles.filter((entry) => entry !== file);
        renderPending();
        els.input.focus();
      }));
      return chip;
    }));
  }

  async function addFiles(fileList) {
    const files = [...fileList];
    if (!files.length) return;
    for (const file of files) {
      const kind = kindOf(file);
      const docs = current.documents.length + pendingFiles.filter((entry) => entry.kind !== "picture").length;
      const pictures = pendingFiles.filter((entry) => entry.kind === "picture").length;
      let problem = "";
      if (!kind) problem = `“${file.name}” can’t be read. Use ${FILE_TYPES_TEXT}.`;
      else if (kind !== "picture" && docs >= LIMITS.documents) problem = `A chat can hold ${LIMITS.documents} files. Remove one, or start a new chat.`;
      else if (kind === "picture" && pictures >= PICTURES_PER_MESSAGE) problem = `Add up to ${PICTURES_PER_MESSAGE} pictures per message.`;
      if (problem) { notify({ title: "File not added", text: problem, kind: "error", timeoutMs: 8000 }); continue; }
      const entry = { id: newId(), name: file.name, kind, status: "reading" };
      pendingFiles.push(entry);
      renderPending();
      try {
        entry.result = await readFile(file);
        entry.status = "ready";
        say(`${file.name} is ready. Ask a question about it, or press Send for a summary.`);
      } catch (error) {
        entry.status = "error";
        entry.error = "couldn’t be read";
        notify({ title: "File not added", text: error instanceof Error ? error.message : "That file couldn’t be read.", kind: "error", timeoutMs: 9000 });
        pendingFiles = pendingFiles.filter((other) => other !== entry);
      }
      renderPending();
    }
    els.input.focus();
  }

  $("#buddyAttach").addEventListener("click", () => els.fileInput.click());
  els.fileInput.accept = ACCEPT;
  els.fileInput.addEventListener("change", () => { void addFiles(els.fileInput.files); els.fileInput.value = ""; });
  // Drag files onto the chat, or paste a picture into the message box.
  const main = $(".buddy-main");
  main.addEventListener("dragover", (event) => { if (event.dataTransfer?.types.includes("Files")) { event.preventDefault(); main.classList.add("is-dropping"); } });
  main.addEventListener("dragleave", (event) => { if (!main.contains(event.relatedTarget)) main.classList.remove("is-dropping"); });
  main.addEventListener("drop", (event) => {
    if (!event.dataTransfer?.files.length) return;
    event.preventDefault();
    main.classList.remove("is-dropping");
    void addFiles(event.dataTransfer.files);
  });
  els.input.addEventListener("paste", (event) => {
    const files = [...(event.clipboardData?.files || [])].filter((file) => kindOf(file));
    if (files.length) { event.preventDefault(); void addFiles(files); }
  });

  // ---------- Sending ----------
  function fillInput(text) {
    els.input.value = text;
    growInput();
    els.input.focus();
    els.input.setSelectionRange(text.length, text.length);
  }
  function growInput() {
    els.input.style.height = "auto";
    els.input.style.height = `${Math.min(els.input.scrollHeight, 200)}px`;
  }
  els.input.addEventListener("input", growInput);
  els.input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      els.form.requestSubmit();
    }
  });

  function setSending(controller) {
    sending = controller;
    els.send.classList.toggle("is-stop", Boolean(controller));
    els.send.setAttribute("aria-label", controller ? "Stop answering" : "Send");
    els.send.replaceChildren(icon(controller ? "i-stop" : "i-send"));
    els.thread.setAttribute("aria-busy", String(Boolean(controller)));
  }

  // The chat's files, shortened together to what one question can carry.
  function documentsToSend(chat) {
    if (!chat.documents.length) return [];
    const each = Math.floor(DOCUMENT_CHARS_SENT / chat.documents.length);
    return chat.documents.map((doc) => ({ name: doc.name, text: doc.text.slice(0, each) }));
  }

  els.form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (sending) { sending.abort(); return; }
    if (pendingFiles.some((file) => file.status === "reading")) { say("Wait a moment: a file is still being read.", true); return; }
    const ready = pendingFiles.filter((file) => file.status === "ready");
    const newDocs = ready.filter((file) => file.result.kind === "document");
    const pictures = ready.filter((file) => file.result.kind === "picture");
    let prompt = els.input.value.trim();
    if (!prompt && !ready.length) { els.input.focus(); return; }
    if (!prompt) prompt = pictures.length && !newDocs.length ? "What does this show? Explain it simply." : "Summarise this in simple steps, with the key ideas first.";
    if (serverVersion === "" && ready.length) {
      say("Files need the updated NeuroBuddy function. Ask your teacher or admin to deploy it (see README).", true);
      notify({ title: "Files can’t be read yet", text: "NeuroBuddy’s server function needs updating before it can read files. Your message wasn’t sent.", kind: "error", timeoutMs: 10000 });
      return;
    }

    const chat = current;
    const history = chat.messages.filter((message) => message.role === "user" || message.role === "assistant").slice(-HISTORY_SENT).map(({ role, content }) => ({ role, content }));
    newDocs.forEach((file) => chat.documents.push({ id: file.id, name: file.name, docKind: file.result.docKind, text: file.result.text, truncated: file.result.truncated }));
    const userMessage = { role: "user", content: prompt, ...(ready.length ? { files: ready.map((file) => ({ name: file.name, kind: file.kind === "picture" ? "picture" : "document" })) } : {}) };
    chat.messages.push(userMessage);
    if (chat.title === "New chat") chat.title = titleFrom(els.input.value.trim() || ready[0]?.name || prompt);
    keep(chat);
    els.title.textContent = chat.title;
    renderShelf();
    if (els.thread.querySelector(".buddy-empty")) els.thread.replaceChildren();
    els.thread.append(messageNode(userMessage));
    els.input.value = "";
    growInput();
    clearPending();

    const pending = el("div", "chat-bubble assistant-bubble is-pending", "Thinking…");
    els.thread.append(pending);
    els.thread.scrollTop = els.thread.scrollHeight;
    say("NeuroBuddy is thinking through that with you…");
    const controller = new AbortController();
    setSending(controller);
    let text = "";
    let version = null;
    try {
      const stickToBottom = () => els.thread.scrollHeight - els.thread.scrollTop - els.thread.clientHeight < 80;
      text = await streamAssistant(supabase, {
        task: "tutor",
        ...(chat.classId ? { classId: chat.classId } : {}),
        prompt,
        style,
        history,
        documents: documentsToSend(chat),
        pictures: pictures.map((file) => ({ dataUrl: file.result.dataUrl }))
      }, (soFar) => {
        const follow = stickToBottom();
        text = soFar;
        pending.classList.remove("is-pending");
        pending.classList.add("rich");
        pending.replaceChildren(renderMarkdown(soFar));
        if (follow) els.thread.scrollTop = els.thread.scrollHeight;
      }, { signal: controller.signal, onVersion: (value) => { version = value; serverVersion = value; } });
    } catch (error) {
      if (error?.name !== "AbortError") {
        pending.classList.remove("is-pending", "rich");
        pending.classList.add("assistant-error-bubble");
        pending.textContent = error instanceof Error ? error.message : "NeuroBuddy could not reply. Try again.";
        say("Your question wasn’t answered. Try again in a moment.", true);
        // Put the question back so it can be sent again.
        if (!els.input.value) fillInput(userMessage.content);
        chat.messages = chat.messages.filter((message) => message !== userMessage);
        keep(chat);
        setSending(null);
        return;
      }
    }
    setSending(null);
    if (!text.trim()) {
      pending.remove();
      chat.messages = chat.messages.filter((message) => message !== userMessage);
      keep(chat);
      if (!els.input.value) fillInput(userMessage.content);
      say("Stopped.");
      return;
    }
    chat.messages.push({ role: "assistant", content: text.trim() });
    if (version === "" && (chat.documents.length || pictures.length)) {
      chat.messages.push({ role: "note", content: "NeuroBuddy’s server function is an older version, so it couldn’t see your files for this answer. Deploy the updated learning-assistant function (see README)." });
    }
    if (chat.messages.length > LIMITS.messages) chat.messages.splice(0, chat.messages.length - LIMITS.messages);
    keep(chat);
    if (current === chat) renderChat();
    say(controller.signal.aborted ? "Stopped. The answer so far is saved." : "Answered. Ask a follow-up, or change how NeuroBuddy explains.");
  });

  // ---------- Explanation style (in the message box) ----------
  const styleOptions = [...els.styleMenu.querySelectorAll("[role=option]")];
  function setStyle(value, { remember = true } = {}) {
    if (!STYLES[value]) return;
    style = value;
    els.styleLabel.textContent = STYLES[value];
    els.styleButton.setAttribute("aria-label", `How NeuroBuddy explains: ${STYLES[value]}. Change`);
    styleOptions.forEach((option) => option.setAttribute("aria-selected", String(option.dataset.style === value)));
    if (remember) store(styleKey, value);
  }
  let activeOption = 0;
  function highlight(index) {
    activeOption = (index + styleOptions.length) % styleOptions.length;
    styleOptions.forEach((option, i) => option.classList.toggle("is-active", i === activeOption));
    els.styleMenu.setAttribute("aria-activedescendant", styleOptions[activeOption].id);
  }
  function openStyleMenu() {
    els.styleMenu.hidden = false;
    els.styleButton.setAttribute("aria-expanded", "true");
    highlight(styleOptions.findIndex((option) => option.dataset.style === style));
    els.styleMenu.focus();
  }
  function closeStyleMenu({ focusButton = false } = {}) {
    if (els.styleMenu.hidden) return;
    els.styleMenu.hidden = true;
    els.styleButton.setAttribute("aria-expanded", "false");
    if (focusButton) els.styleButton.focus();
  }
  function chooseStyle(index) {
    setStyle(styleOptions[index].dataset.style);
    closeStyleMenu();
    say(`NeuroBuddy will explain: ${STYLES[style]}.`);
    els.input.focus();
  }
  els.styleButton.addEventListener("click", () => (els.styleMenu.hidden ? openStyleMenu() : closeStyleMenu()));
  els.styleButton.addEventListener("keydown", (event) => {
    if (event.key === "ArrowUp" || event.key === "ArrowDown") { event.preventDefault(); openStyleMenu(); }
  });
  els.styleMenu.addEventListener("keydown", (event) => {
    const moves = { ArrowDown: 1, ArrowUp: -1 };
    if (moves[event.key]) { event.preventDefault(); highlight(activeOption + moves[event.key]); }
    else if (event.key === "Home") { event.preventDefault(); highlight(0); }
    else if (event.key === "End") { event.preventDefault(); highlight(styleOptions.length - 1); }
    else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); chooseStyle(activeOption); }
    else if (event.key === "Escape" || event.key === "Tab") { if (event.key === "Escape") event.preventDefault(); closeStyleMenu({ focusButton: event.key === "Escape" }); }
  });
  styleOptions.forEach((option, index) => {
    option.addEventListener("click", () => chooseStyle(index));
    option.addEventListener("mousemove", () => highlight(index));
  });
  document.addEventListener("click", (event) => { if (!event.target.closest(".buddy-style")) closeStyleMenu(); });
  setStyle(style, { remember: false });

  // ---------- Flashcards ----------
  const flashcards = createFlashcards({
    supabase,
    onSaveDeck: (chatId, deck) => {
      const chat = chatId ? chats.find((entry) => entry.id === chatId) : current;
      const target = chat || current;
      target.decks.unshift(deck);
      target.decks.splice(LIMITS.decks);
      if (target.title === "New chat") target.title = titleFrom(deck.title);
      keep(target);
      if (current === target) { els.title.textContent = target.title; renderShelf(); }
    },
    // Practising remembers which cards were tricky (saved without moving the chat up the list).
    onUpdateDeck: (deck) => {
      if (chats.some((chat) => chat.decks.some((entry) => entry.id === deck.id))) persist();
    }
  });
  function openFlashcards(topic = "") { flashcards.openMaker(current, { topic }); }
  $("#buddyFlashcards").addEventListener("click", () => openFlashcards());

  // ---------- Chat list on small screens (a drawer) ----------
  const opener = $("#buddyChatsOpen");
  function closeDrawer() {
    if (!els.chats.classList.contains("is-open")) return;
    els.chats.classList.remove("is-open");
    opener.setAttribute("aria-expanded", "false");
  }
  opener.addEventListener("click", () => {
    els.chats.classList.add("is-open");
    opener.setAttribute("aria-expanded", "true");
    $("#buddyNewChat").focus();
  });
  $("#buddyChatsClose").addEventListener("click", () => { closeDrawer(); opener.focus(); });
  els.chats.addEventListener("keydown", (event) => { if (event.key === "Escape" && els.chats.classList.contains("is-open")) { closeDrawer(); opener.focus(); } });
  // A tap outside closes the drawer. The click's path is checked (not its target), because a pencil
  // or bin button inside the list is swapped out (for the rename box) before this runs.
  document.addEventListener("click", (event) => {
    if (!els.chats.classList.contains("is-open")) return;
    const inside = event.composedPath().some((node) => node === els.chats || node === opener || node?.tagName === "DIALOG");
    if (!inside) closeDrawer();
  });

  $("#buddyNewChat").addEventListener("click", () => startChat());
  els.search.addEventListener("input", renderList);

  // Home's shortcuts ("Ask NeuroBuddy about Biology") start a fresh chat with the question begun;
  // "Continue where you left off" reopens a chat.
  window.addEventListener("neurofocus:buddy-prompt", (event) => {
    const { text = "", send = false, classId } = event.detail || {};
    if (current.messages.length) startChat(classId !== undefined ? { classId } : {});
    else if (classId !== undefined) { current.classId = classId; renderClassPick(); }
    fillInput(text);
    if (send && text.trim()) els.form.requestSubmit();
  });
  window.addEventListener("neurofocus:buddy-open", (event) => { if (event.detail?.id) openChat(event.detail.id); });
  // The NeuroBuddy dock (buddy-dock.js) saved its quick chat: take that chat's new copy, leaving the
  // rest as they are here.
  window.addEventListener("neurofocus:buddy-stored", (event) => {
    const id = event.detail?.id;
    const fresh = loadChats(userId).find((chat) => chat.id === id);
    if (!fresh) return;
    const index = chats.findIndex((chat) => chat.id === id);
    if (index >= 0) chats[index] = fresh;
    else chats.unshift(fresh);
    if (current?.id === id) {
      current = fresh;
      if (window.neuroFocusView === "buddy") renderChat();
    }
    renderList();
  });
  window.addEventListener("neurofocus:viewchange", (event) => { if (event.detail?.name === "buddy") renderChat(); });
  // Class names arrive after the page opens (student-classes.js).
  window.addEventListener("neurofocus:class-status", () => { renderClassPick(); renderList(); if (!current.messages.length) renderChat(); });

  // Start on the chat open last time, else a new chat.
  const last = chats.find((chat) => chat.id === read(currentKey));
  if (last) { current = last; renderChat(); } else { current = blankChat(); renderChat(); }
  renderList();
}
