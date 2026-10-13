// Student focus tools: live attention stats, focus timeline, ADHD-friendly focus
// timer, gentle re-engagement nudges, and micro-goals. Reads the
// "neurofocus:attention-update" events published by eye-analyzer.js. The timer state and
// micro-goals are also shared with the Home view (student-dashboard.js).
import { themeColor, withAlpha } from "../shared/appearance.js?v=1";
import { showSessionSummary } from "./session-summary.js?v=1";
import {
  createSessionAccumulator, createSampleWindow, normalizeReading, describeReading, LEGACY_SAMPLE_STATES, missingQualityColumns
} from "../shared/tracking-states.js?v=1";

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
    renderNextStep();
    window.dispatchEvent(new CustomEvent("neurofocus:goals-change", { detail: goalsApi.list() }));
  }

  // The first step not done yet, in the session panel, so it stays in view during a focus block.
  function renderNextStep() {
    const next = goals.find((goal) => !goal.done);
    const allDone = goals.length > 0 && !next;
    $("#timerNext").dataset.empty = String(!next);
    $("#timerNextText").textContent = next?.text || (allDone ? "All steps done. Add another, or take a break." : "Add a small step to keep it in view");
    $("#timerNextText").title = next?.text || "";
    $("#timerNextDone").hidden = !next;
    $("#timerNextAdd").hidden = Boolean(next);
    $("#timerNextDone").setAttribute("aria-label", next ? `Mark “${next.text}” done` : "Mark this step done");
  }

  // Today's plan on the Home view lists, ticks off and adds the same steps.
  const goalsApi = {
    list: () => goals.map(({ id, text, done }) => ({ id, text, done })),
    add(text) {
      const clean = String(text || "").trim().slice(0, 120);
      if (!clean) return false;
      goals.push({ id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, text: clean, done: false });
      saveGoals();
      renderGoals();
      return true;
    },
    setDone(id, done) {
      const goal = goals.find((item) => item.id === id);
      if (!goal) return;
      goal.done = Boolean(done);
      saveGoals();
      renderGoals();
    },
    remove(id) {
      const before = goals.length;
      goals = goals.filter((item) => item.id !== id);
      if (goals.length === before) return;
      saveGoals();
      renderGoals();
    }
  };
  window.neuroFocusGoals = goalsApi;

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
  $("#timerNextAdd").addEventListener("click", (event) => {
    event.preventDefault();
    $("#micro-goals").scrollIntoView({ behavior: "smooth", block: "center" });
    $("#goalInput").focus({ preventScroll: true });
  });
  $("#timerNextDone").addEventListener("click", () => {
    const next = goals.find((goal) => !goal.done);
    if (next) goalsApi.setDone(next.id, true);
    if (goals.length && goals.every((goal) => goal.done)) {
      showToast({ icon: "🏆", kind: "praise", title: "All steps done!", text: "Great work finishing your plan. Take a moment to celebrate.", autoHideMs: 4000 });
    }
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
  const presetButtons = document.querySelectorAll("[data-timer-preset]");
  let trackingOn = false;
  // An intentional break: the timer's break phase once started (running or paused). The tracker
  // (eye-analyzer.js) marks readings as "break" meanwhile, so they don't count and no nudges show.
  const isOnBreak = () => timer.phase === "break" && (timer.running || timer.remaining < timer.total);
  // The solo timer is personal: its break never touches a class session's tracking. While the
  // camera serves a class's live session, readings stay measured and reach the teacher as usual.
  const inClassSession = () => Boolean(window.neuroFocusClassContext?.().joinedClassId);
  window.neuroFocusBreakActive = () => isOnBreak() && !inClassSession();

  // The state pill at the top of the Focus session page and the tracker card's outline.
  function renderSessionState() {
    const hero = $("#focusHero");
    if (!hero) return;
    const onBreak = isOnBreak();
    // The camera may be running for a class's live session; Solo focus doesn't claim that tracking.
    const soloTracking = trackingOn && !window.neuroFocusClassContext?.().joinedClassId;
    const state = onBreak ? "break" : soloTracking ? "tracking" : timer.running ? "timer" : "idle";
    hero.dataset.state = state;
    $("#focusStateTag").textContent = { idle: "Ready", tracking: "Tracking", timer: "Timer on", break: "Break" }[state];
    $("#focusStateText").textContent = trackingOn && !soloTracking ? "Camera in use by your class session"
      : onBreak ? (trackingOn ? "Camera on · rest your eyes" : "Stand up, stretch, drink some water")
      : trackingOn ? "Camera on · only numbers are kept"
      : timer.running ? "Camera off · timer running"
      : "Camera off";
    $("#focus-session")?.setAttribute("data-tracking", String(trackingOn));
  }

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
    presetButtons.forEach((button) => {
      const chosen = button.dataset.timerPreset === $("#timerPreset").value;
      button.setAttribute("aria-checked", String(chosen));
      button.tabIndex = chosen ? 0 : -1;
    });
    saveTimer();
    window.neuroFocusOnBreak = window.neuroFocusBreakActive();
    renderSessionState();
    // The header's focus pill and the Home view show the timer from any page.
    window.neuroFocusTimerState = { phase: timer.phase, remaining: timer.remaining, total: timer.total, running: timer.running, rounds: timer.rounds };
    window.dispatchEvent(new CustomEvent("neurofocus:timer-change", { detail: window.neuroFocusTimerState }));
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
      if (!restoring && timer.phase === "focus" && $("#timerWithTracking").checked && !window.neuroFocusClassContext?.().joinedClassId) {
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

  // The length buttons set the hidden #timerPreset list, which Home's focus coach also reads and sets.
  presetButtons.forEach((button) => button.addEventListener("click", () => {
    const select = $("#timerPreset");
    if (select.value === button.dataset.timerPreset) return;
    select.value = button.dataset.timerPreset;
    select.dispatchEvent(new Event("change"));
  }));
  // Arrow keys move between the length buttons, like a radio group.
  $("#timerPresetButtons")?.addEventListener("keydown", (event) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (!step) return;
    event.preventDefault();
    const list = [...presetButtons];
    const next = list[(list.findIndex((button) => button.getAttribute("aria-checked") === "true") + step + list.length) % list.length];
    next.click();
    next.focus();
  });

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

  // The teacher ended the live session this camera session was part of (student-classes.js): the
  // camera turns off, which saves the session, and its summary opens (session-summary.js). The
  // solo timer is separate and keeps its state.
  let summaryFor = null; // the class whose ended session gets a summary once the camera stops
  window.addEventListener("neurofocus:end-focus-session", (event) => {
    summaryFor = event.detail || {};
    window.dispatchEvent(new CustomEvent("neurofocus:stop-camera"));
    // If the camera had already stopped, there's no session left to summarise.
    window.setTimeout(() => { if (!trackingOn) summaryFor = null; }, 3000);
  });

  // ---------- Live attention stats, nudges and timeline ----------
  // The numbers follow scripts/shared/tracking-states.js. Only usable readings count towards the
  // estimated score, on-screen share and looking-away count. Time when tracking was unavailable,
  // or the student was on a break, is kept separately and shown as gaps on the timeline.
  const stats = {
    live: $("#statLiveScore"), liveState: $("#statLiveState"), focus: $("#statSessionFocus"), tracked: $("#statTracked"),
    streak: $("#statStreak"), best: $("#statBestStreak"), lapses: $("#statLapses"), nudges: $("#statNudges"),
    liveTile: $("#liveScoreTile"), liveMeter: $("#statLiveMeter"), focusMeter: $("#statFocusMeter")
  };
  const timelineLabels = [];
  const timelineScores = [];
  let session = createSessionAccumulator({ lookAwayMs: NUDGE_AFTER_MS });
  let startedAt = 0;
  let nudgesShown = 0;
  let snoozeUntil = 0;
  let bucket = null;        // this second's usable scores: { sec, sum, n }
  let lastBucketSec = -1;

  const clock = (ms) => {
    const total = Math.floor(ms / 1000);
    const minutes = Math.floor(total / 60);
    return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}:${String(total % 60).padStart(2, "0")}`;
  };

  let chart = null;
  // Chart colours come from the student's theme (styles/student.css) and follow theme changes.
  function paintTimeline() {
    if (!chart) return;
    const accent = themeColor("--accent", "#00d9ff");
    const muted = themeColor("--text-muted");
    const [score, threshold] = chart.data.datasets;
    score.borderColor = accent;
    score.backgroundColor = withAlpha(accent, 0.1);
    threshold.borderColor = themeColor("--border-hover", "#3a3a42");
    chart.options.scales.y.ticks.color = muted;
    chart.options.scales.x.ticks.color = muted;
    chart.options.scales.y.grid.color = themeColor("--surface-hover", "#1c1c20");
    chart.options.scales.x.border.color = themeColor("--border", "#222226");
    chart.update("none");
  }
  if (window.Chart) {
    chart = new window.Chart($("#focusTimeline"), {
      type: "line",
      data: {
        labels: timelineLabels,
        datasets: [
          // Seconds with no usable reading are null: drawn as a gap, never as 0.
          { label: "Attention", data: timelineScores, borderWidth: 2, tension: 0.35, pointRadius: 0, fill: true, spanGaps: false },
          { label: "70%", data: [], borderWidth: 1, borderDash: [4, 4], pointRadius: 0, fill: false }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        interaction: { mode: "index", intersect: false },
        scales: {
          y: { min: 0, max: 100, ticks: { stepSize: 25, callback: (v) => `${v}%` }, grid: {}, border: { display: false } },
          x: { ticks: { maxTicksLimit: 6 }, grid: { display: false }, border: {} }
        },
        plugins: {
          legend: { display: false },
          tooltip: { filter: (item) => item.datasetIndex === 0 && item.parsed.y !== null, callbacks: { label: (ctx) => `${ctx.dataset.label}: ${Math.round(ctx.parsed.y)}%` } }
        }
      }
    });
    paintTimeline();
    window.addEventListener("neurofocus:appearance-change", paintTimeline);
    // The timeline lives in the Focus session view and may be drawn while that view is hidden:
    // size it to its box whenever the view is shown.
    window.addEventListener("neurofocus:viewchange", (event) => {
      if (event.detail?.name === "focus" || event.detail?.name === "class") window.requestAnimationFrame(() => chart?.resize());
    });
  } else {
    $("#timelineEmpty").textContent = "Chart library could not load. Check your internet connection and refresh.";
  }

  function pushTimeline(sec, value) {
    timelineLabels.push(`${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`);
    timelineScores.push(value);
    if (timelineLabels.length > TIMELINE_SECONDS) { timelineLabels.shift(); timelineScores.shift(); }
  }

  function flushBucket() {
    if (!bucket) return;
    // Seconds with no reading at all (the page was in the background, say) are gaps too.
    for (let sec = Math.max(lastBucketSec + 1, bucket.sec - TIMELINE_SECONDS); sec < bucket.sec; sec += 1) pushTimeline(sec, null);
    pushTimeline(bucket.sec, bucket.n ? Math.round(bucket.sum / bucket.n) : null);
    lastBucketSec = bucket.sec;
    bucket = null;
    $("#timelineEmpty").hidden = true;
    if (chart) {
      chart.data.datasets[1].data = timelineLabels.map(() => 70);
      chart.update("none");
    }
  }

  function addToTimeline(now, reading) {
    const sec = Math.floor((now - startedAt) / 1000);
    if (bucket && bucket.sec !== sec) flushBucket();
    bucket ??= { sec, sum: 0, n: 0 };
    if (reading.tracking === "active") {
      bucket.sum += reading.score;
      bucket.n += 1;
    }
  }

  function resetSession() {
    session = createSessionAccumulator({ lookAwayMs: NUDGE_AFTER_MS });
    startedAt = Date.now();
    nudgesShown = 0;
    bucket = null;
    lastBucketSec = -1;
    timelineLabels.length = 0;
    timelineScores.length = 0;
    stats.focusMeter.style.width = "0%";
    chart?.update("none");
    $("#timelineEmpty").hidden = false;
    window.neuroFocusSessionStats = null;
  }

  // A gentle nudge only when the tracker estimates the student has looked away for a few seconds
  // while it could measure. Never because tracking is unavailable, and never during a break.
  function onLookingAway() {
    if (!$("#nudgeToggle").checked || Date.now() < snoozeUntil || window.neuroFocusBreakActive()) return;
    nudgesShown += 1;
    const task = MICRO_TASKS[Math.floor(Math.random() * MICRO_TASKS.length)];
    const goal = nextGoal();
    showToast({
      icon: "🌱", kind: "nudge",
      title: "Looked away for a bit?",
      text: `If you were reading notes or thinking, carry on. Otherwise: ${task}${goal ? ` Your next step: “${goal}”.` : ""}`,
      actions: [
        { label: "I’m back", primary: true },
        { label: "Snooze 5 min", onClick: () => { snoozeUntil = Date.now() + 5 * 60 * 1000; } }
      ]
    });
    chime();
  }

  function onReturned() {
    if (!toast.el.hidden && toast.el.dataset.kind === "nudge") {
      showToast({ icon: "🎉", kind: "praise", title: "Welcome back!", text: "Nice job bringing your attention back.", autoHideMs: 2500 });
    }
  }

  function renderStats(now) {
    const snap = session.snapshot(now);
    window.neuroFocusSessionStats = snap;
    const reading = snap.reading;
    const described = describeReading(reading);
    const active = reading.tracking === "active";
    stats.live.textContent = active ? `${reading.score}%` : "—";
    stats.liveState.textContent = active ? described.label : described.detail ? `${described.label} · ${described.detail}` : described.label;
    const tileState = active ? (reading.engagement === "looking-away" ? "Distracted" : "Focused") : reading.tracking === "break" ? "Break" : "Unavailable";
    stats.liveState.dataset.state = tileState;
    stats.liveTile.dataset.state = tileState;
    stats.liveMeter.style.width = active ? `${reading.score}%` : "0%";
    stats.focus.textContent = snap.focusPercent === null ? "—" : `${snap.focusPercent}%`;
    stats.focusMeter.style.width = `${snap.focusPercent || 0}%`;
    stats.tracked.textContent = [
      `${clock(snap.usableMs)} measured`,
      snap.unavailableMs >= 1000 ? `${clock(snap.unavailableMs)} unavailable` : "",
      snap.breakMs >= 1000 ? `${clock(snap.breakMs)} break` : ""
    ].filter(Boolean).join(" · ");
    stats.streak.textContent = clock(snap.streakMs);
    stats.best.textContent = `Best this session: ${clock(snap.bestStreakMs)}`;
    stats.lapses.textContent = String(snap.episodes);
    stats.nudges.textContent = `${nudgesShown} nudge${nudgesShown === 1 ? "" : "s"} shown`;
  }

  window.addEventListener("neurofocus:tracking-started", () => {
    resetSession();
    trackingOn = true;
    renderSessionState();
  });

  // The tiles, tracker and timeline moved between Solo focus and a class page (student-classes.js,
  // only while the camera is off): clear them, so neither page shows the other session's readings.
  function clearLiveDisplay() {
    resetSession();
    stats.live.textContent = "—";
    stats.liveState.textContent = "Start tracking to begin";
    stats.liveState.dataset.state = "";
    stats.liveTile.dataset.state = "";
    stats.liveMeter.style.width = "0%";
    stats.focus.textContent = "—";
    stats.tracked.textContent = "0:00 measured";
    stats.streak.textContent = "0:00";
    stats.best.textContent = "Best this session: 0:00";
    stats.lapses.textContent = "0";
    stats.nudges.textContent = "0 nudges shown";
    if (toast.el.dataset.kind === "nudge") hideToast();
    renderSessionState();
  }
  window.addEventListener("neurofocus:tracker-moved", clearLiveDisplay);

  window.addEventListener("neurofocus:attention-update", (event) => {
    const now = Date.now();
    if (!startedAt) startedAt = now;
    const reading = normalizeReading(event.detail);
    const { episodeStarted, returned } = session.add(reading, now);
    if (episodeStarted) onLookingAway();
    if (returned) onReturned();
    // A reminder never stays up once tracking can't measure, or a break starts.
    if (reading.tracking !== "active" && toast.el.dataset.kind === "nudge") hideToast();
    addToTimeline(now, reading);
    renderStats(now);
  });

  window.addEventListener("neurofocus:tracking-stopped", () => {
    const now = Date.now();
    flushBucket();
    const snap = session.snapshot(now);
    if (toast.el.dataset.kind === "nudge") hideToast();
    stats.live.textContent = "—";
    stats.liveState.textContent = "Camera off";
    stats.liveState.dataset.state = "";
    stats.liveTile.dataset.state = "";
    stats.liveMeter.style.width = "0%";
    stats.streak.textContent = "0:00";
    trackingOn = false;
    renderSessionState();
    if (snap.totalMs >= 10000 && !summaryFor) {
      const extra = [
        snap.unavailableMs >= 1000 ? `${clock(snap.unavailableMs)} unavailable` : "",
        snap.breakMs >= 1000 ? `${clock(snap.breakMs)} break` : ""
      ].filter(Boolean).join(" · ");
      showToast({
        icon: "📈", kind: "timer", title: "Session summary",
        text: snap.focusPercent === null
          ? `Not enough tracking to measure your attention (${clock(snap.usableMs)} measured${extra ? ` · ${extra}` : ""}). Check that your face is in view and well lit.`
          : `${snap.focusPercent}% of the time looking at the screen · ${clock(snap.usableMs)} measured${extra ? ` · ${extra}` : ""} · ${snap.episodes} look-away${snap.episodes === 1 ? "" : "s"}.`,
        autoHideMs: 9000
      });
    }
  });

  // ---------- Saved attention history (Supabase) ----------
  // While tracking, one sample is kept per 5 seconds and saved every 10 seconds together with the
  // session summary. Numbers only, never video. Samples and summaries follow tracking-states.js:
  // unavailable or break time is saved as such (no score), never as a score of 0.
  // Before the tracking-quality database update (supabase/migrations/20261009000000_tracking_quality.sql)
  // the database can't hold that: unavailable and break samples are then left out (gaps), and the
  // summary's tracked time is the usable time, so its focus figure still means the same thing.
  //
  // Each saved record is a "part" with its own state: a whole tracking session, or the piece of it
  // shared with one class's live session. Saves run one at a time (a queue), so two saves never
  // overlap, and a part's final numbers are taken the moment it ends, so a later session can't
  // change them. window.neuroFocusSavesDone() resolves once everything queued is saved.
  const SAMPLE_MS = 5000;
  const SAVE_EVERY_MS = 10000;
  const MAX_PENDING = 720; // an hour of samples kept while offline
  let part = null;            // the part being recorded now
  let saveQueue = Promise.resolve();
  let legacySession = false;  // the database doesn't have the tracking-quality columns yet
  let legacySamples = false;  // ... or doesn't accept unavailable/break samples yet
  const historyStatus = $("#historyStatus");
  const setHistoryStatus = (text, isError = false) => {
    historyStatus.textContent = text;
    historyStatus.dataset.state = isError ? "error" : "";
  };
  const missingTables = (error) => error && (error.code === "PGRST205" || error.code === "42P01" || /attention_sessions|attention_samples/.test(error.message || ""));
  const refusedSample = (error) => error && (error.code === "23514" || error.code === "23502" || /check constraint|null value/i.test(error.message || ""));
  const SETUP_HINT = "History isn’t being saved yet: run the Phase 2 database update (see README).";
  const OFFLINE_TEXT = "You’re offline. Readings are kept on this device and saved when you’re back online.";

  // Runs a save after every save already queued.
  function enqueue(task) {
    saveQueue = saveQueue.then(task).catch((error) => console.warn("Saving attention history failed", error));
    return saveQueue;
  }
  window.neuroFocusSavesDone = () => saveQueue;

  async function insertSession(row) {
    const full = legacySession ? row : { ...row, tracking_version: 2 };
    let result = await app.supabase.from("attention_sessions").insert(full).select("id").single();
    if (!legacySession && missingQualityColumns(result.error)) {
      legacySession = true;
      result = await app.supabase.from("attention_sessions").insert(row).select("id").single();
    }
    return result;
  }

  // A saved part belongs to a class (and that class's live session) only while the student shares
  // with it (student-classes.js); otherwise it is personal history that teachers can't see.
  // The database refuses class-linked history outside an open live session.
  function startPart() {
    const p = {
      sessionId: null, creating: null, pending: [], history: [], window: createSampleWindow(), off: false, timer: null, ended: false,
      base: session.snapshot(Date.now()), scoreSum: 0, scoreCount: 0, bestStreakMs: 0, startedAt: Date.now(), final: null,
      classId: window.neuroFocusSharingClassId || null
    };
    p.classSessionId = p.classId ? window.neuroFocusSharingSessionId || null : null;
    // The record is created after any earlier part has finished saving.
    p.creating = saveQueue.then(async () => {
      let result = await insertSession({ class_id: p.classId, class_session_id: p.classSessionId });
      // Before the live-workflow database update there is no class_session_id column.
      if (result.error && /class_session_id/.test(result.error.message || "")) result = await insertSession({ class_id: p.classId });
      // Not allowed to share (the session just ended, or the teacher removed this student):
      // keep the history, but as personal history.
      if (result.error && p.classId && (result.error.code === "42501" || /row-level security/i.test(result.error.message || ""))) {
        p.classId = null;
        p.classSessionId = null;
        result = await insertSession({ class_id: null });
      }
      if (result.error) throw result.error;
      p.sessionId = result.data.id;
      if (!p.ended) setHistoryStatus("Recording this session. It appears here when you stop tracking.");
      return p.sessionId;
    }).catch((error) => {
      p.off = true;
      setHistoryStatus(missingTables(error) ? SETUP_HINT : navigator.onLine === false ? "You’re offline, so this session couldn’t be saved." : "This session couldn’t be saved. Check your connection.", true);
      console.warn("Could not start a saved attention session", error);
      return null;
    });
    p.timer = window.setInterval(() => { if (!p.ended) enqueue(() => saveProgress(p)); }, SAVE_EVERY_MS);
    part = p;
    return p;
  }

  // Ends a part: its last sample and final numbers are fixed now, then the final save is queued.
  // The last part shared with each class, for the summary when its teacher ends the session: the
  // end can reach this page after sharing has already stopped (a short personal part started then).
  const lastClassPart = new Map();
  function endPart(p) {
    if (!p || p.ended) return saveQueue;
    p.ended = true;
    window.clearInterval(p.timer);
    closeSampleWindow(p);
    p.final = partSummary(p, Date.now());
    if (p.classId) lastClassPart.set(p.classId, p);
    if (part === p) part = null;
    return enqueue(() => saveProgress(p)).then(() => {
      // student-history.js reloads My progress.
      window.dispatchEvent(new CustomEvent("neurofocus:history-saved"));
    });
  }

  function closeSampleWindow(p) {
    const row = p.window.close();
    if (!row) return;
    // Every sample of this part, for the end-of-session summary's chart (kept on this page only).
    p.history.push({ at: row.recorded_at, score: row.score });
    if (p.history.length > 1440) p.history.shift();
    p.pending.push(row);
    if (p.pending.length > MAX_PENDING) p.pending.splice(0, p.pending.length - MAX_PENDING);
  }

  function recordSample(now, raw) {
    const p = part;
    if (!p || p.off || p.ended) return;
    const reading = normalizeReading(raw);
    if (reading.tracking === "active") {
      p.scoreSum += reading.score;
      p.scoreCount += 1;
    }
    p.bestStreakMs = Math.max(p.bestStreakMs, session.snapshot(now).streakMs);
    p.window.add(reading, now);
    if (now - p.window.start >= SAMPLE_MS) closeSampleWindow(p);
  }

  // A part's numbers: the session's numbers since the part started.
  function partSummary(p, now) {
    const snap = session.snapshot(now);
    const base = p.base || { usableMs: 0, unavailableMs: 0, breakMs: 0, onScreenMs: 0, episodes: 0 };
    const usableMs = Math.max(0, snap.usableMs - base.usableMs);
    const onScreenMs = Math.max(0, snap.onScreenMs - base.onScreenMs);
    return {
      totalMs: Math.max(0, now - p.startedAt),
      usableMs,
      unavailableMs: Math.max(0, snap.unavailableMs - base.unavailableMs),
      breakMs: Math.max(0, snap.breakMs - base.breakMs),
      focusPercent: usableMs >= 10000 ? Math.round((onScreenMs / usableMs) * 100) : null,
      episodes: Math.max(0, snap.episodes - base.episodes),
      averageScore: p.scoreCount ? Math.round(p.scoreSum / p.scoreCount) : null,
      bestStreakMs: p.bestStreakMs,
      endedAt: new Date(now).toISOString()
    };
  }

  async function insertSamples(rows) {
    const usable = legacySamples ? rows.filter((row) => LEGACY_SAMPLE_STATES.has(row.state) && row.score !== null) : rows;
    if (!usable.length) return null;
    const { error } = await app.supabase.from("attention_samples").insert(usable);
    if (error && !legacySamples && refusedSample(error)) {
      legacySamples = true;
      return insertSamples(rows);
    }
    return error;
  }

  // One save of one part (always run through the queue).
  async function saveProgress(p) {
    if (!p || p.off) return;
    const sessionId = p.sessionId ?? await p.creating;
    if (!sessionId) return;
    const rows = p.pending.splice(0).map((row) => ({ ...row, session_id: sessionId, class_id: p.classId }));
    if (rows.length) {
      const error = await insertSamples(rows);
      if (error) {
        p.pending.unshift(...rows.map(({ recorded_at, score, state }) => ({ recorded_at, score, state })));
        setHistoryStatus(navigator.onLine === false ? OFFLINE_TEXT : "Couldn’t save the latest readings. Retrying…", true);
        if (p.ended) window.setTimeout(() => enqueue(() => saveProgress(p)), SAVE_EVERY_MS); // keep trying the final save
        return;
      }
    }
    const numbers = p.final || partSummary(p, Date.now());
    const seconds = (ms) => Math.min(86400, Math.round(ms / 1000));
    const summary = {
      last_seen_at: p.final ? p.final.endedAt : new Date().toISOString(),
      average_score: numbers.averageScore,
      focus_percent: numbers.focusPercent,
      lapses: numbers.episodes,
      best_streak_seconds: seconds(numbers.bestStreakMs),
      ...(p.final ? { ended_at: p.final.endedAt } : {})
    };
    const quality = { tracked_seconds: seconds(numbers.totalMs), usable_seconds: seconds(numbers.usableMs), unavailable_seconds: seconds(numbers.unavailableMs), break_seconds: seconds(numbers.breakMs) };
    const update = (fields) => app.supabase.from("attention_sessions").update(fields).eq("id", sessionId);
    let { error } = await update(legacySession ? { ...summary, tracked_seconds: seconds(numbers.usableMs) } : { ...summary, ...quality });
    if (error && !legacySession && missingQualityColumns(error)) {
      legacySession = true;
      ({ error } = await update({ ...summary, tracked_seconds: seconds(numbers.usableMs) }));
    }
    if (error) {
      setHistoryStatus(navigator.onLine === false ? OFFLINE_TEXT : "Couldn’t update the session summary. Retrying…", true);
      if (p.ended) window.setTimeout(() => enqueue(() => saveProgress(p)), SAVE_EVERY_MS);
    } else if (p.final) {
      p.saved = true;
      if (!part) setHistoryStatus("Latest session saved.");
    } else setHistoryStatus("Recording this session. It appears here when you stop tracking.");
  }

  // A saved session that hasn't finished yet: the one this page is recording right now, or one
  // still being saved from another tab or device (progress is saved every 10 seconds, so it was
  // updated in the last 90). My progress (student-history.js) and Home leave these out of history.
  window.neuroFocusSessionInProgress = (row) => !row.ended_at && (
    (part !== null && row.id === part.sessionId)
    || Date.now() - new Date(row.last_seen_at || row.started_at) < 90000
  );

  window.addEventListener("neurofocus:tracking-started", () => { startPart(); });
  // Joining or leaving a live session mid-tracking ends this part and starts a new one.
  window.addEventListener("neurofocus:sharing-change", (event) => {
    const next = event.detail?.classId || null;
    const nextSession = event.detail?.sessionId || null;
    if (!part || part.off || (next === part.classId && nextSession === part.classSessionId)) return;
    endPart(part);
    startPart();
  });
  window.addEventListener("neurofocus:attention-update", (event) => recordSample(Date.now(), event.detail));
  // The camera stopped: the part's final numbers are fixed right away (synchronously), then saved.
  // When the teacher ended the session, its summary opens.
  window.addEventListener("neurofocus:tracking-stopped", () => {
    const ended = part;
    endPart(part);
    const request = summaryFor;
    summaryFor = null;
    if (!request) return;
    // The part shared with that class (it may have ended a moment earlier, when sharing stopped).
    const recent = lastClassPart.get(request.classId);
    const classPart = ended?.classId === request.classId ? ended
      : recent && Date.now() - new Date(recent.final.endedAt).getTime() < 120000 ? recent : null;
    if (!classPart?.final) return;
    lastClassPart.delete(request.classId);
    const numbers = classPart.final;
    showSessionSummary({
      ...request,
      startedAt: classPart.startedAt,
      endedAt: numbers.endedAt,
      totalMs: numbers.totalMs,
      usableMs: numbers.usableMs,
      unavailableMs: numbers.unavailableMs,
      focusPercent: numbers.focusPercent,
      averageScore: numbers.averageScore,
      bestStreakMs: numbers.bestStreakMs,
      episodes: numbers.episodes,
      samples: classPart.history
    });
  });
  // Back online: save what was kept meanwhile.
  window.addEventListener("online", () => { if (part) enqueue(() => saveProgress(part)); });
  window.addEventListener("offline", () => { if (part) setHistoryStatus(OFFLINE_TEXT, true); });

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
