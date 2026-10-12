// A guided tour: a short series of cards, each pointing at one part of the page with a spotlight.
// Used by the teacher dashboard (scripts/teacher/teacher-tour.js); any page can define its own steps.
//
// Steps: { target?, title, text, before?, buttons? }
//   target  - a selector (or function returning an element). Without one, the card is centred.
//             A step whose target is missing or hidden is skipped.
//   before  - runs before the step is shown (e.g. open the page or the sidebar drawer).
//   buttons - extra buttons for this step: [{ label, primary?, run(tour) }].
// Keyboard: ← and → move between steps, Esc ends the tour.
//
// Whether someone has seen a tour is kept on their account (Supabase auth user metadata, which
// only they can change), so it doesn't come back on another device, plus a local copy so it
// never flashes back while the account update is on its way.

const localKey = (user, name) => `neuroFocusTour:${user.id}:${name}`;

export function tourSeen(user, name) {
  try { if (localStorage.getItem(localKey(user, name))) return true; } catch { /* storage unavailable */ }
  return Boolean(user.user_metadata?.tours?.[name]);
}

export async function markTourSeen(supabase, user, name) {
  try { localStorage.setItem(localKey(user, name), "1"); } catch { /* storage unavailable */ }
  if (user.user_metadata?.tours?.[name]) return;
  const tours = { ...(user.user_metadata?.tours || {}), [name]: new Date().toISOString() };
  try {
    const { data } = await supabase.auth.updateUser({ data: { tours } });
    if (data?.user) user.user_metadata = data.user.user_metadata;
  } catch { /* offline: the local copy still applies on this device */ }
}

const visible = (node) => {
  if (!node || !node.isConnected) return false;
  const box = node.getBoundingClientRect();
  return box.width > 0 && box.height > 0 && getComputedStyle(node).visibility !== "hidden";
};

let active = null;

