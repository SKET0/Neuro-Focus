// Tracking reliability checks: the shared reading rules (scripts/shared/tracking-states.js), the
// tracker's frame rules (scripts/tracking/gaze-reading.js) and Focus Coach (focus-analysis.js).
// Pure calculations only: no camera, browser or database. Run: cd tests && npm test
import {
  normalizeReading, legacyState, describeReading, createSessionAccumulator, createSampleWindow, sampleKind, sampleRuns,
  hasQualityInfo, missingQualityColumns
} from "../scripts/shared/tracking-states.js";
import { assessFrame, createReadingFilter } from "../scripts/tracking/gaze-reading.js";
import { averageFocus, focusedSeconds, buildCoaching, buildInsights, evidenceFor, compareGroups, timeOfDay, COACH_MINIMUM } from "../scripts/student/focus-analysis.js";

let failures = 0;
const ok = (label, cond, extra = "") => { if (!cond) failures += 1; console.log(`${cond ? "✓" : "✗"} ${label}${extra ? `  ${extra}` : ""}`); };
const section = (name) => console.log(`\n— ${name} —`);

const onScreen = (score = 85) => ({ tracking: "active", score, engagement: "on-screen" });
const away = (score = 30) => ({ tracking: "active", score, engagement: "looking-away" });
const unavailable = (reason = "no-face") => ({ tracking: "unavailable", reason, score: null });
const onBreak = () => ({ tracking: "break", score: null });
// Feeds readings every `step` ms from `from`; returns the time after the last one.
function feed(acc, reading, from, ms, step = 125, events = []) {
  let t = from;
  for (; t < from + ms; t += step) events.push(acc.add(reading, t));
  return t;
}

// ---------- Readings ----------
section("Readings keep a missing score missing");
ok("unavailable reading has no score", normalizeReading(unavailable()).score === null);
ok("legacy 'Away' reading with score 0 is read as unavailable, not 0", normalizeReading({ score: 0, state: "Away" }).tracking === "unavailable" && normalizeReading({ score: 0, state: "Away" }).score === null);
ok("a reading with score null is never turned into 0", normalizeReading({ score: null, state: "Focused" }).score === null);
ok("a reading with no score at all is unavailable", normalizeReading({ state: "Focused" }).tracking === "unavailable");
ok("a real score of 0 from a measured reading stays 0", normalizeReading({ tracking: "active", score: 0, engagement: "looking-away" }).score === 0);
ok("'Stopped' means camera off", normalizeReading({ state: "Stopped" }).tracking === "off");
ok("break reading has no score", normalizeReading(onBreak()).score === null && normalizeReading(onBreak()).tracking === "break");
ok("older teacher pages still get a state name", legacyState(normalizeReading(unavailable())) === "Unavailable" && legacyState(normalizeReading(away())) === "Distracted");
ok("unavailable reading says 'Tracking unavailable' with the reason", describeReading(normalizeReading(unavailable("multiple-faces"))).label === "Tracking unavailable" && describeReading(normalizeReading(unavailable("multiple-faces"))).detail === "More than one face in view");
ok("looking away is labelled as an estimate", describeReading(normalizeReading(away())).detail === "Estimate");

// ---------- Session numbers ----------
section("Student looks briefly away");
{
  const acc = createSessionAccumulator();
  const events = [];
  let t = feed(acc, onScreen(), 0, 20000, 125, events);
  t = feed(acc, away(), t, 1500, 125, events);   // a 1.5-second glance
  t = feed(acc, onScreen(), t, 20000, 125, events);
  const s = acc.snapshot(t);
  ok("a 1.5 s glance is not a looking-away episode", s.episodes === 0);
  ok("no nudge is triggered", !events.some((e) => e.episodeStarted));
  ok("the glance counts as a little looking-away time", s.lookingAwayMs >= 1400 && s.lookingAwayMs <= 1650, `${s.lookingAwayMs} ms`);
  ok("on-screen share dips only slightly", s.focusPercent >= 95 && s.focusPercent < 100, `${s.focusPercent}%`);
}

