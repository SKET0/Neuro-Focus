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
      // Drop the stagger once it has played, so hover effects on the card aren't delayed by it.
      setTimeout(() => { entry.target.style.transitionDelay = ""; }, 1000);
      observer.unobserve(entry.target);
    });
  }, { rootMargin: "0px 0px -8% 0px", threshold: 0.12 });
  items.forEach((item) => observer.observe(item));
})();

// 3D depth: cards tilt toward the pointer and their contents lift off the surface (the [data-tilt]
// and .depth-* styles in index.html), and the hero's floating cards turn together with the logo.
// Mouse and trackpad only, and nothing moves for people who prefer reduced motion.
(function depth() {
  const canHover = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!canHover || reduceMotion) return;

  // Eases an element's custom properties toward targets, one animation frame at a time.
  function easer(el, values, rate) {
    const now = { ...values };
    const target = { ...values };
    let frame = 0;
    const step = () => {
      let moving = false;
      for (const key in target) {
        now[key] += (target[key] - now[key]) * rate;
        if (Math.abs(target[key] - now[key]) > 0.002) moving = true;
        else now[key] = target[key];
        el.style.setProperty(`--${key}`, key === "lift" ? now[key].toFixed(3) : `${now[key].toFixed(2)}deg`);
      }
      frame = moving ? requestAnimationFrame(step) : 0;
    };
    return (next) => {
      Object.assign(target, next);
      if (!frame) frame = requestAnimationFrame(step);
    };
  }

  document.querySelectorAll("[data-tilt]").forEach((card) => {
    const max = Number(card.dataset.tilt) || 8; // degrees at the card's edge
    const ease = easer(card, { rx: 0, ry: 0, lift: 0 }, 0.12);
    card.addEventListener("pointermove", (event) => {
      const box = card.getBoundingClientRect();
      const x = (event.clientX - box.left) / box.width;
      const y = (event.clientY - box.top) / box.height;
      card.style.setProperty("--gx", `${(x * 100).toFixed(1)}%`);
      card.style.setProperty("--gy", `${(y * 100).toFixed(1)}%`);
      ease({ rx: (0.5 - y) * max, ry: (x - 0.5) * max, lift: 1 });
    });
    card.addEventListener("pointerleave", () => ease({ rx: 0, ry: 0, lift: 0 }));
  });

  // Same direction and feel as the logo's own pointer tilt (neural-background.js).
  const scene = document.querySelector(".hero-scene");
  if (scene) {
    const ease = easer(scene, { sx: 0, sy: 0 }, 0.06);
    window.addEventListener("pointermove", (event) => {
      if (window.scrollY > window.innerHeight) return;
      const x = event.clientX / window.innerWidth - 0.5;
      const y = event.clientY / window.innerHeight - 0.5;
      ease({ sx: -y * 10, sy: x * 16 });
    }, { passive: true });
  }
})();
