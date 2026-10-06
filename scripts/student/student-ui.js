// Student workspace shell: view switching (#dashboard, #focus, #buddy, #notes, #progress, #classes,
// #class/<id>, #profile), the header breadcrumb, today's date and the "Start focus session" buttons.
// #focus is Solo focus (personal, never shared); a class's page (#class/<id>) has its Live focus.
(function studentWorkspace() {
  const VIEWS = {
    dashboard: "Home", focus: "Solo focus", buddy: "NeuroBuddy", notes: "Class notes",
    progress: "My progress", classes: "Classes", class: "Class", profile: "My profile"
  };
  const ALIASES = { home: "dashboard" };
  const views = document.querySelectorAll("[data-view]");
  const links = document.querySelectorAll("[data-view-link]");
  const crumb = document.querySelector("#pageCrumb");
  const main = document.querySelector("main");
  let currentView = null;
  let currentClassId = null;

  function showView() {
    const raw = window.location.hash.slice(1);
    // A class's page: #class/<id> or #class/<id>/<tab> (student-classes.js and
    // student-classroom.js fill it in). Tabs: live (Live focus), posts, assignments, quizzes.
    const classRoute = /^class\/([0-9a-z-]+)(?:\/(live|posts|assignments|quizzes))?/i.exec(raw);
    const hash = classRoute ? "class" : ALIASES[raw] || raw;
    // Links like #focus-timer or #history point at a card inside a view.
    const target = hash && !VIEWS[hash] ? document.getElementById(hash) : null;
    const name = VIEWS[hash] ? hash : target?.closest("[data-view]")?.dataset.view || "dashboard";
    const classId = name === "class" ? classRoute?.[1] || null : null;
    const previous = currentView === "class" && currentClassId !== classId ? `class/${currentClassId}` : currentView;
    currentView = name;
    currentClassId = classId;
    window.neuroFocusRouteClassId = classId;
    window.neuroFocusRouteClassTab = classId ? (classRoute?.[2] || "live").toLowerCase() : null;
    views.forEach((view) => {
      view.hidden = view.dataset.view !== name;
      // Cards settle in once when a view opens (styles/student.css; skipped for reduced motion).
      if (view.dataset.view === name && previous !== name && previous !== null) {
        view.classList.add("is-entering");
        window.setTimeout(() => view.classList.remove("is-entering"), 900);
      }
    });
    links.forEach((link) => {
      if (link.dataset.viewLink === name && name !== "class") link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    });
    if (crumb) crumb.textContent = VIEWS[name];
    document.title = `${VIEWS[name]} · Neuro-Focus`;
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

  // Go to a view or a card in one ("focus-session", "notes", …), even if the address already shows it.
  window.neuroFocusNavigate = (hash) => {
    if (window.location.hash.slice(1) === hash) showView();
    else window.location.hash = hash;
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
