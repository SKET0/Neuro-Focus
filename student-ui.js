// Student workspace shell: view switching (#dashboard, #buddy, #notes, #history, #classes),
// the header breadcrumb, today's date, the user's initials and the "Start focus session" button.
(function studentWorkspace() {
  const VIEWS = { dashboard: "Dashboard", buddy: "NeuroBuddy", notes: "Class notes", history: "Focus history", classes: "Classes" };
  const views = document.querySelectorAll("[data-view]");
  const links = document.querySelectorAll("[data-view-link]");
  const crumb = document.querySelector("#pageCrumb");
  const main = document.querySelector("main");

  function showView() {
    const hash = window.location.hash.slice(1);
    // Old links like #focus-timer point at a card on the dashboard.
    const target = hash && !VIEWS[hash] ? document.getElementById(hash) : null;
    const name = VIEWS[hash] ? hash : target?.closest("[data-view]")?.dataset.view || "dashboard";
    views.forEach((view) => { view.hidden = view.dataset.view !== name; });
    links.forEach((link) => {
      if (link.dataset.viewLink === name) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    });
    if (crumb) crumb.textContent = VIEWS[name];
    document.title = `${VIEWS[name]} · Neuro-Focus`;
    if (target) target.scrollIntoView({ block: "start" });
    else main?.scrollTo({ top: 0 });
  }
  window.addEventListener("hashchange", showView);
  showView();

  const today = document.querySelector("#todayLabel");
  if (today) today.textContent = new Date().toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });

  // Initials for the sidebar avatar, once auth-guard.js fills in the profile name.
  const nameEl = document.querySelector(".user-card [data-profile-name]");
  const initialsEl = document.querySelector("#userInitials");
  const updateInitials = () => {
    const parts = (nameEl?.textContent || "").trim().split(/\s+/).filter(Boolean);
    if (initialsEl && parts.length) initialsEl.textContent = (parts[0][0] + (parts[1]?.[0] || "")).toUpperCase();
  };
  if (nameEl) new MutationObserver(updateInitials).observe(nameEl, { childList: true, characterData: true, subtree: true });
  updateInitials();

  // One-click focus session: start (or stop) the attention tracker from the page header.
  const quickStart = document.querySelector("#quickStart");
  const quickLabel = quickStart?.querySelector("span");
  let tracking = false;
  quickStart?.addEventListener("click", () => {
    if (tracking) {
      document.querySelector("#stopAnalyzer")?.click();
      return;
    }
    window.dispatchEvent(new CustomEvent("neurofocus:start-camera"));
    document.querySelector("#focus-session")?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  window.addEventListener("neurofocus:tracking-started", () => {
    tracking = true;
    if (quickLabel) quickLabel.textContent = "End focus session";
  });
  window.addEventListener("neurofocus:tracking-stopped", () => {
    tracking = false;
    if (quickLabel) quickLabel.textContent = "Start focus session";
  });
})();
