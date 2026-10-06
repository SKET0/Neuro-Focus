// One meaning for attention-tracking readings everywhere: the tracker (eye-analyzer.js), the
// student's Focus session and history, the teacher's live monitor and saved history.
//
// A reading answers two separate questions:
//   1. Is tracking available right now?  tracking: "active" | "unavailable" | "break" | "off"
//      - active:      the camera can see one face clearly enough to estimate where it looks
//      - unavailable: the camera is on but this can't be measured (no face, more than one face,
//                     face partly out of view, too far away, eyes not visible, no recent readings)
//      - break:       the student is on an intentional break (the focus timer's break)
//      - off:         the camera is off or tracking stopped
//   2. Only when active: the estimated engagement, engagement: "on-screen" | "looking-away",
//      and an estimated score from 0 to 100 (share of the last couple of seconds the face and
//      eyes pointed at the screen). Otherwise score and engagement are null, never 0.
//
// Scores are estimates from face and eye direction. Looking away is not proof of distraction:
// a student may be reading notes or thinking. Unavailable and break time never counts as
// looking away, and is left out of averages, on-screen time and looking-away counts.

export const TRACKING = { ACTIVE: "active", UNAVAILABLE: "unavailable", BREAK: "break", OFF: "off" };
export const ENGAGEMENT = { ON_SCREEN: "on-screen", LOOKING_AWAY: "looking-away" };

// Score bands, the same on the student and teacher screens.
export const SCORE_BANDS = { HIGH: 70, MIDDLE: 45 };
export function scoreBand(score) {
  if (score === null || score === undefined) return null;
  return score >= SCORE_BANDS.HIGH ? "high" : score >= SCORE_BANDS.MIDDLE ? "middle" : "low";
}
export const BAND_LABELS = { high: "Mostly on screen", middle: "Mixed", low: "Mostly looking away" };

export const REASONS = {
  "no-face": "No face in view",
  "multiple-faces": "More than one face in view",
  "partly-out-of-view": "Face partly out of view",
  "too-far": "Too far from the camera",
  "eyes-not-visible": "Eyes not visible",
  "no-recent-readings": "No recent readings",
  "older-version": "Recorded by an older version"
};

// Saved 5-second samples (attention_samples.state). The first two names come from the first
// version of Neuro-Focus and now mean the engagement estimate. "Away" is only in old records:
// it meant "no face found" and was saved with a score of 0, which is now read as unavailable.
export const SAMPLE_STATE = { ON_SCREEN: "Focused", LOOKING_AWAY: "Distracted", UNAVAILABLE: "Unavailable", BREAK: "Break", OLD_NO_FACE: "Away" };
// The states a database without the tracking-quality update accepts.
export const LEGACY_SAMPLE_STATES = new Set([SAMPLE_STATE.ON_SCREEN, SAMPLE_STATE.LOOKING_AWAY]);

const clampScore = (value) => Math.max(0, Math.min(100, Math.round(value)));

// Any reading (from this tracker, a live broadcast, or an older version of the app) in the
// shared shape. An older reading with state "Away" and score 0 meant "no face": unavailable.
export function normalizeReading(raw = {}) {
  const off = { tracking: TRACKING.OFF, score: null, engagement: null, reason: null };
  if (!raw || raw.state === "Stopped" || raw.tracking === TRACKING.OFF) return off;
  if (raw.tracking === TRACKING.BREAK || raw.state === SAMPLE_STATE.BREAK) {
    return { tracking: TRACKING.BREAK, score: null, engagement: null, reason: null };
  }
  if (raw.tracking === TRACKING.UNAVAILABLE || raw.state === SAMPLE_STATE.UNAVAILABLE || raw.state === SAMPLE_STATE.OLD_NO_FACE) {
    return { tracking: TRACKING.UNAVAILABLE, score: null, engagement: null, reason: REASONS[raw.reason] ? raw.reason : "no-face" };
  }
  const value = raw.score === null || raw.score === undefined || raw.score === "" ? NaN : Number(raw.score);
  if (!Number.isFinite(value)) return { tracking: TRACKING.UNAVAILABLE, score: null, engagement: null, reason: "no-recent-readings" };
  const lookingAway = raw.engagement === ENGAGEMENT.LOOKING_AWAY || (raw.engagement === undefined && raw.state === SAMPLE_STATE.LOOKING_AWAY);
  return { tracking: TRACKING.ACTIVE, score: clampScore(value), engagement: lookingAway ? ENGAGEMENT.LOOKING_AWAY : ENGAGEMENT.ON_SCREEN, reason: null };
}

// The state name sent with live readings and shown on screen ("Focused" / "Distracted" are kept
// as the engagement names so older teacher dashboards still understand them).
export function legacyState(reading) {
  if (reading.tracking === TRACKING.BREAK) return SAMPLE_STATE.BREAK;
  if (reading.tracking !== TRACKING.ACTIVE) return SAMPLE_STATE.UNAVAILABLE;
  return reading.engagement === ENGAGEMENT.LOOKING_AWAY ? SAMPLE_STATE.LOOKING_AWAY : SAMPLE_STATE.ON_SCREEN;
}

