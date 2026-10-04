// Profile pictures, built-in avatars and initials, shared by the student and teacher pages.
// Uploaded pictures live in the private "avatars" storage bucket. They are shown through
// short-lived signed links, which storage only hands out to the picture's owner and the
// teachers of classes the owner is in. Anything missing falls back to a built-in avatar or initials.

const glyph = (paths) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

// The ids match the database check in supabase/migrations/20261007000000_student_profiles.sql.
export const AVATAR_PRESETS = [
  { id: "spark", label: "Spark", colors: ["#22d3ee", "#0e7490"], svg: glyph('<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8Z"/><path d="M19 17v4M17 19h4"/>') },
  { id: "rocket", label: "Rocket", colors: ["#a78bfa", "#5b21b6"], svg: glyph('<path d="M5 15c-1.5 1.5-2 5-2 5s3.5-.5 5-2M14 4c4-1 6-1 6-1s0 2-1 6l-6 6-5-5Z"/><path d="M9 10 6 9l-2 2 5 1M14 15l1 3-2 2-1-5"/>') },
  { id: "leaf", label: "Leaf", colors: ["#4ade80", "#15803d"], svg: glyph('<path d="M5 19c0-8 5-13 14-14 0 9-5 14-13 14Z"/><path d="M5 19l8-8"/>') },
  { id: "planet", label: "Planet", colors: ["#fb923c", "#be185d"], svg: glyph('<circle cx="12" cy="12" r="5"/><path d="M4.6 16.6c-1.3 1.7-.4 2.7 2.2 2.2 3-.6 7.4-3.1 10.6-5.9 2.6-2.3 3.6-4.4 2.5-5.1-.6-.4-1.8-.2-3.2.4"/>') },
  { id: "book", label: "Book", colors: ["#60a5fa", "#1e40af"], svg: glyph('<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z"/><path d="M9 7h7"/>') },
  { id: "bolt", label: "Bolt", colors: ["#facc15", "#c2410c"], svg: glyph('<path d="M13 2 4 14h7l-1 8 9-12h-7Z"/>') },
  { id: "wave", label: "Wave", colors: ["#2dd4bf", "#1d4ed8"], svg: glyph('<path d="M2 10c2.5 0 2.5-3 5-3s2.5 3 5 3 2.5-3 5-3 2.5 3 5 3"/><path d="M2 16c2.5 0 2.5-3 5-3s2.5 3 5 3 2.5-3 5-3 2.5 3 5 3"/>') },
  { id: "star", label: "Star", colors: ["#f472b6", "#7c3aed"], svg: glyph('<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9Z"/>') }
];
const presetById = new Map(AVATAR_PRESETS.map((preset) => [preset.id, preset]));
export const avatarPreset = (id) => presetById.get(id) || null;

export function initialsOf(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return ([...parts[0]][0] + (parts.length > 1 ? [...parts[parts.length - 1]][0] : "")).toUpperCase();
}

// Fills an avatar element: an uploaded picture (url), else a built-in avatar (preset), else initials.
// Avatars sit next to the person's name, so they are hidden from screen readers.
export function paintAvatar(el, { name = "", preset = null, url = null } = {}) {
  if (!el) return;
  el.setAttribute("aria-hidden", "true");
  el.style.background = "";
  el.replaceChildren();
  const fallback = () => paintAvatar(el, { name, preset });
  if (url) {
    const img = document.createElement("img");
    img.alt = "";
    img.decoding = "async";
    img.referrerPolicy = "no-referrer";
    img.addEventListener("error", fallback, { once: true });
    img.src = url;
    el.dataset.kind = "picture";
    el.append(img);
    return;
  }
  const chosen = avatarPreset(preset);
  if (chosen) {
    el.dataset.kind = "preset";
    el.style.background = `linear-gradient(135deg, ${chosen.colors[0]}, ${chosen.colors[1]})`;
    el.innerHTML = chosen.svg; // fixed markup from AVATAR_PRESETS above
    return;
  }
  el.dataset.kind = "initials";
  el.textContent = initialsOf(name);
}

// Signed links for uploaded pictures, cached until shortly before they expire.
const LINK_SECONDS = 3600;
const cache = new Map(); // path -> { url, expires }

export async function avatarUrls(supabase, paths) {
  const now = Date.now();
  const wanted = [...new Set(paths.filter(Boolean))];
  const missing = wanted.filter((path) => !(cache.get(path)?.expires > now));
  if (missing.length) {
    try {
      const { data, error } = await supabase.storage.from("avatars").createSignedUrls(missing, LINK_SECONDS);
      if (!error) {
        (data || []).forEach((item) => {
          if (item?.signedUrl && !item.error) cache.set(item.path, { url: item.signedUrl, expires: now + (LINK_SECONDS - 300) * 1000 });
        });
      }
    } catch { /* storage unavailable: initials or built-in avatars are shown instead */ }
  }
  return new Map(wanted.filter((path) => cache.has(path)).map((path) => [path, cache.get(path).url]));
}

export async function avatarUrl(supabase, path) {
  if (!path) return null;
  return (await avatarUrls(supabase, [path])).get(path) || null;
}

// Drop a cached link, e.g. after the picture was replaced or removed.
export const forgetAvatarUrl = (path) => cache.delete(path);
