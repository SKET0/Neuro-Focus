// Student focus tools: live attention stats, focus timeline, ADHD-friendly focus
// timer, gentle re-engagement nudges, and micro-goals. Reads the
// "neurofocus:attention-update" events published by eye-analyzer.js.

const app = await window.neuroFocusReady;

if (app) {
  const $ = (selector) => document.querySelector(selector);
  const NUDGE_AFTER_MS = 4000;   // continuous distraction before a nudge
  const TIMELINE_SECONDS = 120;  // points kept on the focus timeline
  const MICRO_TASKS = [
    "Take one slow breath in for 4 and out for 6, then look back at your screen.",
    "Write down one sentence about what you just learned.",
    "Find the last line you read and put your finger next to it.",
    "Roll your shoulders back twice, then return to your task.",
    "Say your current goal out loud in five words or less."
  ];

  // ---------- Greeting ----------
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const firstName = (app.profile.display_name || "there").split(/\s+/)[0];
  $("#welcomeTitle").textContent = `${greeting}, ${firstName}`;

  // ---------- Toast (nudges + timer messages) ----------
  const toast = {
    el: $("#focusToast"), icon: $("#toastIcon"), title: $("#toastTitle"), text: $("#toastText"), actions: $("#toastActions")
  };
  let toastTimer;

  function hideToast() {
    window.clearTimeout(toastTimer);
    toast.el.hidden = true;
    toast.el.dataset.kind = "";
  }

  function showToast({ icon, title, text, kind = "", actions = [], autoHideMs = 0 }) {
    window.clearTimeout(toastTimer);
    toast.icon.textContent = icon;
    toast.title.textContent = title;
    toast.text.textContent = text;
    toast.el.dataset.kind = kind;
    toast.actions.replaceChildren(...actions.map(({ label, primary, onClick }) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = primary ? "btn-primary" : "btn-action";
      button.textContent = label;
      button.addEventListener("click", () => { hideToast(); onClick?.(); });
      return button;
    }));
    toast.el.hidden = false;
    if (autoHideMs) toastTimer = window.setTimeout(hideToast, autoHideMs);
  }

  let audioContext;
  function chime() {
    if (!$("#chimeToggle").checked) return;
    try {
      audioContext ??= new AudioContext();
      const now = audioContext.currentTime;
      const osc = audioContext.createOscillator();
      const gain = audioContext.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(660, now);
      osc.frequency.linearRampToValueAtTime(880, now + 0.18);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.06, now + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.5);
      osc.connect(gain).connect(audioContext.destination);
      osc.start(now);
      osc.stop(now + 0.5);
    } catch {
      // Sound is optional.
    }
  }

  // ---------- Settings remembered on this device, per account ----------
  const prefsKey = `neuroFocusPrefs:${app.user.id}`;
  const PREF_IDS = ["nudgeToggle", "chimeToggle", "shareToggle", "timerWithTracking"];
  try {
    const prefs = JSON.parse(localStorage.getItem(prefsKey) || "{}");
    PREF_IDS.forEach((id) => {
      const box = document.getElementById(id);
      if (box && typeof prefs[id] === "boolean" && box.checked !== prefs[id]) {
        box.checked = prefs[id];
        box.dispatchEvent(new Event("change"));
      }
    });
  } catch { /* storage unavailable */ }
  PREF_IDS.forEach((id) => document.getElementById(id)?.addEventListener("change", () => {
    try {
      const prefs = Object.fromEntries(PREF_IDS.map((key) => [key, Boolean(document.getElementById(key)?.checked)]));
      localStorage.setItem(prefsKey, JSON.stringify(prefs));
    } catch { /* storage unavailable */ }
  }));

  // ---------- Micro-goals (saved on this device, per account) ----------
  const goalsKey = `neuroFocusGoals:${app.user.id}`;
  let goals = [];
  try { goals = JSON.parse(localStorage.getItem(goalsKey) || "[]"); } catch { goals = []; }

  const saveGoals = () => { try { localStorage.setItem(goalsKey, JSON.stringify(goals)); } catch { /* storage unavailable */ } };
  const nextGoal = () => goals.find((goal) => !goal.done)?.text;

  function renderGoals() {
    const list = $("#goalList");
    list.replaceChildren();
    if (!goals.length) {
      const empty = document.createElement("li");
      empty.className = "empty-state";
      empty.textContent = "Add 2–4 small steps, like “Read pages 12–14” or “Answer question 3”.";
      list.append(empty);
    }
    goals.forEach((goal) => {
      const item = document.createElement("li");
      item.className = "goal-item";
      item.dataset.done = String(goal.done);
      const label = document.createElement("label");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = goal.done;
      box.addEventListener("change", () => {
        goal.done = box.checked;
        saveGoals();
        renderGoals();
        if (goal.done && goals.every((g) => g.done)) {
          showToast({ icon: "🏆", kind: "praise", title: "All steps done!", text: "Great work finishing your plan. Take a moment to celebrate.", autoHideMs: 4000 });
        }
      });
      const text = document.createElement("span");
      text.textContent = goal.text;
      label.append(box, text);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "goal-delete";
      remove.setAttribute("aria-label", `Remove “${goal.text}”`);
      remove.textContent = "×";
      remove.addEventListener("click", () => {
        goals = goals.filter((g) => g !== goal);
        saveGoals();
        renderGoals();
      });
      item.append(label, remove);
      list.append(item);
    });
    const done = goals.filter((goal) => goal.done).length;
    $("#goalSummary").textContent = !goals.length
      ? "No steps yet"
      : done === goals.length ? `All ${goals.length} steps done 🎉` : `${done} of ${goals.length} steps done`;
    $("#goalProgress").style.width = goals.length ? `${(done / goals.length) * 100}%` : "0%";
    $("#goalClearDone").disabled = !done;
  }

  $("#goalForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const input = $("#goalInput");
    const text = input.value.trim().slice(0, 120);
    if (!text) return;
    goals.push({ id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, text, done: false });
    input.value = "";
    saveGoals();
    renderGoals();
  });
  $("#goalClearDone").addEventListener("click", () => {
    goals = goals.filter((goal) => !goal.done);
    saveGoals();
    renderGoals();
  });
  renderGoals();

  // ---------- Focus timer ----------
  const PRESETS = { "25-5": [25, 5], "15-3": [15, 3], "10-2": [10, 2], "45-10": [45, 10] };
  const RING = 2 * Math.PI * 52;
  const timer = { phase: "focus", remaining: 0, total: 1, running: false, rounds: 0, interval: null };
  const presetMinutes = () => PRESETS[$("#timerPreset").value] || PRESETS["25-5"];
  const timerKey = `neuroFocusTimer:${app.user.id}`;

  function saveTimer() {
    try {
      localStorage.setItem(timerKey, JSON.stringify({
        preset: $("#timerPreset").value, phase: timer.phase, total: timer.total, remaining: timer.remaining,
        rounds: timer.rounds, running: timer.running, endsAt: timer.running ? Date.now() + timer.remaining * 1000 : null
      }));
    } catch { /* storage unavailable */ }
  }

  function renderTimer() {
    const minutes = Math.floor(timer.remaining / 60);
    const seconds = timer.remaining % 60;
    $("#timerDisplay").textContent = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
    $("#timerPhase").textContent = timer.phase === "focus" ? "Focus block" : "Break";
    $("#timerRing").style.strokeDashoffset = String(RING * (1 - timer.remaining / timer.total));
    $("#focus-timer").dataset.phase = timer.phase;
    $("#timerToggle").textContent = timer.running
      ? "Pause"
      : timer.remaining < timer.total ? "Resume" : timer.phase === "focus" ? "Start focus" : "Start break";
    $("#timerRounds").textContent = String(timer.rounds);
    saveTimer();
  }

  function setPhase(phase) {
    const [focusMinutes, breakMinutes] = presetMinutes();
    timer.phase = phase;
    timer.total = (phase === "focus" ? focusMinutes : breakMinutes) * 60;
    timer.remaining = timer.total;
    renderTimer();
  }

  function setTimerRunning(running, { restoring = false } = {}) {
    window.clearInterval(timer.interval);
    timer.running = running;
    if (running) {
      timer.interval = window.setInterval(tickTimer, 1000);
      // After a page refresh the camera stays off until the student starts it again.
      if (!restoring && timer.phase === "focus" && $("#timerWithTracking").checked) {
        window.dispatchEvent(new CustomEvent("neurofocus:start-camera"));
      }
    }
    renderTimer();
  }

  function tickTimer() {
    timer.remaining -= 1;
    if (timer.remaining > 0) {
      renderTimer();
      return;
    }
    chime();
    if (timer.phase === "focus") {
      timer.rounds += 1;
      setPhase("break");
      setTimerRunning(true);
      showToast({
        icon: "☕", kind: "timer", title: "Focus block complete!",
        text: `Take a ${presetMinutes()[1]}-minute break: stand up, stretch, and drink some water.`,
        autoHideMs: 8000
      });
    } else {
      setPhase("focus");
      setTimerRunning(false);
      showToast({
        icon: "🎯", kind: "timer", title: "Break’s over",
        text: "Start your next focus block whenever you’re ready.",
        actions: [{ label: "Start focus", primary: true, onClick: () => setTimerRunning(true) }]
      });
    }
  }

  $("#timerToggle").addEventListener("click", () => setTimerRunning(!timer.running));
  $("#timerReset").addEventListener("click", () => { setTimerRunning(false); setPhase("focus"); });
  $("#timerSkip").addEventListener("click", () => { setTimerRunning(false); setPhase(timer.phase === "focus" ? "break" : "focus"); });
  $("#timerPreset").addEventListener("change", () => { setTimerRunning(false); setPhase("focus"); });

  // Restore the timer after a refresh, catching up on time that passed meanwhile.
  function restoreTimer() {
    let saved;
    try { saved = JSON.parse(localStorage.getItem(timerKey) || "null"); } catch { saved = null; }
    if (!saved || !PRESETS[saved.preset] || !["focus", "break"].includes(saved.phase)) {
      setPhase("focus");
      return;
    }
    $("#timerPreset").value = saved.preset;
    timer.phase = saved.phase;
    timer.total = Math.max(1, Number(saved.total) || 1);
    timer.rounds = Math.max(0, Number(saved.rounds) || 0);
    const remaining = saved.running && saved.endsAt
      ? Math.ceil((saved.endsAt - Date.now()) / 1000)
      : Number(saved.remaining) || timer.total;
    if (remaining > 0) {
      timer.remaining = Math.min(remaining, timer.total);
      setTimerRunning(Boolean(saved.running), { restoring: true });
    } else if (timer.phase === "focus") {
      timer.rounds += 1;
      setPhase("break");
      showToast({ icon: "☕", kind: "timer", title: "Your focus block finished", text: "It ended while this page was closed. Start your break when you’re ready.", autoHideMs: 8000 });
    } else {
      setPhase("focus");
    }
  }
  restoreTimer();

  // ---------- Live attention stats, nudges and timeline ----------
  const stats = {
    live: $("#statLiveScore"), liveState: $("#statLiveState"), focus: $("#statSessionFocus"), tracked: $("#statTracked"),
    streak: $("#statStreak"), best: $("#statBestStreak"), lapses: $("#statLapses"), nudges: $("#statNudges")
  };
  const timelineLabels = [];
  const timelineScores = [];
  let startedAt = 0;
  let lastEventAt = 0;
  let trackedMs = 0;
  let streakStart = null;
  let bestStreakMs = 0;
  let distractedSince = null;
  let lapseActive = false;
  let lapses = 0;
  let nudgesShown = 0;
  let snoozeUntil = 0;
  let bucket = null;
  let lastFocus = null;

  const clock = (ms) => {
    const total = Math.floor(ms / 1000);
    const minutes = Math.floor(total / 60);
    return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}:${String(total % 60).padStart(2, "0")}`;
  };

  let chart = null;
  if (window.Chart) {
    const muted = "#82828c";
    chart = new window.Chart($("#focusTimeline"), {
      type: "line",
      data: {
        labels: timelineLabels,
        datasets: [
          { label: "Attention score", data: timelineScores, borderColor: "#00d9ff", borderWidth: 2, tension: 0.35, pointRadius: 0, fill: true, backgroundColor: "rgba(0, 217, 255, 0.08)" },
          { label: "Focus threshold", data: [], borderColor: "#3a3a42", borderWidth: 1, borderDash: [4, 4], pointRadius: 0, fill: false }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        interaction: { mode: "index", intersect: false },
        scales: {
          y: { min: 0, max: 100, ticks: { color: muted, stepSize: 25, callback: (v) => `${v}%` }, grid: { color: "#1c1c20" }, border: { display: false } },
          x: { ticks: { color: muted, maxTicksLimit: 6 }, grid: { display: false }, border: { color: "#222226" } }
        },
        plugins: {
          legend: { labels: { color: "#f4f4f5", boxWidth: 10, boxHeight: 10, usePointStyle: true } },
          tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${Math.round(ctx.parsed.y)}%` } }
        }
      }
    });
  } else {
    $("#timelineEmpty").textContent = "Chart library could not load. Check your internet connection and refresh.";
  }

  function flushBucket() {
    if (!bucket) return;
    const s = bucket.sec;
    timelineLabels.push(`${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`);
    timelineScores.push(Math.round(bucket.sum / bucket.n));
    if (timelineLabels.length > TIMELINE_SECONDS) { timelineLabels.shift(); timelineScores.shift(); }
    $("#timelineEmpty").hidden = true;
    if (chart) {
      chart.data.datasets[1].data = timelineLabels.map(() => 70);
      chart.update("none");
    }
  }

  function addToTimeline(now, score) {
    const sec = Math.floor((now - startedAt) / 1000);
    if (bucket?.sec !== sec) {
      flushBucket();
      bucket = { sec, sum: 0, n: 0 };
    }
    bucket.sum += score;
    bucket.n += 1;
  }

  function resetSession() {
    startedAt = Date.now();
    lastEventAt = 0;
    trackedMs = 0;
    streakStart = null;
    bestStreakMs = 0;
    distractedSince = null;
    lapseActive = false;
    lapses = 0;
    nudgesShown = 0;
    bucket = null;
    lastFocus = null;
    timelineLabels.length = 0;
    timelineScores.length = 0;
    chart?.update("none");
    $("#timelineEmpty").hidden = false;
  }

  function onLapse(state) {
    const onBreak = timer.phase === "break" && timer.running;
    if (!$("#nudgeToggle").checked || Date.now() < snoozeUntil || onBreak) return;
    nudgesShown += 1;
    const task = MICRO_TASKS[Math.floor(Math.random() * MICRO_TASKS.length)];
    const goal = nextGoal();
    showToast({
      icon: "🌱", kind: "nudge",
      title: state === "Away" ? "Looks like you stepped away" : "Let’s gently refocus",
      text: goal ? `${task} Your next step: “${goal}”.` : task,
      actions: [
        { label: "I’m back", primary: true },
        { label: "Snooze 5 min", onClick: () => { snoozeUntil = Date.now() + 5 * 60 * 1000; } }
      ]
    });
    chime();
  }

  function onRefocus() {
    if (!toast.el.hidden && toast.el.dataset.kind === "nudge") {
      showToast({ icon: "🎉", kind: "praise", title: "Welcome back!", text: "Nice job bringing your attention back.", autoHideMs: 2500 });
    }
  }

  window.addEventListener("neurofocus:tracking-started", resetSession);

  window.addEventListener("neurofocus:attention-update", (event) => {
    const reading = event.detail;
    const now = Date.now();
    if (!startedAt) startedAt = now;
    if (lastEventAt) trackedMs += Math.min(now - lastEventAt, 1000);
    lastEventAt = now;
    lastFocus = reading.cumulativeFocus;

    if (reading.state === "Focused") {
      streakStart ??= now;
      distractedSince = null;
      if (lapseActive) {
        lapseActive = false;
        onRefocus();
      }
    } else {
      streakStart = null;
      distractedSince ??= now;
      if (!lapseActive && now - distractedSince >= NUDGE_AFTER_MS) {
        lapseActive = true;
        lapses += 1;
        onLapse(reading.state);
      }
    }
    const streakMs = streakStart ? now - streakStart : 0;
    bestStreakMs = Math.max(bestStreakMs, streakMs);

    stats.live.textContent = `${reading.score}%`;
    stats.liveState.textContent = reading.state === "Away" ? "Face not detected" : reading.state;
    stats.liveState.dataset.state = reading.state;
    stats.focus.textContent = `${reading.cumulativeFocus}%`;
    stats.tracked.textContent = `${clock(trackedMs)} tracked`;
    stats.streak.textContent = clock(streakMs);
    stats.best.textContent = `Best this session: ${clock(bestStreakMs)}`;
    stats.lapses.textContent = String(lapses);
    stats.nudges.textContent = `${nudgesShown} nudge${nudgesShown === 1 ? "" : "s"} shown`;
    addToTimeline(now, reading.score);
  });

  window.addEventListener("neurofocus:tracking-stopped", () => {
    flushBucket();
    bucket = null;
    lastEventAt = 0;
    streakStart = null;
    distractedSince = null;
    lapseActive = false;
    if (toast.el.dataset.kind === "nudge") hideToast();
    stats.live.textContent = "—";
    stats.liveState.textContent = "Tracking stopped";
    stats.liveState.dataset.state = "";
    stats.streak.textContent = "0:00";
    if (trackedMs >= 10000 && lastFocus !== null) {
      showToast({
        icon: "📈", kind: "timer", title: "Session summary",
        text: `${lastFocus}% focus over ${clock(trackedMs)} · best streak ${clock(bestStreakMs)} · ${lapses} lapse${lapses === 1 ? "" : "s"}.`,
        autoHideMs: 9000
      });
    }
  });

  // ---------- Saved attention history (Supabase) ----------
  // While tracking, one sample is kept per 5 seconds (average score + dominant state) and
  // saved every 10 seconds together with the session summary. Numbers only, never video.
  const SAMPLE_MS = 5000;
  const SAVE_EVERY_MS = 10000;
  // A saved session belongs to a class (and that class's live session) only while the student
  // shares with it (student-classes.js); otherwise it is personal history that teachers can't see.
  // The database refuses class-linked history outside an open live session.
  const saved = { sessionId: null, creating: null, classId: null, classSessionId: null, pending: [], window: null, scoreSum: 0, scoreCount: 0, off: false, timer: null, trackedBase: 0, lapseBase: 0 };
  const historyStatus = $("#historyStatus");
  const setHistoryStatus = (text, isError = false) => {
    historyStatus.textContent = text;
    historyStatus.dataset.state = isError ? "error" : "";
  };
  const missingTables = (error) => error && (error.code === "PGRST205" || error.code === "42P01" || /attention_sessions|attention_samples/.test(error.message || ""));
  const SETUP_HINT = "History isn’t being saved yet: run the Phase 2 database update (see README).";

  function startSavedSession() {
    window.clearInterval(saved.timer);
    Object.assign(saved, { sessionId: null, pending: [], window: null, scoreSum: 0, scoreCount: 0, off: false, trackedBase: trackedMs, lapseBase: lapses });
    saved.classId = window.neuroFocusSharingClassId || null;
    saved.classSessionId = saved.classId ? window.neuroFocusSharingSessionId || null : null;
    const insert = (row) => app.supabase.from("attention_sessions").insert(row).select("id").single();
    saved.creating = insert({ class_id: saved.classId, class_session_id: saved.classSessionId })
      .then(async (result) => {
        // Before the live-workflow database update there is no class_session_id column.
        if (result.error && /class_session_id/.test(result.error.message || "")) result = await insert({ class_id: saved.classId });
        // Not allowed to share (the session just ended, or the teacher removed this student):
        // keep the history, but as personal history.
        if (result.error && saved.classId && (result.error.code === "42501" || /row-level security/i.test(result.error.message || ""))) {
          saved.classId = null;
          saved.classSessionId = null;
          result = await insert({ class_id: null });
        }
        return result;
      })
      .then(({ data, error }) => {
        if (error) throw error;
        saved.sessionId = data.id;
        setHistoryStatus("Recording this session. It appears here when you stop tracking.");
        return data.id;
      })
      .catch((error) => {
        saved.off = true;
        setHistoryStatus(missingTables(error) ? SETUP_HINT : "This session couldn’t be saved. Check your connection.", true);
        console.warn("Could not start a saved attention session", error);
        return null;
      });
    saved.timer = window.setInterval(() => { void saveProgress(); }, SAVE_EVERY_MS);
  }

  function closeSampleWindow() {
    const w = saved.window;
    saved.window = null;
    if (!w?.n) return;
    const state = Object.entries(w.states).sort((a, b) => b[1] - a[1])[0][0];
    saved.pending.push({ recorded_at: new Date(w.end).toISOString(), score: Math.round(w.sum / w.n), state });
    if (saved.pending.length > 720) saved.pending.splice(0, saved.pending.length - 720);
  }

  function recordSample(now, reading) {
    if (!saved.creating || saved.off) return;
    saved.scoreSum += reading.score;
    saved.scoreCount += 1;
    saved.window ??= { start: now, end: now, sum: 0, n: 0, states: { Focused: 0, Distracted: 0, Away: 0 } };
    const w = saved.window;
    w.sum += reading.score;
    w.n += 1;
    w.end = now;
    if (w.states[reading.state] !== undefined) w.states[reading.state] += 1;
    if (now - w.start >= SAMPLE_MS) closeSampleWindow();
  }

  async function saveProgress(final = false) {
    if (!saved.creating || saved.off) return;
    if (final) closeSampleWindow();
    const sessionId = saved.sessionId ?? await saved.creating;
    if (!sessionId) return;
    const rows = saved.pending.splice(0).map((row) => ({ ...row, session_id: sessionId, class_id: saved.classId }));
    if (rows.length) {
      const { error } = await app.supabase.from("attention_samples").insert(rows);
      if (error) {
        saved.pending.unshift(...rows.map(({ recorded_at, score, state }) => ({ recorded_at, score, state })));
        setHistoryStatus("Couldn’t save the latest readings. Retrying…", true);
        return;
      }
    }
    const { error } = await app.supabase.from("attention_sessions").update({
      last_seen_at: new Date().toISOString(),
      tracked_seconds: Math.min(86400, Math.round((trackedMs - saved.trackedBase) / 1000)),
      average_score: saved.scoreCount ? Math.round(saved.scoreSum / saved.scoreCount) : null,
      focus_percent: lastFocus,
      lapses: lapses - saved.lapseBase,
      best_streak_seconds: Math.min(86400, Math.round(bestStreakMs / 1000)),
      ...(final ? { ended_at: new Date().toISOString() } : {})
    }).eq("id", sessionId);
    if (error) setHistoryStatus("Couldn’t update the session summary. Retrying…", true);
    else setHistoryStatus(final ? "Latest session saved." : "Recording this session. It appears here when you stop tracking.");
  }

  window.addEventListener("neurofocus:tracking-started", startSavedSession);
  // Joining or leaving a live session mid-tracking closes this saved session and starts a new one.
  window.addEventListener("neurofocus:sharing-change", async (event) => {
    const next = event.detail?.classId || null;
    const nextSession = event.detail?.sessionId || null;
    if (!saved.creating || saved.off || (next === saved.classId && nextSession === saved.classSessionId)) return;
    window.clearInterval(saved.timer);
    await saveProgress(true);
    startSavedSession();
    // The finished part (e.g. a live session that just ended) shows in Focus history right away.
    window.dispatchEvent(new CustomEvent("neurofocus:history-saved"));
  });
  window.addEventListener("neurofocus:attention-update", (event) => recordSample(Date.now(), event.detail));
  window.addEventListener("neurofocus:tracking-stopped", async () => {
    window.clearInterval(saved.timer);
    await saveProgress(true);
    saved.creating = null;
    // student-history.js reloads the Focus history view.
    window.dispatchEvent(new CustomEvent("neurofocus:history-saved"));
  });

  // ---------- Study assistant quick prompts ----------
  document.querySelectorAll("[data-tutor-prompt]").forEach((chip) => {
    chip.addEventListener("click", () => {
      const input = $("#tutorPrompt");
      input.value = chip.dataset.tutorPrompt;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
  });
}
