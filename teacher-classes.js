// Teacher class management: all-classes overview, one class at a time with tabs
// (Live monitor, Students, History, Settings), live sessions, student moderation and
// class settings. Live updates use private Supabase Realtime class channels (class-live.js).
import {
  openClassChannel, onlineStudentIds, confirmAction, notify, copyText, missingDatabaseUpdates, showSetupBanner
} from "./class-live.js?v=5";

const app = await window.neuroFocusReady;

if (app) {
  const { supabase } = app;
  const $ = (selector) => document.querySelector(selector);
  const selectedKey = "neuroFocusCurrentClassId";
  const liveKey = `neuroFocusLiveSession:${app.user.id}`;
  const TABS = ["live", "students", "history", "settings"];
  const REMOVED_NOTICE_MS = 2 * 60 * 1000; // removed students are told within this window
  const SHARING_STALE_MS = 6000;
  const SETUP_TEXT = "Run the class management database update first (see README).";

  let classes = [];
  let roster = [];                 // members of the open class: { id, name, joinedAt }
  let rosterLoadedFor = "";
  let selectedId = "";
  let view = "classes";
  let tab = "live";
  let hasClassSettings = true;     // false until the class management SQL has been run
  let newIds = new Set();          // roster rows to highlight once
  let refreshTimer;
  const channels = new Map();      // classId -> { channel, ready }
  const online = new Map();        // classId -> Set(studentId)
  const sharing = new Map();       // classId -> Map(studentId -> last reading time)
  const removed = new Map();       // classId -> [{ id, at }]
  let live = loadLive();           // { classId, since } | null
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
    let { data, error } = await supabase.from("classes").select(`${columns}, joining_open`).order("created_at", { ascending: false });
    if (error && (error.code === "42703" || /joining_open/.test(error.message || ""))) {
      hasClassSettings = false;
      ({ data, error } = await supabase.from("classes").select(columns).order("created_at", { ascending: false }));
    }
    if (error) throw error;
    classes = (data || []).map((item) => ({
      ...item,
      joining_open: item.joining_open ?? true,
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
    const { data, error } = await supabase
      .from("class_members")
      .select("student_id, joined_at, profiles(display_name)")
      .eq("class_id", classId)
      .order("joined_at", { ascending: true });
    if (classId !== selectedId) return;
    if (error) {
      $("#studentsStatus").textContent = "Couldn’t load students. Refresh to try again.";
      return;
    }
    const previous = new Set(roster.map((member) => member.id));
    roster = (data || []).map((member) => ({
      id: member.student_id, name: member.profiles?.display_name || "Student", joinedAt: member.joined_at
    }));
    if (rosterLoadedFor === classId) roster.forEach((member) => { if (!previous.has(member.id)) newIds.add(member.id); });
    rosterLoadedFor = classId;
    window.neuroFocusRoster = roster.map(({ id, name }) => ({ id, name }));
    window.dispatchEvent(new CustomEvent("neurofocus:roster-loaded", { detail: { classId, members: window.neuroFocusRoster } }));
    renderStudents();
    renderClassHeader();
  }

  function scheduleRefresh() {
    window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(async () => {
      try {
        await loadClasses();
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
        broadcasts: ["attention", "member-joined", "member-left"],
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
    entry.channel.track({ role: "teacher", live: isLive, since: isLive ? live.since : null, removed: recent.map((item) => item.id) })
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
      if (!payload.studentId || live?.classId !== classId) return;
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

  function renderClassGrid() {
    const grid = $("#classGrid");
    grid.replaceChildren();
    renderSummary();
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
      ? `Live since ${clock(live.since)} · ${sharingCount(item.id)} of ${plural(item.memberCount, "student")} sharing`
      : other ? `${other.name} is live. Starting here ends that session.` : "Students share their attention only during a live session.";
  }

  function renderStudents() {
    const body = $("#studentRows");
    body.replaceChildren();
    const item = selected();
    if (!item) return;
    if (!roster.length) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = 4;
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
      avatar.textContent = member.name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase();
      name.append(avatar, member.name);
      const status = document.createElement("td");
      const badge = document.createElement("span");
      badge.className = "student-status";
      status.append(badge);
      const joined = document.createElement("td");
      joined.textContent = new Date(member.joinedAt).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
      const actions = document.createElement("td");
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "btn-remove";
      remove.textContent = "Remove";
      remove.setAttribute("aria-label", `Remove ${member.name} from the class`);
      remove.addEventListener("click", () => removeStudent(member));
      actions.append(remove);
      row.append(name, status, joined, actions);
      body.append(row);
    });
    newIds = new Set();
    updateStudentStatuses();
  }

  function updateStudentStatuses() {
    const labels = { session: "In live session", online: "Online", offline: "Offline" };
    document.querySelectorAll("#studentRows tr[data-student-id]").forEach((row) => {
      const state = studentState(row.dataset.studentId);
      const badge = row.querySelector(".student-status");
      badge.dataset.state = state;
      badge.textContent = labels[state];
    });
    const item = selected();
    if (!item) return;
    const onlineCount = online.get(item.id)?.size || 0;
    const parts = [plural(roster.length, "student"), `${onlineCount} online`];
    if (live?.classId === item.id) parts.push(`${sharingCount(item.id)} in the live session`);
    $("#studentsStatus").textContent = roster.length
      ? `${parts.join(" · ")}. Updates live.`
      : "Students appear here the moment they join, and the dots show who is online.";
  }

  function renderSettings() {
    const item = selected();
    if (!item) return;
    $("#renameInput").value = item.name;
    $("#joiningToggle").checked = item.joining_open;
    $("#passwordState").textContent = item.join_password_protected ? "· On" : "· Off";
    $("#removePassword").disabled = !item.join_password_protected;
    ["#joiningToggle", "#regenerateCode", "#removePassword", "#passwordForm button[type='submit']", "#deleteClass"].forEach((selector) => {
      const element = $(selector);
      if (element && !hasClassSettings) element.disabled = true;
    });
  }

  function renderView() {
    const inClass = view === "class" && Boolean(selected());
    $("#classesView").hidden = inClass;
    $("#classView").hidden = !inClass;
    $("#classNav").hidden = !selected();
    document.querySelectorAll("[data-nav]").forEach((button) => {
      const target = button.dataset.nav;
      const current = inClass ? target === tab : target === "classes";
      if (button.classList.contains("nav-item")) {
        if (current) button.setAttribute("aria-current", "page");
        else button.removeAttribute("aria-current");
      }
    });
    const names = { live: "Live monitor", students: "Students", history: "History", settings: "Settings" };
    $("#crumbCurrent").textContent = inClass ? `${selected().name} · ${names[tab]}` : "Classes";
    if (inClass) renderClassHeader();
  }

  function setTab(next) {
    tab = TABS.includes(next) ? next : "live";
    document.querySelectorAll(".class-tabs [data-tab]").forEach((button) => {
      button.setAttribute("aria-selected", String(button.dataset.tab === tab));
    });
    TABS.forEach((name) => { $(`#tab-${name}`).hidden = name !== tab; });
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
    window.neuroFocusLiveSession = { classId: selectedId, live: isLive, since: isLive ? live.since : null };
    window.dispatchEvent(new CustomEvent("neurofocus:live-session", { detail: window.neuroFocusLiveSession }));
  }

  // ---------- Actions ----------
  async function toggleSession() {
    const item = selected();
    if (!item) return;
    if (live?.classId === item.id) {
      const ok = await confirmAction({
        title: "End the live session?",
        message: `Students in ${item.name} will stop sharing their attention with you.`,
        confirmLabel: "End session"
      });
      if (!ok) return;
      live = null;
      saveLive();
      publishPresence(item.id);
      notify({ title: "Live session ended", text: `${item.name} is no longer sharing attention.` });
    } else {
      const previous = live?.classId;
      live = { classId: item.id, since: new Date().toISOString() };
      saveLive();
      if (previous) publishPresence(previous);
      publishPresence(item.id);
      notify({ title: "You’re live", text: `Students in ${item.name} have been asked to join the session.`, kind: "live" });
      setTab("live");
    }
    sharing.set(item.id, new Map());
    announceLive();
    renderClassHeader();
    renderClassGrid();
  }

  async function removeStudent(member) {
    const item = selected();
    if (!item) return;
    const ok = await confirmAction({
      title: `Remove ${member.name}?`,
      message: `${member.name} will lose access to ${item.name}, its live sessions and their class notes. They can rejoin with the join code unless you close joining or make a new code in Settings.`,
      confirmLabel: "Remove student",
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
    publishPresence(item.id);
    notify({
      title: `${member.name} was removed`,
      text: `They no longer have access to ${item.name}.`,
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

  async function copyCode() {
    const item = selected();
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
      else if (selected()) openClass(selectedId, target);
    });
  });
  document.querySelectorAll(".class-tabs [data-tab]").forEach((button) => {
    button.addEventListener("click", () => setTab(button.dataset.tab));
  });
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

  // ---------- Start ----------
  void recheckSetup();
  try {
    await loadClasses();
    let start = "";
    try { start = localStorage.getItem(selectedKey) || ""; } catch { /* storage unavailable */ }
    if (live && classes.some((item) => item.id === live.classId)) openClass(live.classId, "live");
    else if (classes.some((item) => item.id === start)) openClass(start, "live");
    else if (classes.length === 1) openClass(classes[0].id, "students");
    else showClasses();
  } catch (error) {
    console.error("Class loading failed", error);
    $("#classGrid").replaceChildren(Object.assign(document.createElement("p"), {
      className: "empty-state",
      textContent: "Couldn’t load your classes. Check your connection and refresh."
    }));
  }
}