export function startTour(steps, { onEnd } = {}) {
  active?.end(false);
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const previousFocus = document.activeElement;
  const root = document.createElement("div");
  root.className = "tour";
  const shade = document.createElement("div");
  shade.className = "tour-shade";
  const spot = document.createElement("div");
  spot.className = "tour-spot";
  spot.setAttribute("aria-hidden", "true");
  const card = document.createElement("div");
  card.className = "tour-card-pop";
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-modal", "true");
  card.setAttribute("aria-labelledby", "tourTitle");
  card.setAttribute("aria-describedby", "tourText");
  card.tabIndex = -1;
  root.append(shade, spot, card);
  document.body.append(root);
  document.body.classList.add("tour-open");

  let index = -1;
  let target = null;
  let frame = 0;

  const targetOf = (step) => {
    if (!step.target) return null;
    const node = typeof step.target === "function" ? step.target() : document.querySelector(step.target);
    return visible(node) ? node : undefined; // undefined: the step should be skipped
  };

  function place() {
    const gap = 14;
    const margin = 12;
    const width = window.innerWidth;
    const height = window.innerHeight;
    card.style.maxWidth = `${Math.min(360, width - margin * 2)}px`;
    if (!target) {
      root.dataset.centred = "true";
      spot.style.cssText = "";
      card.style.left = `${Math.max(margin, (width - card.offsetWidth) / 2)}px`;
      card.style.top = `${Math.max(margin, (height - card.offsetHeight) / 2)}px`;
      return;
    }
    delete root.dataset.centred;
    const box = target.getBoundingClientRect();
    const pad = 6;
    spot.style.left = `${box.left - pad}px`;
    spot.style.top = `${box.top - pad}px`;
    spot.style.width = `${box.width + pad * 2}px`;
    spot.style.height = `${box.height + pad * 2}px`;
    const cw = card.offsetWidth;
    const ch = card.offsetHeight;
    // Prefer below, then above, then beside (right, left); otherwise pin to the bottom of the screen.
    const options = [
      { top: box.bottom + gap, left: box.left, fits: box.bottom + gap + ch <= height - margin },
      { top: box.top - gap - ch, left: box.left, fits: box.top - gap - ch >= margin },
      { top: box.top, left: box.right + gap, fits: box.right + gap + cw <= width - margin },
      { top: box.top, left: box.left - gap - cw, fits: box.left - gap - cw >= margin }
    ];
    const choice = options.find((option) => option.fits) || { top: height - ch - margin, left: (width - cw) / 2 };
    card.style.left = `${Math.min(Math.max(margin, choice.left), width - cw - margin)}px`;
    card.style.top = `${Math.min(Math.max(margin, choice.top), height - ch - margin)}px`;
  }
  const schedulePlace = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(place); };

  function button(label, className, run) {
    const node = document.createElement("button");
    node.type = "button";
    node.className = className;
    node.textContent = label;
    node.addEventListener("click", run);
    return node;
  }

  async function show(next, direction = 1) {
    let i = next;
    // Skip steps whose part of the page isn't there right now.
    while (i >= 0 && i < steps.length) {
      await steps[i].before?.();
      if (targetOf(steps[i]) !== undefined) break;
      i += direction;
    }
    if (i < 0) i = index;
    if (i >= steps.length) { end(true); return; }
    index = i;
    const step = steps[index];
    document.querySelector(".tour-target")?.classList.remove("tour-target");
    target = targetOf(step);
    if (target) {
      // Short parts are centred; tall ones are scrolled to their top (below the sticky header).
      target.classList.add("tour-target");
      const tall = target.getBoundingClientRect().height > window.innerHeight * 0.55;
      const where = { block: tall ? "start" : "center", inline: "nearest" };
      target.scrollIntoView({ ...where, behavior: reducedMotion ? "auto" : "smooth" });
      await new Promise((resolve) => window.setTimeout(resolve, reducedMotion ? 0 : 360));
      // A smooth scroll can be cut short (or not run in a background tab): make sure it arrived.
      const box = target.getBoundingClientRect();
      const arrived = tall ? box.top >= 0 && box.top < window.innerHeight * 0.3 : box.top >= 0 && box.bottom <= window.innerHeight;
      if (!arrived) target.scrollIntoView(where);
    }

    const counted = steps.filter((s) => !s.intro);
    const number = counted.indexOf(step) + 1;
    const head = document.createElement("div");
    head.className = "tour-head";
    if (number) head.append(Object.assign(document.createElement("span"), { className: "tour-step", textContent: `${number} of ${counted.length}` }));
    head.append(button("Skip tour", "tour-skip", () => end(true)));
    const title = Object.assign(document.createElement("h2"), { id: "tourTitle", textContent: step.title });
    const text = Object.assign(document.createElement("p"), { id: "tourText", textContent: step.text });
    const progress = document.createElement("div");
    progress.className = "tour-dots";
    progress.setAttribute("aria-hidden", "true");
    counted.forEach((s) => progress.append(Object.assign(document.createElement("span"), { className: s === step ? "on" : "" })));
    const actions = document.createElement("div");
    actions.className = "tour-actions";
    if (step.buttons) {
      step.buttons.forEach((b) => actions.append(button(b.label, b.primary ? "btn-primary" : "btn-action", () => b.run(api))));
    } else {
      if (index > 0 && !steps[index - 1].intro) actions.append(button("Back", "btn-action", () => show(index - 1, -1)));
      const last = steps.slice(index + 1).every((s) => s.target && targetOf(s) === undefined);
      actions.append(button(last ? "Finish" : "Next", "btn-primary", () => show(index + 1)));
    }
    card.replaceChildren(head, title, text, ...(number ? [progress] : []), actions);
    root.dataset.step = String(index);
    place();
    card.classList.remove("is-in");
    void card.offsetWidth;
    card.classList.add("is-in");
    (actions.querySelector(".btn-primary") || card).focus({ preventScroll: true });
  }

  function onKey(event) {
    if (event.key === "Escape") { event.preventDefault(); end(true); }
    else if (event.key === "ArrowRight" && !steps[index]?.buttons) show(index + 1);
    else if (event.key === "ArrowLeft" && index > 0 && !steps[index - 1].intro) show(index - 1, -1);
    else if (event.key === "Tab") {
      // Keep focus inside the card while the tour is open.
      const items = [...card.querySelectorAll("button")];
      if (!items.length) return;
      const first = items[0];
      const lastItem = items.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); lastItem.focus(); }
      else if (!event.shiftKey && document.activeElement === lastItem) { event.preventDefault(); first.focus(); }
      else if (!card.contains(document.activeElement)) { event.preventDefault(); first.focus(); }
    }
  }

  function end(completed) {
    if (!root.isConnected) return;
    cancelAnimationFrame(frame);
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("resize", schedulePlace);
    window.removeEventListener("scroll", schedulePlace, true);
    document.removeEventListener("transitionend", schedulePlace, true);
    root.remove();
    document.querySelector(".tour-target")?.classList.remove("tour-target");
    document.body.classList.remove("tour-open");
    active = null;
    onEnd?.({ completed, step: index });
    if (previousFocus?.isConnected) previousFocus.focus?.({ preventScroll: true });
  }

  document.addEventListener("keydown", onKey, true);
  window.addEventListener("resize", schedulePlace);
  window.addEventListener("scroll", schedulePlace, true);
  // Parts that slide into place (like the sidebar drawer on phones) are measured again once they stop.
  document.addEventListener("transitionend", schedulePlace, true);
  shade.addEventListener("click", () => card.focus());

  const api = { next: () => show(index + 1), back: () => show(index - 1, -1), end };
  active = api;
  void show(0);
  return api;
}

