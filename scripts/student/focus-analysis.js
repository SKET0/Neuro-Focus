// Reading a student's saved focus sessions (attention_sessions rows), shared by My progress
// (student-history.js: insights for a date range), Home (student-dashboard.js: the Focus coach)
// and the teacher Home (teacher-home.js: class focus and insights from shared live-session history).
//
// Everything here comes from the student's own saved numbers, and those numbers are estimates
// from face and eye direction (scripts/shared/tracking-states.js). So:
//   - "focus" means the estimated share of *measured* time the face and eyes pointed at the screen;
//     time when tracking was unavailable or on a break is not part of it.
//   - patterns are only described once there is a clearly stated minimum of measured data, and
//     always as tentative observations, never as proof;
//   - nothing claims that a technique (nudges, short blocks, ...) improves focus: Neuro-Focus has
//     not evaluated that. General tips are labelled as general.
//
// Older sessions (saved before tracking-quality checks) have no usable_seconds. Their focus_percent
// counted time with no face in view as "not focused", so they still show in history and totals,
// but personal patterns and suggestions only use sessions with tracking-quality information.

export const sum = (list, fn) => list.reduce((total, item) => total + fn(item), 0);
export const hasFocus = (s) => s.focus_percent !== null && s.focus_percent !== undefined;
export const hasQualityInfo = (s) => s.usable_seconds !== null && s.usable_seconds !== undefined;
// Time that was actually measured: usable time for newer sessions, tracked time for older ones.
export const measuredSeconds = (s) => (hasQualityInfo(s) ? s.usable_seconds : s.tracked_seconds || 0);
export const focusedSeconds = (s) => (hasFocus(s) ? (measuredSeconds(s) * s.focus_percent) / 100 : 0);

// Estimated on-screen share, weighted by measured time, so a 1-minute session doesn't count like a 40-minute one.
export function averageFocus(list) {
  const scored = list.filter(hasFocus);
  const measured = sum(scored, measuredSeconds);
  return measured ? Math.round(sum(scored, focusedSeconds) / measured * 100) : null;
}

// Words for an estimated on-screen share. They describe what was recorded, not how well someone focused.
export const LEVELS = [
  { min: 80, key: "great", label: "Mostly on screen", color: "var(--green)" },
  { min: 60, key: "good", label: "Often on screen", color: "var(--info)" },
  { min: 40, key: "mixed", label: "Mixed", color: "var(--amber)" },
  { min: 0, key: "tough", label: "Often looking away", color: "var(--red)" }
];
export const levelFor = (pct) => LEVELS.find((level) => pct >= level.min);

export const TIMES = [
  { key: "morning", from: 5, to: 12, phrase: "in the morning", name: "the morning" },
  { key: "afternoon", from: 12, to: 17, phrase: "in the afternoon", name: "the afternoon" },
  { key: "evening", from: 17, to: 21, phrase: "in the evening", name: "the evening" },
  { key: "night", from: 21, to: 29, phrase: "late at night", name: "late at night" }
];
// preset: the focus timer setting (student-focus.js) that matches each length.
export const LENGTHS = [
  { max: 15 * 60, phrase: "sessions under 15 minutes", preset: "15-3", presetLabel: "15-minute blocks" },
  { max: 30 * 60, phrase: "15–30 minute sessions", preset: "25-5", presetLabel: "25-minute blocks" },
  { max: Infinity, phrase: "sessions over 30 minutes", preset: "45-10", presetLabel: "45-minute blocks" }
];

const hourOf = (s) => { const h = new Date(s.started_at).getHours(); return h < 5 ? h + 24 : h; };
export const timeOfDay = (s) => TIMES.find((t) => hourOf(s) >= t.from && hourOf(s) < t.to).key;
const lengthOf = (s) => LENGTHS.findIndex((l) => (s.tracked_seconds || 0) < l.max);

// ---------- How much data is enough ----------
// Personal suggestions need, within the period looked at (30 days on Home, the chosen range in
// My progress), at least 5 sessions with tracking-quality information, on at least 3 different
// days, with at least 60 minutes of measured (usable) tracking in total. A session counts only if
// it has 2 or more measured minutes.
export const COACH_MINIMUM = { sessions: 5, days: 3, minutes: 60, sessionMinutes: 2 };
// A comparison (time of day, session length) needs each side to have 3 sessions and 20 measured
// minutes, and a difference of 10 points or more, before it is mentioned.
export const GROUP_MINIMUM = { sessions: 3, minutes: 20, difference: 10 };
const DAY = 86400000;

