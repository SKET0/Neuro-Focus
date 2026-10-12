// NeuroBuddy dock: a small floating NeuroBuddy button in the bottom right corner of every student
// workspace page (styles/buddy-dock.css). It opens a quick chat without leaving the page.
// Quick chats are ordinary NeuroBuddy chats (buddy-store.js), so they appear in the full NeuroBuddy
// page's list, and "Open full chat" continues them there. After saving one it sends
// "neurofocus:buddy-stored" so the full page (learning-assistant.js) picks up the new copy.
// It is hidden on the NeuroBuddy page itself; questions asked inside a class use that class for context.
import { streamAssistant } from "../services/assistant-api.js?v=2";
import { renderMarkdown } from "./markdown.js?v=1";
import { greetingName } from "./avatars.js?v=1";
import { loadChats, saveChats, newId, titleFrom, LIMITS } from "../student/buddy-store.js?v=1";

const HISTORY_SENT = 10;
const DOCUMENT_CHARS_SENT = 60000;
const STARTERS = [
  { icon: "spark", label: "Explain a topic simply", text: "Explain this simply, with one everyday example: " },
  { icon: "rocket", label: "Help me get started", text: "I'm stuck getting started. Break this task into tiny first steps: " },
  { icon: "help", label: "Quiz me on something", text: "Quiz me with 3 quick questions, one at a time, about " }
];

