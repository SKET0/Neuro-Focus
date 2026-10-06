// Student workspace shell: view switching (#dashboard, #focus, #buddy, #notes, #progress, #classes,
// #profile), the header breadcrumb, today's date and the "Start focus session" buttons.
(function studentWorkspace() {
  const VIEWS = {
    dashboard: "Home", focus: "Focus session", buddy: "NeuroBuddy", notes: "Class notes",
    progress: "My progress", classes: "Classes", profile: "My profile"
  };
  const ALIASES = { home: "dashboard" };
  const views = document.querySelectorAll("[data-view]");
  const links = document.querySelectorAll("[data-view-link]");
  const crumb = document.querySelector("#pageCrumb");
  const main = document.querySelector("main");
  let currentView = null;

  function showView() {
    const raw = window.location.hash.slice(1);
    const hash = ALIASES[raw] || raw;
    // Links like #focus-timer or #history point at a card inside a view.
    const target = hash && !VIEWS[hash] ? document.getElementById(hash) : null;
    const name = VIEWS[hash] ? hash : target?.closest("[data-view]")?.dataset.view || "dashboard";
    const previous = currentView;
    currentView = name;
    views.forEach((view) => {
      view.hidden = view.dataset.view !== name;
      // Cards settle in once when a view opens (styles/student.css; skipped for reduced motion).
      if (view.dataset.view === name && previous !== name && previous !== null) {
        view.classList.add("is-entering");
        window.setTimeout(() => view.classList.remove("is-entering"), 900);
      }
    });
    links.forEach((link) => {
      if (link.dataset.viewLink === name) link.setAttribute("aria-current", "page");
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
    window.dispatchEvent(new CustomEvent("neurofocus:viewchange", { detail: { name, previous } }));
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
  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-start-focus]");
    if (!button) return;
    if (tracking) {
      document.querySelector("#stopAnalyzer")?.click();
      return;
    }
    window.dispatchEvent(new CustomEvent("neurofocus:start-camera"));
    window.neuroFocusNavigate("focus-session");
  });
  window.addEventListener("neurofocus:tracking-started", () => {
    tracking = true;
    if (quickLabel) quickLabel.textContent = "End focus session";
    quickIcon?.setAttribute("href", "#i-stop");
  });
  window.addEventListener("neurofocus:tracking-stopped", () => {
    tracking = false;
    if (quickLabel) quickLabel.textContent = "Start focus session";
    quickIcon?.setAttribute("href", "#i-play");
  });
})();
