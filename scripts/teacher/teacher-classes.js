// Teacher class management: Home (#home), the Classes page (#classes), one class at a time with tabs
// (Posts, Assignments, Quizzes, Live focus, then Master list, Attendance, History, Settings), live sessions, the class master
// list, removing students from a session or the class, and class settings. Live sessions are
// saved (class_sessions) so attendance can be taken; teacher-attendance.js shows it.
// Live updates use private Supabase Realtime class channels (class-live.js).
import {
  openClassChannel, onlineStudentIds, confirmAction, notify, copyText, missingDatabaseUpdates, showSetupBanner, isMissingSql
} from "../shared/class-live.js";
import { paintAvatar, avatarUrls } from "../shared/avatars.js";
import { classHue } from "../shared/class-colors.js";
import { classColor } from "../student/class-colors.js";

const app = await window.neuroFocusReady;

if (app) {
  const { supabase } = app;
  const $ = (selector) => document.querySelector(selector);
  const selectedKey = "neuroFocusCurrentClassId";
  const liveKey = `neuroFocusLiveSession:${app.user.id}`;
  const TABS = ["live", "posts", "assignments", "quizzes", "students", "attendance", "history", "settings"];
  const TAB_NAMES = { live: "Live focus", posts: "Posts", assignments: "Assignments", quizzes: "Quizzes", students: "Master list", attendance: "Attendance", history: "History", settings: "Settings" };
  const REMOVED_NOTICE_MS = 2 * 60 * 1000; // removed students are told within this window
  const SHARING_STALE_MS = 6000;
  const SETUP_TEXT = "Run the class management database update first (see README).";

  let classes = [];
  let classesLoaded = false;
  let roster = [];                 // members of the open class: { id, name, joinedAt }
  let rosterLoadedFor = "";
  let selectedId = "";
  let view = "classes";             // "classes" (Home), "list" (the Classes page), "class" (one class), "profile" (Profile settings),
                                   // "all-students" or "report" (attendance across classes, teacher-overview.js)
  const OVERVIEWS = {
    list: { address: "#classes", label: "Classes" },
    "all-students": { address: "#students", label: "All students", underClasses: true },
    report: { address: "#attendance-report", label: "Attendance report", underClasses: true }
  };
  // Sidebar entry for each page; a class page marks its own class in the sidebar's class list.
  const NAV_FOR_VIEW = { list: "classes", "all-students": "all-students", report: "attendance-report" };
  let tab = "live";
  // A class opens on Live focus while its session is live, otherwise on Posts.
  // A class opens on Live focus, the main feature (its board explains how to start a session).
  const defaultTab = () => "live";
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
    classesLoaded = true;
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
    publishRoster();
    window.dispatchEvent(new CustomEvent("neurofocus:roster-loaded", { detail: { classId, members: window.neuroFocusRoster } }));
    renderStudents();
    renderClassHeader();
    void inviteNewMembers();
    void loadRosterPictures(classId);
  }

  // The open class's students, for the live board (teacher-analytics.js): names and pictures.
  function publishRoster() {
    window.neuroFocusRoster = roster.map(({ id, name, avatarPreset, avatarUrl }) => ({ id, name, avatarPreset, avatarUrl: avatarUrl || null }));
  }

  // Uploaded pictures are private: storage hands this teacher short-lived links only for
  // students in their classes. Until they arrive (or if they can't), built-in avatars or initials show.
  async function loadRosterPictures(classId) {
    const paths = roster.map((member) => member.avatarPath).filter(Boolean);
    if (!paths.length) return;
    const urls = await avatarUrls(supabase, paths);
    if (classId !== selectedId) return;
    roster.forEach((member) => { member.avatarUrl = urls.get(member.avatarPath) || null; });
    publishRoster();
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
    set("#sumClasses", String(classes.length));
    set("#sumClassesLine", classes.length ? `${classes.length} ${classes.length === 1 ? "class" : "classes"} · ${plural(classes.reduce((sum, item) => sum + item.memberCount, 0), "student")}` : "No classes yet");
    set("#sumStudents", String(classes.reduce((sum, item) => sum + item.memberCount, 0)));
    set("#sumOnline", String(totalOnline));
    renderSidebarClasses();
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
    renderClassGrid();
    if (classId === selectedId) {
      renderClassHeader();
      updateStudentStatuses();
    }
  }

  // Sidebar: the fixed pages (with counts), a "Live now" shortcut while a session runs, and every
  // class with who's online and a live dot. The open class is marked.
  let sidebarKey = "";
  function renderSidebarClasses() {
    const liveClass = live ? classes.find((item) => item.id === live.classId) : null;
    $("#navLiveNow").hidden = !liveClass;
    $("#navLiveClass").textContent = liveClass?.name || "";
    const students = classes.reduce((sum, item) => sum + item.memberCount, 0);
    $("#navClassCount").textContent = classes.length ? String(classes.length) : "";
    $("#navStudentCount").textContent = students ? String(students) : "";
    const openId = view === "class" ? selectedId : "";
    const key = JSON.stringify([classesLoaded, openId, live?.classId, classes.map((item) => [item.id, item.name, item.memberCount, online.get(item.id)?.size || 0])]);
    if (key === sidebarKey) return;
    sidebarKey = key;
    const box = $("#sidebarClasses");
    const focusedId = box.contains(document.activeElement) ? document.activeElement.dataset.classId : null;
    if (!classesLoaded || !classes.length) {
      const empty = document.createElement("p");
      empty.className = "sidebar-empty";
      empty.textContent = classesLoaded ? "No classes yet. Press + to create one." : "Loading…";
      box.replaceChildren(empty);
      return;
    }
    box.replaceChildren(...classes.map((item) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "nav-item sidebar-class";
      button.dataset.classId = item.id;
      button.dataset.open = String(item.id === openId);
      if (item.id === openId) button.setAttribute("aria-current", "page");
      const count = online.get(item.id)?.size || 0;
      button.title = `${item.name} · ${plural(item.memberCount, "student")}${count ? `, ${count} online` : ""}`;
      const initial = document.createElement("span");
      initial.className = "cs-badge";
      initial.style.setProperty("--hue", String(classHue(item.id)));
      initial.setAttribute("aria-hidden", "true");
      initial.textContent = initialOf(item.name);
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = item.name;
      button.append(initial, name);
      if (live?.classId === item.id) {
        const dot = document.createElement("span");
        dot.className = "nav-live";
        dot.innerHTML = '<span class="live-dot"></span><span class="sr-only">, live now</span>';
        button.append(dot);
      } else if (count) {
        const badge = document.createElement("span");
        badge.className = "nav-online";
        badge.textContent = String(count);
        badge.setAttribute("aria-label", `${count} online`);
        button.append(badge);
      }
      button.addEventListener("click", () => openClass(item.id, defaultTab(item.id)));
      return button;
    }));
    if (focusedId) box.querySelector(`[data-class-id="${CSS.escape(focusedId)}"]`)?.focus();
  }

  // ---------- Classes page: the same live strip, toolbar and cards as the student Classes page
  // (styles/class-cards.css). Each card opens the class on Live focus, or straight to a section.
  let classFilter = "all";
  const CARD_SECTIONS = [["live", "i-live", "Live"], ["posts", "i-megaphone", "Posts"], ["assignments", "i-assignment", "Work"], ["quizzes", "i-quiz", "Quizzes"]];
  const SECTION_NAMES = { live: "Live focus", posts: "Posts", assignments: "Assignments", quizzes: "Quizzes" };
  const make = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const useIcon = (id) => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "icon");
    svg.setAttribute("aria-hidden", "true");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", `#${id}`);
    svg.append(use);
    return svg;
  };
  const clockOf = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "");

  let cardsKey = "";
  function renderClassGrid() {
    const grid = $("#classGrid");
    renderSummary();
    renderSidebarClasses();
    // Rebuilt only when something on the page changed (online counts arrive often).
    const key = JSON.stringify([classesLoaded, classFilter, $("#tClassesSearch")?.value || "", live?.classId, live?.since, live ? sharingCount(live.classId) : 0,
      classes.map((item) => [item.id, item.name, item.join_code, item.memberCount, item.joining_open, item.join_password_protected, online.get(item.id)?.size || 0])]);
    if (key === cardsKey) return;
    cardsKey = key;
    renderClassesLive();
    const toolbar = $("#tClassesToolbar");
    if (toolbar) toolbar.hidden = classes.length < 4;
    if (!classesLoaded) return;
    if (!classes.length) {
      const empty = make("div", "classes-empty");
      const button = make("button", "btn-primary");
      button.type = "button";
      button.append(useIcon("i-plus"), "Create your first class");
      button.addEventListener("click", openNewClass);
      empty.append(make("h2", "", "No classes yet"), make("p", "", "Create a class to get a join code for your students. Then start a live session from its Live focus tab."), button);
      grid.replaceChildren(empty);
      return;
    }
    const query = ($("#tClassesSearch")?.value || "").trim().toLowerCase();
    const shown = classes.filter((item) => (classFilter !== "live" || live?.classId === item.id) && (!query || item.name.toLowerCase().includes(query)));
    if (!shown.length) {
      grid.replaceChildren(make("p", "empty-state", classFilter === "live" ? "None of your classes is live right now." : "No classes match that search."));
      return;
    }
    const focusKey = grid.contains(document.activeElement) ? document.activeElement.dataset.focusKey : null;
    grid.replaceChildren(...shown.map(classCard));
    if (focusKey) grid.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`)?.focus();
    // Later updates (who's online, live status) replace cards without replaying the entrance.
    window.setTimeout(() => { grid.dataset.settled = "true"; }, 900);
  }

  function classCard(item, index) {
    const isLive = live?.classId === item.id;
    const onlineCount = online.get(item.id)?.size || 0;
    const card = make("article", "class-card-v2");
    card.setAttribute("role", "listitem");
    card.dataset.classId = item.id;
    card.dataset.live = String(isLive);
    card.style.setProperty("--class-color", classColor(item.id));
    card.style.setProperty("--i", String(index));

    // Colour band with the class initial, and whether it's live or who's online
    const band = make("div", "class-band");
    const initial = make("span", "class-band-initial", initialOf(item.name));
    initial.setAttribute("aria-hidden", "true");
    const badge = make("span", "class-badge");
    if (isLive) { badge.dataset.state = "live"; badge.append(make("span", "live-dot"), "Live now"); }
    else if (onlineCount) { badge.dataset.state = "online"; badge.textContent = `${onlineCount} online`; }
    else badge.hidden = true;
    band.append(initial, badge);

    // Name (the whole card opens the class on Live focus), join code and facts
    const body = make("div", "class-body");
    const title = make("h3", "class-name");
    const open = make("button", "class-open-link", item.name);
    open.type = "button";
    open.dataset.focusKey = `open-${item.id}`;
    open.addEventListener("click", () => openClass(item.id, "live"));
    title.append(open);
    const codeRow = make("div", "class-teacher-row");
    const code = make("button", "class-code");
    code.type = "button";
    code.dataset.focusKey = `code-${item.id}`;
    code.title = "Copy join code";
    code.setAttribute("aria-label", `Copy join code ${item.join_code}`);
    code.append(make("span", "", item.join_code), useIcon("i-copy"));
    code.addEventListener("click", () => { void copyCode(item.id); });
    codeRow.append(code);
    if (isLive && live.since) codeRow.append(make("small", "class-since", `live since ${clockOf(live.since)}`));
    const facts = make("div", "class-facts");
    facts.append(make("span", "", plural(item.memberCount, "student")));
    facts.append(make("span", onlineCount ? "is-online" : "", `● ${onlineCount} online`));
    if (!item.joining_open) facts.append(make("span", "is-closed", "Joining closed"));
    if (item.join_password_protected) facts.append(make("span", "", "Password to join"));
    body.append(title, codeRow, facts);

    // Shortcuts to each part of the class
    const sections = make("nav", "class-shortcuts");
    sections.setAttribute("aria-label", `${item.name} sections`);
    CARD_SECTIONS.forEach(([tabName, iconId, label]) => {
      const shortcut = make("button", "class-shortcut");
      shortcut.type = "button";
      shortcut.dataset.focusKey = `${tabName}-${item.id}`;
      shortcut.title = SECTION_NAMES[tabName];
      shortcut.setAttribute("aria-label", `${item.name}: ${SECTION_NAMES[tabName]}`);
      shortcut.append(useIcon(iconId), make("span", "", label));
      if (tabName === "live" && isLive) shortcut.dataset.live = "true";
      shortcut.addEventListener("click", () => openClass(item.id, tabName));
      sections.append(shortcut);
    });

    // Main action and the ⋯ menu
    const foot = make("div", "class-foot");
    const main = make("button", isLive ? "btn-primary class-main" : "btn-action class-main");
    main.type = "button";
    main.dataset.focusKey = `main-${item.id}`;
    main.append(isLive ? "Open Live focus" : "Open class", useIcon("i-chevron"));
    main.addEventListener("click", () => openClass(item.id, "live"));
    foot.append(main, classCardMenu(item));
    card.append(band, body, sections, foot);
    return card;
  }

  // ⋯ menu: Master list, Attendance, Copy join code, Settings.
  function classCardMenu(item) {
    const wrap = make("div", "class-menu");
    const toggle = make("button", "class-menu-button", "⋯");
    toggle.type = "button";
    toggle.dataset.focusKey = `menu-${item.id}`;
    toggle.setAttribute("aria-label", `More for ${item.name}`);
    toggle.setAttribute("aria-expanded", "false");
    const list = make("div", "class-menu-list");
    list.hidden = true;
    const close = (focus = false) => {
      list.hidden = true;
      toggle.setAttribute("aria-expanded", "false");
      if (focus) toggle.focus();
    };
    const option = (iconId, label, onClick) => {
      const button = make("button", "class-menu-item");
      button.type = "button";
      button.append(useIcon(iconId), label);
      button.addEventListener("click", () => { close(); onClick(); });
      list.append(button);
    };
    option("i-users", "Master list", () => openClass(item.id, "students"));
    option("i-attendance", "Attendance", () => openClass(item.id, "attendance"));
    option("i-copy", `Copy join code (${item.join_code})`, () => { void copyCode(item.id); });
    option("i-settings", "Settings", () => openClass(item.id, "settings"));
    toggle.addEventListener("click", () => {
      const opening = list.hidden;
      document.querySelectorAll("#classGrid .class-menu-list").forEach((other) => { other.hidden = true; });
      document.querySelectorAll("#classGrid .class-menu-button").forEach((other) => other.setAttribute("aria-expanded", "false"));
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

  // The live session running now: a strip above the cards with a way back to it.
  function renderClassesLive() {
    const strip = $("#tClassesLive");
    if (!strip) return;
    const item = live ? classes.find((entry) => entry.id === live.classId) : null;
    strip.hidden = !item;
    if (!item) { strip.replaceChildren(); return; }
    const row = make("div", "classes-live-row");
    row.style.setProperty("--class-color", classColor(item.id));
    const text = make("div", "classes-live-text");
    const kicker = make("span", "classes-live-kicker");
    kicker.append(make("span", "live-dot"), live.since ? `Live now · since ${clockOf(live.since)}` : "Live now");
    const sharing = sharingCount(item.id);
    text.append(kicker, make("b", "", item.name), make("small", "", `${plural(sharing, "student")} sharing attention · ${plural(item.memberCount, "student")} on the master list`));
    const action = make("button", "btn-primary");
    action.type = "button";
    action.append(useIcon("i-live"), "Open Live focus");
    action.addEventListener("click", () => openClass(item.id, "live"));
    row.append(text, action);
    strip.replaceChildren(row);
  }

  $("#tClassesSearch")?.addEventListener("input", () => renderClassGrid());
  document.querySelectorAll("[data-t-class-filter]").forEach((button) => button.addEventListener("click", () => {
    classFilter = button.dataset.tClassFilter;
    document.querySelectorAll("[data-t-class-filter]").forEach((other) => other.setAttribute("aria-pressed", String(other === button)));
    renderClassGrid();
  }));
  document.addEventListener("click", (event) => {
    if (event.composedPath().some((node) => node?.classList?.contains?.("class-menu"))) return;
    document.querySelectorAll("#classGrid .class-menu-list").forEach((list) => { list.hidden = true; });
    document.querySelectorAll("#classGrid .class-menu-button").forEach((button) => button.setAttribute("aria-expanded", "false"));
  });

  function renderClassHeader() {
    const item = selected();
    if (!item) return;
    const isLive = live?.classId === item.id;
    const onlineCount = online.get(item.id)?.size || 0;
    $("#classTitle").textContent = item.name;
    const badge = $("#classInitial");
    if (badge) badge.textContent = initialOf(item.name);
    $("#classCode").textContent = item.join_code;
    $("#classMetaText").textContent = `${plural(item.memberCount, "student")} · ${onlineCount} online`;
    $("#joiningChip").hidden = item.joining_open;
    $("#tabStudentCount").textContent = item.memberCount ? String(item.memberCount) : "";
    $("#tabLiveDot").hidden = !isLive;

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
    $("#classListView").hidden = overview !== "list";
    $("#classView").hidden = !inClass;
    $("#profileView").hidden = !inProfile;
    $("#allStudentsView").hidden = overview !== "all-students";
    $("#reportView").hidden = overview !== "report";
    // The CSV is the open class's live student table: shown on class pages only.
    document.querySelectorAll("[data-export-report]").forEach((button) => { button.hidden = !inClass; });
    renderSidebarClasses();
    syncAddress();
    document.querySelectorAll("[data-nav]").forEach((button) => {
      const target = button.dataset.nav;
      const page = inProfile ? "profile" : inClass ? "" : overview ? NAV_FOR_VIEW[overview] : "home";
      if (button.classList.contains("nav-item") || button.classList.contains("user-card")) {
        if (target === page) button.setAttribute("aria-current", "page");
        else button.removeAttribute("aria-current");
      }
    });
    const toClasses = { label: "Classes", go: () => showOverview("list") };
    renderCrumbs(overview ? [...(OVERVIEWS[overview].underClasses ? [toClasses] : []), { label: OVERVIEWS[overview].label }]
      : inProfile ? [{ label: "Profile settings" }]
      : inClass ? [toClasses, { label: selected().name, go: () => openClass(selectedId, defaultTab(selectedId)) }, { label: TAB_NAMES[tab] }]
      : []);
    document.title = `${overview ? OVERVIEWS[overview].label : inProfile ? "Profile settings" : inClass ? `${selected().name} · ${TAB_NAMES[tab]}` : "Home"} · Neuro-Focus`;
    if (inClass) renderClassHeader();
    // The shared Profile settings page (profile.js) ends a theme preview when it is left.
    const name = overview || (inProfile ? "profile" : inClass ? "class" : "dashboard");
    if (name !== shownView) {
      const previous = shownView;
      shownView = name;
      window.neuroFocusView = name;
      window.dispatchEvent(new CustomEvent("neurofocus:viewchange", { detail: { name, previous } }));
    }
  }

  // Breadcrumb trail in the header: Home / Classes / Biology / Posts. Every part but the last is a link.
  function renderCrumbs(trail) {
    const nav = $("#crumbs");
    const focusedLabel = nav.contains(document.activeElement) ? document.activeElement.textContent : null;
    const parts = [{ label: "Home", go: showClasses }, ...trail];
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
      if (classes.some((item) => item.id === id)) openClass(id, TABS.includes(part) ? part : defaultTab(id));
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
    if (name === "list") renderClassGrid();
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
    else if (hash === "classes") showOverview("list");
    else showClasses();
  };

  function setTab(next) {
    tab = TABS.includes(next) ? next : defaultTab(selectedId);
    document.querySelectorAll(".class-tabs [data-tab]").forEach((button) => {
      button.setAttribute("aria-selected", String(button.dataset.tab === tab));
      button.tabIndex = button.dataset.tab === tab ? 0 : -1;
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
      if (target === "home") showClasses();
      else if (target === "classes") showOverview("list");
      else if (target === "new-class") openNewClass();
      else if (target === "profile" || target === "profile-appearance") window.neuroFocusNavigate(target);
      else if (target === "all-students") showOverview("all-students");
      else if (target === "attendance-report") showOverview("report");
      else if (selected()) openClass(selectedId, target);
    });
  });
  document.querySelectorAll(".class-tabs [data-tab]").forEach((button) => {
    button.addEventListener("click", () => setTab(button.dataset.tab));
  });
  // Arrow keys, Home and End move between the class tabs.
  $(".class-tabs").addEventListener("keydown", (event) => {
    const step = { ArrowRight: 1, ArrowLeft: -1, Home: -99, End: 99 }[event.key];
    if (!step) return;
    event.preventDefault();
    const index = step === -99 ? 0 : step === 99 ? TABS.length - 1 : (TABS.indexOf(tab) + step + TABS.length) % TABS.length;
    setTab(TABS[index]);
    document.querySelector(`.class-tabs [data-tab="${TABS[index]}"]`)?.focus();
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
  window.neuroFocusTeacherActions = { openClass, showClasses, openNewClass, copyCode, showOverview, defaultTab };
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
    const linked = /^#(class|classes|profile|students|attendance-report)/.test(window.location.hash) && routeTo(window.location.hash);
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
