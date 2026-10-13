// Student workspace shell: view switching (#dashboard, #classes, #class/<id>/<tab>, #focus, #notes,
// #progress, #buddy, #profile), the header breadcrumb, today's date and the "Start focus session"
// buttons. #focus is Solo focus (personal, never shared); a class's page has its Live focus tab.
// Navigating never turns the camera on: only the Start / Join buttons do.
(function studentWorkspace() {
  const VIEWS = {
    dashboard: "Home", focus: "Solo focus", buddy: "NeuroBuddy", notes: "My notes",
    progress: "My progress", classes: "Classes", class: "Class", profile: "Profile settings"
  };
  const CLASS_TABS = { overview: "Overview", live: "Live focus", posts: "Posts", assignments: "Assignments", quizzes: "Quizzes" };
  const ALIASES = { home: "dashboard" };
  const views = document.querySelectorAll("[data-view]");
  const links = document.querySelectorAll("[data-view-link]");
  const crumbs = document.querySelector("#crumbs");
  const main = document.querySelector("main");
  let currentView = null;
  let currentClassId = null;
  let tabChosen = true; // false when the address names a class but not a tab

  // A class opens on its Overview (student-class-overview.js), which shows a live session with a Join
  // button. A student already in the class's live session goes straight to Live focus.
  function defaultClassTab(classId) {
    const status = window.neuroFocusClassStatus;
    const item = status?.classes?.find((entry) => entry.id === classId);
    return item?.inSession || status?.joinedClassId === classId ? "live" : "overview";
  }
  const className = (classId) => window.neuroFocusClassStatus?.classes?.find((entry) => entry.id === classId)?.name
    || (window.neuroFocusClasses || []).find((entry) => entry.id === classId)?.name || "Class";

  // Home / Classes / Biology / Posts: every part but the last is a link.
  function renderCrumbs(name) {
    if (!crumbs) return;
    const trail = [];
    if (name !== "dashboard") trail.push({ label: "Home", href: "#dashboard" });
    if (name === "class") {
      trail.push({ label: "Classes", href: "#classes" }, { label: className(currentClassId), href: `#class/${currentClassId}/${defaultClassTab(currentClassId)}` },
        { label: CLASS_TABS[window.neuroFocusRouteClassTab] || "Class" });
    } else trail.push({ label: VIEWS[name] });
    crumbs.replaceChildren(...trail.flatMap((part, index) => {
      const last = index === trail.length - 1;
      const node = document.createElement(last ? "span" : "a");
      node.className = last ? "crumb-current" : "crumb-link";
      if (last) node.setAttribute("aria-current", "page");
      else node.href = part.href;
      node.textContent = part.label;
      if (!index) return [node];
      const sep = document.createElement("span");
      sep.className = "crumb-sep";
      sep.setAttribute("aria-hidden", "true");
      sep.textContent = "/";
      return [sep, node];
    }));
  }

  function showView() {
    const raw = window.location.hash.slice(1);
    // A class's page: #class/<id> or #class/<id>/<tab> (student-classes.js and
    // student-classroom.js fill it in). Tabs: overview, live (Live focus), posts, assignments, quizzes.
    const classRoute = /^class\/([0-9a-z-]+)(?:\/(overview|live|posts|assignments|quizzes))?/i.exec(raw);
    const hash = classRoute ? "class" : ALIASES[raw] || raw;
    // Links like #focus-timer or #history point at a card inside a view.
    const target = hash && !VIEWS[hash] ? document.getElementById(hash) : null;
    const name = VIEWS[hash] ? hash : target?.closest("[data-view]")?.dataset.view || "dashboard";
    const classId = name === "class" ? classRoute?.[1] || null : null;
    const previous = currentView === "class" && currentClassId !== classId ? `class/${currentClassId}` : currentView;
    currentView = name;
    currentClassId = classId;
    window.neuroFocusRouteClassId = classId;
    tabChosen = Boolean(classRoute?.[2]);
    window.neuroFocusRouteClassTab = classId ? (classRoute?.[2] || defaultClassTab(classId)).toLowerCase() : null;
    views.forEach((view) => {
      view.hidden = view.dataset.view !== name;
      // Cards settle in once when a view opens (styles/student.css; skipped for reduced motion).
      if (view.dataset.view === name && previous !== name && previous !== null) {
        view.classList.add("is-entering");
        window.setTimeout(() => view.classList.remove("is-entering"), 900);
      }
    });
    // The page's own link is current. Inside a class, its entry under "Your classes" is marked
    // instead (student-sidebar.js), the same as on the teacher dashboard.
    links.forEach((link) => {
      if (link.dataset.viewLink === name) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    });
    renderCrumbs(name);
    document.title = name === "class" ? `${className(classId)} · ${CLASS_TABS[window.neuroFocusRouteClassTab]} · Neuro-Focus` : `${VIEWS[name]} · Neuro-Focus`;
    if (target) target.scrollIntoView({ block: "start" });
    else main?.scrollTo({ top: 0 });
    // Keyboard and screen-reader users land on the new page's heading.
    if (previous !== null && previous !== name && !target) {
      const heading = document.querySelector(`[data-view="${name}"] h1`);
      if (heading) {
        heading.tabIndex = -1;
        heading.focus({ preventScroll: true });
      }
    }
    window.neuroFocusView = name;
    window.dispatchEvent(new CustomEvent("neurofocus:viewchange", { detail: { name, previous, classId } }));
  }
  window.addEventListener("hashchange", showView);
  showView();
  // Class names and live sessions arrive after the page opens (student-classes.js). A class opened
  // without a tab in its address moves to Live focus if its session turns out to be live.
  window.addEventListener("neurofocus:class-status", () => {
    if (currentView !== "class") return;
    if (!tabChosen) {
      tabChosen = true;
      const tab = defaultClassTab(currentClassId);
      if (tab !== window.neuroFocusRouteClassTab) { window.location.replace(`#class/${currentClassId}/${tab}`); return; }
    }
    renderCrumbs("class");
    document.title = `${className(currentClassId)} · ${CLASS_TABS[window.neuroFocusRouteClassTab]} · Neuro-Focus`;
  });

  // Go to a view or a card in one ("focus-session", "notes", …), even if the address already shows it.
  window.neuroFocusNavigate = (hash) => {
    if (window.location.hash.slice(1) === hash) showView();
    else window.location.hash = hash;
  };
  // My notes, showing one class's notes (student-notes.js listens for the filter).
  window.neuroFocusOpenClassNotes = (classId) => {
    window.addEventListener("neurofocus:viewchange", () => {
      window.dispatchEvent(new CustomEvent("neurofocus:notes-filter", { detail: { classId } }));
    }, { once: true });
    window.neuroFocusNavigate("notes");
  };

  const today = document.querySelector("#todayLabel");
  if (today) today.textContent = new Date().toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });

  // "Start focus session" buttons (data-start-focus, including ones added later): start the
  // attention tracker and show it, or stop it if it is already running. The camera never
  // starts on its own when a page opens.
  const quickLabel = document.querySelector("#quickStart span");
  const quickIcon = document.querySelector("#quickStart use");
  let tracking = false;
  document.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-start-focus]");
    if (!button) return;
    const inClass = Boolean(window.neuroFocusClassContext?.().joinedClassId);
    // The button ends a running solo session. A class session's camera is never stopped from here.
    if (tracking && !inClass) {
      document.querySelector("#stopAnalyzer")?.click();
      return;
    }
    // A solo session is personal: if the student is in a class's live session, they leave it first
    // (student-classes.js asks), so nothing from the solo session is ever shared.
    const ready = window.neuroFocusClassActions?.prepareSolo ? await window.neuroFocusClassActions.prepareSolo() : true;
    if (!ready) return;
    window.dispatchEvent(new CustomEvent("neurofocus:start-camera"));
    window.neuroFocusNavigate("solo-tracker");
  });
  window.addEventListener("neurofocus:tracking-started", () => {
    tracking = true;
    // Only a solo session turns the Solo focus button into "End focus session".
    if (window.neuroFocusClassContext?.().joinedClassId) return;
    if (quickLabel) quickLabel.textContent = "End focus session";
    quickIcon?.setAttribute("href", "#i-stop");
  });
  window.addEventListener("neurofocus:tracking-stopped", () => {
    tracking = false;
    if (quickLabel) quickLabel.textContent = "Start focus session";
    quickIcon?.setAttribute("href", "#i-play");
  });
})();
