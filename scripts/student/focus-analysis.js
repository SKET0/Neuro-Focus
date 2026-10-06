// Reading a student's saved focus sessions (attention_sessions rows), shared by My progress
// (student-history.js: insights for a date range), Home (student-dashboard.js: the Focus coach)
// and the teacher Home (teacher-home.js: class focus and insights from shared live-session history).
// Everything here is worked out from the student's own saved numbers; nothing is invented.

export const hasFocus = (s) => s.focus_percent !== null && s.focus_percent !== undefined;
export const focusedSeconds = (s) => (hasFocus(s) ? (s.tracked_seconds * s.focus_percent) / 100 : 0);
export const sum = (list, fn) => list.reduce((total, item) => total + fn(item), 0);

// Average focus weighted by how long each session was, so a 1-minute session doesn't count like a 40-minute one.
export function averageFocus(list) {
  const scored = list.filter(hasFocus);
  const tracked = sum(scored, (s) => s.tracked_seconds);
  return tracked ? Math.round(sum(scored, focusedSeconds) / tracked * 100) : null;
}

export const LEVELS = [
  { min: 80, key: "great", label: "Great focus", color: "var(--green)" },
  { min: 60, key: "good", label: "Good focus", color: "var(--info)" },
  { min: 40, key: "mixed", label: "Up and down", color: "var(--amber)" },
  { min: 0, key: "tough", label: "Hard to focus", color: "var(--red)" }
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
  { max: 15 * 60, phrase: "sessions under 15 minutes", title: "Shorter sessions work best for you", tip: "Short focus-timer blocks with breaks suit you.", preset: "15-3", presetLabel: "15-minute blocks" },
  { max: 30 * 60, phrase: "15–30 minute sessions", title: "Your sweet spot is 15–30 minutes", tip: "Plan your work in blocks of about that length.", preset: "25-5", presetLabel: "25-minute blocks" },
  { max: Infinity, phrase: "sessions over 30 minutes", title: "You stay focused in longer sessions", tip: "Long, deep-work sessions are a strength of yours.", preset: "45-10", presetLabel: "45-minute blocks" }
];

const hourOf = (s) => { const h = new Date(s.started_at).getHours(); return h < 5 ? h + 24 : h; };
export const timeOfDay = (s) => TIMES.find((t) => hourOf(s) >= t.from && hourOf(s) < t.to).key;
const lengthOf = (s) => LENGTHS.findIndex((l) => s.tracked_seconds < l.max);

// Compares groups (time of day, session length) and returns the best and worst with enough data.
export function compareGroups(list, groupOf) {
  const groups = new Map();
  list.filter(hasFocus).forEach((s) => {
    const key = groupOf(s);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  });
  const scored = [...groups].filter(([, items]) => sum(items, (s) => s.tracked_seconds) >= 180)
    .map(([key, items]) => ({ key, avg: averageFocus(items), count: items.length }))
    .sort((a, b) => b.avg - a.avg);
  return scored.length >= 2 && scored[0].avg - scored[scored.length - 1].avg >= 5 ? { best: scored[0], worst: scored[scored.length - 1] } : null;
}

// Trend: the newer half of the sessions against the older half (needs 4 or more).
function trendOf(newestFirst) {
  const chronological = newestFirst.filter(hasFocus).slice().reverse();
  if (chronological.length < 4) return null;
  const half = Math.floor(chronological.length / 2);
  const before = averageFocus(chronological.slice(0, half));
  const after = averageFocus(chronological.slice(half));
  return { before, after, overall: averageFocus(chronological), change: after - before };
}

// How often focus slipped: one lapse every `every` minutes (null below 5 tracked minutes).
function lapseRate(list) {
  const minutes = sum(list, (s) => s.tracked_seconds) / 60;
  if (minutes < 5) return null;
  const lapses = sum(list, (s) => s.lapses || 0);
  return { lapses, minutes, every: lapses ? Math.max(1, Math.round(minutes / lapses)) : null };
}

