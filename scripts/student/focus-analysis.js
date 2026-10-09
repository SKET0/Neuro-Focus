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
// sessions: finished saved sessions, newest first. habits: what the student has set up right now
// ({ nudgesOn, stepsPlanned, timerPreset }). Returns what the tracker recorded, what might be worth
// trying (each tip can carry an action the Home page knows how to run) and what it is based on.
export function buildCoaching(sessions, habits = {}, now = Date.now()) {
  const recent = sessions.filter((s) => now - new Date(s.started_at) < 30 * DAY);
  const evidence = evidenceFor(recent);
  const lastWeek = sessions.filter((s) => now - new Date(s.started_at) < 7 * DAY);
  const activeDays = new Set(lastWeek.map((s) => new Date(s.started_at).toDateString())).size;
  const daysSinceLast = sessions.length ? Math.floor((now - new Date(sessions[0].started_at)) / DAY) : null;
  const wins = [];
  const tips = [];
  const progress = {
    sessions: { done: Math.min(evidence.sessions, COACH_MINIMUM.sessions), needed: COACH_MINIMUM.sessions },
    days: { done: Math.min(evidence.days, COACH_MINIMUM.days), needed: COACH_MINIMUM.days },
    minutes: { done: Math.min(evidence.minutes, COACH_MINIMUM.minutes), needed: COACH_MINIMUM.minutes }
  };

  // ----- Not enough measured data yet: general tips, clearly labelled as general -----
  if (!evidence.enough) {
    if (sessions.length) {
      wins.push({ icon: "i-check", title: `${plural(sessions.length, "session")} recorded so far`, text: `${mins(sum(sessions, measuredSeconds))} of measured tracking saved.` });
    }
    if (habits.stepsPlanned) wins.push({ icon: "i-list", title: "You’ve planned your steps", text: "Your next steps are written down in Today." });
    if (habits.nudgesOn) wins.push({ icon: "i-spark", title: "Nudges are on", text: "You’ll get a gentle reminder if the tracker estimates you’ve looked away for a few seconds." });

    if (habits.timerPreset !== "15-3" && habits.timerPreset !== "10-2") {
      tips.push({ icon: "i-timer", title: "Try short blocks", text: "Many students find 15 minutes of work and a 3-minute break easier to stick with than one long stretch. A general tip, not based on your data.", action: { kind: "preset", value: "15-3", label: "Use 15-minute blocks" } });
    }
    if (!habits.stepsPlanned) {
      tips.push({ icon: "i-list", title: "Write 2–3 tiny steps first", text: "“Read page 12” is often easier to begin than “study biology”. A general tip.", action: { kind: "step", label: "Add a step" } });
    }
    if (!habits.nudgesOn) {
      tips.push({ icon: "i-spark", title: "Nudges are off", text: "Turn them on if you’d like a gentle reminder when the tracker estimates you’ve looked away. Neuro-Focus hasn’t measured whether they help, so see if they suit you.", action: { kind: "nudges", label: "Turn nudges on" } });
    }
    tips.push({ icon: "i-eye", title: "Help the tracker measure", text: "Keep your face in view and well lit, with no one else in the picture. Time the camera can’t measure isn’t counted at all." });
    return {
      stage: "starter",
      basis: `General tips, not based on your data · personal suggestions need ${EVIDENCE_RULE} in the last 30 days`,
      evidence,
      progress,
      wins,
      tips: tips.slice(0, 3)
    };
  }

  // ----- Personal: tentative, from their measured sessions in the last 30 days -----
  const used = evidence.used;
  const trend = trendOf(used);
  const rate = lookAwayRate(used);
  const times = compareGroups(used, timeOfDay);
  const lengths = compareGroups(used, lengthOf);
  const average = averageFocus(used);
  const bestStreak = used.reduce((top, s) => Math.max(top, s.best_streak_seconds || 0), 0);

  if (activeDays >= 3) wins.push({ icon: "i-calendar", title: `You studied on ${activeDays} of the last 7 days`, text: "Recorded in your saved sessions." });
  if (trend?.direction === "up") wins.push({ icon: "i-trend", title: "Recorded on-screen time has gone up", text: `Estimated ${trend.after}% recently, compared with ${trend.before}% earlier.` });
  if (average !== null && average >= 75) wins.push({ icon: "i-check", title: `About ${average}% of measured time on screen`, text: `The tracker’s estimate across ${mins(evidence.minutes * 60)} of measured tracking.` });
  if (rate && (!rate.episodes || rate.every >= 10)) {
    wins.push(rate.episodes
      ? { icon: "i-target", title: `Looked away 4s+ about once every ${rate.every} minutes`, text: `Recorded across ${mins(rate.minutes * 60)} of measured tracking.` }
      : { icon: "i-target", title: "No 4-second look-aways recorded", text: `Across ${mins(rate.minutes * 60)} of measured tracking.` });
  }
  if (times) {
    const best = TIMES.find((t) => t.key === times.best.key);
    const worst = TIMES.find((t) => t.key === times.worst.key);
    wins.push({ icon: "i-sun", title: `Higher estimates ${best.phrase}`, text: `${times.best.avg}% then, against ${times.worst.avg}% ${worst.phrase}. Possibly a pattern; worth testing for yourself.` });
  }
  if (bestStreak >= 600) wins.push({ icon: "i-flame", title: `Longest stretch recorded on screen: ${mins(bestStreak)}`, text: "A continuous stretch the tracker estimated as looking at the screen." });

  // What might be worth trying, most relevant first. Suggestions, not conclusions.
  if (daysSinceLast !== null && daysSinceLast >= 4) {
    tips.push({ icon: "i-rocket", title: `It’s been ${daysSinceLast} days since your last session`, text: "Starting small, like one 10–15 minute block, can make it easier to get going again.", action: { kind: "start", label: "Start a focus session" } });
  }
  if (trend?.direction === "down") {
    tips.push({ icon: "i-flag", tone: "amber", title: "Recorded on-screen time has gone down", text: `Estimated ${trend.after}% recently, down from ${trend.before}%. This could be lighting or the kind of work. If it matches how you felt, shorter blocks might be worth a try.`, action: habits.timerPreset !== "15-3" ? { kind: "preset", value: "15-3", label: "Try 15-minute blocks" } : null });
  }
  if (rate && rate.episodes && rate.every < 10) {
    const base = `The tracker recorded looking away for 4+ seconds about once every ${plural(rate.every, "minute")}. That can include reading notes.`;
    if (!habits.nudgesOn) tips.push({ icon: "i-spark", title: "Nudges are off", text: `${base} Turn them on if you’d like a reminder; Neuro-Focus hasn’t measured whether they help.`, action: { kind: "nudges", label: "Turn nudges on" } });
    else if (!habits.stepsPlanned) tips.push({ icon: "i-list", title: "Write down your next step", text: `${base} Having the next step written down may make it quicker to restart.`, action: { kind: "step", label: "Add a step" } });
    else tips.push({ icon: "i-timer", title: "Plan short breaks", text: `${base} Some students find a short break every 15–25 minutes useful; see if it suits you.`, action: habits.timerPreset === "45-10" ? { kind: "preset", value: "25-5", label: "Use 25-minute blocks" } : null });
  }
  if (lengths) {
    const best = LENGTHS[lengths.best.key];
    if (habits.timerPreset !== best.preset) {
      tips.push({ icon: "i-timer", title: `You could try ${best.presetLabel}`, text: `Your ${best.phrase} had higher estimates (${lengths.best.avg}%) than ${LENGTHS[lengths.worst.key].phrase} (${lengths.worst.avg}%). A tentative pattern, worth testing.`, action: { kind: "preset", value: best.preset, label: `Use ${best.presetLabel}` } });
    } else {
      wins.unshift({ icon: "i-timer", title: "Your timer matches your higher estimates", text: `Your ${best.phrase} had the highest estimates (${lengths.best.avg}%), and that’s how your timer is set.` });
    }
  }
  if (times) {
    const worst = TIMES.find((t) => t.key === times.worst.key);
    tips.push({ icon: "i-sun", title: `Lower estimates ${worst.phrase}`, text: `${times.worst.avg}% ${worst.phrase}. You might try lighter tasks then, like reading over notes, and see whether that suits you.` });
  }
  if (activeDays <= 1 && !(daysSinceLast !== null && daysSinceLast >= 4)) {
    tips.push({ icon: "i-calendar", title: "Spread sessions across the week", text: `You tracked on ${plural(activeDays, "day")} this week. Many students find a few short sessions easier than one long one.`, action: { kind: "start", label: "Start a focus session" } });
  }
  if (!tips.length) tips.push({ icon: "i-check", title: "Nothing stands out", text: "Your recent sessions don’t show a clear pattern to change." });
  if (!wins.length) wins.push({ icon: "i-check", title: `${plural(used.length, "session")} recorded this month`, text: `${mins(evidence.minutes * 60)} of measured tracking.` });

  return {
    stage: "personal",
    basis: `Suggestions from ${plural(evidence.sessions, "session")} on ${plural(evidence.days, "day")} (${evidence.minutes} min measured) in the last 30 days · estimates, not conclusions${evidence.older ? ` · ${plural(evidence.older, "older session")} without tracking-quality information not used` : ""}`,
    evidence,
    wins: wins.slice(0, 3),
    tips: tips.slice(0, 3)
  };
}
