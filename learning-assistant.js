const app = await window.neuroFocusReady;

if (app) {
  const { supabase } = app;
  const conversation = document.querySelector("#tutorConversation");
  const tutorForm = document.querySelector("#tutorForm");
  const notesInput = document.querySelector("#noteCaptureInput");
  const notesOutput = document.querySelector("#classNotes");
  const notesState = document.querySelector("#notesSaveState");
  const historyByClass = new Map();
  let currentClass = window.neuroFocusClass || null;
  let renderedClassId = undefined;
  let noteSaveTimer;
  let noteDirty = false;

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

  function addBubble(text, type) {
    const bubble = document.createElement("p");
    bubble.className = `chat-bubble ${type}-bubble`;
    bubble.textContent = text;
    conversation.append(bubble);
    conversation.scrollTop = conversation.scrollHeight;
    return bubble;
  }

  async function saveNotes(classId, text) {
    const { error } = await supabase.from("class_notes").upsert({
      class_id: classId,
      student_id: app.user.id,
      note_text: text,
      updated_at: new Date().toISOString()
    }, { onConflict: "class_id,student_id" });
    if (currentClass?.id === classId) {
      notesState.textContent = error ? "Could not save" : "Saved to your account";
      if (error) status("#notesMessage", "Your notes are still on screen but did not sync. Try again before leaving.", true);
    }
    return !error;
  }

  async function loadNotes(classId) {
    notesOutput.disabled = true;
    notesState.textContent = "Loading your private notes…";
    const { data, error } = await supabase
      .from("class_notes")
      .select("note_text")
      .eq("class_id", classId)
      .eq("student_id", app.user.id)
      .maybeSingle();
    if (currentClass?.id !== classId) return;
    notesOutput.disabled = false;
    if (error) {
      notesState.textContent = "Could not load notes";
      status("#notesMessage", "Could not load your private notes. Check the database setup and try again.", true);
      return;
    }
    notesOutput.value = data?.note_text || "";
    notesState.textContent = "Saved to your account";
  }

  function applyClass(classInfo) {
    const nextClassId = classInfo?.id || "";
    if (nextClassId !== renderedClassId) {
      if (noteDirty && currentClass) {
        clearTimeout(noteSaveTimer);
        void saveNotes(currentClass.id, notesOutput.value);
      }
      noteDirty = false;
      renderedClassId = nextClassId;
      notesOutput.value = "";
      notesInput.value = "";
      showGreeting(classInfo);
      currentClass = classInfo;
      currentHistory().forEach((message) => addBubble(message.content, message.role === "user" ? "student" : "assistant"));
    }
    currentClass = classInfo;
    if (classInfo) {
      void loadNotes(classInfo.id);
      status("#tutorMessage", `NeuroBuddy is using ${classInfo.name} for context. Your question and class name go to the AI service when you ask; avoid personal details.`);
      status("#notesMessage", `Your notes are private to your account. AI requests send this class name and only the text you choose; avoid personal details.`);
    } else {
      notesOutput.value = "";
      notesOutput.disabled = true;
      notesState.textContent = "Choose a class";
      status("#tutorMessage", "No class needed to chat. Pick a class any time to give NeuroBuddy context.");
      status("#notesMessage", "Join a class before creating class notes.");
    }
    tutorForm.querySelector("button[type='submit']").disabled = false;
    document.querySelector("#generateNotesButton").disabled = !classInfo;
  }

  async function requestAssistant(payload) {
    const { data, error } = await supabase.functions.invoke("learning-assistant", { body: payload });
    if (error) {
      let details;
      try {
        details = await error.context?.json();
      } catch { /* Use the generic setup message when the function response is not JSON. */ }
      if (details?.error) throw new Error(details.error);
      throw new Error("NeuroBuddy isn’t connected yet. Deploy the learning-assistant function and add your AI API key secret first.");
    }
    if (data?.error) throw new Error(data.error);
    if (!data?.text) throw new Error("The AI service returned no text. Try again.");
    return data.text;
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

    try {
      const answer = await requestAssistant({
        task: "tutor",
        ...(currentClass ? { classId: currentClass.id } : {}),
        prompt,
        style: document.querySelector("#supportStyle").value,
        history
      });
      pending.textContent = answer;
      history.push({ role: "user", content: prompt }, { role: "assistant", content: answer });
      if (history.length > 16) history.splice(0, history.length - 16);
      saveHistory();
      status("#tutorMessage", "You can ask a follow-up or request another explanation.");
    } catch (error) {
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

  document.querySelector("#generateNotesButton").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    const studentInput = notesInput.value.trim();
    if (!currentClass || !studentInput) {
      status("#notesMessage", currentClass ? "Add a few ideas or notes first." : "Join a class before creating class notes.", true);
      return;
    }
    button.disabled = true;
    button.textContent = "Organizing…";
    status("#notesMessage", "Organizing the text you provided…");
    const targetClassId = currentClass.id;
    try {
      const draft = await requestAssistant({ task: "notes", classId: targetClassId, studentInput });
      if (currentClass?.id !== targetClassId) return;
      notesOutput.value = draft;
      noteDirty = false;
      const saved = await saveNotes(targetClassId, draft);
      status("#notesMessage", saved
        ? "Draft ready and saved to your account. Review it and edit anything you want to change."
        : "Draft ready, but it did not sync. Copy it before leaving, then check your connection.", !saved);
    } catch (error) {
      status("#notesMessage", error instanceof Error ? error.message : "Could not organize notes. Try again.", true);
    } finally {
      button.disabled = !currentClass;
      button.textContent = "Organize my notes";
    }
  });

  notesOutput.addEventListener("input", () => {
    if (!currentClass) return;
    noteDirty = true;
    notesState.textContent = "Saving…";
    clearTimeout(noteSaveTimer);
    const classId = currentClass.id;
    noteSaveTimer = window.setTimeout(() => {
      const contents = notesOutput.value;
      noteDirty = false;
      void saveNotes(classId, contents);
    }, 650);
  });

  window.addEventListener("neurofocus:classchange", (event) => applyClass(event.detail));
  applyClass(currentClass);
}