section("Looking away for longer");
{
  const acc = createSessionAccumulator();
  const events = [];
  let t = feed(acc, onScreen(), 0, 10000, 125, events);
  t = feed(acc, away(), t, 6000, 125, events);
  const startedAt = events.findIndex((e) => e.episodeStarted);
  t = feed(acc, onScreen(), t, 2000, 125, events);
  const s = acc.snapshot(t);
  ok("6 s of looking away is one episode", s.episodes === 1);
  ok("exactly one nudge is triggered, after about 4 s", events.filter((e) => e.episodeStarted).length === 1 && startedAt > 0);
  ok("returning to the screen is noticed", events.some((e) => e.returned));
}

section("Face disappears from view");
{
  const acc = createSessionAccumulator();
  const events = [];
  let t = feed(acc, onScreen(), 0, 30000, 125, events);
  const before = acc.snapshot(t).focusPercent;
  t = feed(acc, unavailable(), t, 30000, 125, events);
  const s = acc.snapshot(t);
  ok("30 s with no face is unavailable time", Math.abs(s.unavailableMs - 30000) <= 250, `${s.unavailableMs} ms`);
  ok("it is not usable time", Math.abs(s.usableMs - 30000) <= 250, `${s.usableMs} ms usable`);
  ok("it is not looking-away time", s.lookingAwayMs === 0);
  ok("no looking-away episode and no nudge", s.episodes === 0 && !events.some((e) => e.episodeStarted));
  ok("the on-screen share is unchanged (not pulled towards 0)", s.focusPercent === before && s.focusPercent === 100, `${before}% → ${s.focusPercent}%`);
  ok("the average score ignores unavailable readings", s.averageScore === 85);
}
{
  const acc = createSessionAccumulator();
  const events = [];
  let t = feed(acc, onScreen(), 0, 10000);
  t = feed(acc, away(), t, 3000, 125, events);       // looking away for 3 s ...
  t = feed(acc, unavailable(), t, 5000, 125, events); // ... then the face is lost
  t = feed(acc, away(), t, 3000, 125, events);
  ok("a looking-away run interrupted by lost tracking doesn't add up to a nudge", acc.snapshot(t).episodes === 0 && !events.some((e) => e.episodeStarted));
}

section("Only unavailable readings");
{
  const acc = createSessionAccumulator();
  const t = feed(acc, unavailable(), 0, 60000);
  const s = acc.snapshot(t);
  ok("no on-screen share is claimed", s.focusPercent === null);
  ok("no average score", s.averageScore === null);
}

section("Intentional break");
{
  const acc = createSessionAccumulator();
  const events = [];
  let t = feed(acc, onScreen(), 0, 20000);
  t = feed(acc, away(), t, 3000, 125, events);
  t = feed(acc, onBreak(), t, 60000, 125, events);
  t = feed(acc, onScreen(), t, 20000, 125, events);
  const s = acc.snapshot(t);
  ok("break time is counted separately", Math.abs(s.breakMs - 60000) <= 250, `${s.breakMs} ms`);
  ok("break time is excluded from usable time", Math.abs(s.usableMs - 43000) <= 300, `${s.usableMs} ms`);
  ok("no looking-away episode or nudge during the break", s.episodes === 0 && !events.some((e) => e.episodeStarted));
  // 320 on-screen readings at 85 and 24 looking-away readings at 30; the 480 break readings add nothing.
  ok("break readings don't change the average score", s.averageScore === Math.round((85 * 320 + 30 * 24) / 344), `${s.averageScore}`);
}

section("Connection drop or page in the background (no readings arrive)");
{
  const acc = createSessionAccumulator();
  let t = feed(acc, onScreen(), 0, 10000);
  t += 20000; // 20 s with no readings at all
  t = feed(acc, onScreen(), t, 10000);
  const s = acc.snapshot(t);
  ok("silence beyond 2 s counts as unavailable, not on screen", Math.abs(s.unavailableMs - 18000) <= 300, `${s.unavailableMs} ms`);
  ok("the on-screen streak restarts after the silence", s.bestStreakMs <= 12500, `${s.bestStreakMs} ms`);
  ok("snapshot doesn't change the totals", JSON.stringify(acc.snapshot(t)) === JSON.stringify(s));
}

