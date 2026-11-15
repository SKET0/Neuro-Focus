// The floating focus window for online classes (Zoom / Google Meet). When a student presses
// "Join on Zoom/Meet" (student-classes.js), this opens a small always-on-top window
// (Document Picture-in-Picture, Chrome and Edge) that shows their tracking status and focus,
// with a button that opens the meeting and one to leave the live session. Tracking itself keeps
// running in the Neuro-Focus tab behind the meeting (scripts/shared/background-clock.js).
// Nothing in this window is sent anywhere; it only shows what the tracker on this device reads.
import { normalizeReading, describeReading, TRACKING } from "../shared/tracking-states.js";

let pip = null;        // the floating window
let parts = null;      // its elements
let info = null;       // { classId, className, meetingUrl, providerLabel, onLeave }
let lastReading = null;
let session = { joined: false, live: true, removed: false, sharing: false };
let lastPaint = 0;

export const companionSupported = () => "documentPictureInPicture" in window;
export const companionClassId = () => (pip ? info?.classId : null);

const STYLE = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; padding: 12px 14px; display: flex; flex-direction: column; gap: 8px;
    background: #101318; color: #e8eaed; font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; }
  .top { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
  .brand { font-size: 11px; font-weight: 650; letter-spacing: 0.05em; text-transform: uppercase; color: #8b95a1; }
  .class { font-weight: 650; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .status { display: flex; align-items: center; gap: 10px; }
  .dot { width: 10px; height: 10px; flex: none; border-radius: 50%; background: #6b7280; }
  .status[data-key="on-screen"] .dot { background: #4ade80; }
  .status[data-key="looking-away"] .dot { background: #fbbf24; }
  .status[data-key="unavailable"] .dot, .status[data-key="off"] .dot { background: #f87171; }
  .label { flex: 1; min-width: 0; font-weight: 600; }
  .label small { display: block; font-weight: 400; color: #8b95a1; }
  .score { font-size: 26px; font-weight: 800; font-variant-numeric: tabular-nums; }
  .note { font-size: 11.5px; color: #8b95a1; }
  .actions { display: flex; gap: 8px; margin-top: auto; }
  a, button { flex: 1; display: inline-flex; align-items: center; justify-content: center; padding: 8px 10px; border-radius: 9px;
    font: inherit; font-weight: 650; text-decoration: none; cursor: pointer; border: 1px solid #2a2f37; }
  a { background: #2563eb; border-color: #2563eb; color: #fff; }
  button { background: #1b2028; color: #e8eaed; }
  a:focus-visible, button:focus-visible { outline: 2px solid #60a5fa; outline-offset: 2px; }
`;

function el(doc, tag, className = "", text = "") {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function build(doc) {
  doc.title = "Neuro-Focus";
  const style = el(doc, "style");
  style.textContent = STYLE;
  doc.head.append(style);
  const top = el(doc, "div", "top");
  top.append(el(doc, "span", "brand", "Neuro-Focus"), el(doc, "span", "class", info.className));
  const status = el(doc, "div", "status");
  status.setAttribute("role", "status");
  const label = el(doc, "span", "label");
  const score = el(doc, "span", "score");
  status.append(el(doc, "span", "dot"), label, score);
  const note = el(doc, "p", "note");
  note.style.margin = "0";
  const open = el(doc, "a", "", `Open ${info.providerLabel}`);
  open.href = info.meetingUrl;
  open.target = "_blank";
  open.rel = "noopener noreferrer";
  const leave = el(doc, "button", "", "Leave session");
  leave.type = "button";
  leave.addEventListener("click", () => info?.onLeave?.());
  const actions = el(doc, "div", "actions");
  actions.append(open, leave);
  doc.body.append(top, status, note, actions);
  parts = { status, label, score, note, open };
}

function paint() {
  if (!pip || !parts) return;
  const { status, label, score, note } = parts;
  const reading = lastReading ? normalizeReading(lastReading) : { tracking: window.neuroFocusTracking ? TRACKING.UNAVAILABLE : TRACKING.OFF, reason: "no-recent-readings" };
  const described = describeReading(reading);
  status.dataset.key = described.key;
  const title = !window.neuroFocusTracking ? "Camera off" : described.label;
  label.replaceChildren(title);
  if (described.detail && window.neuroFocusTracking && reading.tracking !== TRACKING.ACTIVE) label.append(el(parts.label.ownerDocument, "small", "", described.detail));
  score.textContent = reading.tracking === TRACKING.ACTIVE && Number.isFinite(reading.score) ? `${reading.score}%` : "";
  note.textContent = session.removed ? "Your teacher removed you from this session, so nothing is shared."
    : !session.live ? "The live session has ended. Nothing more is shared."
    : !session.joined ? "Joining the live session…"
    : session.sharing ? `Keep this window open during ${info.providerLabel}. Your teacher sees your focus score only, never video.`
    : "Not shared right now: turn your camera on in Neuro-Focus to share your focus.";
}

window.addEventListener("neurofocus:attention-update", (event) => {
  lastReading = event.detail;
  // About 4 updates a second is plenty for a glance.
  const now = Date.now();
  if (pip && now - lastPaint > 250) { lastPaint = now; paint(); }
});
window.addEventListener("neurofocus:tracking-started", () => { lastReading = null; paint(); });
window.addEventListener("neurofocus:tracking-stopped", () => { lastReading = null; paint(); });

// Opens the floating window. Must be called straight from the student's click (the browser
// only allows it then). Resolves true if it opened.
export async function openCompanion(details) {
  info = details;
  if (!companionSupported()) return false;
  try {
    if (pip) pip.close();
    pip = await window.documentPictureInPicture.requestWindow({ width: 340, height: 190 });
  } catch (error) {
    console.warn("Floating focus window not opened", error);
    pip = null;
    return false;
  }
  const opened = pip;
  build(opened.document);
  opened.addEventListener("pagehide", () => { if (pip === opened) { pip = null; parts = null; } });
  paint();
  parts.open.focus();
  return true;
}

// The live session's state, from student-classes.js.
export function updateCompanion(next) {
  session = { ...session, ...next };
  paint();
}

export function closeCompanion() {
  pip?.close();
  pip = null;
  parts = null;
}