// Drawn here so the dock doesn't depend on the page's icon sprite.
const stroke = (paths, extra = "") => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${paths}</svg>`;
const ICONS = {
  face: stroke('<path d="M12 5V3"/><circle cx="12" cy="2.3" r="1.1" fill="currentColor" stroke="none"/><rect x="3.5" y="5" width="17" height="14" rx="7"/><rect x="6.5" y="8.6" width="11" height="6.8" rx="3.4"/><path d="M10 11.3v1.4M14 11.3v1.4" stroke-width="2.2"/>'),
  close: stroke('<path d="M6 6l12 12M18 6 6 18"/>'),
  down: stroke('<path d="m6 9 6 6 6-6"/>'),
  expand: stroke('<path d="M14 4h6v6M20 4l-7 7M10 20H4v-6M4 20l7-7"/>'),
  plus: stroke('<path d="M12 5v14M5 12h14"/>'),
  send: stroke('<path d="M5 12h13M13 6l6 6-6 6"/>'),
  stop: stroke('<rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none"/>'),
  spark: stroke('<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9Z"/>'),
  rocket: stroke('<path d="M5 15c-1 1-1.5 3.5-1.5 5.5 2 0 4.5-.5 5.5-1.5M9 15l-2-2c1-4 4.5-8.5 11-9 0 6.5-5 10-9 11Z"/><circle cx="14.5" cy="9.5" r="1.5"/>'),
  help: stroke('<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 0 1 4.9.7c0 1.7-2.4 2.3-2.4 3.8M12 17h.01"/>')
};

// The signed-in student (auth-guard.js), or null when the page isn't a student page.
async function findContext() {
  if (document.body?.dataset.requiredRole !== "student") return null;
  const app = await window.neuroFocusReady;
  if (!app) return null;
  return { supabase: app.supabase, userId: app.user.id, name: app.profile?.display_name || "" };
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function iconNode(name) {
  const holder = document.createElement("span");
  holder.innerHTML = ICONS[name];
  return holder.firstElementChild;
}
function iconButton(name, label, onClick) {
  const button = el("button", "bd-icon-btn");
  button.type = "button";
  button.setAttribute("aria-label", label);
  button.title = label;
  button.append(iconNode(name));
  button.addEventListener("click", onClick);
  return button;
}

function mount(context) {
  const { userId } = context;
  const dockKey = `neuroFocusBuddyDock:${userId}`;
  const read = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
  const store = (key, value) => { try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch { /* storage unavailable */ } };

  // ---------- The button and the panel ----------
  const dock = el("div", "buddy-dock");
  dock.dataset.open = "false";
  const panel = el("section", "buddy-dock-panel");
  panel.id = "buddyDockPanel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-labelledby", "buddyDockTitle");
  panel.hidden = true;

  const head = el("header", "buddy-dock-head");
  const face = el("span", "buddy-dock-face");
  face.append(iconNode("face"));
  const heading = el("div", "buddy-dock-heading");
  const title = el("h2", "", "NeuroBuddy");
  title.id = "buddyDockTitle";
  const subtitle = el("small", "", "Your study buddy");
  heading.append(title, subtitle);
  head.append(face, heading);

  const thread = el("div", "buddy-dock-thread");
  thread.setAttribute("aria-live", "polite");
  panel.append(head, thread);

  const button = el("button", "buddy-dock-button");
  button.type = "button";
  button.setAttribute("aria-controls", panel.id);
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-label", "Ask NeuroBuddy");
  const faceIcon = iconNode("face");
  faceIcon.classList.add("bd-face-icon");
  const closeIcon = iconNode("down");
  closeIcon.classList.add("bd-close-icon");
  button.append(faceIcon, closeIcon, el("span", "buddy-dock-tip", "Ask NeuroBuddy"));

  dock.append(panel, button);
  document.body.append(dock);

  let chat = null;      // the dock's chat; a new one isn't saved until it has a message
  let sending = null;   // AbortController while an answer is coming in

  function setOpen(open, { focusButton = false } = {}) {
    if (open === !panel.hidden) return;
    panel.hidden = !open;
    dock.dataset.open = String(open);
    button.setAttribute("aria-expanded", String(open));
    button.setAttribute("aria-label", open ? "Close NeuroBuddy" : "Ask NeuroBuddy");
    if (open) {
      loadChat();
      render();
      input.focus();
    } else if (focusButton) button.focus();
  }
  button.addEventListener("click", () => setOpen(panel.hidden));
  panel.addEventListener("keydown", (event) => { if (event.key === "Escape") { event.preventDefault(); setOpen(false, { focusButton: true }); } });

  const closeButton = iconButton("close", "Close", () => setOpen(false, { focusButton: true }));

  // ---------- The quick chat ----------
  const classes = () => window.neuroFocusClasses || [];
  const className = (id) => classes().find((item) => item.id === id)?.name || "";
  const contextClass = () => window.neuroFocusRouteClassId || "";
  const blankChat = () => ({ id: null, title: "New chat", classId: contextClass(), createdAt: "", updatedAt: "", messages: [], documents: [], decks: [] });

  // Always start from the stored copy: the chat may have continued on the full NeuroBuddy page.
  function loadChat() {
    if (sending) return;
    const id = chat?.id || read(dockKey);
    chat = (id && loadChats(userId).find((entry) => entry.id === id)) || (chat?.id ? blankChat() : chat || blankChat());
    if (!chat.messages.length) chat.classId = contextClass();
  }

  function save() {
    const now = new Date().toISOString();
    chat.updatedAt = now;
    if (!chat.id) {
      chat.id = newId();
      chat.createdAt = now;
      store(dockKey, chat.id);
    }
    if (chat.messages.length > LIMITS.messages) chat.messages.splice(0, chat.messages.length - LIMITS.messages);
    const problem = saveChats(userId, [chat, ...loadChats(userId).filter((entry) => entry.id !== chat.id)]);
    window.dispatchEvent(new CustomEvent("neurofocus:buddy-stored", { detail: { id: chat.id } }));
    return problem;
  }

  function newChat() {
    if (sending) sending.abort();
    chat = blankChat();
    store(dockKey, null);
    render();
    input.focus();
  }

  // The full NeuroBuddy page, on this chat (it opens the chat saved as current).
  function openFull() {
    if (chat?.id) store(`neuroFocusBuddyCurrent:${userId}`, chat.id);
    setOpen(false);
    if (chat?.id) window.dispatchEvent(new CustomEvent("neurofocus:buddy-open", { detail: { id: chat.id } }));
    window.neuroFocusNavigate?.("buddy");
  }

  head.append(iconButton("plus", "New chat", newChat), iconButton("expand", "Open full chat", openFull), closeButton);

  const form = el("form", "buddy-dock-form");
  form.noValidate = true;
  const input = el("textarea");
  input.rows = 1;
  input.maxLength = 4000;
  input.placeholder = "Ask NeuroBuddy anything…";
  input.setAttribute("aria-label", "Message NeuroBuddy");
  const sendButton = el("button", "bd-send");
  sendButton.type = "submit";
  form.append(input, sendButton);
  const foot = el("p", "buddy-dock-foot", "Files, flashcards and all your chats are in the full chat.");
  panel.append(form, foot);

  function setSending(controller) {
    sending = controller;
    sendButton.classList.toggle("is-stop", Boolean(controller));
    sendButton.setAttribute("aria-label", controller ? "Stop answering" : "Send");
    sendButton.replaceChildren(iconNode(controller ? "stop" : "send"));
    thread.setAttribute("aria-busy", String(Boolean(controller)));
  }
  setSending(null);

  function growInput() {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 130)}px`;
  }
  function fillInput(text) {
    input.value = text;
    growInput();
    input.focus();
    input.setSelectionRange(text.length, text.length);
  }
  input.addEventListener("input", growInput);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      form.requestSubmit();
    }
  });

  function messageNode(message) {
    if (message.role === "note") return el("p", "bd-note", message.content);
    if (message.role === "user") {
      const bubble = el("div", "bd-msg user");
      if (message.files?.length) bubble.append(el("div", "bd-files", `📎 ${message.files.map((file) => file.name).join(", ")}`));
      bubble.append(el("p", "", message.content));
      return bubble;
    }
    const bubble = el("div", "bd-msg assistant");
    bubble.append(renderMarkdown(message.content));
    return bubble;
  }

  function welcome() {
    const box = el("div", "bd-welcome");
    const big = el("div", "bd-welcome-face");
    big.append(iconNode("face"));
    const name = greetingName(context.name);
    const label = className(chat.classId);
    const starters = el("div", "bd-starters");
    STARTERS.forEach((starter) => {
      const chip = el("button", "bd-starter");
      chip.type = "button";
      chip.append(iconNode(starter.icon), el("span", "", starter.label));
      chip.addEventListener("click", () => fillInput(starter.text));
      starters.append(chip);
    });
    box.append(big, el("h3", "", name === "there" || name === "Student" ? "Hi! What are we working on?" : `Hi ${name}! What are we working on?`),
      el("p", "", label ? `Ask anything about ${label}. I’ll keep it simple.` : "Ask a question, or pick a way to start."), starters);
    return box;
  }

  function render() {
    const label = className(chat.classId);
    subtitle.textContent = chat.messages.length ? chat.title : label ? `Working on ${label}` : "Your study buddy";
    if (!chat.messages.length) thread.replaceChildren(welcome());
    else thread.replaceChildren(...chat.messages.map(messageNode));
    thread.scrollTop = thread.scrollHeight;
  }

  // The chat's files (added on the full page), shortened together to what one question can carry.
  function documentsToSend() {
    if (!chat.documents.length) return [];
    const each = Math.floor(DOCUMENT_CHARS_SENT / chat.documents.length);
    return chat.documents.map((doc) => ({ name: doc.name, text: doc.text.slice(0, each) }));
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (sending) { sending.abort(); return; }
    const prompt = input.value.trim();
    if (!prompt) { input.focus(); return; }
    loadChat();
    const history = chat.messages.filter((message) => message.role === "user" || message.role === "assistant")
      .slice(-HISTORY_SENT).map(({ role, content }) => ({ role, content }));
    const userMessage = { role: "user", content: prompt };
    chat.messages.push(userMessage);
    if (chat.title === "New chat") chat.title = titleFrom(prompt);
    save();
    render();
    input.value = "";
    growInput();

    const pending = el("div", "bd-msg assistant is-pending", "Thinking…");
    thread.append(pending);
    thread.scrollTop = thread.scrollHeight;
    const controller = new AbortController();
    setSending(controller);
    let text = "";
    try {
      const nearBottom = () => thread.scrollHeight - thread.scrollTop - thread.clientHeight < 80;
      text = await streamAssistant(context.supabase, {
        task: "tutor",
        ...(chat.classId ? { classId: chat.classId } : {}),
        prompt,
        style: read(`neuroFocusBuddyStyle:${userId}`) || "step-by-step",
        history,
        documents: documentsToSend(),
        pictures: []
      }, (soFar) => {
        const follow = nearBottom();
        text = soFar;
        pending.classList.remove("is-pending");
        pending.replaceChildren(renderMarkdown(soFar));
        if (follow) thread.scrollTop = thread.scrollHeight;
      }, { signal: controller.signal });
    } catch (error) {
      if (error?.name !== "AbortError") {
        pending.classList.remove("is-pending");
        pending.classList.add("is-error");
        pending.textContent = error instanceof Error ? error.message : "NeuroBuddy couldn’t reply. Try again.";
        chat.messages = chat.messages.filter((message) => message !== userMessage);
        save();
        if (!input.value) fillInput(prompt);
        setSending(null);
        return;
      }
    }
    setSending(null);
    if (!text.trim()) {
      pending.remove();
      chat.messages = chat.messages.filter((message) => message !== userMessage);
      save();
      if (!input.value) fillInput(prompt);
      return;
    }
    chat.messages.push({ role: "assistant", content: text.trim() });
    const problem = save();
    render();
    if (problem) thread.append(el("p", "bd-note", problem));
  });

  // Not on the NeuroBuddy page itself (it is already open there).
  {
    const update = () => {
      const onBuddy = window.neuroFocusView === "buddy";
      if (onBuddy) setOpen(false);
      dock.hidden = onBuddy;
    };
    window.addEventListener("neurofocus:viewchange", update);
    window.addEventListener("neurofocus:class-status", () => { if (!panel.hidden && !chat.messages.length) { chat.classId = contextClass(); render(); } });
    update();
  }
}

try {
  const context = await findContext();
  if (context) mount(context);
} catch (error) {
  console.warn("NeuroBuddy dock unavailable", error);
}