export const countsAsEvidence = (s) => hasFocus(s) && hasQualityInfo(s) && s.usable_seconds >= COACH_MINIMUM.sessionMinutes * 60;

export function evidenceFor(list) {
  const used = list.filter(countsAsEvidence);
  const days = new Set(used.map((s) => new Date(s.started_at).toDateString())).size;
  const minutes = Math.floor(sum(used, (s) => s.usable_seconds) / 60);
  return {
    used,
    sessions: used.length,
    days,
    minutes,
    older: list.filter((s) => !hasQualityInfo(s)).length,
    enough: used.length >= COACH_MINIMUM.sessions && days >= COACH_MINIMUM.days && minutes >= COACH_MINIMUM.minutes
  };
}

export const EVIDENCE_RULE = `${COACH_MINIMUM.sessions} sessions on ${COACH_MINIMUM.days} different days, with ${COACH_MINIMUM.minutes} minutes of measured tracking`;

// Compares groups (time of day, session length) and returns the highest and lowest, only when
// both have enough measured data and differ clearly. Returns null otherwise.
export function compareGroups(list, groupOf, minimum = GROUP_MINIMUM) {
  const groups = new Map();
  list.filter(hasFocus).forEach((s) => {
    const key = groupOf(s);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  });
  const scored = [...groups]
    .filter(([, items]) => items.length >= minimum.sessions && sum(items, measuredSeconds) >= minimum.minutes * 60)
    .map(([key, items]) => ({ key, avg: averageFocus(items), count: items.length }))
    .sort((a, b) => b.avg - a.avg);
  return scored.length >= 2 && scored[0].avg - scored[scored.length - 1].avg >= minimum.difference
    ? { best: scored[0], worst: scored[scored.length - 1] } : null;
}

// Trend: the newer half of the sessions against the older half. Needs 6 or more sessions, and
// 20 measured minutes in each half. A change under 10 points is reported as steady.
export function trendOf(newestFirst) {
  const chronological = newestFirst.filter(hasFocus).slice().reverse();
  if (chronological.length < 6) return null;
  const half = Math.floor(chronological.length / 2);
  const older = chronological.slice(0, half);
  const newer = chronological.slice(half);
  if (sum(older, measuredSeconds) < 20 * 60 || sum(newer, measuredSeconds) < 20 * 60) return null;
  const before = averageFocus(older);
  const after = averageFocus(newer);
  const change = after - before;
  return { before, after, overall: averageFocus(chronological), change, direction: change >= 10 ? "up" : change <= -10 ? "down" : "steady" };
}