// Short words for a reading, for the student's and teacher's screens.
export function describeReading(reading) {
  if (!reading || reading.tracking === TRACKING.OFF) return { key: "off", label: "Camera off", detail: "" };
  if (reading.tracking === TRACKING.BREAK) return { key: "break", label: "On a break", detail: "Not counted" };
  if (reading.tracking === TRACKING.UNAVAILABLE) return { key: "unavailable", label: "Tracking unavailable", detail: REASONS[reading.reason] || "" };
  return reading.engagement === ENGAGEMENT.LOOKING_AWAY
    ? { key: "looking-away", label: "Looking away", detail: "Estimate" }
    : { key: "on-screen", label: "Looking at screen", detail: "Estimate" };
}

// ---------- One tracking session's numbers ----------
// Feed every reading in order with its time. The time until the next reading belongs to this
// reading's state, up to gapMs; any longer silence (tab in the background, computer asleep,
// tracker frozen) counts as unavailable, because nothing was measured.
//   usable time      = active time (on screen + looking away)
//   on-screen share  = on-screen time / usable time (null until there's enough usable time)
//   looking-away episode = looking away for lookAwayMs or more in one go, while active
//   streak           = continuous on-screen time; looking away, unavailable or break ends it
export function createSessionAccumulator({ gapMs = 2000, lookAwayMs = 4000, minUsableMs = 10000 } = {}) {
  const totals = { onScreenMs: 0, lookingAwayMs: 0, unavailableMs: 0, breakMs: 0 };
  let startedAt = null;
  let last = null;            // { at, reading }
  let scoreSum = 0;
  let scoreCount = 0;
  let episodes = 0;
  let awaySince = null;       // start of the current looking-away run
  let episodeOpen = false;    // the current run already counted as an episode
  let streakMs = 0;
  let bestStreakMs = 0;

  function attribute(until) {
    if (!last) return;
    const elapsed = Math.max(0, until - last.at);
    const counted = Math.min(elapsed, gapMs);
    const { tracking, engagement } = last.reading;
    if (tracking === TRACKING.ACTIVE && engagement === ENGAGEMENT.ON_SCREEN) {
      totals.onScreenMs += counted;
      streakMs += counted;
      bestStreakMs = Math.max(bestStreakMs, streakMs);
    } else if (tracking === TRACKING.ACTIVE) totals.lookingAwayMs += counted;
    else if (tracking === TRACKING.BREAK) totals.breakMs += counted;
    else totals.unavailableMs += counted;
    totals.unavailableMs += elapsed - counted;
    if (elapsed > gapMs) { streakMs = 0; awaySince = null; episodeOpen = false; }
  }

  // Returns what happened with this reading: a new looking-away episode (for a gentle nudge),
  // or a return to the screen after one.
  function add(raw, at) {
    const reading = normalizeReading(raw);
    startedAt ??= at;
    attribute(at);
    const events = { episodeStarted: false, returned: false };
    if (reading.tracking === TRACKING.ACTIVE) {
      scoreSum += reading.score;
      scoreCount += 1;
      if (reading.engagement === ENGAGEMENT.LOOKING_AWAY) {
        streakMs = 0;
        awaySince ??= at;
        if (!episodeOpen && at - awaySince >= lookAwayMs) {
          episodeOpen = true;
          episodes += 1;
          events.episodeStarted = true;
        }
      } else {
        if (episodeOpen) events.returned = true;
        awaySince = null;
        episodeOpen = false;
      }
    } else {
      // Unavailable or break: not looking away, so any looking-away run ends without a nudge.
      streakMs = 0;
      awaySince = null;
      episodeOpen = false;
    }
    last = { at, reading };
    return events;
  }

  // The numbers so far, counting time up to `at` without changing anything.
  function snapshot(at = last?.at ?? 0) {
    const saved = { totals: { ...totals }, streakMs, bestStreakMs, awaySince, episodeOpen };
    attribute(at);
    const result = summary(at);
    Object.assign(totals, saved.totals);
    ({ streakMs, bestStreakMs, awaySince, episodeOpen } = saved);
    return result;
  }

  function summary(at) {
    const usableMs = totals.onScreenMs + totals.lookingAwayMs;
    return {
      totalMs: startedAt === null ? 0 : Math.max(0, at - startedAt),
      usableMs,
      unavailableMs: totals.unavailableMs,
      breakMs: totals.breakMs,
      onScreenMs: totals.onScreenMs,
      lookingAwayMs: totals.lookingAwayMs,
      focusPercent: usableMs >= minUsableMs ? Math.round((totals.onScreenMs / usableMs) * 100) : null,
      averageScore: scoreCount ? Math.round(scoreSum / scoreCount) : null,
      episodes,
      streakMs,
      bestStreakMs,
      lookingAwayForMs: awaySince === null ? 0 : Math.max(0, at - awaySince),
      reading: last?.reading || normalizeReading({ tracking: TRACKING.OFF })
    };
  }

  return { add, snapshot };
}

