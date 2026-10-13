// The session summary popup, shown to a student when their teacher ends the live session they were
// in (student-focus.js opens it once the camera has stopped and the session is saved). It shows
// the class, how long it ran, the share of measured time on screen with a ring, the attention
// over the whole session, and the other numbers. Styles: styles/student.css (.summary-dialog).
import { levelFor } from "./focus-analysis.js?v=3";

const SVG_NS = "http://www.w3.org/2000/svg";

const clock = (ms) => {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}h ${m}m` : m ? `${m} min${s && m < 10 ? ` ${s}s` : ""}` : `${s}s`;
};
const timeOf = (date) => date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function svg(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, String(value)));
  return node;
}

// A few kind words that describe what was recorded, never a judgement of the student.
function message(pct) {
  if (pct === null) return "There wasn’t enough tracking to measure this session. Next time, check your face is in view and well lit.";
  if (pct >= 80) return "You stayed on screen for most of the session. Great focus!";
  if (pct >= 60) return "You were on screen for much of the session. Nice work.";
  if (pct >= 40) return "A mixed session, and that’s normal. Short breaks or a quieter spot can help next time.";
  return "You were often looking away this time. Writing notes or reading on paper counts as looking away too.";
}

// The attention ring: the share of measured time on screen.
function ring(pct, color) {
  const wrap = el("div", "summary-ring");
  const box = svg("svg", { viewBox: "0 0 120 120", "aria-hidden": "true" });
  const r = 52;
  const length = 2 * Math.PI * r;
  box.append(svg("circle", { class: "summary-ring-track", cx: 60, cy: 60, r }));
  const fill = svg("circle", { class: "summary-ring-fill", cx: 60, cy: 60, r, "stroke-dasharray": length.toFixed(2), "stroke-dashoffset": length.toFixed(2) });
  fill.style.stroke = color;
  box.append(fill);
  const center = el("div", "summary-ring-center");
  center.append(el("b", "", pct === null ? "—" : `${pct}%`), el("small", "", "on screen"));
  wrap.append(box, center);
  // Fills in once the popup is open (or straight away with reduced motion).
  const target = pct === null ? length : length * (1 - pct / 100);
  requestAnimationFrame(() => requestAnimationFrame(() => fill.setAttribute("stroke-dashoffset", target.toFixed(2))));
  return wrap;
}

// Attention across the whole session: one point per saved 5-second sample, with gaps where
// nothing could be measured (drawn as gaps, never as 0).
function timeline(samples) {
  const box = el("div", "summary-chart");
  const scored = samples.filter((sample) => sample.score !== null && sample.score !== undefined);
  if (scored.length < 2) {
    box.append(el("p", "summary-chart-empty", "Not enough readings to draw your attention over time."));
    return box;
  }
  const width = 600;
  const height = 120;
  const pad = 6;
  const step = (width - pad * 2) / Math.max(1, samples.length - 1);
  const y = (score) => pad + (1 - score / 100) * (height - pad * 2);
  const chart = svg("svg", { viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: "none", role: "img", "aria-label": "Your attention over the session" });
  const defs = svg("defs");
  const gradient = svg("linearGradient", { id: "summaryFill", x1: 0, y1: 0, x2: 0, y2: 1 });
  gradient.append(svg("stop", { offset: "0", class: "summary-fill-top" }), svg("stop", { offset: "1", class: "summary-fill-bottom" }));
  defs.append(gradient);
  chart.append(defs);
  chart.append(svg("line", { class: "summary-goal", x1: 0, x2: width, y1: y(70), y2: y(70) }));
  // One path per run of measured samples.
  let run = [];
  const runs = [];
  samples.forEach((sample, i) => {
    if (sample.score === null || sample.score === undefined) { if (run.length) runs.push(run); run = []; return; }
    run.push([pad + i * step, y(sample.score)]);
  });
  if (run.length) runs.push(run);
  runs.forEach((points) => {
    const line = points.map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(1)} ${py.toFixed(1)}`).join(" ");
    if (points.length > 1) chart.append(svg("path", { class: "summary-area", d: `${line} L${points.at(-1)[0].toFixed(1)} ${height} L${points[0][0].toFixed(1)} ${height} Z` }));
    chart.append(svg("path", { class: "summary-line", d: points.length > 1 ? line : `${line} l0.1 0` }));
  });
  box.append(chart);
  const legend = el("div", "summary-chart-legend");
  legend.append(el("span", "", "Start"), el("span", "summary-chart-goal", "Dashed line: 70%"), el("span", "", "End"));
  box.append(legend);
  return box;
}

