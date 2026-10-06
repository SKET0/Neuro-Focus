// Teacher class management: all-classes overview, one class at a time with tabs
// (Live monitor, Students, Attendance, History, Settings), live sessions, the class master
// list, removing students from a session or the class, and class settings. Live sessions are
// saved (class_sessions) so attendance can be taken; teacher-attendance.js shows it.
// Live updates use private Supabase Realtime class channels (class-live.js).
import {
  openClassChannel, onlineStudentIds, confirmAction, notify, copyText, missingDatabaseUpdates, showSetupBanner, isMissingSql
} from "../shared/class-live.js?v=9";
import { paintAvatar, avatarUrls } from "../shared/avatars.js?v=1";

const app = await window.neuroFocusReady;

if (app) {
  const { supabase } = app;
  const $ = (selector) => document.querySelector(selector);
  const selectedKey = "neuroFocusCurrentClassId";
  const liveKey = `neuroFocusLiveSession:${app.user.id}`;
  const TABS = ["live", "posts", "assignments", "quizzes", "students", "attendance", "history", "settings"];
  const REMOVED_NOTICE_MS = 2 * 60 * 1000; // removed students are told within this window
  const SHARING_STALE_MS = 6000;
  const SETUP_TEXT = "Run the class management database update first (see README).";

  let classes = [];
  let roster = [];                 // members of the open class: { id, name, joinedAt }
  let rosterLoadedFor = "";
  let selectedId = "";
  let view = "classes";             // "classes" (Home), "class" (one class), "profile" (My profile),
                                   // "all-students" or "report" (attendance across classes, teacher-overview.js)
  // The Demo (teacher-demo.js) is a separate page with sample data only.
  const OVERVIEWS = {
    "all-students": { address: "#students", label: "All students" },
    report: { address: "#attendance-report", label: "Attendance report" },
    demo: { address: "#demo", label: "Demo — sample data" }
  };
  const NAV_FOR_VIEW = { "all-students": "all-students", report: "attendance-report", demo: "demo" };
  let tab = "live";
  let hasClassSettings = true;     // false until the class management SQL has been run
  let newIds = new Set();          // roster rows to highlight once
  let refreshTimer;
  const channels = new Map();      // classId -> { channel, ready }
  const online = new Map();        // classId -> Set(studentId)
  const sharing = new Map();       // classId -> Map(studentId -> last reading time)
  const removed = new Map();       // classId -> [{ id, at }]
  let live = loadLive();           // { classId, since, sessionId } | null
  let hasSessions = true;          // false until the attendance SQL has been run
  let sessionRemovedIds = new Set(); // students removed from the live session (still in the class)
  let invites = new Map();         // studentId -> time of the last "please join" ping
  let attendance = { classId: "", current: new Map(), byStudent: new Map() }; // from teacher-attendance.js
  let lastInviteKey = "";
  let lastJoinRefresh = 0;
  let presenceWarned = false;
  let channelWarned = false;

  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const selected = () => classes.find((item) => item.id === selectedId) || null;
  const missingSql = (error) => error && (error.code === "42501" || error.code === "42703" || error.code === "PGRST202"
    || /permission denied|joining_open|regenerate_join_code|set_class_password/.test(error.message || ""));
  const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

  function loadLive() {
    try {
      const value = JSON.parse(localStorage.getItem(liveKey) || "null");
      return value?.classId ? value : null;
    } catch {
      return null;
    }
  }
  function saveLive() {
    try {
      if (live) localStorage.setItem(liveKey, JSON.stringify(live));
      else localStorage.removeItem(liveKey);
    } catch { /* storage unavailable */ }
  }

  // ---------- Data ----------
  async function loadClasses() {
    const columns = "id, name, join_code, join_password_protected, created_at, class_members(count)";
    // Columns added by later database updates are dropped if those haven't been run yet.
    const missingColumn = (error) => error && (error.code === "42703" || /joining_open|late_after_minutes/.test(error.message || ""));
    let { data, error } = await supabase.from("classes").select(`${columns}, joining_open, late_after_minutes`).order("created_at", { ascending: false });
    if (missingColumn(error)) ({ data, error } = await supabase.from("classes").select(`${columns}, joining_open`).order("created_at", { ascending: false }));
    if (missingColumn(error)) {
      hasClassSettings = false;
      ({ data, error } = await supabase.from("classes").select(columns).order("created_at", { ascending: false }));
    }
    if (error) throw error;
    classes = (data || []).map((item) => ({
      ...item,
      joining_open: item.joining_open ?? true,
      late_after_minutes: item.late_after_minutes ?? null,
      memberCount: item.class_members?.[0]?.count ?? 0
    }));
    if (live && !classes.some((item) => item.id === live.classId)) {
      live = null;
      saveLive();
    }
    watchChannels();
    renderClassGrid();
    if (view === "class") {
      if (selected()) renderClassHeader();
      else showClasses();
    }
  }

  async function loadRoster() {
    const classId = selectedId;
    if (!classId) return;
    // Students' avatars come with the student profiles database update; before it, names only.
    const members = (fields) => supabase.from("class_members").select(`student_id, joined_at, profiles(${fields})`)
      .eq("class_id", classId).order("joined_at", { ascending: true });
    let { data, error } = await members("display_name, avatar_preset, avatar_path");
    if (error && (error.code === "42703" || /avatar_/.test(error.message || ""))) ({ data, error } = await members("display_name"));
    if (classId !== selectedId) return;
    if (error) {
      $("#studentsStatus").textContent = "Couldn’t load students. Refresh to try again.";
      return;
    }
    const previous = new Set(roster.map((member) => member.id));
    roster = (data || []).map((member) => ({
      id: member.student_id, name: member.profiles?.display_name || "Student", joinedAt: member.joined_at,
      avatarPreset: member.profiles?.avatar_preset || null, avatarPath: member.profiles?.avatar_path || null
    }));
    if (rosterLoadedFor === classId) roster.forEach((member) => { if (!previous.has(member.id)) newIds.add(member.id); });
    rosterLoadedFor = classId;
    window.neuroFocusRoster = roster.map(({ id, name }) => ({ id, name }));
    window.dispatchEvent(new CustomEvent("neurofocus:roster-loaded", { detail: { classId, members: window.neuroFocusRoster } }));
    renderStudents();
    renderClassHeader();
    void inviteNewMembers();
    void loadRosterPictures(classId);
  }

  // Uploaded pictures are private: storage hands this teacher short-lived links only for
  // students in their classes. Until they arrive (or if they can't), built-in avatars or initials show.
  async function loadRosterPictures(classId) {
    const paths = roster.map((member) => member.avatarPath).filter(Boolean);
    if (!paths.length) return;
    const urls = await avatarUrls(supabase, paths);
    if (classId !== selectedId) return;
    roster.forEach((member) => { member.avatarUrl = urls.get(member.avatarPath) || null; });
    document.querySelectorAll("#studentRows tr[data-student-id]").forEach((row) => {
      const member = roster.find((item) => item.id === row.dataset.studentId);
      if (member?.avatarUrl) paintAvatar(row.querySelector(".mini-avatar"), { name: member.name, preset: member.avatarPreset, url: member.avatarUrl });
    });
  }

  // ---------- Saved live sessions ----------
  // The open session in the database is the source of truth (it works across devices);
  // before the attendance SQL is run, the live state is kept on this device only.
  // Sessions whose dashboard was closed for 15+ minutes (e.g. "End" was never pressed) are
  // ended at their last activity so attendance is finalized. Needs the live-workflow SQL.
  async function closeStaleSessions() {
    const { data, error } = await supabase.rpc("close_stale_sessions", { p_minutes: 15 });
    if (error || !Array.isArray(data) || !data.length) return;
    data.forEach((row) => {
      const item = classes.find((entry) => entry.id === row.class_id);
      notify({
        title: "A live session was ended for you",
        text: `${item?.name || "A class"}: the session from ${clock(row.started_at)} ended at ${clock(row.ended_at)}, when this dashboard was last open. Attendance is saved.`,
        kind: "info",
        timeoutMs: 20000,
        actions: item ? [{ label: "View attendance", onClick: () => openClass(item.id, "attendance") }] : []
      });
    });
    refreshAttendance();
  }

  // While live, tell the database the dashboard is still here (see closeStaleSessions).
  async function keepSessionAlive() {
    if (!live?.sessionId || !hasSessions) return;
    const { data, error } = await supabase.rpc("keep_session_alive", { p_session_id: live.sessionId });
    if (error) return; // older database without this function, or offline: try again next time
    if (data === false) {
      // Ended somewhere else (another device, or closed after a long absence).
      await loadOpenSession();
      renderClassHeader();
      renderClassGrid();
      refreshAttendance();
    }
  }
  window.setInterval(() => { void keepSessionAlive(); }, 60000);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") void keepSessionAlive(); });

  async function loadOpenSession() {
    const { data, error } = await supabase.from("class_sessions")
      .select("id, class_id, started_at").is("ended_at", null)
      .order("started_at", { ascending: false }).limit(1);
    if (error) {
      if (isMissingSql(error)) hasSessions = false;
      return;
    }
    hasSessions = true;
    const open = (data || []).find((row) => classes.some((item) => item.id === row.class_id));
    const before = live?.sessionId;
    if (!open) {
      if (live) { live = null; saveLive(); }
    } else if (open.id !== before) {
      live = { classId: open.class_id, since: open.started_at, sessionId: open.id };
      saveLive();
      invites = new Map();
      const { data: removedRows } = await supabase.from("session_attendance")
        .select("student_id").eq("session_id", open.id).not("removed_at", "is", null);
      sessionRemovedIds = new Set((removedRows || []).map((row) => row.student_id));
    }
    if (live?.sessionId !== before) {
      classes.forEach((item) => publishPresence(item.id));
      announceLive();
    }
  }

  // Students who join the class during a live session are invited to it automatically.
  async function inviteNewMembers() {
    if (!live?.sessionId || live.classId !== selectedId || !roster.length) return;
    const key = `${live.sessionId}:${roster.map((member) => member.id).sort().join(",")}`;
    if (key === lastInviteKey) return;
    lastInviteKey = key;
    const { data, error } = await supabase.rpc("invite_class_members", { p_session_id: live.sessionId });
    if (!error && data > 0) refreshAttendance();
  }

  const refreshAttendance = () => window.dispatchEvent(new CustomEvent("neurofocus:attendance-refresh"));

  function scheduleRefresh() {
    window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(async () => {
      try {
        await loadClasses();
        if (hasSessions) await loadOpenSession();
        if (view === "class" || selectedId) await loadRoster();
      } catch (error) {
        console.error("Class refresh failed", error);
      }
    }, 400);
  }

  // ---------- Realtime ----------
  function watchChannels() {
    const ids = new Set(classes.map((item) => item.id));
    channels.forEach((entry, id) => {
      if (ids.has(id)) return;
      if (entry.channel) supabase.removeChannel(entry.channel);
      channels.delete(id);
      online.delete(id);
    });
    classes.forEach((item) => {
      if (channels.has(item.id)) return;
      const entry = { channel: null, ready: false, blocked: false };
      channels.set(item.id, entry);
      void openClassChannel(supabase, item.id, {
        presenceKey: app.user.id,
        broadcasts: ["attention", "member-joined", "member-left", "member-updated"],
        onSync: (state) => {
          const before = online.get(item.id) || new Set();
          const now = onlineStudentIds(state);
          online.set(item.id, now);
          // Someone online who isn't on the roster yet has just joined.
          if (item.id === selectedId && [...now].some((id) => !roster.some((member) => member.id === id))) scheduleRefresh();
          if (before.size !== now.size || [...now].some((id) => !before.has(id))) renderOnline(item.id);
        },
        onBroadcast: (event, payload) => handleBroadcast(item.id, event, payload),
        onReady: (channel) => {
          entry.channel = channel;
          entry.ready = true;
          publishPresence(item.id);
          // Supabase reconnects on its own, e.g. after the database updates are run: clear the warning.
          if (entry.blocked) {
            entry.blocked = false;
            window.dispatchEvent(new CustomEvent("neurofocus:live-channel-ok", { detail: { classId: item.id } }));
            void recheckSetup();
          }
        },
        onError: () => {
          entry.blocked = true;
          window.dispatchEvent(new CustomEvent("neurofocus:live-channel-error", { detail: { classId: item.id } }));
          if (channelWarned) return;
          channelWarned = true;
          notify({
            title: "Live connection blocked",
            text: "Students can’t see your live sessions until the Phase 2 database updates are run (see the banner at the top).",
            kind: "error",
            timeoutMs: 15000
          });
        }
      }).then((channel) => {
        entry.channel ??= channel;
        if (!channels.has(item.id)) supabase.removeChannel(channel);
      });
    });
  }

  // The teacher's presence tells students whether a session is live and who was just removed.
  function publishPresence(classId) {
    const entry = channels.get(classId);
    if (!entry?.ready || !entry.channel) return;
    const now = Date.now();
    const recent = (removed.get(classId) || []).filter((item) => now - item.at < REMOVED_NOTICE_MS);
    removed.set(classId, recent);
    const isLive = live?.classId === classId;
    entry.channel.track({
      role: "teacher",
      live: isLive,
      since: isLive ? live.since : null,
      sessionId: isLive ? live.sessionId || null : null,
      sessionRemoved: isLive ? [...sessionRemovedIds] : [],
      invites: isLive ? Object.fromEntries(invites) : {},
      removed: recent.map((item) => item.id)
    })
      .then((result) => {
        if (result === "ok" || presenceWarned) return;
        presenceWarned = true;
        notify({
          title: "Students can’t see your live session yet",
          text: "Going live needs the class management database update (see README).",
          kind: "error",
          timeoutMs: 12000
        });
      })
      .catch(() => {});
  }

  function handleBroadcast(classId, event, payload) {
    if (event === "attention") {
      if (!payload.studentId || live?.classId !== classId || sessionRemovedIds.has(payload.studentId)) return;
      // Scores from someone not yet marked as joined: they just checked in, so refresh attendance now.
      if (payload.state !== "Stopped" && attendance.classId === classId && !attendance.current.get(payload.studentId)?.joined_at
        && Date.now() - lastJoinRefresh > 3000) {
        lastJoinRefresh = Date.now();
        window.setTimeout(refreshAttendance, 1200);
      }
      const map = sharing.get(classId) || new Map();
      sharing.set(classId, map);
      if (payload.state === "Stopped") map.delete(payload.studentId);
      else map.set(payload.studentId, Date.now());
      window.dispatchEvent(new CustomEvent("neurofocus:live-attention", { detail: { ...payload, classId } }));
      return;
    }
    if (event === "member-left") {
      const item = classes.find((entry) => entry.id === classId);
      notify({ title: `${payload.name || "A student"} left ${item?.name || "your class"}` });
      sharing.get(classId)?.delete(payload.studentId);
      scheduleRefresh();
      return;
    }
    // A student changed their display name or picture: reload the list (names come from the database).
    if (event === "member-updated") {
      if (classId === selectedId) scheduleRefresh();
      return;
    }
    if (event === "member-joined") {
      const item = classes.find((entry) => entry.id === classId);
      const name = payload.name || "A student";
      notify({
        title: `${name} ${payload.rejoined ? "rejoined" : "joined"} ${item?.name || "your class"}`,
        kind: "success",
        actions: classId !== selectedId || view !== "class" ? [{ label: "Open class", onClick: () => openClass(classId, "students") }] : []
      });
      if (payload.studentId) newIds.add(payload.studentId);
      scheduleRefresh();
    }
  }

  function studentState(id) {
    const last = sharing.get(selectedId)?.get(id);
    if (live?.classId === selectedId && last && Date.now() - last < SHARING_STALE_MS) return "session";
    return online.get(selectedId)?.has(id) ? "online" : "offline";
  }

  function sharingCount(classId) {
    const map = sharing.get(classId);
    if (!map) return 0;
    const now = Date.now();
    return [...map.values()].filter((at) => now - at < SHARING_STALE_MS).length;
  }

  // ---------- Rendering ----------
  const initialOf = (name) => (name.trim()[0] || "C").toUpperCase();

  // Overview numbers above the class cards.
  function renderSummary() {
    const set = (selector, value) => { const el = $(selector); if (el) el.textContent = value; };
    const totalOnline = classes.reduce((sum, item) => sum + (online.get(item.id)?.size || 0), 0);
    const liveClass = live ? classes.find((item) => item.id === live.classId) : null;
    set("#sumClasses", String(classes.length));
    set("#sumStudents", String(classes.reduce((sum, item) => sum + item.memberCount, 0)));
    set("#sumOnline", String(totalOnline));
    set("#sumLive", liveClass ? "Live" : "Off");
    set("#sumLiveSub", liveClass ? `${liveClass.name} since ${clock(live.since)}` : "Open a class to start one");
    $("#sumLiveCard")?.setAttribute("data-live", String(Boolean(liveClass)));
    publishStatus();
  }

  // The teacher Home (teacher-home.js) shows classes, online students and the live session from this.
  function publishStatus() {
    const detail = {
      loaded: true,
      classes: classes.map((item) => ({
        id: item.id, name: item.name, joinCode: item.join_code, students: item.memberCount,
        online: online.get(item.id)?.size || 0, joiningOpen: item.joining_open
      })),
      live: live && classes.some((item) => item.id === live.classId)
        ? { classId: live.classId, since: live.since, sessionId: live.sessionId || null, sharing: sharingCount(live.classId) }
        : null
    };
    window.neuroFocusTeacherStatus = detail;
    window.dispatchEvent(new CustomEvent("neurofocus:teacher-status", { detail }));
  }

  function renderOnline(classId) {
    const card = document.querySelector(`.class-card[data-class-id="${classId}"] .online`);
    if (card) card.textContent = `● ${online.get(classId)?.size || 0} online`;
    renderSummary();
    if (classId === selectedId) {
      renderClassHeader();
      updateStudentStatuses();
    }
  }

  // Sidebar: every class, with its live dot or student count. The open class's pages
  // (#classNav: Live monitor, Master list, ...) unfold right under it; a running session also
  // gets a "Live now" shortcut at the top.
  const classSubnav = $("#classNav"); // kept here: it moves in and out of the class list
  function renderSidebarClasses() {
    const list = $("#sidebarClassList");
    const subnav = classSubnav;
    const inClass = view === "class" && Boolean(selected());
    const liveClass = live ? classes.find((item) => item.id === live.classId) : null;
    $("#navLiveNow").hidden = !liveClass;
    $("#navLiveClass").textContent = liveClass?.name || "";
    // Out of the list while it is rebuilt; back under the open class afterwards.
    subnav.hidden = true;
    list.closest(".nav-group").after(subnav);
    if (!classes.length) {
      const empty = document.createElement("p");
      empty.className = "sidebar-empty";
      empty.textContent = "No classes yet.";
      list.replaceChildren(empty);
      return;
    }
    list.replaceChildren(...classes.map((item) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "nav-item sidebar-class";
      button.dataset.classId = item.id;
      const open = inClass && item.id === selectedId;
      button.dataset.open = String(open);
      if (open) button.setAttribute("aria-expanded", "true");
      const tile = document.createElement("span");
      tile.className = "class-initial";
      tile.setAttribute("aria-hidden", "true");
      tile.textContent = initialOf(item.name);
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = item.name;
      button.append(tile, name);
      if (live?.classId === item.id) {
        const dot = document.createElement("span");
        dot.className = "nav-live";
        dot.innerHTML = '<span class="live-dot"></span>';
        button.append(dot);
        button.setAttribute("aria-label", `${item.name}, live now`);
      } else {
        const count = document.createElement("span");
        count.className = "nav-count";
        count.textContent = item.memberCount ? String(item.memberCount) : "";
        button.append(count);
        button.setAttribute("aria-label", `${item.name}, ${plural(item.memberCount, "student")}`);
      }
      button.addEventListener("click", () => {
        if (open) return; // its pages are already listed under it
        openClass(item.id, live?.classId === item.id ? "live" : "students");
      });
      return button;
    }));
    subnav.hidden = !inClass;
    if (inClass) list.querySelector(`[data-class-id="${CSS.escape(selectedId)}"]`)?.after(subnav);
  }

  function renderClassGrid() {
    const grid = $("#classGrid");
    grid.replaceChildren();
    renderSummary();
    renderSidebarClasses();
    if (!classes.length) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      const text = document.createElement("p");
      text.textContent = "You don’t have any classes yet. Create one to get a join code for your students.";
      const button = document.createElement("button");
      button.type = "button";
      button.className = "btn-primary";
      button.style.marginTop = "12px";
      button.textContent = "＋ Create your first class";
      button.addEventListener("click", openNewClass);
      empty.append(text, button);
      grid.append(empty);
      return;
    }
    classes.forEach((item) => {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "class-card";
      card.dataset.classId = item.id;
      card.addEventListener("click", () => openClass(item.id, live?.classId === item.id ? "live" : "students"));

      const top = document.createElement("div");
      top.className = "class-card-top";
      const initial = document.createElement("span");
      initial.className = "class-initial";
      initial.textContent = initialOf(item.name);
      const title = document.createElement("h3");
      title.textContent = item.name;
      top.append(initial, title);
      if (live?.classId === item.id) {
        const pill = document.createElement("span");
        pill.className = "live-pill";
        const dot = document.createElement("span");
        dot.className = "live-dot";
        pill.append(dot, "Live");
        top.append(pill);
      }

      const code = document.createElement("span");
      code.className = "code-chip";
      code.textContent = item.join_code;

      const stats = document.createElement("div");
      stats.className = "class-card-stats";
      const members = document.createElement("span");
      members.textContent = plural(item.memberCount, "student");
      const onlineText = document.createElement("span");
      onlineText.className = "online";
      onlineText.textContent = `● ${online.get(item.id)?.size || 0} online`;
      stats.append(members, onlineText);
      if (!item.joining_open) {
        const closed = document.createElement("span");
        closed.textContent = "Joining closed";
        stats.append(closed);
      }
      if (item.join_password_protected) {
        const locked = document.createElement("span");
        locked.textContent = "🔒 Password";
        stats.append(locked);
      }
      const foot = document.createElement("span");
      foot.className = "class-card-foot";
      foot.textContent = live?.classId === item.id ? "Open live monitor →" : "Open class →";
      card.append(top, code, stats, foot);
      grid.append(card);
    });
  }

  function renderClassHeader() {
    const item = selected();
    if (!item) return;
    const isLive = live?.classId === item.id;
    const onlineCount = online.get(item.id)?.size || 0;
    $("#classTitle").textContent = item.name;
    const badge = $("#classInitial");
    if (badge) badge.textContent = initialOf(item.name);
    $("#classNavLabel").textContent = item.name;
    $("#classCode").textContent = item.join_code;
    $("#classMetaText").textContent = `${plural(item.memberCount, "student")} · ${onlineCount} online`;
    $("#joiningChip").hidden = item.joining_open;
    $("#tabStudentCount").textContent = item.memberCount ? String(item.memberCount) : "";
    $("#navStudentCount").textContent = item.memberCount ? String(item.memberCount) : "";
    $("#navLiveDot").hidden = !isLive;

    const toggle = $("#sessionToggle");
    toggle.dataset.live = String(isLive);
    toggle.textContent = isLive ? "■ End live session" : "▶ Start live session";
    const other = live && live.classId !== item.id ? classes.find((entry) => entry.id === live.classId) : null;
    $("#sessionHint").textContent = isLive
      ? `Live since ${clock(live.since)} · ${joinedSummary(item)} · ${sharingCount(item.id)} sharing now`
      : other ? `${other.name} is live. Starting here ends that session.` : "Starting a session invites everyone on the master list.";
  }

  // "12 of 20 joined" for the live session (attendance rows from teacher-attendance.js).
  function joinedSummary(item) {
    if (!live?.sessionId || attendance.classId !== item.id) return `${plural(item.memberCount, "student")} invited`;
    const rows = [...attendance.current.values()];
    const joined = rows.filter((row) => row.joined_at && !row.removed_at).length;
    return `${joined} of ${plural(rows.length, "student")} joined`;
  }

  // What the "This session" column says for one student.
  function sessionState(member) {
    const item = selected();
    if (!item || live?.classId !== item.id) return { state: "none", text: "—" };
    if (sessionRemovedIds.has(member.id)) return { state: "removed", text: "Removed from session" };
    const row = attendance.classId === item.id ? attendance.current.get(member.id) : null;
    const late = row?.status === "late" ? "Late · " : "";
    if (studentState(member.id) === "session") return { state: "in", text: `${late}In session${row?.joined_at ? ` since ${clock(row.joined_at)}` : ""}` };
    if (row?.joined_at) return { state: "joined", text: `${late}Joined ${clock(row.joined_at)} · not sharing now` };
    if (row?.status === "excused") return { state: "excused", text: "Excused" };
    return { state: "invited", text: invites.has(member.id) ? `Invited again at ${clock(new Date(invites.get(member.id)).toISOString())}` : "Invited · not joined yet" };
  }

  function smallButton(label, className, onClick, ariaLabel) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.textContent = label;
    if (ariaLabel) button.setAttribute("aria-label", ariaLabel);
    button.addEventListener("click", onClick);
    return button;
  }

  // Row actions are only rebuilt when they change, so keyboard focus isn't lost.
  function fillActions(cell, member, state) {
    const key = `${state}:${live?.classId === selectedId}`;
    if (cell.dataset.key === key) return;
    cell.dataset.key = key;
    const wrap = document.createElement("div");
    wrap.className = "row-actions";
    if (state === "removed") {
      wrap.append(smallButton("Let back in", "btn-action btn-small", () => { void setSessionRemoved(member, false); }, `Let ${member.name} back into the session`));
    } else if (state !== "none") {
      if (state === "invited") wrap.append(smallButton("Invite again", "btn-action btn-small", () => inviteAgain(member), `Invite ${member.name} to the session again`));
      wrap.append(smallButton("Remove from session", "btn-remove", () => { void setSessionRemoved(member, true); }, `Remove ${member.name} from this live session`));
    }
    const menu = document.createElement("details");
    menu.className = "row-menu";
    const summary = document.createElement("summary");
    summary.setAttribute("aria-label", `More actions for ${member.name}`);
    summary.textContent = "⋯";
    const list = document.createElement("div");
    list.className = "row-menu-list";
    list.append(smallButton("Remove from class", "row-menu-danger", () => { menu.open = false; void removeStudent(member); }, `Remove ${member.name} from the class`));
    menu.append(summary, list);
    wrap.append(menu);
    cell.replaceChildren(wrap);
  }

  function attendanceCell(cell, member) {
    const stats = attendance.classId === selectedId ? attendance.byStudent.get(member.id) : null;
    cell.replaceChildren();
    if (!stats || !stats.counted) {
      cell.append(Object.assign(document.createElement("span"), { className: "muted", textContent: hasSessions ? "No sessions yet" : "—" }));
      return;
    }
    const rate = Math.round((stats.attended / stats.counted) * 100);
    const wrap = document.createElement("span");
    wrap.className = "att-rate";
    wrap.dataset.level = rate >= 90 ? "good" : rate >= 75 ? "ok" : "low";
    const bar = document.createElement("span");
    bar.className = "att-bar";
    const fill = document.createElement("span");
    fill.style.width = `${rate}%`;
    bar.append(fill);
    wrap.append(bar, `${rate}%`);
    wrap.title = `Attended ${stats.attended} of ${plural(stats.counted, "session")}${stats.late ? ` (${stats.late} late)` : ""}${stats.excused ? ` · ${stats.excused} excused` : ""}`;
    cell.append(wrap);
  }

  function renderStudents() {
    const body = $("#studentRows");
    body.replaceChildren();
    const item = selected();
    if (!item) return;
    const isLive = live?.classId === item.id;
    $("#studentsTable").dataset.live = String(isLive);
    if (!roster.length) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = 5;
      cell.className = "empty-state";
      cell.textContent = `No students yet. Share the join code ${item.join_code}; students appear here the moment they join.`;
      row.append(cell);
      body.append(row);
    }
    roster.forEach((member) => {
      const row = document.createElement("tr");
      row.dataset.studentId = member.id;
      if (newIds.has(member.id)) row.classList.add("row-new");
      const name = document.createElement("td");
      const avatar = document.createElement("span");
      avatar.className = "mini-avatar";
      paintAvatar(avatar, { name: member.name, preset: member.avatarPreset, url: member.avatarUrl });
      const nameText = document.createElement("span");
      nameText.className = "student-name";
      const joined = document.createElement("small");
      joined.textContent = `Joined ${new Date(member.joinedAt).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })}`;
      nameText.append(member.name, joined);
      name.append(avatar, nameText);
      const status = document.createElement("td");
      const badge = document.createElement("span");
      badge.className = "student-status";
      status.append(badge);
      const session = document.createElement("td");
      session.className = "session-cell";
      const attendanceTd = document.createElement("td");
      attendanceTd.className = "attendance-cell";
      const actions = document.createElement("td");
      actions.className = "actions-cell";
      row.append(name, status, session, attendanceTd, actions);
      body.append(row);
    });
    newIds = new Set();
    updateStudentStatuses();
  }

  function updateStudentStatuses() {
    const labels = { session: "In live session", online: "Online", offline: "Offline" };
    const memberById = new Map(roster.map((member) => [member.id, member]));
    document.querySelectorAll("#studentRows tr[data-student-id]").forEach((row) => {
      const member = memberById.get(row.dataset.studentId);
      if (!member) return;
      const state = studentState(member.id);
      const badge = row.querySelector(".student-status");
      badge.dataset.state = state;
      badge.textContent = labels[state];
      const session = sessionState(member);
      const sessionCell = row.querySelector(".session-cell");
      sessionCell.textContent = session.text;
      sessionCell.dataset.state = session.state;
      attendanceCell(row.querySelector(".attendance-cell"), member);
      fillActions(row.querySelector(".actions-cell"), member, session.state);
    });
    const item = selected();
    if (!item) return;
    const onlineCount = online.get(item.id)?.size || 0;
    const parts = [plural(roster.length, "student"), `${onlineCount} online`];
    if (live?.classId === item.id) parts.push(joinedSummary(item));
    $("#studentsStatus").textContent = roster.length
      ? `${parts.join(" · ")}. Everyone here is invited to each live session automatically.`
      : "Students appear here the moment they join. Everyone on this list is invited to each live session automatically.";
  }

  function renderSettings() {
    const item = selected();
    if (!item) return;
    $("#renameInput").value = item.name;
    $("#joiningToggle").checked = item.joining_open;
    $("#passwordState").textContent = item.join_password_protected ? "· On" : "· Off";
    $("#removePassword").disabled = !item.join_password_protected;
    $("#lateInput").value = item.late_after_minutes ?? 10;
    $("#lateForm button[type='submit']").disabled = item.late_after_minutes === null;
    $("#lateHint").textContent = item.late_after_minutes === null
      ? "Run the attendance database update (see README) to change this."
      : `Students who join a live session more than ${plural(item.late_after_minutes, "minute")} after it starts are marked late.`;
    ["#joiningToggle", "#regenerateCode", "#removePassword", "#passwordForm button[type='submit']", "#deleteClass"].forEach((selector) => {
      const element = $(selector);
      if (element && !hasClassSettings) element.disabled = true;
    });
  }

  let shownView = null;
  function renderView() {
    const inClass = view === "class" && Boolean(selected());
    const inProfile = view === "profile";
    const overview = OVERVIEWS[view] ? view : null;
    $("#classesView").hidden = inClass || inProfile || Boolean(overview);
    $("#classView").hidden = !inClass;
    $("#profileView").hidden = !inProfile;
    $("#allStudentsView").hidden = overview !== "all-students";
    $("#reportView").hidden = overview !== "report";
    $("#demoView").hidden = overview !== "demo";
    // Exports are for real data only: no export button while the Demo is open.
    document.querySelectorAll("[data-export-report]").forEach((button) => { button.hidden = overview === "demo"; });
    renderSidebarClasses();
    syncAddress();
    document.querySelectorAll("[data-nav]").forEach((button) => {
      const target = button.dataset.nav;
      const current = inProfile ? target === "profile" : inClass ? target === tab : overview ? target === NAV_FOR_VIEW[overview] : target === "classes";
      if (button.classList.contains("nav-item") || button.classList.contains("user-card")) {
        if (current) button.setAttribute("aria-current", "page");
        else button.removeAttribute("aria-current");
      }
    });
    const names = { live: "Live monitor", posts: "Posts", assignments: "Assignments", quizzes: "Quizzes", students: "Master list", attendance: "Attendance", history: "History", settings: "Settings" };
    renderCrumbs(overview ? [{ label: OVERVIEWS[overview].label }]
      : inProfile ? [{ label: "My profile" }]
      : inClass ? [{ label: selected().name, go: () => openClass(selectedId, "live") }, { label: names[tab] }]
      : [{ label: "Home" }]);
    if (inClass) renderClassHeader();
    // The shared My profile page (profile.js) ends a theme preview when it is left.
    const name = overview || (inProfile ? "profile" : inClass ? "class" : "dashboard");
    if (name !== shownView) {
      const previous = shownView;
      shownView = name;
      window.neuroFocusView = name;
      window.dispatchEvent(new CustomEvent("neurofocus:viewchange", { detail: { name, previous } }));
    }
  }

  // Breadcrumb trail in the header: every part but the last is a link ("Teacher" goes Home).
  function renderCrumbs(trail) {
    const nav = $("#crumbs");
    const focusedLabel = nav.contains(document.activeElement) ? document.activeElement.textContent : null;
    const parts = [{ label: "Teacher", go: showClasses }, ...trail];
    nav.replaceChildren(...parts.flatMap((part, index) => {
      const last = index === parts.length - 1;
      let node;
      if (last) {
        node = document.createElement("span");
        node.className = "crumb-current";
        node.setAttribute("aria-current", "page");
      } else {
        node = document.createElement("button");
        node.type = "button";
        node.className = "crumb-link";
        node.addEventListener("click", part.go);
      }
      node.textContent = part.label;
      if (!index) return [node];
      const sep = document.createElement("span");
      sep.className = "crumb-sep";
      sep.setAttribute("aria-hidden", "true");
      sep.textContent = "/";
      return [sep, node];
    }));
    // Keep keyboard focus in the trail after using it (on the same part if it's still a link).
    if (focusedLabel !== null) {
      const links = [...nav.querySelectorAll(".crumb-link")];
      (links.find((link) => link.textContent === focusedLabel) || links[0])?.focus();
    }
  }

  // ---------- Page addresses ----------
  // Each page has its own address (#home, #class/<id>/<tab>, #profile), so the browser's Back and
  // Forward buttons move between pages and a refresh reopens the same page. Other hashes (the Home
  // tiles jump to cards on the page) are left alone.
  let lastAddress = "";
  let routing = false;
  const currentAddress = () => (OVERVIEWS[view] ? OVERVIEWS[view].address : view === "profile" ? "#profile"
    : view === "class" && selected() ? `#class/${selectedId}/${tab}` : "#home");
  function syncAddress() {
    const next = currentAddress();
    if (routing || next === lastAddress) { lastAddress = next; return; }
    // The first page shown replaces the address instead of adding a step to Back.
    if (lastAddress) window.history.pushState(null, "", next);
    else window.history.replaceState(null, "", next);
    lastAddress = next;
  }
  function routeTo(hash) {
    const [kind, id, part] = hash.replace(/^#/, "").split("/");
    if (kind === "profile" || kind === "profile-appearance") { showProfile(kind === "profile" ? "" : kind); return true; }
    if (kind === "class") {
      // A class that no longer exists (deleted, or a stale link) goes Home.
      if (classes.some((item) => item.id === id)) openClass(id, TABS.includes(part) ? part : "live");
      else showClasses();
      return true;
    }
    if (kind === "home" || kind === "") { showClasses(); return true; }
    const overview = Object.keys(OVERVIEWS).find((key) => OVERVIEWS[key].address === `#${kind}`);
    if (overview) { showOverview(overview); return true; }
    return false;
  }
  window.addEventListener("popstate", () => {
    routing = true;
    try { routeTo(window.location.hash); } finally { routing = false; }
  });

  // All students and the attendance report (teacher-overview.js fills them in when shown).
  function showOverview(name) {
    view = name;
    renderView();
    window.scrollTo({ top: 0 });
    document.querySelector("main")?.scrollTo({ top: 0 });
  }

  function showProfile(section = "") {
    view = "profile";
    renderView();
    const main = document.querySelector("main");
    const target = section ? document.getElementById(section) : null;
    if (target) target.scrollIntoView({ block: "start" });
    else { window.scrollTo({ top: 0 }); main?.scrollTo({ top: 0 }); }
  }

  // Shared pages call this to move around ("profile", "profile-appearance", "dashboard").
  window.neuroFocusNavigate = (hash) => {
    if (hash === "profile" || hash === "profile-appearance") showProfile(hash === "profile" ? "" : hash);
    else if (hash === "all-students") showOverview("all-students");
    else if (hash === "attendance-report") showOverview("report");
    else if (hash === "demo") showOverview("demo");
    else showClasses();
  };

  function setTab(next) {
    tab = TABS.includes(next) ? next : "live";
    document.querySelectorAll(".class-tabs [data-tab]").forEach((button) => {
      button.setAttribute("aria-selected", String(button.dataset.tab === tab));
    });
    TABS.forEach((name) => { $(`#tab-${name}`).hidden = name !== tab; });
    window.neuroFocusClassTab = tab;
    window.dispatchEvent(new CustomEvent("neurofocus:class-tab", { detail: { tab } }));
    if (tab === "settings") renderSettings();
    if (tab === "students") renderStudents();
    renderView();
  }

  // ---------- Navigation ----------
  function openClass(id, nextTab = tab) {
    if (!classes.some((item) => item.id === id)) return;
    const changed = id !== selectedId;
    selectedId = id;
    try { localStorage.setItem(selectedKey, id); } catch { /* storage unavailable */ }
    view = "class";
    if (changed) {
      roster = [];
      rosterLoadedFor = "";
      newIds = new Set();
      window.neuroFocusClass = selected();
      window.dispatchEvent(new CustomEvent("neurofocus:classchange", { detail: selected() }));
      announceLive();
      void loadRoster();
    }
    setTab(nextTab);
    window.scrollTo({ top: 0 });
    document.querySelector("main")?.scrollTo({ top: 0 });
  }

  function showClasses() {
    view = "classes";
    renderView();
    renderClassGrid();
  }

  function announceLive() {
    const isLive = live?.classId === selectedId;
    window.neuroFocusLiveSession = { classId: selectedId, live: isLive, since: isLive ? live.since : null, sessionId: isLive ? live.sessionId || null : null };
    window.dispatchEvent(new CustomEvent("neurofocus:live-session", { detail: window.neuroFocusLiveSession }));
  }

  // ---------- Actions ----------
  async function toggleSession() {
    const item = selected();
    if (!item) return;
    const toggle = $("#sessionToggle");
    if (live?.classId === item.id) {
      const ok = await confirmAction({
        title: "End the live session?",
        message: live.sessionId
          ? `Students in ${item.name} stop sharing their attention with you. Attendance is saved, and anyone who didn’t join is marked absent.`
          : `Students in ${item.name} will stop sharing their attention with you.`,
        confirmLabel: "End session"
      });
      if (!ok) return;
      const sessionId = live.sessionId;
      toggle.disabled = true;
      const { error } = sessionId ? await supabase.rpc("end_class_session", { p_session_id: sessionId }) : { error: null };
      toggle.disabled = false;
      if (error) {
        notify({ title: "Couldn’t end the session", text: error.message, kind: "error", timeoutMs: 9000 });
        return;
      }
      live = null;
      saveLive();
      sessionRemovedIds = new Set();
      invites = new Map();
      publishPresence(item.id);
      notify({
        title: "Live session ended",
        text: sessionId ? "Attendance is saved. Students who didn’t join are marked absent." : `${item.name} is no longer sharing attention.`,
        kind: "success",
        actions: sessionId ? [{ label: "View attendance", onClick: () => setTab("attendance") }] : []
      });
    } else {
      let session = null;
      if (hasSessions) {
        toggle.disabled = true;
        const { data, error } = await supabase.rpc("start_class_session", { p_class_id: item.id });
        toggle.disabled = false;
        if (error && isMissingSql(error)) hasSessions = false;
        else if (error) {
          notify({ title: "Couldn’t start the live session", text: error.message, kind: "error", timeoutMs: 9000 });
          return;
        } else session = data;
      }
      const previous = live?.classId;
      live = { classId: item.id, since: session?.started_at || new Date().toISOString(), sessionId: session?.id || null };
      saveLive();
      sessionRemovedIds = new Set();
      invites = new Map();
      lastInviteKey = "";
      if (previous) publishPresence(previous);
      publishPresence(item.id);
      notify({
        title: "You’re live",
        text: session
          ? `${plural(session.invited, "student")} on the master list ${session.invited === 1 ? "was" : "were"} invited automatically. Attendance is being taken.`
          : `Students in ${item.name} have been asked to join. Run the attendance database update (see README) to save attendance.`,
        kind: "live"
      });
      setTab("live");
    }
    sharing.set(item.id, new Map());
    announceLive();
    refreshAttendance();
    renderClassHeader();
    renderClassGrid();
    if (tab === "students") renderStudents();
  }

  // Removing a student from the live session keeps them on the master list; they can be let back in.
  async function setSessionRemoved(member, remove) {
    const item = selected();
    if (!item || live?.classId !== item.id) return;
    if (remove) {
      const ok = await confirmAction({
        title: `Remove ${member.name} from this session?`,
        message: `${member.name} stops sharing with you and can’t rejoin this session unless you let them back in. They stay on the ${item.name} master list and are invited to future sessions automatically.`,
        confirmLabel: "Remove from session",
        danger: true
      });
      if (!ok) return;
    }
    if (live.sessionId) {
      const { error } = await supabase.rpc("set_session_removed", { p_session_id: live.sessionId, p_student_id: member.id, p_remove: remove });
      if (error) {
        notify({ title: "Couldn’t update the session", text: error.message, kind: "error", timeoutMs: 9000 });
        return;
      }
    }
    invites.delete(member.id);
    if (remove) {
      sessionRemovedIds.add(member.id);
      sharing.get(item.id)?.delete(member.id);
      window.dispatchEvent(new CustomEvent("neurofocus:live-attention", { detail: { studentId: member.id, classId: item.id, state: "Stopped" } }));
    } else sessionRemovedIds.delete(member.id);
    publishPresence(item.id);
    notify({
      title: remove ? `${member.name} was removed from the session` : `${member.name} can rejoin the session`,
      text: remove ? "They’re still on the master list." : "They’ve been told they can join again.",
      kind: "success"
    });
    refreshAttendance();
    updateStudentStatuses();
    renderClassHeader();
  }

  function inviteAgain(member) {
    const item = selected();
    if (!item || live?.classId !== item.id) return;
    invites.set(member.id, Date.now());
    publishPresence(item.id);
    const isOnline = online.get(item.id)?.has(member.id);
    notify({
      title: `Invite sent to ${member.name}`,
      text: isOnline ? "They’ll see a notification now." : "They’ll see it as soon as they open Neuro-Focus during this session.",
      kind: "success"
    });
    updateStudentStatuses();
  }

  async function removeStudent(member) {
    const item = selected();
    if (!item) return;
    const ok = await confirmAction({
      title: `Remove ${member.name}?`,
      message: `${member.name} comes off the ${item.name} master list and loses access to its live sessions. Their past attendance is kept. They can rejoin with the join code unless you close joining or make a new code in Settings. To take them out of just today’s session, use “Remove from session” instead.`,
      confirmLabel: "Remove from class",
      danger: true
    });
    if (!ok) return;
    const { error, count } = await supabase.from("class_members").delete({ count: "exact" })
      .eq("class_id", item.id).eq("student_id", member.id);
    if (error || count === 0) {
      notify({ title: "Couldn’t remove the student", text: missingSql(error) || count === 0 ? SETUP_TEXT : error.message, kind: "error", timeoutMs: 9000 });
      return;
    }
    removed.set(item.id, [...(removed.get(item.id) || []), { id: member.id, at: Date.now() }]);
    sharing.get(item.id)?.delete(member.id);
    sessionRemovedIds.delete(member.id);
    publishPresence(item.id);
    notify({
      title: `${member.name} was removed`,
      text: `They’re off the master list and no longer have access to ${item.name}.`,
      kind: "success",
      actions: [{ label: "Make a new code", onClick: () => setTab("settings") }]
    });
    scheduleRefresh();
  }

  async function updateClass(fields, successTitle) {
    const item = selected();
    const { error } = await supabase.from("classes").update(fields).eq("id", item.id);
    if (error) {
      notify({ title: "Couldn’t save", text: missingSql(error) ? SETUP_TEXT : error.message, kind: "error", timeoutMs: 9000 });
      return false;
    }
    notify({ title: successTitle, kind: "success" });
    await loadClasses();
    renderSettings();
    return true;
  }

  async function copyCode(classId = selectedId) {
    const item = classes.find((entry) => entry.id === classId);
    if (!item) return;
    const ok = await copyText(item.join_code);
    notify({ title: ok ? "Join code copied" : item.join_code, text: ok ? `${item.join_code} · share it with your students.` : "Copy this code and share it with your students.", kind: ok ? "success" : "info" });
  }

  // New class dialog
  const newDialog = $("#newClassDialog");
  function openNewClass() {
    $("#createClassForm").reset();
    $("#createClassMessage").textContent = "";
    newDialog.showModal();
    $("#className").focus();
  }
  $("#cancelNewClass").addEventListener("click", () => newDialog.close());
  $("#createClassForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const message = $("#createClassMessage");
    const submit = event.currentTarget.querySelector("button[type='submit']");
    submit.disabled = true;
    message.dataset.state = "";
    message.textContent = "Creating your class…";
    const { data, error } = await supabase.rpc("create_class", {
      p_name: $("#className").value.trim(),
      p_join_password: $("#newClassPassword").value || null
    });
    submit.disabled = false;
    if (error) {
      message.dataset.state = "error";
      message.textContent = error.message || "Couldn’t create the class. Try again.";
      return;
    }
    newDialog.close();
    await loadClasses();
    openClass(data.id, "students");
    notify({
      title: `${data.name} is ready`,
      text: `Share join code ${data.join_code} with your students.`,
      kind: "success",
      timeoutMs: 12000,
      actions: [{ label: "Copy code", primary: true, onClick: () => copyCode() }]
    });
  });

  // ---------- Wiring ----------
  document.querySelectorAll("[data-nav]").forEach((button) => {
    button.addEventListener("click", () => {
      const target = button.dataset.nav;
      if (target === "classes") showClasses();
      else if (target === "new-class") openNewClass();
      else if (target === "profile" || target === "profile-appearance") window.neuroFocusNavigate(target);
      else if (target === "all-students") showOverview("all-students");
      else if (target === "attendance-report") showOverview("report");
      else if (target === "demo") showOverview("demo");
      else if (selected()) openClass(selectedId, target);
    });
  });
  document.querySelectorAll(".class-tabs [data-tab]").forEach((button) => {
    button.addEventListener("click", () => setTab(button.dataset.tab));
  });
  $("#navLiveNow").addEventListener("click", () => { if (live) openClass(live.classId, "live"); });
  $("#sessionToggle").addEventListener("click", () => { void toggleSession(); });
  $("#classCode").addEventListener("click", () => { void copyCode(); });
  $("#copyInvite").addEventListener("click", () => { void copyCode(); });
  $("#copyCodeSetting").addEventListener("click", () => { void copyCode(); });

  $("#renameForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = $("#renameInput").value.trim();
    if (name.length < 2 || name === selected()?.name) return;
    await updateClass({ name }, "Class renamed");
  });
  $("#joiningToggle").addEventListener("change", async (event) => {
    const open = event.currentTarget.checked;
    const saved = await updateClass({ joining_open: open }, open ? "Joining is open" : "Joining is closed");
    if (!saved) event.currentTarget.checked = !open;
  });
  $("#regenerateCode").addEventListener("click", async () => {
    const item = selected();
    const ok = await confirmAction({
      title: "Make a new join code?",
      message: `The current code ${item.join_code} stops working right away. Students already in ${item.name} stay in the class.`,
      confirmLabel: "Make new code"
    });
    if (!ok) return;
    const { data, error } = await supabase.rpc("regenerate_join_code", { p_class_id: item.id });
    if (error) {
      notify({ title: "Couldn’t make a new code", text: missingSql(error) ? SETUP_TEXT : error.message, kind: "error", timeoutMs: 9000 });
      return;
    }
    notify({ title: "New join code", text: `${data} · the old code no longer works.`, kind: "success", actions: [{ label: "Copy code", primary: true, onClick: () => copyCode() }] });
    await loadClasses();
  });
  $("#lateForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const minutes = Math.round(Number($("#lateInput").value));
    if (!Number.isFinite(minutes) || minutes < 0 || minutes > 240) {
      notify({ title: "Choose 0 to 240 minutes", kind: "error" });
      return;
    }
    if (minutes === selected()?.late_after_minutes) return;
    await updateClass({ late_after_minutes: minutes }, `Late after ${plural(minutes, "minute")}`);
  });

  // Attendance data loaded by teacher-attendance.js fills the master list's columns.
  window.addEventListener("neurofocus:attendance", (event) => {
    attendance = event.detail || attendance;
    if (attendance.classId !== selectedId) return;
    updateStudentStatuses();
    renderClassHeader();
  });

  $("#passwordForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const password = $("#passwordInput").value;
    if (password.length < 6) {
      notify({ title: "Password too short", text: "Use at least 6 characters.", kind: "error" });
      return;
    }
    const { error } = await supabase.rpc("set_class_password", { p_class_id: selectedId, p_password: password });
    if (error) {
      notify({ title: "Couldn’t set the password", text: missingSql(error) ? SETUP_TEXT : error.message, kind: "error", timeoutMs: 9000 });
      return;
    }
    $("#passwordInput").value = "";
    notify({ title: "Join password set", text: "New students now need the code and this password.", kind: "success" });
    await loadClasses();
    renderSettings();
  });
  $("#removePassword").addEventListener("click", async () => {
    const { error } = await supabase.rpc("set_class_password", { p_class_id: selectedId, p_password: null });
    if (error) {
      notify({ title: "Couldn’t remove the password", text: missingSql(error) ? SETUP_TEXT : error.message, kind: "error", timeoutMs: 9000 });
      return;
    }
    notify({ title: "Join password removed", text: "Students can join with the code alone.", kind: "success" });
    await loadClasses();
    renderSettings();
  });
  $("#deleteClass").addEventListener("click", async () => {
    const item = selected();
    const ok = await confirmAction({
      title: `Delete ${item.name}?`,
      message: "This removes the class, its join code and every student's class notes for it. It can't be undone.",
      confirmLabel: "Delete class",
      danger: true,
      requireText: item.name
    });
    if (!ok) return;
    const { error, count } = await supabase.from("classes").delete({ count: "exact" }).eq("id", item.id);
    if (error || count === 0) {
      notify({ title: "Couldn’t delete the class", text: missingSql(error) || count === 0 ? SETUP_TEXT : error.message, kind: "error", timeoutMs: 9000 });
      return;
    }
    if (live?.classId === item.id) {
      live = null;
      saveLive();
      sessionRemovedIds = new Set();
      invites = new Map();
    }
    selectedId = "";
    window.neuroFocusClass = null;
    window.dispatchEvent(new CustomEvent("neurofocus:classchange", { detail: null }));
    notify({ title: `${item.name} was deleted`, kind: "success" });
    await loadClasses();
    showClasses();
  });

  // Keep "in live session" statuses and counts fresh as readings arrive or stop.
  window.setInterval(() => {
    if (view !== "class") return;
    renderClassHeader();
    updateStudentStatuses();
  }, 3000);
  // Pick up joins/removals (and finished database updates) made while this tab was in the background.
  const recheckSetup = () => missingDatabaseUpdates(supabase)
    .then((missing) => showSetupBanner(missing, { forTeacher: true }))
    .catch(() => {});
  window.addEventListener("focus", () => {
    scheduleRefresh();
    void recheckSetup();
  });
  window.addEventListener("pagehide", () => supabase.removeAllChannels());

  // Actions for the teacher Home (teacher-home.js), with the same behaviour as the buttons here.
  window.neuroFocusTeacherActions = { openClass, showClasses, openNewClass, copyCode, showOverview };
  // Refresh the "students sharing" count on Home while a session is live.
  window.setInterval(() => { if (live && view === "classes") publishStatus(); }, 5000);

  // ---------- Start ----------
  void recheckSetup();
  try {
    await loadClasses();
    await closeStaleSessions();
    await loadOpenSession();
    void keepSessionAlive();
    // Reopen the page in the address (after a refresh or from a link); otherwise land on the live
    // monitor if a session is running, or on Home.
    const linked = /^#(class|profile|students|attendance-report|demo)/.test(window.location.hash) && routeTo(window.location.hash);
    if (linked) { /* done */ }
    else if (live && classes.some((item) => item.id === live.classId)) openClass(live.classId, "live");
    else showClasses();
  } catch (error) {
    console.error("Class loading failed", error);
    $("#classGrid").replaceChildren(Object.assign(document.createElement("p"), {
      className: "empty-state",
      textContent: "Couldn’t load your classes. Check your connection and refresh."
    }));
  }
}