// ---------- Saved 5-second samples ----------
// Collects readings for one sample. A sample is a measured "Focused"/"Distracted" one only when
// at least half its readings were usable; otherwise it is "Unavailable" (or "Break") with no
// score, so a gap is saved as a gap, never as a zero.
export function createSampleWindow() {
  let counts = { active: 0, onScreen: 0, unavailable: 0, break: 0 };
  let scoreSum = 0;
  let start = null;
  let end = null;
  return {
    add(raw, at) {
      const reading = normalizeReading(raw);
      if (reading.tracking === TRACKING.OFF) return;
      start ??= at;
      end = at;
      if (reading.tracking === TRACKING.ACTIVE) {
        counts.active += 1;
        scoreSum += reading.score;
        if (reading.engagement === ENGAGEMENT.ON_SCREEN) counts.onScreen += 1;
      } else if (reading.tracking === TRACKING.BREAK) counts.break += 1;
      else counts.unavailable += 1;
    },
    get start() { return start; },
    get end() { return end; },
    get size() { return counts.active + counts.unavailable + counts.break; },
    // { recorded_at, score, state } or null when empty.
    close() {
      const total = counts.active + counts.unavailable + counts.break;
      if (!total) return null;
      let row;
      if (counts.break * 2 >= total) row = { score: null, state: SAMPLE_STATE.BREAK };
      else if (counts.active * 2 < total) row = { score: null, state: SAMPLE_STATE.UNAVAILABLE };
      else row = {
        score: Math.round(scoreSum / counts.active),
        state: counts.onScreen * 2 >= counts.active ? SAMPLE_STATE.ON_SCREEN : SAMPLE_STATE.LOOKING_AWAY
      };
      row.recorded_at = new Date(end).toISOString();
      counts = { active: 0, onScreen: 0, unavailable: 0, break: 0 };
      scoreSum = 0;
      start = null;
      end = null;
      return row;
    }
  };
}

// How to read a saved sample: { kind, score }. Old "Away" samples (no face, saved as 0) and new
// unavailable or break samples have no score.
export function sampleKind(row) {
  if (row.state === SAMPLE_STATE.ON_SCREEN) return { kind: "on-screen", score: row.score ?? null };
  if (row.state === SAMPLE_STATE.LOOKING_AWAY) return { kind: "looking-away", score: row.score ?? null };
  if (row.state === SAMPLE_STATE.BREAK) return { kind: "break", score: null };
  return { kind: "unavailable", score: null };
}

// A saved session's samples as runs for a timeline, with time that has no sample (tracking
// paused, connection lost, or unavailable time an older database couldn't store) as "gap" runs.
// samples: oldest first, each standing for the `sampleSeconds` before its recorded_at.
export function sampleRuns(samples, sampleSeconds = 5) {
  const runs = [];
  const step = sampleSeconds * 1000;
  let previousAt = null;
  samples.forEach((row) => {
    const at = new Date(row.recorded_at).getTime();
    if (previousAt !== null && at - previousAt > step * 1.5) {
      const missing = Math.round((at - previousAt) / step) - 1;
      if (missing > 0) runs.push({ kind: "gap", count: missing, start: new Date(previousAt).toISOString(), end: new Date(at - step).toISOString() });
    }
    previousAt = at;
    const { kind } = sampleKind(row);
    const lastRun = runs[runs.length - 1];
    if (lastRun && lastRun.kind === kind) { lastRun.count += 1; lastRun.end = row.recorded_at; }
    else runs.push({ kind, count: 1, start: row.recorded_at, end: row.recorded_at });
  });
  return runs;
}

// ---------- Saved sessions ----------
// Sessions saved after the tracking-quality update carry usable_seconds (and tracking_version 2).
// Older sessions don't: their focus_percent counted time with no face in view as not focused.
export const QUALITY_COLUMNS = "usable_seconds, unavailable_seconds, break_seconds, tracking_version";
export const hasQualityInfo = (session) => session.usable_seconds !== null && session.usable_seconds !== undefined;
const QUALITY_COLUMN_ERROR = /usable_seconds|unavailable_seconds|break_seconds|tracking_version/;
export const missingQualityColumns = (error) => Boolean(error) && QUALITY_COLUMN_ERROR.test(`${error.message || ""} ${error.details || ""} ${error.hint || ""}`);

// Runs a select with the quality columns, or without them if the database update hasn't been run.
let qualityColumnsMissing = false;
export async function selectWithQuality(run) {
  if (!qualityColumnsMissing) {
    const result = await run(`, ${QUALITY_COLUMNS}`);
    if (!missingQualityColumns(result.error)) return result;
    qualityColumnsMissing = true;
  }
  return run("");
}
