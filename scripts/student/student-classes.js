// Student classes: class list (sidebar + My Classes), current class banner, joining and
// leaving classes, and live sessions. During a teacher's live session the student's
// attention numbers (never video) stream to that teacher over the private class channel.
import {
  openClassChannel, teacherStatus, confirmAction, notify, showMessage, missingDatabaseUpdates, showSetupBanner, isMissingSql
} from "../shared/class-live.js?v=9";
import { paintAvatar, avatarUrls } from "../shared/avatars.js?v=1";
import { normalizeReading, legacyState } from "../shared/tracking-states.js?v=1";

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
  let lastSentTracking = null;
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
  // The class whose live session the student joined (pressed "Join session"). Only this class's
  // live session ever receives readings or attendance check-ins; Solo focus is never shared.
  let joinedClassId = null;
  let cameraStarting = false;      // Join pressed, camera not running yet
  const lastLiveSession = new Map(); // classId -> key of the live session last seen (sessionId, or "local")
  let focusInSession = null;       // { classId, key } live session the student's focus session is part of
  const teacherNames = new Map();  // classId -> { name, preset, path, url } of the class's teacher (my_class_teachers)
  let teacherNamesFor = "";
  let teacherNamesAt = 0;
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
      const resumes = classId === joinedClassId && tracking && shareToggle?.checked;
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
    void loadTeacherNames();
  }

  // Teacher names and pictures for the class cards, refreshed when the class list changes or every
  // few minutes. Pictures come with the teacher avatars database update (signed links that only the
  // teacher's own students can get); before it, cards show the name with initials, and before the
  // student profiles update, cards leave the teacher out.
  async function loadTeacherNames() {
    const key = classes.map((item) => item.id).sort().join(",");
    if (!key || (key === teacherNamesFor && Date.now() - teacherNamesAt < 180000)) return;
    teacherNamesFor = key;
    teacherNamesAt = Date.now();
    const { data, error } = await supabase.rpc("my_class_teachers");
    if (error) return;
    const urls = await avatarUrls(supabase, (data || []).map((row) => row.teacher_avatar_path).filter(Boolean));
    teacherNames.clear();
    (data || []).forEach((row) => teacherNames.set(row.class_id, {
      name: row.teacher_name, preset: row.teacher_avatar_preset || null, path: row.teacher_avatar_path || null,
      url: urls.get(row.teacher_avatar_path) || null
    }));
    renderCards();
    publishStatus();
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
    publishStatus();
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

  const sessionKey = (status) => status.sessionId || "local";

  // Which live session the student's focus session is part of, so it can end with that session.
  // Kept while the teacher's dashboard is briefly disconnected; cleared when the student stops
  // tracking, stops sharing, switches class or is removed from the session.
  function noteFocusSession() {
    if (!tracking) focusInSession = null;
    else if (sharingClassId) focusInSession = { classId: sharingClassId, key: sharingSessionId || "local" };
    else if (focusInSession && (focusInSession.classId !== joinedClassId || !shareToggle?.checked || removedFromSession(joinedClassId))) focusInSession = null;
  }

  // The teacher ended a live session: end the focus session that was part of it (stop the timer,
  // turn the camera off and save it to My progress) and tell the student. A saved session is
  // checked first: a teacher dashboard opening on another device can briefly look "not live"
  // before it finds the open session, and that must not end anyone's focus session.
  async function endFocusWithSession(item, key) {
    if (joinedSessionId === key) joinedSessionId = null;
    const mine = () => tracking && focusInSession?.classId === item.id && focusInSession.key === key;
    const joined = joinedClassId === item.id;
    if (!mine() && !joined) return;
    if (key !== "local") {
      const { data, error } = await supabase.from("class_sessions").select("ended_at").eq("id", key).maybeSingle();
      if (!error && data && !data.ended_at) return; // still open: the dashboard is just reconnecting
    } else {
      // Sessions aren't saved before the attendance database update: wait a moment instead.
      await new Promise((resolve) => window.setTimeout(resolve, 4000));
      const status = teacher.get(item.id);
      if (status?.live && sessionKey(status) === key) return;
    }
    if (joinedClassId === item.id) {
      joinedClassId = null;
      updateSharing();
      render();
    }
    if (!mine()) return;
    focusInSession = null;
    liveNotices.get(item.id)?.();
    liveNotices.delete(item.id);
    window.dispatchEvent(new CustomEvent("neurofocus:end-focus-session", { detail: { classId: item.id } }));
    notify({
      title: `The live session in ${item.name} has ended`,
      text: "Your teacher ended the session, so your focus session has ended too and your camera is off. It’s saved in My progress.",
      kind: "info",
      timeoutMs: 15000,
      actions: [{ label: "See my progress", onClick: () => window.neuroFocusNavigate?.("progress") }]
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
    // The teacher ended the live session: their dashboard is online and that session is no longer
    // the live one. (A dashboard that disconnected only pauses the session, so nothing ends then.)
    const lastLive = lastLiveSession.get(classId);
    if (status.live) lastLiveSession.set(classId, sessionKey(status));
    else if (status.online) lastLiveSession.delete(classId);
    if (lastLive && status.online && (!status.live || sessionKey(status) !== lastLive)) void endFocusWithSession(item, lastLive);
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
    const alreadyIn = classId === joinedClassId && tracking && !sessionRemovedNow;

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
    } else if (!status.live && previous.live && !(status.online && tracking && focusInSession?.classId === classId)) {
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
    const cameraWasOn = item.id === joinedClassId && tracking;
    if (joinedClassId === item.id) { joinedClassId = null; joinedSessionId = null; }
    if (window.neuroFocusRouteClassId === item.id) window.location.hash = "classes";
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
    const status = joinedClassId ? teacher.get(joinedClassId) : null;
    const live = Boolean(status?.live) && !removedFromSession(joinedClassId);
    const next = live && shareToggle?.checked ? joinedClassId : null;
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
  // The attention tracker card lives in Solo focus, and moves to the class page's Live focus while
  // the student is in that class's live session. It only moves while the camera is off.
  // The live numbers and the timeline go with it, so each page only ever shows its own session's
  // readings; they start blank after a move (student-focus.js clears them on "tracker-moved").
  function placeTracker() {
    const toClass = Boolean(joinedClassId);
    const parts = [
      ["#this-session", toClass ? "#classStatsSlot" : "#soloStatsSlot"],
      ["#focus-session", toClass ? "#classTrackerSlot" : "#solo-tracker"],
      ["#focus-timeline", toClass ? "#classTimelineSlot" : "#soloTimelineSlot"]
    ];
    const card = $("#focus-session");
    if (!card || tracking || cameraStarting || card.parentElement === $(parts[1][1])) return;
    parts.forEach(([part, slot]) => { const node = $(part); const target = $(slot); if (node && target) target.append(node); });
    window.dispatchEvent(new CustomEvent("neurofocus:tracker-moved", { detail: { to: toClass ? "class" : "solo", classId: joinedClassId } }));
  }

  // Waits until the camera has stopped and every save of that session has finished
  // (student-focus.js queues them one at a time), so switching never overlaps two sessions' saves.
  const savesDone = () => (window.neuroFocusSavesDone ? window.neuroFocusSavesDone() : Promise.resolve());
  async function stopCameraAndWait() {
    if (tracking) {
      await new Promise((resolve) => {
        window.addEventListener("neurofocus:tracking-stopped", () => window.setTimeout(resolve, 0), { once: true });
        window.dispatchEvent(new CustomEvent("neurofocus:stop-camera"));
      });
    }
    await savesDone();
  }

  async function joinSession(classId) {
    const item = classes.find((entry) => entry.id === classId);
    if (!item) return;
    if (removedFromSession(classId)) {
      notify({ title: "You can’t join this session", text: "Your teacher removed you from it. Ask them to let you back in.", kind: "error" });
      return;
    }
    // A solo session (or another class's session) is ended and saved first, so it's never shared.
    if (tracking && joinedClassId !== classId) {
      const ok = await confirmAction({
        title: `Join ${item.name}’s live session?`,
        message: joinedClassId
          ? "Your current class session ends first. It’s already saved under that class."
          : "Your solo session ends first and is saved to My progress as Personal. It isn’t shared with your teacher.",
        confirmLabel: "Join session"
      });
      if (!ok) return;
    }
    // Even with no camera running, a session that just stopped may still be saving.
    await stopCameraAndWait();
    joinedClassId = classId;
    joinedSessionId = teacher.get(classId)?.sessionId || null;
    // Any "you're invited, join" notice for this class is done with.
    liveNotices.get(classId)?.();
    liveNotices.delete(classId);
    if (classId !== currentId) selectClass(classId);
    if (shareToggle && !shareToggle.checked) {
      shareToggle.checked = true;
      shareToggle.dispatchEvent(new Event("change"));
    }
    updateSharing();
    placeTracker();
    // Show the class page's Live focus with the tracker in sight (student-ui.js).
    if (window.neuroFocusRouteClassId !== classId) window.location.hash = `class/${classId}`;
    if (!tracking) {
      cameraStarting = true;
      window.dispatchEvent(new CustomEvent("neurofocus:start-camera"));
    }
    render(); // checks in for attendance even if the camera is slow to start
  }

  // Leaving the live session: the camera stops (the session so far is saved under the class) and
  // nothing more is shared. The student stays in the class.
  async function leaveSession() {
    await stopCameraAndWait();
    joinedClassId = null;
    joinedSessionId = null;
    updateSharing();
    render();
  }

  // Before a solo session starts (student-ui.js): if the student is in a class's live session,
  // they confirm leaving it, so nothing from the solo session is shared.
  async function prepareSolo() {
    if (!joinedClassId) { await savesDone(); return true; }
    const item = classes.find((entry) => entry.id === joinedClassId);
    const ok = await confirmAction({
      title: "Start a solo session?",
      message: `You’ll leave ${item?.name || "your class"}’s live session first${tracking ? ", and that session is saved under the class" : ""}. Your solo session stays private.`,
      confirmLabel: "Leave and start solo"
    });
    if (!ok) return false;
    await leaveSession();
    return true;
  }

  // Which session the camera belongs to, for Solo focus and the timer (student-focus.js).
  window.neuroFocusClassContext = () => ({
    joinedClassId,
    name: classes.find((entry) => entry.id === joinedClassId)?.name || "",
    tracking
  });

  // ---------- Attendance check-in ----------
  // While the student is in a live session they joined (camera on or off, sharing on or off), the
  // database marks them present or late and counts their minutes; repeated every 30 seconds.
  function updateCheckIn() {
    // Attendance only needs the student to have joined this live session. It doesn't depend on
    // the camera or on sharing attention: with sharing off they're still present.
    const status = joinedClassId ? teacher.get(joinedClassId) : null;
    const inSession = status?.live && status.sessionId && !removedFromSession(joinedClassId);
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
        const status = teacher.get(joinedClassId);
        if (status) showSessionRemoval(joinedClassId, status);
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
    noteFocusSession();
    updateCheckIn();
    placeTracker();
    renderSidebar();
    renderCards();
    renderClassPage();
    renderBanner();
    renderSoloNotice();
    updateShareStatus();
    publishStatus();
  }

  // The class page's header (#view-class). The page shows the class in the address, which is
  // selected when it opens (it's also where the student appears online to the teacher).
  function renderClassPage() {
    const id = window.neuroFocusRouteClassId;
    if (window.neuroFocusView !== "class" || !id) return;
    const item = classes.find((entry) => entry.id === id);
    if (!item) return;
    $("#classPageTitle").textContent = item.name;
    $("#classPageTile").textContent = (item.name.trim()[0] || "C").toUpperCase();
    const info = teacherNames.get(item.id);
    $("#classPageTeacher").textContent = info?.name ? `Teacher: ${info.name}` : "Classroom";
    const crumb = $("#pageCrumb");
    if (crumb) crumb.textContent = item.name;
    document.title = `${item.name} · Neuro-Focus`;
  }

  // Solo focus never shows class details, except to say the camera is busy with a class session.
  function renderSoloNotice() {
    const busy = Boolean(joinedClassId && (tracking || cameraStarting));
    const name = classes.find((entry) => entry.id === joinedClassId)?.name || "your class";
    $("#soloTrackerNote").hidden = !busy;
    $("#view-focus")?.toggleAttribute("data-camera-in-class", busy);
    if (busy) {
      $("#soloTrackerNoteText").textContent = `You’re in ${name}’s live session. Leave it there to track a solo session; the timer and steps here still work.`;
      $("#soloTrackerNoteLink").href = `#class/${joinedClassId}`;
      $("#soloTrackerNoteLink").textContent = `Open ${name}`;
    }
    const notice = $("#soloClassNotice");
    notice.hidden = !busy;
    if (busy) notice.textContent = `Your camera is in use by ${name}’s live session.`;
  }

  // The Home view (student-dashboard.js) shows classes, teachers and live sessions from this snapshot.
  function publishStatus({ error = false } = {}) {
    const detail = {
      loaded: true,
      error,
      currentId,
      joinedClassId,
      tracking,
      classes: classes.map((item) => {
        const status = teacher.get(item.id);
        const stats = myAttendance.get(item.id);
        return {
          id: item.id,
          name: item.name,
          teacherName: teacherNames.get(item.id)?.name || "",
          teacherAvatar: teacherNames.get(item.id) ? { preset: teacherNames.get(item.id).preset, url: teacherNames.get(item.id).url } : null,
          live: Boolean(status?.live),
          since: status?.live ? status.since || null : null,
          online: Boolean(status?.online),
          removed: removedFromSession(item.id),
          blocked: blockedClasses.has(item.id),
          inSession: Boolean(status?.live) && sharingClassId === item.id && tracking,
          attendance: stats?.counted ? { attended: stats.attended, counted: stats.counted } : null
        };
      })
    };
    window.neuroFocusClassStatus = detail;
    window.dispatchEvent(new CustomEvent("neurofocus:class-status", { detail }));
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
      if (window.neuroFocusView === "class" && item.id === window.neuroFocusRouteClassId) button.setAttribute("aria-current", "page");
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = item.name;
      const initial = document.createElement("span");
      initial.className = "class-initial";
      initial.setAttribute("aria-hidden", "true");
      initial.textContent = (item.name.trim()[0] || "C").toUpperCase();
      button.append(initial, name);
      if (teacher.get(item.id)?.live) button.append(liveDot());
      button.addEventListener("click", () => { window.location.hash = `class/${item.id}`; });
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
      // The class's teacher, with their picture or built-in avatar.
      const teacherInfo = teacherNames.get(item.id);
      const teacherLine = document.createElement("div");
      teacherLine.className = "my-class-teacher";
      if (teacherInfo) {
        const face = document.createElement("span");
        face.className = "nf-avatar sm";
        paintAvatar(face, { name: teacherInfo.name, preset: teacherInfo.preset, url: teacherInfo.url });
        const label = document.createElement("span");
        label.textContent = teacherInfo.name;
        teacherLine.append(face, label);
      }
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
      const open = document.createElement("a");
      open.className = "btn-action";
      open.href = `#class/${item.id}`;
      open.textContent = "Open class";
      actions.append(open);
      if (item.id === joinedClassId) {
        const tag = document.createElement("span");
        tag.className = "my-class-status";
        tag.textContent = "✓ In the live session";
        actions.append(tag);
      }
      if (status?.live && !removedFromSession(item.id) && item.id !== joinedClassId) {
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

      card.append(title, ...(teacherInfo ? [teacherLine] : []), code, state, attendanceLine, actions);
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
    const item = classes.find((entry) => entry.id === window.neuroFocusRouteClassId) || current();
    if (!item) {
      banner.dataset.state = "";
      kicker.textContent = "Live focus";
      title.textContent = "Class not found";
      sub.textContent = "You may have left this class. Open Classes to see the ones you’re in.";
      return;
    }

    const status = teacher.get(item.id);
    const joined = joinedClassId === item.id;
    title.textContent = status?.live ? `Live session · since ${clock(status.since)}` : "No live session right now";
    if (blockedClasses.has(item.id)) {
      banner.dataset.state = "error";
      kicker.textContent = "Live features unavailable";
      sub.textContent = `Live sessions can’t connect. ${SETUP_TEXT}`;
    } else if (status?.live && removedFromSession(item.id)) {
      banner.dataset.state = "error";
      kicker.textContent = "Removed from this live session";
      sub.textContent = "Your teacher removed you from today’s session, so nothing is shared. You’re still in the class and will be invited to the next session.";
      if (joined) actions.append(bannerButton("Leave session", "btn-action", leaveSession));
    } else if (status?.live && joined && tracking && shareToggle?.checked) {
      banner.dataset.state = "sharing";
      kicker.append(liveDot(), checkIn.status === "late" ? "You’re in the live session · marked late" : "You’re in the live session");
      sub.textContent = checkIn.status
        ? "Your attendance is recorded. Your teacher sees your attention estimate, never your video."
        : "Your teacher sees your attention estimate, never your video.";
      actions.append(bannerButton("Leave session", "btn-action", leaveSession));
    } else if (status?.live && joined) {
      banner.dataset.state = "live";
      kicker.append(liveDot(), "You’ve joined");
      sub.textContent = !shareToggle?.checked
        ? "Sharing is paused, so your teacher can’t see your attention estimate. Your attendance still counts."
        : "Your camera is off, so nothing is shared. Your attendance still counts. Turn the camera on to share your attention estimate.";
      if (!tracking && !cameraStarting) actions.append(bannerButton("Turn camera on", "btn-primary", () => window.dispatchEvent(new CustomEvent("neurofocus:start-camera"))));
      actions.append(bannerButton("Leave session", "btn-action", leaveSession));
    } else if (status?.live) {
      banner.dataset.state = "live";
      kicker.append(liveDot(), "Live now");
      sub.textContent = "Your teacher started a live session. Join to share your attention estimate (never video). Nothing is shared until you join.";
      actions.append(bannerButton("Join session", "btn-join", () => joinSession(item.id)));
    } else if (joined) {
      banner.dataset.state = "";
      kicker.textContent = "Live session paused";
      sub.textContent = "Your teacher’s dashboard disconnected. Sharing resumes if they come back.";
      actions.append(bannerButton("Leave session", "btn-action", leaveSession));
    } else {
      banner.dataset.state = "";
      kicker.textContent = "Live focus";
      sub.textContent = status?.online
        ? "Your teacher is online but hasn’t started a live session. You’ll get a notification when they do."
        : "You’ll get a notification when your teacher starts a live session. For studying on your own, use Solo focus.";
    }
    $("#classTrackerNote").hidden = joined;
  }

  function updateShareStatus() {
    if (!shareStatus) return;
    const item = classes.find((entry) => entry.id === window.neuroFocusRouteClassId) || current();
    const status = item ? teacher.get(item.id) : null;
    const live = Boolean(status?.live);
    const joined = item && joinedClassId === item.id;
    let text;
    let state = "";
    if (item && blockedClasses.has(item.id)) text = `Live sharing is unavailable. ${SETUP_TEXT}`;
    else if (navigator.onLine === false) text = "Connection lost · your teacher isn’t receiving updates until you’re back online.";
    else if (!item) text = "Not shared.";
    else if (live && removedFromSession(item.id)) text = "Not shared · your teacher removed you from this live session.";
    else if (!shareToggle?.checked) text = "Sharing paused · your teacher can’t see your attention estimate.";
    else if (!live) text = "Not shared · there’s no live session right now.";
    else if (joined && tracking) {
      text = `Live · your teacher in ${item.name} sees your attention estimate (never your video).`;
      state = "live";
    } else if (joined) text = "You’ve joined · turn the camera on to share your attention estimate.";
    else text = "Not shared yet · join the live session to share your attention estimate.";
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
    window.location.hash = `class/${data.id}`;
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
    // The shared reading shape (tracking-states.js): an unavailable or break reading is sent with
    // no score, so the teacher never sees it as 0. "state" is kept for older teacher dashboards.
    // One reading a second, but a change (e.g. tracking became unavailable) goes straight away.
    const reading = normalizeReading(event.detail);
    if (now - lastSentAt < 1000 && reading.tracking === lastSentTracking) return;
    lastSentAt = now;
    lastSentTracking = reading.tracking;
    sendAttention(sharingClassId, {
      tracking: reading.tracking, score: reading.score, engagement: reading.engagement, reason: reading.reason,
      state: legacyState(reading), cumulativeFocus: window.neuroFocusSessionStats?.focusPercent ?? null
    });
  });
  window.addEventListener("neurofocus:tracking-started", () => { cameraStarting = false; render(); });
  window.addEventListener("neurofocus:tracking-error", () => { cameraStarting = false; render(); });
  window.addEventListener("neurofocus:tracking-stopped", () => {
    cameraStarting = false;
    tracking = false;
    lastSentTracking = null;
    if (sharingClassId) sendAttention(sharingClassId, { state: "Stopped" });
    render();
  });
  shareToggle?.addEventListener("change", () => {
    updateSharing();
    render();
  });
  // Connection lost or back: the share status says whether the teacher is receiving updates.
  window.addEventListener("offline", () => render());
  window.addEventListener("online", () => render());

  // A new display name or picture (student-profile.js): tell each class's teacher so their lists refresh.
  window.addEventListener("neurofocus:profile-updated", () => {
    channels.forEach((entry) => {
      if (!entry.ready || !entry.channel) return;
      void entry.channel.send({ type: "broadcast", event: "member-updated", payload: { studentId: app.user.id, name: app.profile.display_name } });
    });
  });

  // A class page opened (student-ui.js): that class becomes the selected one.
  let classesLoaded = false;
  function openRoutedClass() {
    const id = window.neuroFocusRouteClassId;
    if (window.neuroFocusView !== "class" || !id || !classesLoaded) return;
    if (!classes.some((item) => item.id === id)) {
      notify({ title: "That class isn’t available", text: "You may have left it. Here are the classes you’re in.", kind: "info" });
      window.location.hash = "classes";
      return;
    }
    if (id !== currentId) selectClass(id);
    else render();
  }
  window.addEventListener("neurofocus:viewchange", openRoutedClass);

  // Actions for the Home view (student-dashboard.js), with the same behaviour as the buttons here.
  window.neuroFocusClassActions = { joinSession, selectClass, openJoinDialog, leaveSession, prepareSolo };

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
    classesLoaded = true;
    openRoutedClass();
  } catch (error) {
    console.error("Class loading failed", error);
    $("#studentClassList").replaceChildren(Object.assign(document.createElement("p"), {
      className: "empty-state",
      textContent: "Couldn’t load your classes. Make sure the class database setup has been run, then refresh."
    }));
    publishStatus({ error: true });
  }
}