// Looking away for 4+ seconds while tracking could measure: about once every `every` measured
// minutes. Needs 60 measured minutes.
export function lookAwayRate(list) {
  const minutes = sum(list, measuredSeconds) / 60;
  if (minutes < COACH_MINIMUM.minutes) return null;
  const episodes = sum(list, (s) => s.lapses || 0);
  return { episodes, minutes, every: episodes ? Math.max(1, Math.round(minutes / episodes)) : null };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const mins = (seconds) => (seconds >= 3600 ? `${Math.floor(seconds / 3600)}h ${Math.round((seconds % 3600) / 60)}m` : `${Math.max(1, Math.round(seconds / 60))} min`);
const ESTIMATE_NOTE = "These are estimates from face and eye direction, and can change with lighting, camera angle or the kind of work.";

// ---------- My progress: insights for the chosen range (newest first) ----------
// Returns { evidence, insights }. With too little measured data, insights is empty and the page
// explains what is still needed.
export function buildInsights(current) {
  const evidence = evidenceFor(current);
  if (!evidence.enough) return { evidence, insights: [] };
  const used = evidence.used;
  const insights = [];
  const trend = trendOf(used);
  if (trend?.direction === "up") insights.push({ tone: "green", icon: "i-trend", title: "Recorded on-screen time has gone up", text: `Your more recent sessions were estimated at ${trend.after}% of measured time on screen, compared with ${trend.before}% earlier. ${ESTIMATE_NOTE}` });
  else if (trend?.direction === "down") insights.push({ tone: "amber", icon: "i-flag", title: "Recorded on-screen time has gone down", text: `Recent sessions were estimated at ${trend.after}%, down from ${trend.before}% earlier. If that matches how you felt, a quieter spot or shorter blocks might be worth trying.` });
  else if (trend) insights.push({ tone: "", icon: "i-target", title: "Recorded on-screen time has been steady", text: `Around ${trend.overall}% of measured time across these sessions.` });

  const times = compareGroups(used, timeOfDay);
  if (times) {
    const best = TIMES.find((t) => t.key === times.best.key);
    const worst = TIMES.find((t) => t.key === times.worst.key);
    insights.push({ tone: "", icon: "i-sun", title: `Higher estimates ${best.phrase}`, text: `${times.best.avg}% ${best.phrase} (${plural(times.best.count, "session")}) against ${times.worst.avg}% ${worst.phrase} (${plural(times.worst.count, "session")}). This may be a pattern: you could try harder work ${best.phrase} and see whether it suits you.` });
  }

  const lengths = compareGroups(used, lengthOf);
  if (lengths) {
    const best = LENGTHS[lengths.best.key];
    const worst = LENGTHS[lengths.worst.key];
    insights.push({ tone: "", icon: "i-timer", title: `Higher estimates in ${best.phrase}`, text: `${lengths.best.avg}% of measured time on screen, against ${lengths.worst.avg}% in ${worst.phrase}. A tentative pattern from ${plural(lengths.best.count + lengths.worst.count, "session")}.` });
  }

  const rate = lookAwayRate(used);
  if (rate) {
    insights.push(rate.episodes
      ? { tone: "", icon: "i-flag", title: `Looked away 4s+ about once every ${plural(rate.every, "minute")}`, text: `Recorded across ${mins(rate.minutes * 60)} of measured tracking. Looking away isn’t always losing focus: reading notes or thinking counts too.` }
      : { tone: "green", icon: "i-check", title: "No 4-second look-aways recorded", text: `Across ${mins(rate.minutes * 60)} of measured tracking in this range.` });
  }
  return { evidence, insights: insights.slice(0, 4) };
}

// ---------- Home: the Focus coach ----------
// Practical tips from whatever history there is, from a single session up: nothing is held back
// until a minimum is reached. Every tip says what it is based on ("From your last session",
// "From 4 sessions"), and fewer sessions mean softer wording ("an early sign"). Tips are
// suggestions to try, never claims that something improves focus (Neuro-Focus hasn't measured
// that). With no sessions at all, general tips are shown and labelled as general.
// sessions: finished saved sessions, newest first. habits: { nudgesOn, stepsPlanned, timerPreset }.
// Returns { stage: "starter" | "personal", basis, wins, tips, evidence }; tips carry an optional
// action the Home page knows how to run ({ kind: "start" | "preset" | "nudges" | "step" }).
const COACH_GROUP = { sessions: 1, minutes: 5, difference: 8 }; // time-of-day / length comparisons
const minutesOf = (s) => (s.tracked_seconds || 0) / 60;
const measuredShare = (s) => (hasQualityInfo(s) && s.tracked_seconds ? s.usable_seconds / s.tracked_seconds : null);
const sessionsPhrase = (n) => (n === 1 ? "From your last session" : `From ${n} sessions`);
const tentative = (n) => (n <= 2 ? "An early sign, so see if it holds." : n <= 4 ? "A possible pattern so far." : "");

function generalTips(habits) {
  const tips = [];
  if (habits.timerPreset !== "15-3" && habits.timerPreset !== "10-2") {
    tips.push({ icon: "i-timer", title: "Start with short blocks", text: "15 minutes of work and a 3-minute break is easier to begin than one long stretch.", action: { kind: "preset", value: "15-3", label: "Use 15-minute blocks" }, basis: "General tip" });
  }
  if (!habits.stepsPlanned) tips.push({ icon: "i-list", title: "Write 2–3 tiny steps first", text: "“Read page 12” is easier to start than “study biology”.", action: { kind: "step", label: "Add a step" }, basis: "General tip" });
  if (!habits.nudgesOn) tips.push({ icon: "i-spark", title: "Try gentle nudges", text: "Get a soft reminder when the tracker thinks you’ve looked away. Neuro-Focus hasn’t measured whether they help, so see if they suit you.", action: { kind: "nudges", label: "Turn nudges on" }, basis: "General tip" });
  tips.push({ icon: "i-eye", title: "Help the tracker see you", text: "Face the screen with light in front of you, not behind. Time the camera can’t see isn’t counted.", basis: "General tip" });
  return tips;
}

export function buildCoaching(sessions, habits = {}, now = Date.now()) {
  const recent = sessions.filter((s) => now - new Date(s.started_at) < 30 * DAY && (s.tracked_seconds || 0) >= 60);
  const scored = recent.filter(hasFocus);
  const evidence = evidenceFor(recent);
  if (!recent.length) {
    const wins = [];
    if (habits.stepsPlanned) wins.push({ icon: "i-list", title: "Your steps are planned", text: "Your next steps are written down in Today." });
    return { stage: "starter", basis: "General tips · track a focus session and tips will be based on it", evidence, wins, tips: generalTips(habits).slice(0, 4) };
  }

  const last = recent[0];
  const n = scored.length;
  const lastWeek = recent.filter((s) => now - new Date(s.started_at) < 7 * DAY);
  const activeDays = new Set(lastWeek.map((s) => new Date(s.started_at).toDateString())).size;
  const daysSinceLast = Math.floor((now - new Date(last.started_at)) / DAY);
  const average = averageFocus(scored);
  const candidates = []; // { priority, ...tip }
  const wins = [];
  const add = (priority, tip) => candidates.push({ priority, ...tip });

  // Coming back after a gap
  if (daysSinceLast >= 3) {
    add(85, { icon: "i-rocket", title: `It’s been ${daysSinceLast} days since your last session`, text: "Ease back in with one short 15-minute block. Getting started is the hardest part.", action: { kind: "start", label: "Start a focus session" }, basis: "From your session history" });
  }

  // The camera couldn't see much of the last session
  const share = measuredShare(last);
  if (share !== null && share < 0.65 && minutesOf(last) >= 3) {
    add(90, { icon: "i-eye", tone: "amber", title: "The camera missed part of your last session", text: `It could see you for about ${Math.round(share * 100)}% of the ${mins(last.tracked_seconds)}. Face the screen with light in front of you, so more of your time counts.`, basis: "From your last session" });
  }

  // Looking away often (last session, or across sessions when there are several)
  const lookSource = n >= 3 ? scored : [last];
  const lookMinutes = sum(lookSource, measuredSeconds) / 60;
  const lookEpisodes = sum(lookSource, (s) => s.lapses || 0);
  const lookEvery = lookEpisodes ? lookMinutes / lookEpisodes : null;
  if (lookEvery !== null && lookMinutes >= 5 && lookEvery < 6) {
    const every = Math.max(1, Math.round(lookEvery));
    const base = `The tracker recorded you looking away for 4+ seconds about every ${plural(every, "minute")}${lookSource.length === 1 ? " in your last session" : ""}. Reading notes counts too, so this isn’t always a problem.`;
    const basis = sessionsPhrase(lookSource.length);
    if (!habits.nudgesOn) add(80, { icon: "i-spark", title: "You looked away quite often", text: `${base} Gentle nudges can remind you when you drift; see if they suit you.`, action: { kind: "nudges", label: "Turn nudges on" }, basis });
    else if (!habits.stepsPlanned) add(78, { icon: "i-list", title: "You looked away quite often", text: `${base} Writing your next step down can make it quicker to restart.`, action: { kind: "step", label: "Add a step" }, basis });
    else if (habits.timerPreset !== "15-3") add(76, { icon: "i-timer", title: "You looked away quite often", text: `${base} Shorter blocks with a break might feel easier.`, action: { kind: "preset", value: "15-3", label: "Use 15-minute blocks" }, basis });
  } else if (lookEvery === null && lookMinutes >= 10) {
    wins.push({ icon: "i-target", title: "No 4-second look-aways recorded", text: `${sessionsPhrase(lookSource.length)}, across ${mins(lookMinutes * 60)}.` });
  }

  // Very short last session
  if (minutesOf(last) < 8 && daysSinceLast < 3) {
    add(70, { icon: "i-timer", title: `Your last session was ${mins(last.tracked_seconds)}`, text: "Short sessions are a fine start. Next time, aim for one full 15-minute block with a break after.", action: habits.timerPreset === "15-3" ? { kind: "start", label: "Start 15 minutes" } : { kind: "preset", value: "15-3", label: "Use 15-minute blocks" }, basis: "From your last session" });
  }

  // Long sessions vs shorter ones (or long sessions with lower estimates)
  const long = scored.filter((s) => minutesOf(s) >= 40);
  const shorter = scored.filter((s) => minutesOf(s) < 40);
  const longAvg = averageFocus(long);
  const shortAvg = averageFocus(shorter);
  if (long.length && shorter.length && longAvg !== null && shortAvg !== null && shortAvg - longAvg >= COACH_GROUP.difference) {
    add(74, { icon: "i-timer", title: "Long sessions have gone less well", text: `Sessions over 40 minutes were about ${longAvg}% on screen, against ${shortAvg}% for shorter ones. Try 25-minute blocks with a 5-minute break. ${tentative(n)}`.trim(), action: habits.timerPreset !== "25-5" ? { kind: "preset", value: "25-5", label: "Use 25-minute blocks" } : null, basis: sessionsPhrase(n) });
  } else if (long.length && !shorter.length && longAvg !== null && longAvg < 65) {
    add(66, { icon: "i-timer", title: "Your sessions are long", text: `They average over 40 minutes, at about ${longAvg}% on screen. A short break every 25 minutes might make them easier.`, action: habits.timerPreset !== "25-5" ? { kind: "preset", value: "25-5", label: "Use 25-minute blocks" } : null, basis: sessionsPhrase(n) });
  }

  // Time of day: which part of the day has gone best so far
  const times = compareGroups(scored, timeOfDay, COACH_GROUP);
  if (times) {
    const best = TIMES.find((t) => t.key === times.best.key);
    const worst = TIMES.find((t) => t.key === times.worst.key);
    add(60, { icon: "i-sun", title: `Your estimates are highest ${best.phrase}`, text: `About ${times.best.avg}% on screen ${best.phrase}, against ${times.worst.avg}% ${worst.phrase}. Try your hardest work ${best.phrase} when you can. ${tentative(times.best.count + times.worst.count)}`.trim(), basis: sessionsPhrase(times.best.count + times.worst.count) });
  }

  // Direction over time (4+ sessions: newer half against older half)
  if (n >= 4) {
    const chronological = scored.slice().reverse();
    const half = Math.floor(chronological.length / 2);
    const before = averageFocus(chronological.slice(0, half));
    const after = averageFocus(chronological.slice(half));
    if (before !== null && after !== null && after - before >= 8) wins.push({ icon: "i-trend", title: "Your recent sessions are going up", text: `About ${after}% on screen recently, up from ${before}% earlier.` });
    else if (before !== null && after !== null && before - after >= 8) {
      add(65, { icon: "i-flag", tone: "amber", title: "Your recent sessions have dipped", text: `About ${after}% on screen recently, down from ${before}%. It could be tiredness, the kind of work or the lighting. A quieter spot or shorter blocks might help.`, action: habits.timerPreset !== "15-3" ? { kind: "preset", value: "15-3", label: "Try 15-minute blocks" } : null, basis: sessionsPhrase(n) });
    }
  }

  // Rhythm across the week
  if (activeDays <= 1 && recent.length >= 2 && daysSinceLast < 3) {
    add(45, { icon: "i-calendar", title: "Spread your sessions out", text: "You’ve studied on one day this week. A few short sessions on different days are often easier than one long one.", action: { kind: "start", label: "Start a focus session" }, basis: "From this week" });
  }
  if (!habits.stepsPlanned) {
    add(35, { icon: "i-list", title: "Plan your next step", text: "Write down one small, specific step before you start, like “answer questions 1–3”.", action: { kind: "step", label: "Add a step" }, basis: "General tip" });
  }

  // What's going well
  if (activeDays >= 3) wins.push({ icon: "i-calendar", title: `You studied on ${activeDays} of the last 7 days`, text: "Keeping a rhythm makes starting easier." });
  const bestStreak = scored.reduce((top, s) => Math.max(top, s.best_streak_seconds || 0), 0);
  if (bestStreak >= 600) wins.push({ icon: "i-flame", title: `Longest stretch on screen: ${mins(bestStreak)}`, text: "One continuous stretch, as estimated by the tracker." });
  if (average !== null && average >= 75) wins.push({ icon: "i-check", title: `About ${average}% of measured time on screen`, text: `${sessionsPhrase(n)} in the last 30 days.` });

  const tips = candidates.sort((a, b) => b.priority - a.priority).map(({ priority, ...tip }) => tip);
  // Always offer something practical: general tips fill in behind the personal ones.
  const duplicate = (tip) => tips.some((t) => t.title === tip.title || (tip.action && t.action?.kind === tip.action.kind));
  generalTips(habits).forEach((tip) => { if (tips.length < 3 && !duplicate(tip)) tips.push(tip); });
  return {
    stage: "personal",
    basis: `Based on ${plural(recent.length, "session")} in the last 30 days · estimates from face and eye direction, not conclusions`,
    evidence,
    wins: wins.slice(0, 3),
    tips: tips.slice(0, 4)
  };
}
