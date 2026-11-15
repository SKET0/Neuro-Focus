// Drowsiness: eyes closed for 3 seconds or more, on a face that's clearly in view and roughly
// facing the screen, reads as "eyes closed" (measured, not focused) instead of "unavailable".
// Pure calculations only (scripts/tracking/gaze-reading.js, scripts/shared/tracking-states.js).
// Run: cd tests && npm test
import { assessFrame, createReadingFilter, LIMITS } from "../scripts/tracking/gaze-reading.js";
import { normalizeReading, describeReading, legacyState, createSessionAccumulator } from "../scripts/shared/tracking-states.js";

let failures = 0;
const ok = (label, cond, extra = "") => { if (!cond) failures += 1; console.log(`${cond ? "✓" : "✗"} ${label}${extra ? `  ${extra}` : ""}`); };

// A face looking ahead (the same layout as tests/tracking.test.mjs); open = lid gap / eye width.
function face({ open = 0.3, eyeWidth = 0.08, y = 0.45 } = {}) {
  const points = Array.from({ length: 478 }, () => ({ x: 0.5, y }));
  const set = (i, x, yy = y) => { points[i] = { x, y: yy }; };
  const lo = 0.36, li = lo + eyeWidth, ri = 0.56, ro = ri + eyeWidth;
  set(33, lo); set(133, li); set(362, ri); set(263, ro);
  [468, 469, 470, 471, 472].forEach((i) => set(i, lo + eyeWidth / 2));
  [473, 474, 475, 476, 477].forEach((i) => set(i, ri + eyeWidth / 2));
  const lid = (open * eyeWidth) / 2;
  set(159, lo + eyeWidth / 2, y - lid); set(145, lo + eyeWidth / 2, y + lid);
  set(386, ri + eyeWidth / 2, y - lid); set(374, ri + eyeWidth / 2, y + lid);
  set(1, (lo + ro) / 2, y + 0.06);
  return points;
}
// A 4×4 column-major head matrix: turned by `yaw` degrees, nodded down by `pitch` degrees.
function matrix({ yaw = 0, pitch = 0 } = {}) {
  const a = (yaw * Math.PI) / 180, p = (pitch * Math.PI) / 180;
  const R = [
    [Math.cos(a), Math.sin(a) * Math.sin(p), Math.sin(a) * Math.cos(p)],
    [0, Math.cos(p), -Math.sin(p)],
    [-Math.sin(a), Math.cos(a) * Math.sin(p), Math.cos(a) * Math.cos(p)]
  ];
  const data = new Array(16).fill(0);
  for (let r = 0; r < 3; r += 1) for (let c = 0; c < 3; c += 1) data[c * 4 + r] = R[r][c];
  data[15] = 1;
  return { data };
}
const open = () => assessFrame([face()]);
const closed = (head) => assessFrame([face({ open: 0.02 })], head ? [matrix(head)] : []);
// Feeds one kind of frame every 120 ms for `ms`; returns { t, readings } (nulls left out).
function feed(filter, frame, t, ms) {
  const readings = [];
  for (const end = t + ms; t < end; t += 120) { const r = filter.next(frame(), t); if (r) readings.push(r); }
  return { t, readings };
}

console.log("— Telling closed eyes from hidden eyes —");
ok("closed eyes, facing the camera → eyes-closed", closed().reason === "eyes-closed");
ok("closed eyes with the head drooping 20° (tired) → eyes-closed", closed({ pitch: 20 }).reason === "eyes-closed");
ok("closed-looking eyes with the head turned 45° → eyes not visible (can't judge the lids)", closed({ yaw: 45 }).reason === "eyes-not-visible");
ok("closed-looking eyes with the head bowed 45° (e.g. notes on the desk) → eyes not visible", closed({ pitch: 45 }).reason === "eyes-not-visible");
ok("open eyes are still usable", open().usable === true);