// ---------- My progress: insights for the chosen range (newest first) ----------
export function buildInsights(current) {
  const insights = [];
  const trend = trendOf(current);
  if (trend) {
    if (trend.change >= 5) insights.push({ tone: "green", icon: "i-trend", title: "Your focus is improving", text: `Your recent sessions average ${trend.after}% focus, up from ${trend.before}% before.` });
    else if (trend.change <= -5) insights.push({ tone: "amber", icon: "i-flag", title: "Your focus has dipped lately", text: `Recent sessions average ${trend.after}%, down from ${trend.before}%. A quieter spot or shorter sessions can help.` });
    else insights.push({ tone: "", icon: "i-target", title: "Your focus is steady", text: `Your sessions stay around ${trend.overall}% focus.` });
  }

  const times = compareGroups(current, timeOfDay);
  if (times) {
    const best = TIMES.find((t) => t.key === times.best.key);
    const worst = TIMES.find((t) => t.key === times.worst.key);
    insights.push({ tone: "", icon: "i-sun", title: `You focus best ${best.phrase}`, text: `${times.best.avg}% focus, compared with ${times.worst.avg}% ${worst.phrase}. Try saving harder work for then.` });
  }

  const lengths = compareGroups(current, lengthOf);
  if (lengths) {
    const best = LENGTHS[lengths.best.key];
    const worst = LENGTHS[lengths.worst.key];
    insights.push({ tone: "", icon: "i-timer", title: best.title, text: `${best.phrase[0].toUpperCase()}${best.phrase.slice(1)} average ${lengths.best.avg}% focus, versus ${lengths.worst.avg}% for ${worst.phrase}. ${best.tip}` });
  }

  const rate = lapseRate(current);
  if (rate) {
    if (!rate.lapses) insights.push({ tone: "green", icon: "i-check", title: "No distractions recorded", text: "You stayed on task through every session in this range. Nice work." });
    else {
      insights.push(rate.every >= 10
        ? { tone: "green", icon: "i-check", title: `You lose focus about once every ${rate.every} minutes`, text: "That's a strong stretch of attention. Short breaks will help you keep it up." }
        : { tone: "amber", icon: "i-flag", title: `You lose focus about once every ${rate.every} minute${rate.every === 1 ? "" : "s"}`, text: "That's common, and it's okay. Gentle nudges and small micro-goals help you get back on track faster." });
    }
  }
  return insights.slice(0, 4);
}

// ---------- Home: the Focus coach ----------
// sessions: finished saved sessions, newest first. habits: what the student has set up right now
// ({ nudgesOn, stepsPlanned, timerPreset }). Returns what's going well, what to try next (each tip
// can carry an action the Home page knows how to run) and what the advice is based on.
export const COACH_MIN_SESSIONS = 3;
const DAY = 86400000;
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const mins = (seconds) => (seconds >= 3600 ? `${Math.floor(seconds / 3600)}h ${Math.round((seconds % 3600) / 60)}m` : `${Math.max(1, Math.round(seconds / 60))} min`);