// ---------- A dashboard's tour (teacher-tour.js, student-tour.js) ----------
// The same behaviour on both dashboards: the "Take the tour" card at the bottom of the sidebar,
// opening once by itself the first time the person reaches Home, replaying any time, and the
// sidebar drawer on phones and tablets.

// On narrow screens the sidebar is a drawer: open it for sidebar steps, close it after.
export function sidebarDrawer(open) {
  if (!window.matchMedia("(max-width: 1024px)").matches) return;
  if (document.body.classList.contains("nav-open") !== open) document.querySelector("#navToggle")?.click();
}
export const settle = () => new Promise((resolve) => window.setTimeout(resolve, 260));

// steps(): the full list, starting with the welcome card (intro: true).
// isReady(): the page has what the steps point at. isHome(): Home is the page showing now.
// readyEvents: window events after which isReady() or isHome() may have changed.
export function setupDashboardTour({ supabase, user, name, place, steps, isReady, isHome, readyEvents }) {
  const $ = (selector) => document.querySelector(selector);
  function updateCard() {
    const seen = tourSeen(user, name);
    $("#tourCardTitle").textContent = seen ? "Need a refresher?" : "New here?";
    $("#tourCardText").textContent = seen ? `Replay the one-minute tour of your ${place}.` : `Take a one-minute tour of your ${place}.`;
    $("#tourCard [data-start-tour]").textContent = seen ? "Replay the tour" : "Take the tour";
  }

  function run({ fromStart = false } = {}) {
    sidebarDrawer(false);
    const list = steps();
    // From the sidebar card: straight into the tour, without the welcome card.
    startTour(fromStart ? list.filter((step) => !step.intro) : list, {
      onEnd: () => {
        sidebarDrawer(false);
        updateCard();
        void markTourSeen(supabase, user, name).then(updateCard);
      }
    });
  }

  document.querySelectorAll("[data-start-tour]").forEach((node) => node.addEventListener("click", () => run({ fromStart: true })));
  updateCard();

  // First visit: wait until the page is ready and Home is showing (not a linked page).
  let started = false;
  const maybeStart = () => {
    if (started || tourSeen(user, name) || !isReady() || !isHome()) return;
    started = true;
    window.setTimeout(() => { if (isHome()) run(); else started = false; }, 900);
  };
  readyEvents.forEach((event) => window.addEventListener(event, maybeStart));
  maybeStart();
}
