// Student classes: class list (sidebar + My Classes), current class banner, joining and
// leaving classes, and live sessions. During a teacher's live session the student's
// attention numbers (never video) stream to that teacher over the private class channel.
import {
  openClassChannel, teacherStatus, confirmAction, notify, showMessage, missingDatabaseUpdates, showSetupBanner, isMissingSql
} from "../shared/class-live.js";
import { paintAvatar, avatarUrls } from "../shared/avatars.js";
import { classColor } from "./class-colors.js";
import { createMascot } from "./buddy-mascot.js";
import { normalizeReading, legacyState } from "../shared/tracking-states.js";

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
  const checkInStatus = new Map(); // session id -> "present" | "late", kept after leaving (for the summary)
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
  // verified: the database already showed this session as ended (checkSessionEnded).
  async function endFocusWithSession(item, key, { verified = false } = {}) {
    if (joinedSessionId === key) joinedSessionId = null;
    // A focus session joined before the session's id reached this page is kept as "local": once
    // the database shows the class's session has ended, that one ends too.
    const mine = () => tracking && focusInSession?.classId === item.id && (focusInSession.key === key || focusInSession.key === "local" || key === "local");
    const joined = joinedClassId === item.id;
    if (!mine() && !joined) return;
    if (verified) { /* checked by the caller */ } else if (key !== "local") {
      const { data, error } = await supabase.from("class_sessions").select("ended_at").eq("id", key).maybeSingle();
      if (!error && data && !data.ended_at) return; // still open: the dashboard is just reconnecting
    } else {
      // Sessions aren't saved before the attendance database update: wait a moment instead.
      await new Promise((resolve) => window.setTimeout(resolve, 4000));
      const status = teacher.get(item.id);
      if (status?.live && sessionKey(status) === key) return;
    }
    // The focus session ends first, while this page still knows it belonged to this live session
    // and the attendance mark: leaving the session (below) re-renders, which forgets both. Ending it
    // first also means the summary covers the class session, not a moment of personal tracking.
    if (mine()) {
      focusInSession = null;
      liveNotices.get(item.id)?.();
      liveNotices.delete(item.id);
      // student-focus.js stops the camera, saves the session and shows its summary (session-summary.js).
      window.dispatchEvent(new CustomEvent("neurofocus:end-focus-session", {
        detail: {
          classId: item.id,
          className: item.name,
          teacherName: teacherNames.get(item.id)?.name || "",
          color: classColor(item.id),
          attendance: attendanceFor(key)
        }
      }));
    }
    if (joinedClassId === item.id) {
      joinedClassId = null;
      updateSharing();
      render();
    }
  }

  // The attendance mark for a session the student was in ("present" / "late"), or null if unknown.
  function attendanceFor(key) {
    const status = (key && checkInStatus.get(key)) || checkIn.status;
    return status === "late" || status === "present" ? status : null;
  }

  // The end of a live session normally arrives through the teacher's presence (onTeacherStatus),
  // but a flaky Realtime connection can delay or drop that. So while a student is in a live
  // session, the database is asked every 10 seconds whether it has ended. (Students can't receive
  // Realtime broadcasts at all, by design, so the database is the dependable signal.)
  async function checkSessionEnded(classId, key) {
    const item = classes.find((entry) => entry.id === classId);
    if (!item) return;
    let ended = false;
    let endedKey = key;
    if (key && key !== "local") {
      const { data, error } = await supabase.from("class_sessions").select("ended_at").eq("id", key).maybeSingle();
      ended = !error && Boolean(data?.ended_at);
    } else {
      // The session's id never reached this page: ask whether the class still has an open session.
      const { data, error } = await supabase.from("class_sessions").select("id").eq("class_id", classId).is("ended_at", null).limit(1);
      if (error) return; // before the attendance database update there is nothing to check
      ended = data.length === 0;
      endedKey = "local";
    }
    if (ended) void endFocusWithSession(item, endedKey, { verified: true });
  }
  window.setInterval(() => {
    const classId = focusInSession?.classId || joinedClassId;
    const key = focusInSession?.key || joinedSessionId || "local";
    // Runs in a background tab too (browsers slow it to about once a minute there).
    if (classId && (tracking || joinedClassId)) void checkSessionEnded(classId, key);
  }, 10000);

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
    if (window.neuroFocusRouteClassId !== classId || window.neuroFocusRouteClassTab !== "live") window.location.hash = `class/${classId}/live`;
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
      if (data?.status) checkInStatus.set(sessionId, data.status);
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
    if (!list) return; // the sidebar lists pages only; classes are on the Classes page
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

  // ---------- The Classes page ----------
  // A "Live now" strip for live sessions, then one card per class: colour band, teacher, attendance,
  // shortcuts to each tab, the main action (join, open) and a ⋯ menu (notes, join code, leave).
  // Cards are only rebuilt when what they show changes, and only animate the first time.
  let cardsKey = "";
  let classFilter = "all";
  let liveShown = new Set(); // classes already in the live strip (only new ones animate in)
  const TAB_LINKS = [["live", "i-video", "Live focus"], ["posts", "i-megaphone", "Posts"], ["assignments", "i-assignment", "Assignments"], ["quizzes", "i-quiz", "Quizzes"]];
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const svgIcon = (id) => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "icon");
    svg.setAttribute("aria-hidden", "true");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", `#${id}`);
    svg.append(use);
    return svg;
  };
  const isLive = (item) => Boolean(teacher.get(item.id)?.live) && !removedFromSession(item.id) && !blockedClasses.has(item.id);

  function renderCards() {
    const grid = $("#studentClassList");
    if (!grid) return;
    const query = ($("#classesSearch")?.value || "").trim().toLowerCase();
    const key = JSON.stringify([query, classFilter, joinedClassId, classes.map((item) => {
      const status = teacher.get(item.id);
      const info = teacherNames.get(item.id);
      const stats = myAttendance.get(item.id);
      return [item.id, item.name, item.join_code, status?.live, status?.since, status?.online, removedFromSession(item.id), blockedClasses.has(item.id), info?.name, info?.preset, info?.url, stats?.attended, stats?.counted];
    })]);
    if (key === cardsKey) return;
    cardsKey = key;
    const focusKey = grid.contains(document.activeElement) ? document.activeElement.dataset.focusKey : null;

    // Summary in the page header
    const liveCount = classes.filter(isLive).length;
    const summary = $("#classesSummary");
    if (summary) summary.textContent = classes.length ? `${classes.length} class${classes.length === 1 ? "" : "es"}${liveCount ? ` · ${liveCount} live now` : ""}` : "None yet";

    renderLiveStrip();
    const toolbar = $("#classesToolbar");
    if (toolbar) toolbar.hidden = classes.length < 4;

    if (!classes.length) {
      const empty = el("div", "classes-empty");
      const mascot = createMascot();
      const join = el("button", "btn-primary", "");
      join.type = "button";
      join.append(svgIcon("i-plus"), "Join your first class");
      join.dataset.focusKey = "join-first";
      join.addEventListener("click", openJoinDialog);
      empty.append(mascot, el("h2", "", "No classes yet"),
        el("p", "", "Ask your teacher for a join code. Once you join, their posts, assignments, quizzes and live sessions show up here."), join);
      grid.replaceChildren(empty);
      grid.dataset.settled = "true";
      return;
    }

    const shown = classes.filter((item) => {
      if (classFilter === "live" && !isLive(item)) return false;
      if (!query) return true;
      return `${item.name} ${teacherNames.get(item.id)?.name || ""}`.toLowerCase().includes(query);
    });
    if (!shown.length) {
      grid.replaceChildren(el("p", "empty-state", classFilter === "live" ? "None of your classes is live right now." : "No classes match that search."));
      return;
    }
    grid.replaceChildren(...shown.map((item, index) => classCard(item, index)));
    if (focusKey) grid.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`)?.focus();
    // Later updates (live status, attendance) replace cards without replaying the entrance.
    window.setTimeout(() => { grid.dataset.settled = "true"; }, 900);
  }

  function classCard(item, index) {
    const status = teacher.get(item.id);
    const live = isLive(item);
    const inSession = item.id === joinedClassId;
    const info = teacherNames.get(item.id);
    const stats = myAttendance.get(item.id);
    const card = el("article", "class-card-v2");
    card.setAttribute("role", "listitem");
    card.style.setProperty("--class-color", classColor(item.id));
    card.style.setProperty("--i", String(index));
    card.dataset.live = String(live);
    card.dataset.inSession = String(inSession);

    // Colour band with the class initial and its live status
    const band = el("div", "class-band");
    const initial = el("span", "class-band-initial", ([...item.name.trim()][0] || "C").toUpperCase());
    initial.setAttribute("aria-hidden", "true");
    const badge = el("span", "class-badge");
    if (inSession) { badge.dataset.state = "in"; badge.append(el("span", "live-dot"), "You’re in"); }
    else if (live) { badge.dataset.state = "live"; badge.append(el("span", "live-dot"), "Live now"); }
    else if (status?.live && removedFromSession(item.id)) { badge.dataset.state = "removed"; badge.textContent = "Live · removed"; }
    else if (status?.online) { badge.dataset.state = "online"; badge.textContent = "Teacher online"; }
    else badge.hidden = true;
    band.append(initial, badge);

    // Name (the whole card opens the class) and teacher
    const body = el("div", "class-body");
    const title = el("h3", "class-name");
    const link = el("a", "class-open-link", item.name);
    link.href = `#class/${item.id}`;
    link.dataset.focusKey = `open-${item.id}`;
    title.append(link);
    const who = el("div", "class-teacher-row");
    if (info?.name) {
      const face = el("span", "nf-avatar sm");
      paintAvatar(face, { name: info.name, preset: info.preset, url: info.url });
      who.append(face, el("span", "", info.name));
    } else who.append(el("span", "class-teacher-unknown", "Your teacher"));
    if (live && status?.since) who.append(el("small", "class-since", `since ${clock(status.since)}`));

    // Attendance
    const attendance = el("div", "class-attendance");
    if (stats?.counted) {
      const rate = Math.round((stats.attended / stats.counted) * 100);
      const meter = el("span", "class-meter");
      meter.setAttribute("role", "img");
      meter.setAttribute("aria-label", `Attendance ${rate}%`);
      const fill = el("span");
      fill.style.setProperty("--rate", `${rate}%`);
      meter.append(fill);
      attendance.append(el("span", "class-attendance-label", "Attendance"), meter, el("b", "", `${rate}%`));
      attendance.title = `${stats.attended} of ${stats.counted} live session${stats.counted === 1 ? "" : "s"}`;
    } else attendance.append(el("span", "class-attendance-label", "No live sessions yet"));
    body.append(title, who, attendance);

    // Shortcuts to each part of the class
    const tabs = el("nav", "class-shortcuts");
    tabs.setAttribute("aria-label", `${item.name} sections`);
    TAB_LINKS.forEach(([tab, iconId, label]) => {
      const a = el("a", "class-shortcut");
      a.href = `#class/${item.id}/${tab}`;
      a.dataset.focusKey = `${tab}-${item.id}`;
      a.title = label;
      a.append(svgIcon(iconId), el("span", "", label === "Assignments" ? "Work" : label === "Live focus" ? "Live" : label));
      a.setAttribute("aria-label", label);
      if (tab === "live" && live) a.dataset.live = "true";
      tabs.append(a);
    });

    // Main action and the ⋯ menu
    const foot = el("div", "class-foot");
    let main;
    if (live && !inSession) {
      main = el("button", "btn-join class-main", "");
      main.type = "button";
      main.append(svgIcon("i-video"), "Join live session");
      main.addEventListener("click", () => joinSession(item.id));
    } else {
      main = el("a", "btn-action class-main", "");
      main.href = inSession ? `#class/${item.id}/live` : `#class/${item.id}`;
      main.append(inSession ? "Back to Live focus" : "Open class", svgIcon("i-chevron"));
    }
    main.dataset.focusKey = `main-${item.id}`;
    foot.append(main, classMenu(item));
    card.append(band, body, tabs, foot);
    return card;
  }

  // ⋯ menu: My notes, Copy join code, Leave class.
  function classMenu(item) {
    const wrap = el("div", "class-menu");
    const toggle = el("button", "class-menu-button");
    toggle.type = "button";
    toggle.dataset.focusKey = `menu-${item.id}`;
    toggle.setAttribute("aria-label", `More for ${item.name}`);
    toggle.setAttribute("aria-expanded", "false");
    toggle.textContent = "⋯";
    const list = el("div", "class-menu-list");
    list.hidden = true;
    const close = (focus = false) => {
      list.hidden = true;
      toggle.setAttribute("aria-expanded", "false");
      if (focus) toggle.focus();
    };
    const option = (iconId, label, onClick, danger = false) => {
      const button = el("button", `class-menu-item${danger ? " danger" : ""}`);
      button.type = "button";
      button.append(svgIcon(iconId), label);
      button.addEventListener("click", () => { close(); onClick(); });
      list.append(button);
    };
    option("i-note", "My notes for this class", () => window.neuroFocusOpenClassNotes?.(item.id));
    option("i-copy", `Copy join code (${item.join_code})`, async () => {
      try { await navigator.clipboard.writeText(item.join_code); notify({ title: "Join code copied", text: item.join_code, kind: "success", timeoutMs: 3000 }); }
      catch { notify({ title: "Join code", text: item.join_code, kind: "info" }); }
    });
    option("i-logout", "Leave class", () => leaveClass(item), true);
    toggle.addEventListener("click", () => {
      const opening = list.hidden;
      document.querySelectorAll(".class-menu-list").forEach((other) => { other.hidden = true; });
      document.querySelectorAll(".class-menu-button").forEach((other) => other.setAttribute("aria-expanded", "false"));
      list.hidden = !opening;
      toggle.setAttribute("aria-expanded", String(opening));
      if (opening) list.querySelector("button")?.focus();
    });
    list.addEventListener("keydown", (event) => {
      const items = [...list.querySelectorAll("button")];
      const at = items.indexOf(document.activeElement);
      if (event.key === "Escape") { event.preventDefault(); close(true); }
      else if (event.key === "ArrowDown") { event.preventDefault(); items[(at + 1) % items.length].focus(); }
      else if (event.key === "ArrowUp") { event.preventDefault(); items[(at - 1 + items.length) % items.length].focus(); }
    });
    wrap.addEventListener("focusout", (event) => { if (!wrap.contains(event.relatedTarget)) close(); });
    wrap.append(toggle, list);
    return wrap;
  }

  // Live sessions now: a strip above the cards with a one-press Join.
  function renderLiveStrip() {
    const strip = $("#classesLive");
    if (!strip) return;
    const liveClasses = classes.filter((item) => isLive(item) || item.id === joinedClassId);
    strip.hidden = !liveClasses.length;
    strip.replaceChildren(...liveClasses.map((item) => {
      const status = teacher.get(item.id);
      const inSession = item.id === joinedClassId;
      const row = el("div", `classes-live-row${liveShown.has(item.id) ? "" : " is-new"}`);
      row.style.setProperty("--class-color", classColor(item.id));
      row.dataset.in = String(inSession);
      const text = el("div", "classes-live-text");
      const kicker = el("span", "classes-live-kicker");
      kicker.append(el("span", "live-dot"), inSession ? "You’re in this live session" : status?.since ? `Live now · since ${clock(status.since)}` : "Live now");
      text.append(kicker, el("b", "", item.name), el("small", "", inSession
        ? "Only your attention score is shared with your teacher, never video."
        : `${teacherNames.get(item.id)?.name || "Your teacher"} started a live session. Joining turns on your attention tracker.`));
      let action;
      if (inSession) {
        action = el("a", "btn-action", "Back to Live focus");
        action.href = `#class/${item.id}/live`;
      } else {
        action = el("button", "btn-join", "");
        action.type = "button";
        action.append(svgIcon("i-video"), "Join live session");
        action.addEventListener("click", () => joinSession(item.id));
      }
      row.append(text, action);
      return row;
    }));
    liveShown = new Set(liveClasses.map((item) => item.id));
  }

  $("#classesSearch")?.addEventListener("input", () => renderCards());
  document.querySelectorAll("[data-class-filter]").forEach((button) => button.addEventListener("click", () => {
    classFilter = button.dataset.classFilter;
    document.querySelectorAll("[data-class-filter]").forEach((other) => other.setAttribute("aria-pressed", String(other === button)));
    renderCards();
  }));
  document.addEventListener("click", (event) => {
    if (event.composedPath().some((node) => node?.classList?.contains?.("class-menu"))) return;
    document.querySelectorAll(".class-menu-list").forEach((list) => { list.hidden = true; });
    document.querySelectorAll(".class-menu-button").forEach((button) => button.setAttribute("aria-expanded", "false"));
  });

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
        ? "Your attendance is recorded. Your teacher sees your attention score, never your video."
        : "Your teacher sees your attention score, never your video.";
      actions.append(bannerButton("Leave session", "btn-action", leaveSession));
    } else if (status?.live && joined) {
      banner.dataset.state = "live";
      kicker.append(liveDot(), "You’ve joined");
      sub.textContent = !shareToggle?.checked
        ? "Sharing is paused, so your teacher can’t see your attention score. Your attendance still counts."
        : "Your camera is off, so nothing is shared. Your attendance still counts. Turn the camera on to share your attention score.";
      if (!tracking && !cameraStarting) actions.append(bannerButton("Turn camera on", "btn-primary", () => window.dispatchEvent(new CustomEvent("neurofocus:start-camera"))));
      actions.append(bannerButton("Leave session", "btn-action", leaveSession));
    } else if (status?.live) {
      banner.dataset.state = "live";
      kicker.append(liveDot(), "Live now");
      sub.textContent = "Your teacher started a live session. Join to share your attention score (never video). Nothing is shared until you join.";
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
    else if (!shareToggle?.checked) text = "Sharing paused · your teacher can’t see your attention score.";
    else if (!live) text = "Not shared · there’s no live session right now.";
    else if (joined && tracking) {
      text = `Live · your teacher in ${item.name} sees your attention score (never your video).`;
      state = "live";
    } else if (joined) text = "You’ve joined · turn the camera on to share your attention score.";
    else text = "Not shared yet · join the live session to share your attention score.";
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
