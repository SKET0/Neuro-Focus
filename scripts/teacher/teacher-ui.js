// Teacher dashboard shell: today's date on Home. Names and avatars (sidebar, header, Home) are
// filled in by auth-guard.js and scripts/shared/profile.js; the Home greeting by teacher-home.js.
(function teacherWorkspace() {
  const today = document.querySelector("#todayLabel");
  if (today) today.textContent = new Date().toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
})();
