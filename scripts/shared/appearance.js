// Student appearance: the theme ("default" | "light" | "dark") and accent colour live on <html>
// as data-theme / data-accent, so every student page, dialog and chart picks them up from the
// theme tokens in styles/student.css. Only student pages call this; teachers keep the default look.
//
// The saved choice is also cached on this device for the signed-in account. pages/student.html
// applies that cache before the page paints, but only if it belongs to the account signed in on
// this browser, so one student's theme never shows for another.

export const THEMES = ["default", "light", "dark"];
export const ACCENTS = ["default", "blue", "purple", "green", "orange"];
export const CACHE_KEY = "neuroFocusAppearance";
const BROWSER_BAR = { default: "#09090b", light: "#f4f5f8", dark: "#0f141a" };

export const normalizeAppearance = ({ theme, accent } = {}) => ({
  theme: THEMES.includes(theme) ? theme : "default",
  accent: ACCENTS.includes(accent) ? accent : "default"
});

export const currentAppearance = () => normalizeAppearance(document.documentElement.dataset);

let switchTimer;
// animate: cross-fade colours (skipped when the student prefers reduced motion).
export function applyAppearance(prefs, { animate = false } = {}) {
  const { theme, accent } = normalizeAppearance(prefs);
  const root = document.documentElement;
  if (root.dataset.theme === theme && root.dataset.accent === accent) return;
  if (animate && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    root.classList.add("theme-switching");
    window.clearTimeout(switchTimer);
    switchTimer = window.setTimeout(() => root.classList.remove("theme-switching"), 320);
  }
  root.dataset.theme = theme;
  root.dataset.accent = accent;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", BROWSER_BAR[theme]);
  // Charts (student-focus.js, student-history.js) redraw with the new colours.
  window.dispatchEvent(new CustomEvent("neurofocus:appearance-change", { detail: { theme, accent } }));
}

export function cacheAppearance(userId, prefs) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify({ userId, ...normalizeAppearance(prefs) })); } catch { /* storage unavailable */ }
}

// Called on sign-out and when the account changes, so the next person starts from the default look.
export function clearAppearanceCache() {
  try { localStorage.removeItem(CACHE_KEY); } catch { /* storage unavailable */ }
}

// A theme token's current value, e.g. themeColor("--accent"). Tokens read this way are plain hex colours.
export const themeColor = (name, fallback = "#82828c") =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

// "#00d9ff" + 0.5 -> "rgba(0, 217, 255, 0.5)"; anything else is returned unchanged.
export function withAlpha(color, alpha) {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color)?.[1];
  if (!hex) return color;
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