// ---------- Tracker frames ----------
section("Tracker frame rules");
function face({ gaze = 0.5, headTurn = 0, open = 0.3, eyeWidth = 0.08, shiftX = 0, y = 0.45 } = {}) {
  const points = Array.from({ length: 478 }, () => ({ x: 0.5 + shiftX, y }));
  const set = (i, x, yy = y) => { points[i] = { x: x + shiftX, y: yy }; };
  const lo = 0.36, li = lo + eyeWidth, ri = 0.56, ro = ri + eyeWidth;
  set(33, lo); set(133, li); set(362, ri); set(263, ro);
  [468, 469, 470, 471, 472].forEach((i) => set(i, lo + eyeWidth * gaze));
  [473, 474, 475, 476, 477].forEach((i) => set(i, ri + eyeWidth * gaze));
  const lid = (open * eyeWidth) / 2;
  set(159, lo + eyeWidth / 2, y - lid); set(145, lo + eyeWidth / 2, y + lid);
  set(386, ri + eyeWidth / 2, y - lid); set(374, ri + eyeWidth / 2, y + lid);
  set(1, lo + (ro - lo) * (0.5 + headTurn), y + 0.06);
  return points;
}
ok("no face → unavailable (no-face)", assessFrame([]).reason === "no-face");
ok("a different/second face in view → unavailable (multiple-faces)", assessFrame([face(), face({ shiftX: 0.1 })]).reason === "multiple-faces");
ok("face partly out of view → unavailable", assessFrame([face({ shiftX: 0.5 })]).reason === "partly-out-of-view");
ok("face too far away → unavailable", assessFrame([face({ eyeWidth: 0.01 })]).reason === "too-far");
ok("eyes closed or hidden → unavailable", assessFrame([face({ open: 0.02 })]).reason === "eyes-not-visible");
ok("a clear face looking ahead is usable", assessFrame([face()]).usable === true && Math.abs(assessFrame([face()]).gaze - 0.5) < 0.01);
{
  const filter = createReadingFilter();
  let t = 0;
  let reading;
  for (; t < 2000; t += 120) reading = filter.next(assessFrame([face()]), t);
  ok("looking ahead gives an active on-screen reading with a score", reading.tracking === "active" && reading.engagement === "on-screen" && reading.score >= 90, `${reading.score}`);
  const blink = filter.next(assessFrame([face({ open: 0.02 })]), t);
  ok("a blink (one unusable frame) is skipped, not reported", blink === null);
  let lost = null;
  for (let u = t; u < t + 700; u += 120) lost = filter.next(assessFrame([]), u) || lost;
  ok("a lost face for 0.5 s+ becomes 'unavailable' with no score", lost?.tracking === "unavailable" && lost.score === null && lost.reason === "no-face");
  t += 1000;
  for (let i = 0; i < 20; i += 1, t += 120) reading = filter.next(assessFrame([face({ gaze: 0.15 })]), t);
  ok("eyes far to one side → looking away (an estimate, still with a score)", reading.engagement === "looking-away" && reading.score !== null);
  filter.reset();
  for (let i = 0; i < 20; i += 1, t += 120) reading = filter.next(assessFrame([face({ headTurn: 0.35 })]), t);
  ok("head strongly turned → looking away", reading.engagement === "looking-away");
  for (let i = 0; i < 6; i += 1, t += 120) reading = filter.next(assessFrame([face(), face({ shiftX: 0.1 })]), t) || reading;
  ok("a second face appearing makes tracking unavailable", reading.tracking === "unavailable" && reading.reason === "multiple-faces");
}

