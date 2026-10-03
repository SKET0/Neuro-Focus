// Teacher dashboard shell: today's date, a greeting on the classes overview, and the
// sidebar avatar initials (once auth-guard.js fills in the profile name).
(function teacherWorkspace() {
  const today = document.querySelector("#todayLabel");
  if (today) today.textContent = new Date().toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });

  const nameEl = document.querySelector(".user-card [data-profile-name]");
  const initialsEl = document.querySelector("#userInitials");
  const title = document.querySelector("#classesTitle");

  function update() {
    const parts = (nameEl?.textContent || "").trim().split(/\s+/).filter(Boolean);
    if (!parts.length || parts[0] === "Teacher") return;
    if (initialsEl) initialsEl.textContent = (parts[0][0] + (parts[1]?.[0] || "")).toUpperCase();
    const hour = new Date().getHours();
    const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
    if (title) title.textContent = `${greeting}, ${parts[0]}`;
  }
  if (nameEl) new MutationObserver(update).observe(nameEl, { childList: true, characterData: true, subtree: true });
  update();
})();
