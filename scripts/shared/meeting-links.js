// Online class links (Zoom or Google Meet), one per class (classes.meeting_url, set by the class's
// teacher in Settings). The same rules as the database check in
// supabase/migrations/20261014000000_class_meeting_links.sql: https only, on zoom.us / zoom.com
// (or their subdomains) or meet.google.com.

const PROVIDERS = {
  zoom: { key: "zoom", label: "Zoom" },
  meet: { key: "meet", label: "Google Meet" }
};

// { key, label } for a valid link, or null.
export function meetingProvider(value) {
  if (typeof value !== "string" || !value || value.length > 500 || /\s/.test(value)) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase();
  if (/^([a-z0-9-]+\.)*zoom\.(us|com)$/.test(host)) return PROVIDERS.zoom;
  if (host === "meet.google.com") return PROVIDERS.meet;
  return null;
}