// ---------- Saved samples ----------
section("Saved 5-second samples");
{
  const w = createSampleWindow();
  for (let i = 0; i < 40; i += 1) w.add(i < 30 ? unavailable() : onScreen(), i * 125);
  const row = w.close();
  ok("a mostly unavailable sample is saved as 'Unavailable' with no score", row.state === "Unavailable" && row.score === null);
  for (let i = 0; i < 40; i += 1) w.add(i < 10 ? unavailable() : (i < 30 ? onScreen(90) : away(40)), i * 125);
  const mixed = w.close();
  ok("a mostly measured sample averages only measured readings", mixed.state === "Focused" && mixed.score === Math.round((20 * 90 + 10 * 40) / 30), `${mixed.score}`);
  for (let i = 0; i < 40; i += 1) w.add(onBreak(), i * 125);
  ok("a break sample is saved as 'Break' with no score", w.close().state === "Break");
  ok("an empty window saves nothing", w.close() === null);
}
section("Reopening a saved session");
{
  const at = (s) => new Date(Date.UTC(2026, 9, 6, 10, 0, s)).toISOString();
  const samples = [
    { recorded_at: at(5), score: 90, state: "Focused" }, { recorded_at: at(10), score: 0, state: "Away" },
    { recorded_at: at(15), score: null, state: "Unavailable" }, { recorded_at: at(40), score: 70, state: "Distracted" },
    { recorded_at: at(45), score: null, state: "Break" }
  ];
  const runs = sampleRuns(samples, 5);
  ok("old 'Away' samples are shown as not measured, not 0", sampleKind(samples[1]).kind === "unavailable" && sampleKind(samples[1]).score === null);
  ok("missing samples (20 s with nothing saved) are shown as a gap", runs.some((r) => r.kind === "gap" && r.count === 4), JSON.stringify(runs.map((r) => `${r.kind}×${r.count}`)));
  ok("timeline order: on screen, unavailable, gap, looking away, break", runs.map((r) => r.kind).join(",") === "on-screen,unavailable,gap,looking-away,break");
}