function stat(label, value, note = "") {
  const item = el("div", "summary-stat");
  item.append(el("span", "summary-stat-label", label), el("b", "", value));
  if (note) item.append(el("small", "", note));
  return item;
}

/**
 * Opens the summary. data: { className, teacherName, attendance ("present" | "late" | null when not
 * known), color, startedAt (ms), endedAt (ISO),
 * totalMs, usableMs, unavailableMs, focusPercent, averageScore, bestStreakMs, episodes, samples }
 */
export function showSessionSummary(data) {
  document.querySelector("#sessionSummaryDialog")?.remove();
  const dialog = el("dialog", "summary-dialog");
  dialog.id = "sessionSummaryDialog";
  dialog.setAttribute("aria-labelledby", "summaryTitle");
  if (data.color) dialog.style.setProperty("--class-color", data.color);
  const pct = Number.isFinite(data.focusPercent) ? data.focusPercent : null;
  const level = pct === null ? null : levelFor(pct);
  const ended = new Date(data.endedAt || Date.now());
  const started = new Date(data.startedAt || ended.getTime() - (data.totalMs || 0));

  // Header: the class and when it ran
  const head = el("div", "summary-head"); // not <header>: the dashboard styles every <header> as its top bar
  const badge = el("span", "summary-badge", ([...String(data.className || "C").trim()][0] || "C").toUpperCase());
  badge.setAttribute("aria-hidden", "true");
  const titles = el("div", "summary-titles");
  titles.append(
    el("p", "summary-kicker", "Live session ended"),
    Object.assign(el("h2", "", data.className || "Your class"), { id: "summaryTitle" }),
    el("p", "summary-when", `${data.teacherName ? `with ${data.teacherName} · ` : ""}${timeOf(started)} – ${timeOf(ended)} · ${clock(data.totalMs || ended - started)}`)
  );
  const close = el("button", "summary-close", "×");
  close.type = "button";
  close.setAttribute("aria-label", "Close summary");
  close.addEventListener("click", () => dialog.close());
  head.append(badge, titles, close);

  // The result: ring, level and a kind sentence
  const hero = el("section", "summary-hero");
  const words = el("div", "summary-words");
  const levelLabel = el("p", "summary-level", level ? level.label : "Not enough measured");
  if (level) levelLabel.style.color = level.color;
  words.append(levelLabel, el("p", "summary-message", message(pct)));
  hero.append(ring(pct, level?.color || "var(--text-faint)"), words);

  // Attention over the session
  const chartBlock = el("section", "summary-section");
  chartBlock.append(el("h3", "summary-section-title", "Your attention during the session"), timeline(data.samples || []));

  // The numbers
  const stats = el("section", "summary-stats");
  stats.append(
    stat("Average attention", Number.isFinite(data.averageScore) ? `${data.averageScore}%` : "—"),
    stat("Best focus streak", clock(data.bestStreakMs || 0)),
    stat("Look-aways", String(data.episodes || 0), "4 seconds or more"),
    stat("Measured", clock(data.usableMs || 0), data.unavailableMs >= 60000 ? `${clock(data.unavailableMs)} couldn’t be measured` : "")
  );

  // Attendance and what happened to the session
  const notes = el("ul", "summary-notes");
  if (data.attendance === "late") notes.append(el("li", "is-late", "Attendance: you joined late"));
  else if (data.attendance === "present") notes.append(el("li", "is-ok", "Attendance: you’re marked present"));
  notes.append(
    el("li", "", "Your teacher ended the session, so your camera is off. Only numbers were shared, never video."),
    el("li", "", "This session is saved to My progress under this class.")
  );

  const actions = el("div", "summary-actions");
  const progress = el("button", "btn-action", "See My progress");
  progress.type = "button";
  progress.addEventListener("click", () => { dialog.close(); window.neuroFocusNavigate?.("progress"); });
  const done = el("button", "btn-primary", "Done");
  done.type = "button";
  done.addEventListener("click", () => dialog.close());
  actions.append(progress, done);

  const body = el("div", "summary-body");
  body.append(hero, chartBlock, stats, notes);
  dialog.append(head, body, actions);
  dialog.addEventListener("close", () => dialog.remove());
  // A click on the backdrop closes it.
  dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
  document.body.append(dialog);
  dialog.showModal();
  done.focus();
  return dialog;
}
