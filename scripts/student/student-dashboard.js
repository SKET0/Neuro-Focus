// Home: the student's landing page after signing in, kept simple. A welcome with one main action
// chosen from real data (join a live class → continue studying → start a focus session), three
// small charts (focus score, this week, streak), Today (their own steps and any live class), Jump
// back in (latest note, chat and session) and one Focus coach tip.
// Nothing is made up: no timetable or deadlines are connected, so only live sessions, the
// student's own steps, notes, chats and saved sessions are shown. Live scores are in Focus
// session and saved history in My progress. The camera is never started from here without a click.
//
// Data comes from the other student modules: classes and live sessions (student-classes.js,
// "neurofocus:class-status"), the timer and steps (student-focus.js) and the profile
// (student-profile.js). Notes and the latest saved session are read here.

import { buildCoaching, averageFocus, focusedSeconds, sum, levelFor } from "./focus-analysis.js?v=3";
import { paintAvatar, greetingName } from "../shared/avatars.js?v=1";
import { selectWithQuality } from "../shared/tracking-states.js?v=1";
import { notify } from "../shared/class-live.js?v=9";
import { latestChat } from "./buddy-store.js?v=1";
import { classColor } from "./class-colors.js?v=1";

const app = await window.neuroFocusReady;

if (app) {
  const { supabase } = app;
  const $ = (selector) => document.querySelector(selector);
  const RECENT_NOTE_DAYS = 14;

  let classStatus = window.neuroFocusClassStatus || { loaded: false, classes: [] };
  let timerState = window.neuroFocusTimerState || null;
  let goals = window.neuroFocusGoals?.list() || [];
  let tracking = false;
  let recentNotes = null; // null while loading
  let lastSession = null;
  let savedSessions = null; // finished saved sessions, newest first (null while loading)
  let sessionsFailed = false;
  let extrasLoadedAt = 0;

  // ---------- Small helpers ----------
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const icon = (id, className = "") => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    if (className) svg.setAttribute("class", className);
    svg.setAttribute("aria-hidden", "true");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", `#${id}`);
    svg.append(use);
    return svg;
  };
  const chipIcon = (id, tone = "") => {
    const chip = el("span", `chip-icon${tone ? ` ${tone}` : ""}`);
    chip.append(icon(id));
    return chip;
  };
  const button = (label, className, onClick, iconId) => {
    const node = el("button", className);
    node.type = "button";
    if (iconId) node.append(icon(iconId, "icon"));
    node.append(label);
    if (onClick) node.addEventListener("click", onClick);
    return node;
  };
  const liveDot = () => {
    const dot = el("span", "live-dot static");
    dot.setAttribute("aria-hidden", "true");
    return dot;
  };
  const clockTime = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "");
  const mmss = (seconds) => `${Math.floor(Math.max(0, seconds) / 60)}:${String(Math.max(0, seconds) % 60).padStart(2, "0")}`;
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  function relativeTime(iso) {
    const date = new Date(iso);
    const seconds = (Date.now() - date) / 1000;
    if (seconds < 60) return "just now";
    if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
    if (date.toDateString() === new Date().toDateString()) return `today at ${clockTime(iso)}`;
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    if (date.toDateString() === yesterday.toDateString()) return `yesterday at ${clockTime(iso)}`;
    return date.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  }
  const classNameOf = (id) => (id ? classStatus.classes?.find((item) => item.id === id)?.name || (window.neuroFocusClasses || []).find((item) => item.id === id)?.name || "Former class" : "Personal");
  const actions = () => window.neuroFocusClassActions || {};

  // Open another view, then run something there (e.g. fill in NeuroBuddy's question box).
  function goThen(hash, then) {
    if (then) window.addEventListener("neurofocus:viewchange", () => then(), { once: true });
    window.neuroFocusNavigate?.(hash);
  }
  const openNote = (id) => goThen("notes", () => window.dispatchEvent(new CustomEvent("neurofocus:open-note", { detail: { id } })));
  const openClassNotes = (classId) => goThen("notes", () => window.dispatchEvent(new CustomEvent("neurofocus:notes-filter", { detail: { classId } })));
  function askBuddy(text, send, classId) {
    const deliver = () => window.dispatchEvent(new CustomEvent("neurofocus:buddy-prompt", { detail: { text, send, ...(classId !== undefined ? { classId } : {}) } }));
    if (window.neuroFocusView === "buddy") deliver();
    else goThen("buddy", deliver);
  }

  // Re-render a section only when what it shows has changed, and keep keyboard focus in place.
  const lastKeys = new Map();
  function renderIfChanged(name, key, container, build) {
    if (lastKeys.get(name) === key) return false;
    lastKeys.set(name, key);
    const focusKey = container.contains(document.activeElement) ? document.activeElement.dataset.focusKey : null;
    build();
    if (focusKey) container.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`)?.focus();
    return true;
  }

  // ---------- Welcome ----------
  function renderGreeting() {
    const hour = new Date().getHours();
    const greeting = hour < 5 ? "Hello" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
    const name = el("span", "gradient-name", greetingName(app.profile.display_name));
    $("#welcomeTitle").replaceChildren(`${greeting}, `, name);
    const isNew = classStatus.loaded && !classStatus.error && !(classStatus.classes || []).length;
    $("#heroLead").textContent = isNew
      ? "Welcome! Join your first class, or try a short focus session on your own."
      : "Here’s what’s next. Go at your own pace.";
  }

  // ---------- The one main action ----------
  function chooseNext() {
    const classes = classStatus.classes || [];
    const inSession = classes.find((item) => item.inSession);
    if (inSession) return { kind: "in-session", item: inSession };
    const live = classes.filter((item) => item.live && !item.removed && !item.blocked);
    const pick = live.find((item) => item.id === classStatus.currentId) || live[0];
    if (pick) return { kind: "live", item: pick, more: live.length - 1 };
    if (tracking) return { kind: "tracking" };
    // A new student's most useful step is joining their first class.
    if (classStatus.loaded && !classStatus.error && !classes.length) return { kind: "join-first" };
    const note = (recentNotes || []).find((item) => Date.now() - new Date(item.updated_at) < RECENT_NOTE_DAYS * 86400000);
    if (note) return { kind: "continue", note };
    if (!classStatus.loaded || recentNotes === null) return { kind: "loading" };
    return { kind: "start" };
  }

  function renderNext() {
    const next = chooseNext();
    const card = $("#nextAction");
    const key = JSON.stringify([next.kind, next.item?.id, next.item?.since, next.item?.name, next.more, next.note?.id, next.note?.title, next.note?.updated_at]);
    renderIfChanged("next", key, card, () => {
      const kicker = $("#nextKicker");
      const title = $("#nextTitle");
      const sub = $("#nextSub");
      const buttons = $("#nextButtons");
      kicker.replaceChildren();
      buttons.replaceChildren();
      card.dataset.kind = next.kind;
      card.setAttribute("aria-busy", String(next.kind === "loading"));
      const setIcon = (id) => $("#nextIcon").replaceChildren(icon(id));

      if (next.kind === "in-session") {
        setIcon("i-eye");
        kicker.append(liveDot(), "You’re in a live session");
        title.textContent = next.item.name;
        sub.textContent = "Your teacher sees your attention score, never your video. Keep Live focus open while class is on.";
        buttons.append(
          button("Back to Live focus", "btn-primary", () => { window.location.hash = `class/${next.item.id}/live`; }, "i-video"),
          button("Leave session", "btn-action", () => actions().leaveSession?.())
        );
      } else if (next.kind === "live") {
        setIcon("i-video");
        kicker.append(liveDot(), next.item.since ? `Live now · started ${clockTime(next.item.since)}` : "Live now");
        title.textContent = `${next.item.name} is live`;
        sub.textContent = `${next.item.teacherName ? `${next.item.teacherName} started` : "Your teacher started"} a live session. Joining turns on your attention tracker and shares your focus score, never your video.${next.more > 0 ? ` ${plural(next.more, "other class")} also live.` : ""}`;
        buttons.append(button("Join live class", "btn-join", () => actions().joinSession?.(next.item.id), "i-video"));
      } else if (next.kind === "tracking") {
        setIcon("i-eye");
        kicker.textContent = "Focus session in progress";
        title.textContent = "You’re tracking your focus";
        sub.textContent = "Your camera is on for attention tracking. Video never leaves this device.";
        buttons.append(button("Open Solo focus", "btn-primary", () => window.neuroFocusNavigate?.("focus"), "i-timer"));
      } else if (next.kind === "join-first") {
        setIcon("i-school");
        kicker.textContent = "Get started";
        title.textContent = "Join your first class";
        sub.textContent = "Ask your teacher for a join code. You’ll see your class’s posts, assignments, quizzes and live sessions. Solo focus, notes and NeuroBuddy work on your own too.";
        buttons.append(button("Join a class", "btn-primary", () => actions().openJoinDialog?.(), "i-plus"));
      } else if (next.kind === "continue") {
        setIcon("i-note");
        kicker.textContent = "Continue studying";
        title.textContent = next.note.title?.trim() || "Untitled note";
        sub.textContent = `Your note in ${classNameOf(next.note.class_id)}, last edited ${relativeTime(next.note.updated_at)}.`;
        buttons.append(button("Continue studying", "btn-primary", () => openNote(next.note.id), "i-note"));
      } else if (next.kind === "start") {
        setIcon("i-timer");
        kicker.textContent = "Ready when you are";
        title.textContent = "Start a focus session";
        sub.textContent = "Work in a short focus block with a break after. Your camera turns on only when you press start, and video never leaves this device.";
        const start = button("Start a focus session", "btn-primary", null, "i-play");
        start.dataset.startFocus = ""; // handled by student-ui.js
        buttons.append(start);
      } else {
        setIcon("i-spark");
        kicker.textContent = "Up next";
        title.textContent = "Getting your study space ready…";
        sub.textContent = "";
        buttons.append(el("span", "next-skeleton"), el("span", "next-skeleton short"));
      }
      // A gentle settle when the action changes (not on first paint, and never for reduced motion).
      if (lastKeys.size > 1 && next.kind !== "loading") {
        card.classList.remove("is-updating");
        void card.offsetWidth;
        card.classList.add("is-updating");
      }
    });
  }

  // ---------- Today's plan ----------
  const timerActive = () => Boolean(timerState && (timerState.running || timerState.remaining < timerState.total));
  function timerLine() {
    if (!timerState) return "";
    const phase = timerState.phase === "break" ? "break" : "focus block";
    return timerState.running ? `${mmss(timerState.remaining)} left in this ${phase}` : `Paused with ${mmss(timerState.remaining)} left in this ${phase}`;
  }

  // Today: live classes (one line each) and the student's own steps as a checklist.
  function renderPlan() {
    const list = $("#planList");
    const classes = classStatus.classes || [];
    const live = classes.filter((item) => item.live && !item.blocked && !item.removed);
    const key = JSON.stringify([classStatus.loaded, live.map((item) => [item.id, item.name, item.inSession]), goals]);
    renderIfChanged("plan", key, list, () => {
      const items = [];
      live.forEach((item) => {
        const row = el("li", "today-live");
        row.dataset.in = String(Boolean(item.inSession));
        const text = el("span", "today-live-text");
        const words = el("span");
        words.append(el("b", "", item.name), item.inSession ? " · you’re in" : " is live");
        text.append(liveDot(), words);
        row.append(text);
        if (item.inSession) {
          const open = el("a", "btn-action today-live-action", "Open");
          open.href = `#class/${item.id}/live`;
          open.dataset.focusKey = `live-${item.id}`;
          row.append(open);
        } else {
          const join = button("Join", "btn-join today-live-action", () => actions().joinSession?.(item.id));
          join.dataset.focusKey = `join-${item.id}`;
          join.setAttribute("aria-label", `Join the live session in ${item.name}`);
          row.append(join);
        }
        items.push(row);
      });
      goals.forEach((goal) => {
        const row = el("li", "today-step");
        row.dataset.done = String(goal.done);
        const label = el("label");
        const box = el("input");
        box.type = "checkbox";
        box.checked = goal.done;
        box.dataset.focusKey = `goal-${goal.id}`;
        box.addEventListener("change", () => window.neuroFocusGoals?.setDone(goal.id, box.checked));
        label.append(box, el("span", "", goal.text));
        const remove = el("button", "today-remove", "×");
        remove.type = "button";
        remove.dataset.focusKey = `remove-${goal.id}`;
        remove.setAttribute("aria-label", `Remove “${goal.text}”`);
        remove.addEventListener("click", () => { window.neuroFocusGoals?.remove?.(goal.id); $("#planAddInput").focus(); });
        row.append(label, remove);
        items.push(row);
      });
      if (!items.length) items.push(el("li", "today-empty", "Nothing planned yet. Add one small step below."));
      list.replaceChildren(...items);

      const done = goals.filter((goal) => goal.done).length;
      const count = $("#planCount");
      count.hidden = !goals.length;
      count.textContent = `${done} of ${goals.length} done`;
      const meter = $("#planMeter");
      meter.hidden = !goals.length;
      meter.firstElementChild.style.width = `${goals.length ? Math.round((done / goals.length) * 100) : 0}%`;
    });
  }

  $("#planAddForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const input = $("#planAddInput");
    if (!input.value.trim()) {
      input.focus();
      return;
    }
    if (window.neuroFocusGoals?.add(input.value)) input.value = "";
    input.focus();
  });

  // ---------- Your classes ----------
  function renderClasses() {
    const grid = $("#homeClassGrid");
    if (!grid) return; // classes are listed on the Classes page
    const classes = classStatus.classes || [];
    const key = JSON.stringify([classStatus.loaded, classStatus.error, classStatus.currentId,
      classes.map((item) => [item.id, item.name, item.teacherName, item.teacherAvatar, item.live, item.since, item.online, item.removed, item.inSession])]);
    renderIfChanged("classes", key, grid, () => {
      if (!classStatus.loaded) {
        grid.replaceChildren(el("p", "empty-state", "Loading your classes…"));
        return;
      }
      if (classStatus.error) {
        grid.replaceChildren(el("p", "empty-state", "Couldn’t load your classes. Check your connection, then refresh the page."));
        return;
      }
      if (!classes.length) {
        const empty = el("div", "welcome-empty");
        const join = button("Join your first class", "btn-primary", () => actions().openJoinDialog?.(), "i-plus");
        join.dataset.focusKey = "join-first";
        empty.append(
          chipIcon("i-school"),
          el("b", "", "You haven’t joined a class yet"),
          el("p", "", "Ask your teacher for a join code. Once you join, your classes show up here, and you’ll get a notice when your teacher goes live. The focus timer, notes and NeuroBuddy work on your own too."),
          join
        );
        grid.replaceChildren(empty);
        return;
      }
      grid.replaceChildren(...classes.map((item) => {
        const card = el("article", "home-class-card");
        card.style.setProperty("--class-color", classColor(item.id));
        card.dataset.live = String(item.live && !item.removed);
        if (item.id === classStatus.currentId) card.setAttribute("aria-current", "true");
        const top = el("div", "class-card-top");
        const tile = el("span", "class-tile", ([...item.name.trim()][0] || "C").toUpperCase());
        tile.setAttribute("aria-hidden", "true");
        const name = el("div", "class-card-name");
        name.append(el("h3", "", item.name));
        top.append(tile, name);
        // The class's teacher, with their picture or built-in avatar.
        const teacher = el("div", "class-teacher");
        if (item.teacherName) {
          const face = el("span", "nf-avatar sm");
          paintAvatar(face, { name: item.teacherName, preset: item.teacherAvatar?.preset, url: item.teacherAvatar?.url });
          const who = el("span", "class-teacher-name");
          who.append(el("b", "", item.teacherName), el("small", "", "Teacher"));
          teacher.append(face, who);
        }

        const chip = el("span", "class-chip");
        if (item.inSession) { chip.dataset.state = "in-session"; chip.textContent = "You’re in the live session"; }
        else if (item.live && item.removed) { chip.dataset.state = "removed"; chip.textContent = "Live · you were removed from it"; }
        else if (item.live) { chip.dataset.state = "live"; chip.textContent = item.since ? `Live now · since ${clockTime(item.since)}` : "Live now"; }
        else if (item.blocked) { chip.textContent = "Live sessions unavailable"; }
        else if (item.online) { chip.dataset.state = "online"; chip.textContent = "Teacher online · not live"; }
        else chip.textContent = "No live session";

        const row = el("div", "class-card-actions");
        if (item.live && !item.removed && !item.inSession) {
          const join = button("Join live class", "btn-join", () => actions().joinSession?.(item.id));
          join.dataset.focusKey = `join-${item.id}`;
          join.setAttribute("aria-label", `Join the live session in ${item.name}`);
          row.append(join);
        }
        if (item.id === classStatus.currentId) {
          row.append(el("span", "current-tag", "✓ Working in this class"));
        } else {
          const work = button("Open class", "btn-action", () => { window.location.hash = `class/${item.id}`; });
          work.dataset.focusKey = `work-${item.id}`;
          work.setAttribute("aria-label", `Work in ${item.name}`);
          row.append(work);
        }
        const notes = button("Notes", "btn-action", () => openClassNotes(item.id), "i-note");
        notes.dataset.focusKey = `notes-${item.id}`;
        notes.setAttribute("aria-label", `Notes for ${item.name}`);
        row.append(notes);
        card.append(top, ...(item.teacherName ? [teacher] : []), chip, row);
        return card;
      }));
    });
  }

  // ---------- Continue where you left off ----------
  // The latest NeuroBuddy chat on this device (buddy-store.js).
  const lastChat = () => latestChat(app.user.id);

  // Jump back in: at most three things, one short line each.
  function renderContinue() {
    const list = $("#continueList");
    const chat = lastChat();
    const note = (recentNotes || [])[0] || null;
    const key = JSON.stringify([note, chat, lastSession, recentNotes === null, classStatus.classes?.map((item) => item.name)]);
    renderIfChanged("continue", key, list, () => {
      const items = [];
      const tile = ({ iconId, tone, kind, title, meta, onClick, href, focusKey }) => {
        const item = el("li");
        const node = el(href ? "a" : "button", "jump-item");
        if (href) node.href = href;
        else node.type = "button";
        node.dataset.focusKey = focusKey;
        const text = el("span", "jump-text");
        text.append(el("small", "jump-kind", kind), el("b", "", title), el("span", "jump-meta", meta));
        node.append(chipIcon(iconId, tone), text, icon("i-chevron", "chevron"));
        if (onClick) node.addEventListener("click", onClick);
        item.append(node);
        items.push(item);
      };
      if (note) tile({ iconId: "i-note", kind: "Note", title: note.title?.trim() || "Untitled note", meta: `${classNameOf(note.class_id)} · ${relativeTime(note.updated_at)}`, onClick: () => openNote(note.id), focusKey: `note-${note.id}` });
      if (chat) tile({ iconId: "i-buddy", tone: "green", kind: "NeuroBuddy", title: chat.title, meta: relativeTime(chat.updatedAt),
        onClick: () => goThen("buddy", () => window.dispatchEvent(new CustomEvent("neurofocus:buddy-open", { detail: { id: chat.id } }))), focusKey: "chat" });
      if (lastSession) {
        const minutes = Math.max(1, Math.round(lastSession.tracked_seconds / 60));
        const focus = lastSession.focus_percent === null || lastSession.focus_percent === undefined ? "" : ` · ${lastSession.focus_percent}% focus`;
        tile({ iconId: "i-history", tone: "amber", kind: "Focus session", title: `${minutes} min${focus}`, meta: relativeTime(lastSession.started_at), href: "#progress", focusKey: "session" });
      }
      if (!items.length) items.push(el("li", "today-empty", recentNotes === null ? "Loading…" : "Nothing yet. Your notes, chats and sessions will show up here."));
      list.replaceChildren(...items);
    });
  }

  // Notes and the latest saved session, read when Home opens (at most every 20 seconds).
  async function loadExtras({ force = false } = {}) {
    if (!force && Date.now() - extrasLoadedAt < 20000) return;
    extrasLoadedAt = Date.now();
    const [notes, sessions] = await Promise.all([
      supabase.from("student_notes").select("id, title, class_id, updated_at").eq("student_id", app.user.id).order("updated_at", { ascending: false }).limit(3),
      selectWithQuality((quality) => supabase.from("attention_sessions").select(`id, started_at, last_seen_at, ended_at, tracked_seconds, focus_percent, lapses, best_streak_seconds${quality}`).eq("student_id", app.user.id).gt("tracked_seconds", 4).order("started_at", { ascending: false }).limit(60))
    ]);
    recentNotes = notes.error ? [] : notes.data || [];
    // The session being recorded right now isn't saved history yet (student-focus.js decides).
    const inProgress = window.neuroFocusSessionInProgress || ((s) => !s.ended_at);
    sessionsFailed = Boolean(sessions.error);
    savedSessions = sessions.error ? [] : (sessions.data || []).filter((s) => !inProgress(s));
    lastSession = savedSessions[0] || null;
    renderAll();
  }

  // ---------- Focus timer and tracking at a glance (header pill + Focus tools card) ----------
  function renderFocusIndicators() {
    const pill = $("#focusPill");
    const text = $("#focusPillText");
    const toolTimer = $("#toolTimer");
    const toolTracking = $("#toolTracking");
    const running = Boolean(timerState?.running);
    const time = timerState ? mmss(timerState.remaining) : "";
    let state = "idle";
    let label = "Focus";
    if (tracking) {
      state = "tracking";
      label = running ? `Tracking · ${time}` : "Tracking";
    } else if (running) {
      state = timerState.phase === "break" ? "break" : "timer";
      label = `${time} ${timerState.phase === "break" ? "break" : "focus"}`;
    } else if (timerActive()) {
      label = `Paused ${time}`;
    }
    pill.dataset.state = state;
    if (text.textContent !== label) text.textContent = label;
    const spoken = [
      "Focus session",
      tracking ? "attention tracking is on" : "camera off",
      running ? timerLine() : timerActive() ? timerLine() : ""
    ].filter(Boolean).join(", ");
    if (pill.getAttribute("aria-label") !== spoken) pill.setAttribute("aria-label", spoken);

    const timerValue = $("#glanceTimerValue");
    if (timerValue && timerState && timerValue.textContent !== mmss(timerState.remaining)) timerValue.textContent = mmss(timerState.remaining);
    $("#glanceTimer")?.setAttribute("data-state", running ? (timerState.phase === "break" ? "break" : "running") : timerActive() ? "paused" : "idle");
    if (toolTimer) {
      const line = timerActive()
        ? (running ? (timerState.phase === "break" ? "Break running" : "Focus block running") : "Paused")
        : `Ready · ${timerState ? Math.round(timerState.total / 60) : 25}-minute blocks`;
      if (toolTimer.textContent !== line) toolTimer.textContent = line;
    }
    if (toolTracking) {
      toolTracking.textContent = tracking ? "Tracking on · video stays on this device" : "Camera off until you start tracking";
      toolTracking.dataset.state = tracking ? "on" : "";
    }
  }

  // ---------- NeuroBuddy entry ----------
  $("#buddyEntryForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const input = $("#buddyEntryInput");
    const text = input.value.trim();
    if (!text) {
      input.focus();
      return;
    }
    input.value = "";
    askBuddy(text, true);
  });
  document.querySelectorAll("[data-buddy-starter]").forEach((chip) => {
    chip.addEventListener("click", () => askBuddy(chip.dataset.buddyStarter, false));
  });

  // ---------- Wiring ----------
  // ---------- Focus coach ----------
  // What's going well and what to try next, from the student's saved sessions and what they have
  // set up right now (focus-analysis.js). Each tip's button uses the controls that already exist.
  const nudgeToggle = $("#nudgeToggle");
  const timerPreset = $("#timerPreset");
  const habits = () => ({
    nudgesOn: Boolean(nudgeToggle?.checked),
    stepsPlanned: goals.some((goal) => !goal.done),
    timerPreset: timerPreset?.value || "25-5"
  });

  function runCoachAction(action) {
    if (action.kind === "preset") {
      // Changing the length resets the timer, so a running block is never cut short from here.
      if (timerActive()) {
        notify({ title: "Your timer is running", text: "Change the block length in the timer when this block is done.", kind: "info" });
      } else if (timerPreset) {
        timerPreset.value = action.value;
        timerPreset.dispatchEvent(new Event("change"));
        notify({ title: `Timer set to ${timerPreset.selectedOptions[0]?.textContent || action.value}`, text: "Start a focus block whenever you’re ready.", kind: "success" });
      }
      window.neuroFocusNavigate?.("focus-timer");
    } else if (action.kind === "nudges" && nudgeToggle) {
      nudgeToggle.checked = true;
      nudgeToggle.dispatchEvent(new Event("change")); // saved like any other setting (student-focus.js)
      notify({ title: "Re-engagement nudges are on", text: "You’ll get a gentle prompt if your attention drifts while tracking.", kind: "success" });
    } else if (action.kind === "step") {
      const input = $("#planAddInput");
      input.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" });
      input.focus({ preventScroll: true });
    }
  }

  // One tip at a time (most useful first, "Next tip" for the others), what it's based on, a single
  // "going well" line and the way to more in My progress.
  let coachIndex = 0;
  let coachTips = [];
  function showCoachTip() {
    const tip = coachTips[coachIndex];
    const iconBox = $("#coachIcon");
    iconBox.replaceChildren(icon(tip?.icon || "i-spark"));
    iconBox.dataset.tone = tip?.tone || "";
    $("#coachTipTitle").textContent = tip?.title || "Nothing to change right now";
    $("#coachTipText").textContent = tip?.text || "Keep going the way you are.";
    const basis = $("#coachTipBasis");
    basis.textContent = tip?.basis || "";
    basis.hidden = !tip?.basis;
    const actionsBox = $("#coachActions");
    actionsBox.replaceChildren();
    if (tip?.action) {
      const starts = tip.action.kind === "start";
      const action = button(tip.action.label, "btn-primary", starts ? null : () => runCoachAction(tip.action), starts ? "i-play" : null);
      if (starts) action.dataset.startFocus = ""; // handled by student-ui.js
      action.dataset.focusKey = "coach-action";
      actionsBox.append(action);
    }
    if (coachTips.length > 1) {
      const next = button(`Next tip · ${coachIndex + 1}/${coachTips.length}`, "btn-action coach-next", () => {
        coachIndex = (coachIndex + 1) % coachTips.length;
        showCoachTip();
        $("#focus-coach .coach-next")?.focus();
      });
      next.dataset.focusKey = "coach-next";
      actionsBox.append(next);
    }
    const more = el("a", "text-link", "More in My progress");
    more.href = "#progress";
    actionsBox.append(more);
  }

  function renderCoach() {
    if (savedSessions === null) return;
    const coaching = sessionsFailed ? null : buildCoaching(savedSessions, habits());
    renderIfChanged("coach", JSON.stringify([coaching, sessionsFailed]), $("#focus-coach"), () => {
      const win = $("#coachWin");
      $("#coachProgress").hidden = true;
      if (!coaching) {
        coachTips = [{ icon: "i-flag", title: "Couldn’t load your sessions", text: "Check your connection, then come back to Home." }];
        coachIndex = 0;
        showCoachTip();
        win.hidden = true;
        return;
      }
      $("#focus-coach").dataset.stage = coaching.stage;
      $("#coachTitle").textContent = coaching.stage === "personal" ? "Focus coach" : "Focus coach · general tips";
      const current = coachTips[coachIndex]?.title;
      coachTips = coaching.tips;
      coachIndex = Math.max(0, coachTips.findIndex((tip) => tip.title === current)); // keep the tip being read
      showCoachTip();
      const good = coaching.wins[0];
      win.hidden = !good;
      win.textContent = good ? `Going well: ${good.title}` : "";
    });
  }
  // My progress shows the same coach and uses these for its buttons (student-history.js).
  window.neuroFocusCoach = { habits, run: runCoachAction };
  nudgeToggle?.addEventListener("change", renderCoach);
  timerPreset?.addEventListener("change", renderCoach);

  // ---------- At a glance: focus score and this week ----------
  // From finished saved sessions only. The score is the estimated share of measured time on screen
  // (the same measure as My progress), weighted by session length.
  const DAY_MS = 86400000;
  const startOfDay = (date) => { const d = new Date(date); d.setHours(0, 0, 0, 0); return d; };
  const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const SCORE_RING = 2 * Math.PI * 50;
  const shortDuration = (seconds) => {
    const minutes = Math.round(seconds / 60);
    return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  };

  // Numbers count up to their new value (instantly for reduced motion).
  function countTo(node, target, format) {
    const from = Number(node.dataset.value || 0);
    node.dataset.value = String(target);
    // No animation for reduced motion, or in a background tab (animation frames don't run there).
    if (reducedMotion() || from === target || document.visibilityState === "hidden") { node.textContent = format(target); return; }
    const started = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - started) / 900);
      const eased = 1 - (1 - t) ** 3;
      node.textContent = format(Math.round(from + (target - from) * eased));
      if (t < 1 && Number(node.dataset.value) === target) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  function renderGlance() {
    if (savedSessions === null) return;
    const today = startOfDay(Date.now());
    const weekStart = today.getTime() - 6 * DAY_MS;
    const thisWeek = savedSessions.filter((s) => new Date(s.started_at) >= weekStart);
    const lastWeek = savedSessions.filter((s) => { const t = new Date(s.started_at); return t >= weekStart - 7 * DAY_MS && t < weekStart; });
    const monthly = savedSessions.filter((s) => Date.now() - new Date(s.started_at) < 30 * DAY_MS);
    const scoreSource = thisWeek.length ? thisWeek : monthly;
    const score = averageFocus(scoreSource);
    const previous = thisWeek.length ? averageFocus(lastWeek) : null;
    const days = Array.from({ length: 7 }, (_, i) => {
      const from = weekStart + i * DAY_MS;
      const items = thisWeek.filter((s) => { const t = new Date(s.started_at).getTime(); return t >= from && t < from + DAY_MS; });
      return { date: new Date(from), seconds: sum(items, focusedSeconds), studied: items.length > 0 };
    });
    let streak = 0;
    const studiedOn = new Set(savedSessions.map((s) => startOfDay(s.started_at).getTime()));
    let cursor = studiedOn.has(today.getTime()) ? today.getTime() : today.getTime() - DAY_MS;
    while (studiedOn.has(cursor)) { streak += 1; cursor -= DAY_MS; }
    const weekFocused = sum(thisWeek, focusedSeconds);
    const lastWeekFocused = sum(lastWeek, focusedSeconds);

    const key = JSON.stringify([score, previous, days.map((d) => Math.round(d.seconds)), streak, sessionsFailed]);
    renderIfChanged("glance", key, $(".glance"), () => {
      // Score ring
      const ring = $("#scoreRing");
      ring.style.strokeDasharray = String(SCORE_RING);
      ring.style.strokeDashoffset = String(SCORE_RING * (1 - (score ?? 0) / 100));
      const value = $("#scoreValue");
      if (score === null) {
        value.textContent = "—";
        value.dataset.value = "0";
        $("#scoreLevel").textContent = sessionsFailed ? "Couldn’t load" : "No score yet";
        $("#scoreNote").textContent = sessionsFailed ? "Check your connection" : "Track a session to see it";
      } else {
        countTo(value, score, (n) => String(n));
        $("#scoreLevel").textContent = levelFor(score).label;
        $(".score-tile").dataset.level = levelFor(score).key;
        const change = previous === null ? null : score - previous;
        $("#scoreNote").textContent = !thisWeek.length ? "Last 30 days"
          : change === null ? "This week"
          : change === 0 ? "Same as last week"
          : `${change > 0 ? "▲" : "▼"} ${Math.abs(change)} vs last week`;
        $("#scoreNote").dataset.trend = change > 0 ? "up" : change < 0 ? "down" : "";
      }

      // Focused this week, with a bar per day
      countTo($("#glanceFocusTime"), Math.round(weekFocused / 60), (n) => shortDuration(n * 60));
      const top = Math.max(...days.map((d) => d.seconds), 60);
      $("#glanceBars").replaceChildren(...days.map((d, i) => {
        const col = el("span", "week-col");
        if (i === 6) col.dataset.today = "true";
        const bar = el("span", "week-bar");
        bar.style.setProperty("--h", `${d.seconds ? Math.max(8, Math.round((d.seconds / top) * 100)) : 0}%`);
        bar.style.setProperty("--i", String(i));
        if (!d.seconds) bar.dataset.empty = "true";
        col.title = `${d.date.toLocaleDateString([], { weekday: "long" })}: ${d.seconds ? `${shortDuration(d.seconds)} focused` : "no sessions"}`;
        col.append(bar, el("small", "", d.date.toLocaleDateString([], { weekday: "narrow" })));
        return col;
      }));
      const delta = Math.round((weekFocused - lastWeekFocused) / 60);
      const focusNote = $("#glanceFocusNote");
      focusNote.textContent = !thisWeek.length || !lastWeek.length ? `${plural(thisWeek.length, "session")}`
        : delta === 0 ? "Same as last week" : `${delta > 0 ? "▲" : "▼"} ${shortDuration(Math.abs(delta) * 60)}`;
      focusNote.dataset.trend = thisWeek.length && lastWeek.length && delta ? (delta > 0 ? "up" : "down") : "";
      focusNote.title = thisWeek.length && lastWeek.length ? "Compared with the 7 days before" : "";

      // Day streak, with the last 7 days as dots
      countTo($("#glanceStreak"), streak, (n) => plural(n, "day"));
      $("#glanceDays").replaceChildren(...days.map((d, i) => {
        const dot = el("span", "glance-day", d.date.toLocaleDateString([], { weekday: "narrow" }));
        dot.dataset.on = String(d.studied);
        dot.style.setProperty("--i", String(i));
        if (i === 6) dot.dataset.today = "true";
        return dot;
      }));
      $("#glanceStreakNote").textContent = streak && !studiedOn.has(today.getTime()) ? "Study today to keep it"
        : streak ? "Keep it going" : "Start one today";
    });
  }

  // A soft spotlight follows the pointer across Home's cards (pointer devices only).
  const homeView = $("#view-dashboard");
  let spotFrame = 0;
  homeView.addEventListener("pointermove", (event) => {
    if (event.pointerType !== "mouse") return;
    const card = event.target.closest(".home-card, .home-hero");
    if (!card) return;
    cancelAnimationFrame(spotFrame);
    spotFrame = requestAnimationFrame(() => {
      const box = card.getBoundingClientRect();
      card.style.setProperty("--mx", `${event.clientX - box.left}px`);
      card.style.setProperty("--my", `${event.clientY - box.top}px`);
    });
  });

  function renderAll() {
    renderGreeting();
    renderNext();
    renderPlan();
    renderClasses();
    renderContinue();
    renderCoach();
    renderGlance();
    renderFocusIndicators();
  }

  window.addEventListener("neurofocus:class-status", (event) => {
    classStatus = event.detail || classStatus;
    renderAll();
  });
  window.addEventListener("neurofocus:timer-change", (event) => {
    timerState = event.detail;
    renderFocusIndicators();
    renderPlan();
    renderContinue();
  });
  window.addEventListener("neurofocus:goals-change", (event) => {
    goals = event.detail || [];
    renderPlan();
    renderCoach();
  });
  window.addEventListener("neurofocus:tracking-started", () => {
    tracking = true;
    renderNext();
    renderFocusIndicators();
  });
  window.addEventListener("neurofocus:tracking-stopped", () => {
    tracking = false;
    renderNext();
    renderFocusIndicators();
  });
  window.addEventListener("neurofocus:profile-updated", renderGreeting);
  window.addEventListener("neurofocus:history-saved", () => { void loadExtras({ force: true }); });
  window.addEventListener("neurofocus:viewchange", (event) => {
    if (event.detail?.name === "dashboard") {
      void loadExtras();
      renderContinue();
    }
  });

  renderAll();
  // Cards settle in once on first load (styles/student.css; skipped for reduced motion).
  if (window.neuroFocusView === "dashboard") {
    const view = $("#view-dashboard");
    view.classList.add("is-entering");
    window.setTimeout(() => view.classList.remove("is-entering"), 900);
  }
  await loadExtras({ force: true });
}