// ---------- Saved sessions and Focus Coach ----------
section("Saved session numbers");
const DAY = 86400000;
const now = Date.UTC(2026, 9, 6, 12);
const session = (daysAgo, usableMin, focus, extra = {}) => ({
  started_at: new Date(now - daysAgo * DAY - 3600e3 * (extra.hourOffset || 0)).toISOString(),
  tracked_seconds: Math.round(usableMin * 60 * 1.2), usable_seconds: usableMin * 60, unavailable_seconds: Math.round(usableMin * 12), break_seconds: 0,
  tracking_version: 2, focus_percent: focus, lapses: 2, best_streak_seconds: 300, ...extra
});
{
  const newer = session(1, 10, 80);
  const older = { started_at: new Date(now - 2 * DAY).toISOString(), tracked_seconds: 600, focus_percent: 50, lapses: 3 };
  ok("on-screen time uses measured time for newer sessions", focusedSeconds(newer) === 480);
  ok("older sessions (no quality info) are recognised", !hasQualityInfo(older) && hasQualityInfo(newer));
  ok("averages are weighted by measured time", averageFocus([newer, session(1, 30, 60)]) === 65);
}
section("Focus Coach: practical tips from any amount of history");
const BANNED = /stayed on task|proof|lock in|improves focus|helps you focus|you focus best|great work/i;
const textOf = (c) => [c.basis, ...c.wins, ...c.tips].map((x) => (typeof x === "string" ? x : `${x.title} ${x.text}`)).join(" ");
const titles = (c) => c.tips.map((t) => t.title).join(" | ");
const settled = { nudgesOn: true, stepsPlanned: true, timerPreset: "25-5" };
{
  const none = buildCoaching([], { nudgesOn: false }, now);
  ok("no sessions → general tips, labelled as general", none.stage === "starter" && /general/i.test(none.basis) && none.tips.every((t) => t.basis === "General tip"));
  ok("general nudge tip doesn't claim it works", /hasn’t measured/.test(textOf(none)) && !BANNED.test(textOf(none)));

  const one = buildCoaching([session(0, 25, 90)], {}, now);
  ok("one session is enough for personal tips (no 5-session minimum)", one.stage === "personal", one.basis);
  ok("the basis says how many sessions it uses", /Based on 1 session/.test(one.basis));
  ok("every tip says what it's based on", one.tips.length > 0 && one.tips.every((t) => typeof t.basis === "string" && t.basis.length > 0), JSON.stringify(one.tips.map((t) => t.basis)));

  const missed = buildCoaching([session(0, 10, 80, { tracked_seconds: 1500 })], settled, now);
  ok("camera couldn't see much of the last session → that tip comes first", /camera missed/i.test(missed.tips[0]?.title || ""), titles(missed));
  ok("…and it's based on the last session", missed.tips[0]?.basis === "From your last session");

  const gap = buildCoaching([session(6, 20, 80)], settled, now);
  ok("a long gap → a gentle restart tip with a start button", /6 days/.test(gap.tips[0]?.title || "") && gap.tips[0].action?.kind === "start", titles(gap));

  const short = buildCoaching([session(0, 4, 80, { tracked_seconds: 300 })], settled, now);
  ok("a very short last session → suggest a full 15-minute block", /last session was 5 min/.test(titles(short)), titles(short));

  const drifting = buildCoaching([session(0, 20, 60, { lapses: 8 })], { stepsPlanned: true, timerPreset: "25-5" }, now);
  const look = drifting.tips.find((t) => /looked away/i.test(t.title));
  ok("frequent look-aways with nudges off → offers nudges", look?.action?.kind === "nudges", titles(drifting));
  ok("look-away tip notes it isn't always a problem", /isn’t always a problem/.test(look?.text || ""));

  const at = (daysAgo, hour, usableMin, focus) => ({ ...session(daysAgo, usableMin, focus), started_at: new Date(Date.UTC(2026, 9, 6 - daysAgo, hour)).toISOString() });
  const times = buildCoaching([at(0, 9, 15, 85), at(1, 15, 15, 60)], settled, now);
  const timeTip = times.tips.find((t) => /highest/.test(t.title));
  ok("time of day from just 2 sessions → shown, but as an early sign", Boolean(timeTip) && /early sign/i.test(timeTip.text), titles(times));

  const lengths = buildCoaching([session(0, 50, 55, { tracked_seconds: 3000 }), session(1, 20, 80), session(2, 20, 78)], { nudgesOn: true, stepsPlanned: true, timerPreset: "45-10" }, now);
  ok("long sessions with lower estimates → suggest 25-minute blocks", lengths.tips.some((t) => /Long sessions/.test(t.title) && t.action?.value === "25-5"), titles(lengths));

  const all = [one, missed, gap, short, drifting, times, lengths];
  ok("no overclaiming wording in any tip", all.every((c) => !BANNED.test(textOf(c))), all.map(textOf).join(" ").match(BANNED)?.[0] || "");
  ok("always at least one practical tip", all.every((c) => c.tips.length >= 1));
}
{
  const enough = [session(0, 15, 82), session(1, 15, 78, { hourOffset: 2 }), session(2, 15, 80), session(3, 15, 76), session(4, 15, 81)];
  const coach = buildCoaching(enough, settled, now);
  ok("with more sessions, wins appear (e.g. studying on several days)", coach.wins.some((w) => /of the last 7 days/.test(w.title)), JSON.stringify(coach.wins.map((w) => w.title)));
  ok("personal tips say they are estimates, not conclusions", /not conclusions/.test(coach.basis));
  const { evidence, insights } = buildInsights(enough);
  ok("My progress insights still use their minimum", evidence.enough && Array.isArray(insights));
}
{
  // Time-of-day comparisons need 3 sessions and 20 measured minutes on each side.
  const at = (daysAgo, hour, usableMin, focus) => ({ ...session(daysAgo, usableMin, focus), started_at: new Date(Date.UTC(2026, 9, 6 - daysAgo, hour)).toISOString() });
  const thin = [at(0, 9, 10, 90), at(1, 9, 10, 90), at(2, 15, 10, 50), at(3, 15, 10, 50)];
  ok("a time-of-day pattern from 2 sessions per side is not reported", compareGroups(thin, timeOfDay) === null);
}

// ---------- Database fallback ----------
section("Before the database update");
ok("a missing tracking-quality column is recognised", missingQualityColumns({ code: "PGRST204", message: "Could not find the 'usable_seconds' column of 'attention_sessions' in the schema cache" }));
ok("other errors are not mistaken for it", !missingQualityColumns({ code: "42501", message: "new row violates row-level security policy" }));

console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL TRACKING CHECKS PASSED");
process.exit(failures ? 1 : 0);
