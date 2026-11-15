// Online class links: the page's check (scripts/shared/meeting-links.js) must accept and refuse
// the same links as the database (supabase/migrations/20261014000000_class_meeting_links.sql).
// Run: cd tests && npm test
import { meetingProvider } from "../scripts/shared/meeting-links.js";

let failures = 0;
const ok = (label, cond) => { if (!cond) failures += 1; console.log(`${cond ? "✓" : "✗"} ${label}`); };

console.log("— Online class links —");
for (const [url, key] of [
  ["https://zoom.us/j/81234567890", "zoom"],
  ["https://us06web.zoom.us/j/81234567890?pwd=abc", "zoom"],
  ["https://app.zoom.com/wc/join/81234567890", "zoom"],
  ["https://meet.google.com/abc-defg-hij", "meet"],
  ["https://meet.google.com/abc-defg-hij?authuser=1", "meet"]
]) ok(`accepts ${url}`, meetingProvider(url)?.key === key);
ok("names the provider", meetingProvider("https://zoom.us/j/1").label === "Zoom" && meetingProvider("https://meet.google.com/x").label === "Google Meet");
for (const [label, url] of [
  ["http (not https)", "http://zoom.us/j/1"],
  ["another site", "https://example.com/j/1"],
  ["a look-alike host", "https://zoom.us.example.com/j/1"],
  ["a look-alike name", "https://evilzoom.us/j/1"],
  ["a sign-in trick", "https://zoom.us@example.com/j/1"],
  ["a Meet look-alike", "https://meet.google.com.example.com/abc"],
  ["another Google site", "https://docs.google.com/abc"],
  ["a script link", "javascript:alert(1)"],
  ["spaces", "https://meet.google.com/abc def"],
  ["a port", "https://zoom.us:8443/j/1"],
  ["nothing", ""],
  ["not text", null]
]) ok(`refuses ${label}`, meetingProvider(url) === null);
ok("refuses links over 500 characters", meetingProvider(`https://zoom.us/j/${"1".repeat(500)}`) === null);

console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL LINK CHECKS PASSED");
process.exit(failures ? 1 : 0);
