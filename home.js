// Home page polish: frosted header after scrolling, and sections that fade in as they appear.
(function homePage() {
  const topbar = document.querySelector("#topbar");
  const updateHeader = () => topbar?.classList.toggle("is-scrolled", window.scrollY > 8);
  updateHeader();
  window.addEventListener("scroll", updateHeader, { passive: true });

  const items = document.querySelectorAll(".reveal");
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduceMotion || !("IntersectionObserver" in window)) {
    items.forEach((item) => item.classList.add("is-visible"));
    return;
  }
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      // Stagger items that appear together (e.g. a row of feature cards).
      const siblings = [...entry.target.parentElement.children].filter((el) => el.classList.contains("reveal"));
      entry.target.style.transitionDelay = `${Math.min(siblings.indexOf(entry.target), 5) * 70}ms`;
      entry.target.classList.add("is-visible");
      observer.unobserve(entry.target);
    });
  }, { rootMargin: "0px 0px -8% 0px", threshold: 0.12 });
  items.forEach((item) => observer.observe(item));
})();