console.log("\n— The 3-second rule —");
{
  const filter = createReadingFilter();
  let { t, readings } = feed(filter, open, 0, 2000);
  ok("open eyes → on-screen", readings.at(-1).engagement === "on-screen" && !readings.at(-1).drowsy);
  ({ t, readings } = feed(filter, () => closed(), t, 400));
  ok("eyes closed for under 0.5 s (a blink) → nothing new", readings.length === 0);
  ({ t, readings } = feed(filter, () => closed(), t, 2400));
  ok("eyes closed for 0.5–3 s → unavailable (not measured), as before", readings.length > 0 && readings.every((r) => r.tracking === "unavailable" && r.reason === "eyes-closed" && r.score === null));
  ({ t, readings } = feed(filter, () => closed(), t, 600));
  const drowsy = readings.at(-1);
  ok("eyes closed for 3 s+ → a measured 'eyes closed' reading", drowsy?.tracking === "active" && drowsy.drowsy === true && drowsy.engagement === "looking-away");
  ok("…with the lowest score, not unavailable or 0", drowsy?.score === LIMITS.drowsyScore && drowsy.reason === null);
  ({ t, readings } = feed(filter, open, t, 600));
  ok("opening the eyes → back to on-screen, no longer drowsy", readings.at(-1).engagement === "on-screen" && !readings.at(-1).drowsy);
}
{
  const filter = createReadingFilter();
  let { t } = feed(filter, open, 0, 1500);
  let readings;
  ({ t, readings } = feed(filter, () => closed(), t, 1200));
  ok("a slow blink (1.2 s) is only briefly unavailable", readings.every((r) => r.tracking === "unavailable"));
  ({ t, readings } = feed(filter, open, t, 1000));
  ok("…and never counts as drowsy", readings.every((r) => !r.drowsy && r.tracking === "active"));
}
{
  const filter = createReadingFilter();
  let { t } = feed(filter, open, 0, 1000);
  let readings;
  ({ t } = feed(filter, () => closed(), t, 1500));
  ({ t, readings } = feed(filter, () => closed({ pitch: 45 }), t, 2000));
  ok("eyes closed, then the head droops further (lids can't be judged) → still drowsy", readings.at(-1)?.drowsy === true);
}
{
  const filter = createReadingFilter();
  let { t } = feed(filter, open, 0, 1000);
  const { readings } = feed(filter, () => closed({ yaw: 45 }), t, 1500);
  ok("eyes not visible on their own → unavailable, as before", readings.at(-1)?.tracking === "unavailable" && readings.at(-1).reason === "eyes-not-visible");
}
{
  const filter = createReadingFilter();
  let { t } = feed(filter, open, 0, 1000);
  ({ t } = feed(filter, () => closed(), t, 2000));
  filter.reset();
  const { readings } = feed(filter, () => closed(), t, 1500);
  ok("reset starts the 3 seconds again", readings.every((r) => !r.drowsy));
}

console.log("\n— What 'eyes closed' means everywhere —");
{
  const raw = { tracking: "active", score: 10, engagement: "looking-away", drowsy: true };
  const reading = normalizeReading(raw);
  ok("shared readings keep the eyes-closed mark", reading.drowsy === true && reading.engagement === "looking-away");
  ok("it's labelled 'Eyes closed' for students and teachers", describeReading(reading).label === "Eyes closed");
  ok("saved and sent as Distracted (not focused)", legacyState(reading) === "Distracted");
  ok("ordinary readings carry no mark", !("drowsy" in normalizeReading({ tracking: "active", score: 80, engagement: "on-screen" })));
  ok("an on-screen reading can't be drowsy", !normalizeReading({ tracking: "active", score: 80, engagement: "on-screen", drowsy: true }).drowsy);
  const acc = createSessionAccumulator();
  for (let at = 0; at <= 5000; at += 125) acc.add(raw, at);
  const summary = acc.snapshot(5000);
  ok("eyes-closed time counts as measured, not focused", summary.lookingAwayMs >= 4900 && summary.onScreenMs === 0 && summary.unavailableMs === 0);
}

console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL DROWSINESS CHECKS PASSED");
process.exit(failures ? 1 : 0);
