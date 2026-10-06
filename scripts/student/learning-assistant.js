// NeuroBuddy chat: answers stream in as they are written and render simple formatting
// (bold, lists, headings). Class notes live in student-notes.js.
import { streamAssistant } from "../services/assistant-api.js?v=1";
import { renderMarkdown } from "../shared/markdown.js?v=1";

const app = await window.neuroFocusReady;

if (app) {
  const { supabase } = app;
  const conversation = document.querySelector("#tutorConversation");
  const tutorForm = document.querySelector("#tutorForm");
  const historyByClass = new Map();
  let currentClass = window.neuroFocusClass || null;
  let renderedClassId = undefined;

  // NeuroBuddy chats are kept on this device per account and class, so a refresh keeps them.
  const chatKey = (historyKey) => `neuroFocusChat:${app.user.id}:${historyKey}`;
  const currentHistory = () => {
    const historyKey = currentClass?.id || "open-tutor";
    if (!historyByClass.has(historyKey)) {
      let stored = [];
      try { stored = JSON.parse(localStorage.getItem(chatKey(historyKey)) || "[]"); } catch { stored = []; }
      historyByClass.set(historyKey, Array.isArray(stored) ? stored : []);
    }
    return historyByClass.get(historyKey);
  };
  const saveHistory = () => {
    try { localStorage.setItem(chatKey(currentClass?.id || "open-tutor"), JSON.stringify(currentHistory())); } catch { /* storage unavailable */ }
  };

  // Explanation style: the choices on the page set the hidden #supportStyle list, which is sent
  // with each question. The choice is remembered on this device, per account.
  const styleSelect = document.querySelector("#supportStyle");
  const styleButtons = [...document.querySelectorAll("[data-style]")];
  const styleKey = `neuroFocusBuddyStyle:${app.user.id}`;
  function setStyle(value, { remember = false } = {}) {
    if (![...styleSelect.options].some((option) => option.value === value)) return;
    styleSelect.value = value;
    styleButtons.forEach((button) => {
      const chosen = button.dataset.style === value;
      button.setAttribute("aria-checked", String(chosen));
      button.tabIndex = chosen ? 0 : -1;
    });
    if (remember) { try { localStorage.setItem(styleKey, value); } catch { /* storage unavailable */ } }
  }
  styleButtons.forEach((button) => button.addEventListener("click", () => setStyle(button.dataset.style, { remember: true })));
  document.querySelector("#styleOptions")?.addEventListener("keydown", (event) => {
    const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[event.key];
    if (!step) return;
    event.preventDefault();
    const next = styleButtons[(styleButtons.findIndex((button) => button.dataset.style === styleSelect.value) + step + styleButtons.length) % styleButtons.length];
    setStyle(next.dataset.style, { remember: true });
    next.focus();
  });
  let savedStyle = null;
  try { savedStyle = localStorage.getItem(styleKey); } catch { /* storage unavailable */ }
  setStyle(savedStyle || styleSelect.value);

  function showGreeting(classInfo) {
    conversation.replaceChildren();
    const greeting = document.createElement("p");
    greeting.className = "chat-bubble assistant-bubble";
    greeting.textContent = classInfo
      ? `Hi, I’m NeuroBuddy! You’re working in ${classInfo.name}. What would you like help understanding?`
      : "Hi, I’m NeuroBuddy! Ask me anything you’re learning about. You don’t need to join a class to chat with me.";
    conversation.append(greeting);
  }

  function status(id, text, isError = false) {
    const element = document.querySelector(id);
    if (!element) return;
    element.textContent = text;
    element.dataset.state = isError ? "error" : "";
  }

  function setBubbleText(bubble, text, type) {
    if (type === "assistant") {
      bubble.replaceChildren(renderMarkdown(text));
      bubble.classList.add("rich");
    } else bubble.textContent = text;
  }

  function addBubble(text, type) {
    const bubble = document.createElement(type === "assistant" ? "div" : "p");
    bubble.className = `chat-bubble ${type}-bubble`;
    setBubbleText(bubble, text, type);
    conversation.append(bubble);
    conversation.scrollTop = conversation.scrollHeight;
    return bubble;
  }

  function applyClass(classInfo) {
    const nextClassId = classInfo?.id || "";
    if (nextClassId !== renderedClassId) {
      renderedClassId = nextClassId;
      showGreeting(classInfo);
      currentClass = classInfo;
      currentHistory().forEach((message) => addBubble(message.content, message.role === "user" ? "student" : "assistant"));
    }
    currentClass = classInfo;
    const context = document.querySelector("#buddyContext");
    if (context) context.textContent = classInfo ? `Helping with ${classInfo.name}` : "No class picked · general help";
    status("#tutorMessage", classInfo
      ? `NeuroBuddy is using ${classInfo.name} for context. Your question and class name go to the AI service when you ask; avoid personal details.`
      : "No class needed to chat. Pick a class any time to give NeuroBuddy context.");
    tutorForm.querySelector("button[type='submit']").disabled = false;
  }

  tutorForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = document.querySelector("#tutorPrompt");
    const prompt = input.value.trim();
    if (!prompt) return;
    const history = currentHistory();
    addBubble(prompt, "student");
    input.value = "";
    input.disabled = true;
    const submit = tutorForm.querySelector("button[type='submit']");
    submit.disabled = true;
    status("#tutorMessage", "NeuroBuddy is thinking through that with you…");
    const pending = addBubble("Thinking…", "assistant");
    pending.classList.add("is-pending");

    try {
      // Keep the newest words in view unless the student scrolled up to read.
      const stickToBottom = () => conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 80;
      const answer = await streamAssistant(supabase, {
        task: "tutor",
        ...(currentClass ? { classId: currentClass.id } : {}),
        prompt,
        style: document.querySelector("#supportStyle").value,
        history
      }, (textSoFar) => {
        const follow = stickToBottom();
        pending.classList.remove("is-pending");
        setBubbleText(pending, textSoFar, "assistant");
        if (follow) conversation.scrollTop = conversation.scrollHeight;
      });
      setBubbleText(pending, answer, "assistant");
      history.push({ role: "user", content: prompt }, { role: "assistant", content: answer });
      if (history.length > 16) history.splice(0, history.length - 16);
      saveHistory();
      status("#tutorMessage", "You can ask a follow-up or request another explanation.");
    } catch (error) {
      pending.classList.remove("is-pending", "rich");
      pending.textContent = error instanceof Error ? error.message : "NeuroBuddy could not reply. Try again.";
      pending.classList.add("assistant-error-bubble");
      status("#tutorMessage", "Your question was not answered. Please try again later.", true);
    } finally {
      input.disabled = false;
      submit.disabled = false;
      input.focus();
    }
  });

  document.querySelector("#clearChat")?.addEventListener("click", () => {
    currentHistory().length = 0;
    saveHistory();
    showGreeting(currentClass);
    status("#tutorMessage", "Chat cleared. Ask NeuroBuddy anything.");
  });

  // The Home view's "What are we learning today?" box (student-dashboard.js): a typed question is
  // sent straight away; a shortcut fills in the start of a question for the student to finish.
  window.addEventListener("neurofocus:buddy-prompt", (event) => {
    const { text = "", send = false } = event.detail || {};
    const input = document.querySelector("#tutorPrompt");
    if (!input) return;
    input.value = text;
    if (send && text.trim() && !input.disabled) {
      tutorForm.requestSubmit();
      return;
    }
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  });

  window.addEventListener("neurofocus:classchange", (event) => applyClass(event.detail));
  applyClass(currentClass);
}
