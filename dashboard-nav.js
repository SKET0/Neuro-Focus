// Slide-out sidebar for narrow screens, shared by the student and teacher dashboards.
const toggle = document.querySelector("#navToggle");
const sidebar = document.querySelector("#sidebar");

if (toggle && sidebar) {
  const backdrop = document.createElement("div");
  backdrop.className = "nav-backdrop";
  document.body.append(backdrop);

  const isOpen = () => document.body.classList.contains("nav-open");
  const setOpen = (open) => {
    document.body.classList.toggle("nav-open", open);
    toggle.setAttribute("aria-expanded", String(open));
    if (open) sidebar.querySelector(".nav-item")?.focus();
  };

  toggle.addEventListener("click", () => setOpen(!isOpen()));
  backdrop.addEventListener("click", () => setOpen(false));
  sidebar.addEventListener("click", (event) => {
    if (event.target.closest(".nav-item")) setOpen(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && isOpen()) {
      setOpen(false);
      toggle.focus();
    }
  });
  window.matchMedia("(min-width: 1025px)").addEventListener("change", (event) => {
    if (event.matches) setOpen(false);
  });
}