export function buildCoaching(sessions, habits = {}, now = Date.now()) {
  const recent = sessions.filter((s) => now - new Date(s.started_at) < 30 * DAY);
  const scored = recent.filter(hasFocus);
  const lastWeek = sessions.filter((s) => now - new Date(s.started_at) < 7 * DAY);
  const activeDays = new Set(lastWeek.map((s) => new Date(s.started_at).toDateString())).size;
  const daysSinceLast = sessions.length ? Math.floor((now - new Date(sessions[0].started_at)) / DAY) : null;
  const wins = [];
  const tips = [];

  // ----- Not enough of their own data yet: general tips, clearly labelled -----
  if (scored.length < COACH_MIN_SESSIONS) {
    if (sessions.length) {
      wins.push({ icon: "i-check", title: `You’ve made a start: ${plural(sessions.length, "session")} tracked`, text: `That’s ${mins(sum(sessions, (s) => s.tracked_seconds))} of focus time saved so far.` });
    }
    if (habits.stepsPlanned) wins.push({ icon: "i-list", title: "You’ve planned your steps", text: "Small, clear steps make it easier to start and to get back on track." });
    if (habits.nudgesOn) wins.push({ icon: "i-spark", title: "Nudges are on", text: "You’ll get a gentle reminder if your attention drifts for a few seconds." });

    if (habits.timerPreset !== "15-3" && habits.timerPreset !== "10-2") {
      tips.push({ icon: "i-timer", title: "Start with short blocks", text: "15 minutes of focus and a 3-minute break is easier to stick with than one long stretch.", action: { kind: "preset", value: "15-3", label: "Use 15-minute blocks" } });
    }
    if (!habits.stepsPlanned) {
      tips.push({ icon: "i-list", title: "Write 2–3 tiny steps first", text: "“Read page 12” is easier to begin than “study biology”. Ticking steps off keeps you going.", action: { kind: "step", label: "Add a step" } });
    }
    if (!habits.nudgesOn) {
      tips.push({ icon: "i-spark", title: "Turn re-engagement nudges on", text: "A gentle prompt when your attention drifts helps you notice and come back sooner.", action: { kind: "nudges", label: "Turn nudges on" } });
    }
    tips.push({ icon: "i-eye", title: "Set up your space", text: "A quiet spot, your phone out of reach and your face in view of the camera make tracking (and focusing) work best." });
    return {
      stage: "starter",
      basis: `General tips for now · personal tips after ${COACH_MIN_SESSIONS} tracked sessions`,
      progress: { done: scored.length, needed: COACH_MIN_SESSIONS },
      wins,
      tips: tips.slice(0, 3)
    };
  }

  // ----- Personal: from their last 30 days -----
  const trend = trendOf(recent);
  const rate = lapseRate(recent);
  const times = compareGroups(recent, timeOfDay);
  const lengths = compareGroups(recent, lengthOf);
  const average = averageFocus(recent);
  const bestStreak = recent.reduce((top, s) => Math.max(top, s.best_streak_seconds || 0), 0);

  if (trend && trend.change >= 5) wins.push({ icon: "i-trend", title: "Your focus is improving", text: `Recent sessions average ${trend.after}% focus, up from ${trend.before}%.` });
  if (activeDays >= 3) wins.push({ icon: "i-calendar", title: `You studied on ${activeDays} of the last 7 days`, text: "Short and often builds focus better than long and rare. Keep the rhythm going." });
  if (rate && (!rate.lapses || rate.every >= 10)) {
    wins.push(rate.lapses
      ? { icon: "i-target", title: `You stay on task for about ${rate.every} minutes at a time`, text: "That’s a strong stretch of attention between lapses." }
      : { icon: "i-target", title: "No attention lapses recorded", text: `Across ${mins(rate.minutes * 60)} of tracking. Great work.` });
  }
  if (average !== null && average >= 75) wins.push({ icon: "i-check", title: `Strong focus overall: ${average}%`, text: "That’s the share of tracked time you spent looking at your work." });
  if (times) {
    const best = TIMES.find((t) => t.key === times.best.key);
    const worst = TIMES.find((t) => t.key === times.worst.key);
    wins.push({ icon: "i-sun", title: `You focus best ${best.phrase}`, text: `${times.best.avg}% focus then, compared with ${times.worst.avg}% ${worst.phrase}. Save your hardest work for then.` });
  }
  if (bestStreak >= 600) wins.push({ icon: "i-flame", title: `Your longest focused stretch was ${mins(bestStreak)}`, text: "Proof you can lock in. Short breaks help you do it again." });
  if (habits.stepsPlanned) wins.push({ icon: "i-list", title: "You’ve planned your steps", text: "Clear next steps make it easier to restart after a distraction." });

  // What to try next, most useful first.
  if (daysSinceLast !== null && daysSinceLast >= 4) {
    tips.push({ icon: "i-rocket", title: `It’s been ${daysSinceLast} days since your last session`, text: "Getting back is easiest with something small: one 10–15 minute block today.", action: { kind: "start", label: "Start a focus session" } });
  }
  if (trend && trend.change <= -5) {
    tips.push({ icon: "i-flag", tone: "amber", title: "Your focus has dipped lately", text: `Recent sessions average ${trend.after}%, down from ${trend.before}%. Shorter blocks and a quieter spot often help.`, action: habits.timerPreset !== "15-3" ? { kind: "preset", value: "15-3", label: "Try 15-minute blocks" } : null });
  }
  if (rate && rate.lapses && rate.every < 10) {
    const base = `Your attention slips about once every ${plural(rate.every, "minute")}. That’s common, and it gets easier with practice.`;
    if (!habits.nudgesOn) tips.push({ icon: "i-spark", title: "Turn nudges back on", text: `${base} A gentle nudge helps you notice sooner.`, action: { kind: "nudges", label: "Turn nudges on" } });
    else if (!habits.stepsPlanned) tips.push({ icon: "i-list", title: "Break your work into tiny steps", text: `${base} Knowing your very next step makes it quicker to get back on track.`, action: { kind: "step", label: "Add a step" } });
    else tips.push({ icon: "i-timer", title: "Take a break before you need one", text: `${base} A short break every 15–25 minutes keeps your focus fresh.`, action: habits.timerPreset === "45-10" ? { kind: "preset", value: "25-5", label: "Use 25-minute blocks" } : null });
  }
  if (lengths) {
    const best = LENGTHS[lengths.best.key];
    if (habits.timerPreset !== best.preset) {
      tips.push({ icon: "i-timer", title: `Try ${best.presetLabel}`, text: `Your ${best.phrase} average ${lengths.best.avg}% focus, versus ${lengths.worst.avg}% for ${LENGTHS[lengths.worst.key].phrase}.`, action: { kind: "preset", value: best.preset, label: `Use ${best.presetLabel}` } });
    } else {
      // Feedback on a setting they chose: shown first.
      wins.unshift({ icon: "i-timer", title: "Your timer suits you", text: `Your ${best.phrase} have the best focus (${lengths.best.avg}%), and that’s how your timer is set.` });
    }
  }
  if (times && times.best.avg - times.worst.avg >= 10) {
    const worst = TIMES.find((t) => t.key === times.worst.key);
    tips.push({ icon: "i-sun", title: `Keep easier tasks for ${worst.name}`, text: `Your focus drops to ${times.worst.avg}% ${worst.phrase}. Reading over notes or planning works better then than new topics.` });
  }
  if (activeDays <= 1 && !(daysSinceLast !== null && daysSinceLast >= 4)) {
    tips.push({ icon: "i-calendar", title: "Aim for a little most days", text: `You tracked on ${plural(activeDays, "day")} this week. Two or three short sessions spread out work better than one long one.`, action: { kind: "start", label: "Start a focus session" } });
  }
  if (!tips.length) {
    tips.push({ icon: "i-check", title: "Keep doing what you’re doing", text: "Your recent sessions don’t show anything to fix. Try one small stretch goal: one more focus block than last week." });
  }
  if (!wins.length) {
    wins.push({ icon: "i-check", title: `${plural(recent.length, "session")} tracked this month`, text: `${mins(sum(recent, (s) => s.tracked_seconds))} of focus time. Every session gives you more to learn from.` });
  }

  return {
    stage: "personal",
    basis: `Based on your ${plural(recent.length, "session")} from the last 30 days`,
    wins: wins.slice(0, 3),
    tips: tips.slice(0, 3)
  };
}
