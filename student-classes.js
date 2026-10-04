// Student classes: class list (sidebar + My Classes), current class banner, joining and
// leaving classes, and live sessions. During a teacher's live session the student's
// attention numbers (never video) stream to that teacher over the private class channel.
import {
  openClassChannel, teacherStatus, confirmAction, notify, showMessage, missingDatabaseUpdates, showSetupBanner, isMissingSql
} from "./class-live.js?v=8";

const app = await window.neuroFocusReady;

if (app) {
  const { supabase } = app;
  const $ = (selector) => document.querySelector(selector);
  const selectedKey = "neuroFocusCurrentClassId";
  const SETUP_TEXT = "Run the Phase 2 database updates first (see README).";

  let classes = [];
  let currentId = "";
  try { currentId = localStorage.getItem(selectedKey) || ""; } catch { /* storage unavailable */ }
  let announcedId;
  let tracking = false;
  let lastSentAt = 0;
  const blockedClasses = new Set(); // classes whose live channel is currently refused
  let sharingClassId = null;       // class whose teacher currently receives this student's scores
  let sharingSessionId = null;     // the live session (class_sessions id) being shared with
  let pendingJoinNotice = null;    // { classId, rejoined } to tell the teacher once connected
  const channels = new Map();      // classId -> { channel, ready, tracked }
  const teacher = new Map();       // classId -> { online, live, since, removed }
  const seenStatus = new Set();    // classes whose first presence sync has arrived
  const removedHandled = new Set();
  const leftClasses = new Set();   // classes this student left on purpose (not a removal)
  const liveNotices = new Map();   // classId -> close() for its "live session" notice
  let membershipTicks = 0;
  const invitePings = new Map();   // classId -> last "please join" ping seen from the teacher
  const myAttendance = new Map();  // classId -> { attended, counted } over finished sessions
  let joinedSessionId = null;      // session the student pressed "Join session" for
  let checkIn = { sessionId: null, timer: null, status: "" };
  const CHECK_IN_MS = 30000;
  const shareToggle = $("#shareToggle");
  const shareStatus = $("#shareStatus");

  const current = () => classes.find((item) => item.id === currentId) || null;
  // Removals announced over the live channel are checked against the database before the
  // student acts on them: presence comes from browsers, so a classmate could fake one.
  const sessionRemovalChecks = new Map(); // sessionId -> "pending" | true | false
  const sessionRemovalShown = new Map();  // classId -> { sessionId, removed } last acted on
  const classRemovalChecks = new Map();   // classId -> time of the last membership check
  const serverRemoved = new Set();         // sessionIds where the attendance check-in said "removed"
  const listedAsRemoved = (status) => Boolean(status?.live && status.sessionRemoved?.includes(app.user.id));
  // Removed from the live session by the teacher (still in the class), confirmed by the database.
  const removedFromSession = (classId) => {
    const status = teacher.get(classId);
    if (!status?.live) return false;
    // The check-in answer from the database is authoritative; presence only speeds things up.
    return serverRemoved.has(status.sessionId) || (listedAsRemoved(status) && sessionRemovalChecks.get(status.sessionId || "local") === true);
  };

  async function checkSessionRemoval(classId, sessionId) {
    const key = sessionId || "local";
    sessionRemovalChecks.set(key, "pending");
    let removed = true; // sessions that aren't saved (attendance SQL not run) can't be checked
    if (sessionId) {
      const { data, error } = await supabase.from("session_attendance")
        .select("removed_at").eq("session_id", sessionId).eq("student_id", app.user.id).maybeSingle();
      if (error && !isMissingSql(error)) { sessionRemovalChecks.delete(key); return; } // try again on the next update
      if (!error) removed = Boolean(data?.removed_at);
    }
    sessionRemovalChecks.set(key, removed);
    const status = teacher.get(classId);
    if (status) showSessionRemoval(classId, status);
    updateSharing();
    render();
  }

  // Tells the student when they're removed from, or let back into, a live session.
  function showSessionRemoval(classId, status) {
    const item = classes.find((entry) => entry.id === classId);
    if (!item) return;
    const removed = removedFromSession(classId);
    const last = sessionRemovalShown.get(classId);
    const before = Boolean(last && last.sessionId === status.sessionId && last.removed);
    sessionRemovalShown.set(classId, { sessionId: status.sessionId, removed });
    if (removed && !before) {
      liveNotices.get(classId)?.();
      liveNotices.delete(classId);
      if (joinedSessionId === status.sessionId) joinedSessionId = null;
      notify({
        title: `You were removed from the live session in ${item.name}`,
        text: "Your focus is no longer shared. You’re still in the class and will be invited to the next session.",
        kind: "error",
        timeoutMs: 15000
      });
    } else if (!removed && before && status.live) {
      // Still tracking in this class: sharing resumes by itself.
      const resumes = classId === currentId && tracking && shareToggle?.checked;
      liveNotices.get(classId)?.();
      liveNotices.set(classId, notify({
        title: resumes ? `You’re back in the session in ${item.name}` : `You can rejoin the session in ${item.name}`,
        text: resumes ? "Your teacher let you back in, so your focus is shared again." : "Your teacher let you back into the live session.",
        kind: "live",
        timeoutMs: 20000,
        actions: resumes ? [] : [{ label: "Join session", primary: true, onClick: () => joinSession(classId) }]
      }));
    }
  }
  const missingSql = (error) => error && (error.code === "42501" || /permission denied/.test(error.message || ""));
  const clock = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "");

  // ---------- Data ----------
  async function loadClasses() {
    const { data, error } = await supabase
      .from("class_members")
      .select("class_id, joined_at, classes(id, name, join_code, teacher_id)")
      .order("joined_at", { ascending: false });
    if (error) throw error;
    const previous = classes;
    classes = (data || []).map((membership) => membership.classes).filter(Boolean);
    // A class that vanished without the student leaving it means the teacher removed them.
    const removedNow = previous.filter((item) => !classes.some((other) => other.id === item.id) && !leftClasses.has(item.id));
    removedNow.forEach((item) => { void handleRemoved(item, { confirmed: true }); });
    if (!classes.some((item) => item.id === currentId)) currentId = classes[0]?.id || "";
    void loadMyAttendance();
    // Other modules (student-notes.js) list every class the student is in.
    window.neuroFocusClasses = classes.map(({ id, name }) => ({ id, name }));
    window.dispatchEvent(new CustomEvent("neurofocus:classlist", { detail: window.neuroFocusClasses }));
    watchChannels();
    selectClass(currentId);
  }

  // The student's own attendance per class (finished sessions only).
  async function loadMyAttendance() {
    const { data, error } = await supabase.from("session_attendance")
      .select("class_id, status, class_sessions(ended_at)")
      .eq("student_id", app.user.id);
    if (error) return;
    myAttendance.clear();
    (data || []).forEach((row) => {
      if (!row.class_sessions?.ended_at || row.status === "excused") return;
      const stats = myAttendance.get(row.class_id) || { attended: 0, counted: 0 };
      stats.counted += 1;
      if (row.status === "present" || row.status === "late") stats.attended += 1;
      myAttendance.set(row.class_id, stats);
    });
    renderCards();
  }

  function selectClass(id) {
    currentId = id || "";
    try {
      if (currentId) localStorage.setItem(selectedKey, currentId);
      else localStorage.removeItem(selectedKey);
    } catch { /* storage unavailable */ }
    if (announcedId !== currentId) {
      announcedId = currentId;
      window.neuroFocusClass = current();
      window.dispatchEvent(new CustomEvent("neurofocus:classchange", { detail: current() }));
    }
    updatePresence();
    updateSharing();
    render();
  }

  // ---------- Realtime ----------
  function watchChannels() {
    const ids = new Set(classes.map((item) => item.id));
    channels.forEach((entry, id) => {
      if (ids.has(id)) return;
      if (entry.channel) supabase.removeChannel(entry.channel);
      channels.delete(id);
      teacher.delete(id);
      seenStatus.delete(id);
    });
    classes.forEach((item) => {
      if (channels.has(item.id)) return;
      const entry = { channel: null, ready: false, tracked: false };
      channels.set(item.id, entry);
      void openClassChannel(supabase, item.id, {
        presenceKey: app.user.id,
        onSync: (state) => onTeacherStatus(item.id, teacherStatus(state, item.teacher_id)),
        onReady: (channel) => {
          entry.channel = channel;
          entry.ready = true;
          entry.tracked = false;
          // Supabase reconnects on its own, e.g. after the database updates are run: clear the warning.
          if (blockedClasses.delete(item.id)) {
            recheckSetup();
            render();
          }
          updatePresence();
          flushJoinNotice();
        },
        onError: () => {
          blockedClasses.add(item.id);
          render();
          void refresh();
        }
      }).then((channel) => {
        entry.channel ??= channel;
        if (!channels.has(item.id)) supabase.removeChannel(channel);
      });
    });
  }

  // "Online" (for the teacher's dots) is announced only in the class the student is working in.
  function updatePresence() {
    channels.forEach((entry, id) => {
      if (!entry.ready || !entry.channel) return;
      if (id === currentId && !entry.tracked) {
        entry.tracked = true;
        void entry.channel.track({ role: "student" });
      } else if (id !== currentId && entry.tracked) {
        entry.tracked = false;
        void entry.channel.untrack();
      }
    });
  }

  function onTeacherStatus(classId, status) {
    const item = classes.find((entry) => entry.id === classId);
    if (!item) return;
    const previous = teacher.get(classId) || { live: false, online: false };
    const firstSync = !seenStatus.has(classId);
    seenStatus.add(classId);
    teacher.set(classId, status);

    if (status.removed.includes(app.user.id)) {
      void handleRemoved(item);
      return;
    }
    const listed = listedAsRemoved(status);
    const removalKey = status.sessionId || "local";
    if (listed && !sessionRemovalChecks.has(removalKey)) void checkSessionRemoval(classId, status.sessionId);
    if (!listed) { // let back in: a later removal is checked again
      sessionRemovalChecks.delete(removalKey);
      serverRemoved.delete(status.sessionId);
    }
    showSessionRemoval(classId, status);
    const sessionRemovedNow = listed;
    const ping = status.live ? status.invites?.[app.user.id] : null;
    const newPing = Boolean(ping && ping !== invitePings.get(classId));
    if (ping) invitePings.set(classId, ping);
    const alreadyIn = classId === currentId && tracking && !sessionRemovedNow;

    if (status.live && previous.live && newPing && !firstSync && !sessionRemovedNow && !alreadyIn) {
      liveNotices.get(classId)?.();
      liveNotices.set(classId, notify({
        title: `Your teacher is inviting you to join ${item.name}`,
        text: "The live session is on. Join to share your focus (never your video).",
        kind: "live",
        timeoutMs: 30000,
        actions: [{ label: "Join session", primary: true, onClick: () => joinSession(classId) }]
      }));
    }

    if (status.live && !previous.live && !sessionRemovedNow) {
      if (!alreadyIn) {
        liveNotices.get(classId)?.();
        liveNotices.set(classId, notify({
          title: firstSync ? `Live session in ${item.name}` : `${item.name} is live now`,
          text: "You’re invited: your teacher started a live session. Join to share your focus (never your video).",
          kind: "live",
          timeoutMs: 20000,
          actions: [{ label: "Join session", primary: true, onClick: () => joinSession(classId) }]
        }));
      }
    } else if (!status.live && previous.live) {
      notify({
        title: status.online ? `Live session ended in ${item.name}` : `Live session paused in ${item.name}`,
        text: status.online ? "Your teacher can no longer see your focus." : "Your teacher’s dashboard disconnected. Sharing resumes if they come back.",
        kind: "info"
      });
    }
    updateSharing();
    render();
  }

  // Removed by the teacher: end the session for this student, turn the camera off and tell them.
  async function handleRemoved(item, { confirmed = false } = {}) {
    if (removedHandled.has(item.id)) return;
    if (!confirmed) {
      // Only act if the membership is really gone (the notice itself could be faked).
      if (Date.now() - (classRemovalChecks.get(item.id) || 0) < 20000) return;
      classRemovalChecks.set(item.id, Date.now());
      const { data, error } = await supabase.from("class_members")
        .select("class_id").eq("class_id", item.id).eq("student_id", app.user.id).maybeSingle();
      if (error || data) return;
      if (removedHandled.has(item.id)) return;
    }
    removedHandled.add(item.id);
    liveNotices.get(item.id)?.();
    liveNotices.delete(item.id);
    const wasCurrent = item.id === currentId;
    const cameraWasOn = wasCurrent && tracking;
    if (sharingClassId === item.id) sendAttention(item.id, { state: "Stopped" });
    if (cameraWasOn) window.dispatchEvent(new CustomEvent("neurofocus:stop-camera"));
    const channelEntry = channels.get(item.id);
    if (channelEntry?.channel) supabase.removeChannel(channelEntry.channel);
    channels.delete(item.id);
    teacher.delete(item.id);
    classes = classes.filter((other) => other.id !== item.id);
    selectClass(classes.some((other) => other.id === currentId) ? currentId : classes[0]?.id || "");
    await showMessage({
      title: `You were removed from ${item.name}`,
      message: (cameraWasOn ? "Your teacher removed you from this class, so the live session has ended for you and your camera has been turned off. " : "Your teacher removed you from this class. ")
        + "Ask your teacher if you think this was a mistake. You can rejoin with a join code if they allow it.",
      buttonLabel: "OK"
    });
    if (!confirmed) await refresh();
  }

  function sendAttention(classId, payload) {
    const entry = channels.get(classId);
    if (!entry?.ready || !entry.channel) return;
    void entry.channel.send({ type: "broadcast", event: "attention", payload: { studentId: app.user.id, ...payload } });
  }

  // Scores go to the teacher only while their live session is on and sharing is allowed.
  // student-focus.js saves attention history linked to this class and live session while sharing.
  function updateSharing() {
    const status = currentId ? teacher.get(currentId) : null;
    const live = Boolean(status?.live) && !removedFromSession(currentId);
    const next = live && shareToggle?.checked ? currentId : null;
    const nextSession = next ? status.sessionId || null : null;
    if (next !== sharingClassId || nextSession !== sharingSessionId) {
      if (sharingClassId && sharingClassId !== next) sendAttention(sharingClassId, { state: "Stopped" });
      sharingClassId = next;
      sharingSessionId = nextSession;
      window.neuroFocusSharingClassId = next;
      window.neuroFocusSharingSessionId = nextSession;
      window.dispatchEvent(new CustomEvent("neurofocus:sharing-change", { detail: { classId: next, sessionId: nextSession } }));
    }
  }

  function flushJoinNotice() {
    if (!pendingJoinNotice) return;
    const entry = channels.get(pendingJoinNotice.classId);
    if (!entry?.ready || !entry.channel) return;
    void entry.channel.send({
      type: "broadcast",
      event: "member-joined",
      payload: { studentId: app.user.id, name: app.profile.display_name, rejoined: pendingJoinNotice.rejoined }
    });
    pendingJoinNotice = null;
  }

  // ---------- Live session actions ----------
  function joinSession(classId) {
    if (!classes.some((item) => item.id === classId)) return;
    if (removedFromSession(classId)) {
      notify({ title: "You can’t join this session", text: "Your teacher removed you from it. Ask them to let you back in.", kind: "error" });
      return;
    }
    joinedSessionId = teacher.get(classId)?.sessionId || null;
    if (classId !== currentId) selectClass(classId);
    if (shareToggle && !shareToggle.checked) {
      shareToggle.checked = true;
      shareToggle.dispatchEvent(new Event("change"));
    }
    window.dispatchEvent(new CustomEvent("neurofocus:start-camera"));
    render(); // checks in for attendance even if the camera is slow to start
    // Show the dashboard view (student-ui.js) with the tracker in sight.
    window.location.hash = "dashboard";
    window.setTimeout(() => document.querySelector("#focus-session")?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  }

  function leaveSession() {
    const stop = $("#stopAnalyzer");
    if (stop && !stop.hidden) stop.click();
  }

  // ---------- Attendance check-in ----------
  // While the student is in a live session (sharing, and tracking or having pressed Join), the
  // database marks them present or late and counts their minutes; repeated every 30 seconds.
  function updateCheckIn() {
    const status = currentId ? teacher.get(currentId) : null;
    const inSession = status?.live && status.sessionId && sharingClassId === currentId
      && (tracking || joinedSessionId === status.sessionId);
    const sessionId = inSession ? status.sessionId : null;
    if (sessionId === checkIn.sessionId) return;
    window.clearInterval(checkIn.timer);
    checkIn = { sessionId, timer: null, status: "" };
    if (!sessionId) return;
    const beat = async () => {
      const { data, error } = await supabase.rpc("check_in_session", { p_session_id: sessionId });
      if (checkIn.sessionId !== sessionId) return;
      if (error) {
        if (isMissingSql(error)) window.clearInterval(checkIn.timer); // attendance SQL not run yet
        return;
      }
      if (data?.removed && !serverRemoved.has(sessionId)) {
        // Removed by the teacher, even if the presence notice never arrived.
        serverRemoved.add(sessionId);
        const status = teacher.get(currentId);
        if (status) showSessionRemoval(currentId, status);
        updateSharing();
        render();
        return;
      }
      if (data?.status && data.status !== checkIn.status) {
        checkIn.status = data.status;
        renderBanner();
      }
    };
    void beat();
    checkIn.timer = window.setInterval(() => { void beat(); }, CHECK_IN_MS);
  }

  // ---------- Rendering ----------
  function render() {
    updateCheckIn();
    renderSidebar();
    renderCards();
    renderBanner();
    updateShareStatus();
  }

  function liveDot() {
    const dot = document.createElement("span");
    dot.className = "live-dot";
    dot.setAttribute("aria-label", "Live session");
    return dot;
  }

  function renderSidebar() {
    const list = $("#sidebarClassList");
    list.replaceChildren();
    if (!classes.length) {
      const empty = document.createElement("p");
      empty.className = "sidebar-empty";
      empty.textContent = "No classes yet.";
      list.append(empty);
      return;
    }
    classes.forEach((item) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "nav-item";
      if (item.id === currentId) button.setAttribute("aria-current", "true");
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = item.name;
      const initial = document.createElement("span");
      initial.className = "class-initial";
      initial.setAttribute("aria-hidden", "true");
      initial.textContent = (item.name.trim()[0] || "C").toUpperCase();
      button.append(initial, name);
      if (teacher.get(item.id)?.live) button.append(liveDot());
      button.addEventListener("click", () => selectClass(item.id));
      list.append(button);
    });
  }

  function renderCards() {
    const grid = $("#studentClassList");
    grid.replaceChildren();
    if (!classes.length) {
      const empty = document.createElement("p");
      empty.className = "empty-state";
      empty.textContent = "You haven’t joined a class yet. Ask your teacher for a join code, then press “Join a class”.";
      grid.append(empty);
      return;
    }
    classes.forEach((item) => {
      const status = teacher.get(item.id);
      const card = document.createElement("article");
      card.className = "my-class-card";
      if (item.id === currentId) card.setAttribute("aria-current", "true");
      const title = document.createElement("h3");
      title.textContent = item.name;
      const code = document.createElement("span");
      code.className = "code";
      code.textContent = item.join_code;
      const state = document.createElement("div");
      state.className = "my-class-status";
      state.dataset.live = String(Boolean(status?.live));
      if (status?.live && removedFromSession(item.id)) state.append(liveDot(), "Live session · you were removed from it");
      else if (status?.live) state.append(liveDot(), `Live session since ${clock(status.since)}`);
      else state.textContent = status?.online ? "Teacher online · no live session" : "No live session";
      const stats = myAttendance.get(item.id);
      const attendanceLine = document.createElement("div");
      attendanceLine.className = "my-class-attendance";
      attendanceLine.textContent = stats?.counted
        ? `Attendance ${Math.round((stats.attended / stats.counted) * 100)}% · ${stats.attended} of ${stats.counted} session${stats.counted === 1 ? "" : "s"}`
        : "Attendance: no finished sessions yet";

      const actions = document.createElement("div");
      actions.className = "my-class-actions";
      if (item.id !== currentId) {
        const open = document.createElement("button");
        open.type = "button";
        open.className = "btn-action";
        open.textContent = "Work in this class";
        open.addEventListener("click", () => selectClass(item.id));
        actions.append(open);
      } else {
        const tag = document.createElement("span");
        tag.className = "my-class-status";
        tag.textContent = "✓ Current class";
        actions.append(tag);
      }
      if (status?.live && !removedFromSession(item.id) && !(item.id === currentId && tracking)) {
        const join = document.createElement("button");
        join.type = "button";
        join.className = "btn-join";
        join.textContent = "Join session";
        join.addEventListener("click", () => joinSession(item.id));
        actions.append(join);
      }
      const leave = document.createElement("button");
      leave.type = "button";
      leave.className = "btn-leave";
      leave.textContent = "Leave";
      leave.setAttribute("aria-label", `Leave ${item.name}`);
      leave.addEventListener("click", () => leaveClass(item));
      actions.append(leave);

      card.append(title, code, state, attendanceLine, actions);
      grid.append(card);
    });
  }

  function bannerButton(label, className, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.textContent = label;
    button.addEventListener("click", onClick);
    return button;
  }

  function renderBanner() {
    const banner = $("#classBanner");
    const kicker = $("#bannerKicker");
    const title = $("#bannerTitle");
    const sub = $("#bannerSub");
    const actions = $("#bannerActions");
    actions.replaceChildren();
    kicker.replaceChildren();
    const item = current();

    if (!item) {
      banner.dataset.state = "";
      kicker.textContent = "Get started";
      title.textContent = "Join your first class";
      sub.textContent = "Ask your teacher for the join code. You can still use the tracker, timer and NeuroBuddy on your own.";
      actions.append(bannerButton("＋ Join a class", "btn-primary", openJoinDialog));
      return;
    }

    title.textContent = item.name;
    const status = teacher.get(item.id);
    if (blockedClasses.has(item.id)) {
      banner.dataset.state = "error";
      kicker.textContent = "Live features unavailable";
      sub.textContent = `Live sessions can’t connect. ${SETUP_TEXT}`;
    } else if (status?.live && removedFromSession(item.id)) {
      banner.dataset.state = "error";
      kicker.textContent = "Removed from this live session";
      sub.textContent = "Your teacher removed you from today’s session, so your focus isn’t shared. You’re still in the class and will be invited to the next session.";
    } else if (status?.live && tracking && shareToggle?.checked) {
      banner.dataset.state = "sharing";
      kicker.append(liveDot(), checkIn.status === "late" ? "You’re in the live session · marked late" : "You’re in the live session");
      sub.textContent = checkIn.status
        ? "Your attendance is recorded. Your teacher sees your attention score, never your video."
        : "Your teacher sees your attention score, never your video.";
      actions.append(bannerButton("Leave session", "btn-action", leaveSession));
    } else if (status?.live) {
      banner.dataset.state = "live";
      kicker.append(liveDot(), `Live session · since ${clock(status.since)}`);
      sub.textContent = tracking && !shareToggle?.checked
        ? "You’re tracking privately. Turn on “Share with my teacher” to join the session."
        : "Your teacher started a live session. Join to share your focus.";
      actions.append(bannerButton("Join session", "btn-join", () => joinSession(item.id)));
    } else {
      banner.dataset.state = "";
      kicker.textContent = "Current class";
      sub.textContent = status?.online
        ? "Your teacher is online but hasn’t started a live session. You’ll get a notification when they do."
        : "No live session right now. You’ll get a notification when your teacher starts one.";
    }
    if (classes.length > 1) {
      actions.append(bannerButton("Switch class", "btn-action", () => {
        window.location.hash = "classes";
      }));
    }
  }

  function updateShareStatus() {
    if (!shareStatus) return;
    const item = current();
    const live = Boolean(item && teacher.get(item.id)?.live);
    let text;
    let state = "";
    if (item && blockedClasses.has(item.id)) text = `Live sharing is unavailable. ${SETUP_TEXT}`;
    else if (!item) text = "Not shared · join a class to share your focus with a teacher.";
    else if (live && removedFromSession(item.id)) text = "Not shared · your teacher removed you from this live session.";
    else if (!shareToggle?.checked) text = "Sharing paused · your teacher can’t see your focus.";
    else if (!live) text = `Private · your teacher in ${item.name} can only see your focus during a live session.`;
    else if (tracking) {
      text = `Live · your teacher in ${item.name} sees your attention score (never your video).`;
      state = "live";
    } else text = `${item.name} is live. Start tracking to share your attention score (never your video).`;
    shareStatus.textContent = text;
    shareStatus.dataset.state = state;
  }

  // ---------- Join / leave ----------
  const joinDialog = $("#joinDialog");
  function openJoinDialog() {
    $("#joinClassForm").reset();
    $("#joinClassMessage").textContent = "";
    joinDialog.showModal();
    $("#joinCode").focus();
  }
  $("#cancelJoin").addEventListener("click", () => joinDialog.close());
  document.querySelectorAll("[data-action='join-class']").forEach((button) => button.addEventListener("click", openJoinDialog));

  $("#joinClassForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const message = $("#joinClassMessage");
    const submit = event.currentTarget.querySelector("button[type='submit']");
    submit.disabled = true;
    message.dataset.state = "";
    message.textContent = "Checking the code…";
    const { data, error } = await supabase.rpc("join_class", {
      p_join_code: $("#joinCode").value.trim(),
      p_join_password: $("#joinPassword").value || null
    });
    submit.disabled = false;
    if (error) {
      message.dataset.state = "error";
      message.textContent = error.message || "Couldn’t join. Check the code and try again.";
      return;
    }
    joinDialog.close();
    removedHandled.delete(data.id);
    leftClasses.delete(data.id);
    pendingJoinNotice = { classId: data.id, rejoined: Boolean(data.rejoined) };
    currentId = data.id;
    await refresh();
    flushJoinNotice();
    notify({
      title: data.rejoined ? `Welcome back to ${data.name}` : `You joined ${data.name}`,
      text: "Your teacher can see you on their class list now.",
      kind: "success"
    });
  });

  async function leaveClass(item) {
    const ok = await confirmAction({
      title: `Leave ${item.name}?`,
      message: "You’ll stop getting its live sessions and lose access to your class notes for it. You can rejoin later with the join code if your teacher allows it.",
      confirmLabel: "Leave class",
      danger: true
    });
    if (!ok) return;
    leftClasses.add(item.id);
    // Tell the teacher first: once the membership is gone this student can't post to the class channel.
    if (sharingClassId === item.id) sendAttention(item.id, { state: "Stopped" });
    void channels.get(item.id)?.channel?.send({
      type: "broadcast", event: "member-left", payload: { studentId: app.user.id, name: app.profile.display_name }
    });
    const { error, count } = await supabase.from("class_members").delete({ count: "exact" })
      .eq("class_id", item.id).eq("student_id", app.user.id);
    if (error || count === 0) {
      leftClasses.delete(item.id);
      notify({ title: "Couldn’t leave the class", text: missingSql(error) || count === 0 ? SETUP_TEXT : error.message, kind: "error", timeoutMs: 9000 });
      return;
    }
    notify({ title: `You left ${item.name}`, kind: "success" });
    await refresh();
  }

  async function refresh() {
    try {
      await loadClasses();
    } catch (error) {
      console.error("Class refresh failed", error);
    }
  }

  // ---------- Tracking ----------
  window.addEventListener("neurofocus:attention-update", (event) => {
    if (!tracking) {
      tracking = true;
      render();
    }
    if (!sharingClassId) return;
    const now = Date.now();
    if (now - lastSentAt < 1000) return;
    lastSentAt = now;
    const { score, state, cumulativeFocus } = event.detail;
    sendAttention(sharingClassId, { score, state, cumulativeFocus });
  });
  window.addEventListener("neurofocus:tracking-stopped", () => {
    tracking = false;
    if (sharingClassId) sendAttention(sharingClassId, { state: "Stopped" });
    render();
  });
  shareToggle?.addEventListener("change", () => {
    updateSharing();
    render();
  });

  const recheckSetup = () => missingDatabaseUpdates(supabase).then((missing) => showSetupBanner(missing)).catch(() => {});

  // Removals, renames and new classes made elsewhere show up when the tab regains focus.
  window.addEventListener("focus", () => {
    void refresh();
    void recheckSetup();
  });
  window.setInterval(() => {
    membershipTicks += 1;
    if (tracking || sharingClassId || membershipTicks % 4 === 0) void refresh();
  }, 15000);
  window.addEventListener("pagehide", () => supabase.removeAllChannels());

  void recheckSetup();
  try {
    await loadClasses();
  } catch (error) {
    console.error("Class loading failed", error);
    $("#studentClassList").replaceChildren(Object.assign(document.createElement("p"), {
      className: "empty-state",
      textContent: "Couldn’t load your classes. Make sure the class database setup has been run, then refresh."
    }));
  }
}
