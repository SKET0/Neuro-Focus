// NeuroBuddy chat: answers stream in as they are written and render simple formatting
// (bold, lists, headings). Class notes live in student-notes.js.
import { streamAssistant } from "./assistant-api.js?v=1";
import { renderMarkdown } from "./markdown.js?v=1";

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

  window.addEventListener("neurofocus:classchange", (event) => applyClass(event.detail));
  applyClass(currentClass);
}
