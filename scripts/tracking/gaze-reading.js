// Turns MediaPipe face landmarks into tracking readings (scripts/shared/tracking-states.js).
// No camera or page access here, so the rules can be checked on their own (tests/tracking.test.mjs).
//
// A frame is usable only when exactly one face is fully in view, close enough, with eyes open
// enough to see the irises. Unusable frames give no score at all. A short glitch (a blink, a
// quick head movement) is skipped rather than reported; only when measuring stays impossible
// for holdMs does the reading become "Tracking unavailable".

export const LANDMARKS = {
  leftOuter: 33, leftInner: 133, rightInner: 362, rightOuter: 263,
  leftIris: [468, 469, 470, 471, 472], rightIris: [473, 474, 475, 476, 477],
  leftUpper: 159, leftLower: 145, rightUpper: 386, rightLower: 374, noseTip: 1
};
export const LIMITS = {
  edge: 0.01,          // key points closer than this to the frame edge: face partly out of view
  minEyeWidth: 0.025,  // eye width as a share of the frame width: smaller means too far away
  minEyeOpen: 0.1,     // lid gap / eye width: smaller means eyes closed or hidden
  gazeLow: 0.36,       // iris position inside the eye (0.5 = centred): outside 0.36–0.64 = looking aside
  gazeHigh: 0.64,
  headTurn: 0.25       // nose position between the outer eye corners (0.5 = facing the camera)
};

// The numbers saved for each usable frame, in this order (the recorder's CSV columns and the
// model's inputs). Head angles come from MediaPipe's face transformation matrix.
export const FEATURE_NAMES = ["gaze_x", "gaze_y", "eye_open", "head_turn", "face_size", "head_yaw", "head_pitch", "head_roll"];

const KEY_POINTS = [LANDMARKS.leftOuter, LANDMARKS.leftInner, LANDMARKS.rightInner, LANDMARKS.rightOuter, LANDMARKS.noseTip, ...LANDMARKS.leftIris, ...LANDMARKS.rightIris];

function irisPosition(face, outer, inner, iris) {
  const left = Math.min(face[outer].x, face[inner].x);
  const width = Math.abs(face[inner].x - face[outer].x);
  const centre = iris.reduce((total, index) => total + face[index].x, 0) / iris.length;
  return width ? (centre - left) / width : 0.5;
}

// Iris height between the upper and lower lid: 0 = at the upper lid, 1 = at the lower lid.
function irisHeight(face, upper, lower, iris) {
  const top = face[upper].y;
  const height = face[lower].y - top;
  const centre = iris.reduce((total, index) => total + face[index].y, 0) / iris.length;
  return height ? (centre - top) / height : 0.5;
}

// Head angles in degrees from a 4×4 column-major transformation matrix.
//   yaw: turning left/right, pitch: nodding up/down, roll: tilting toward a shoulder.
export function headAngles(matrix) {
  const m = matrix?.data || matrix;
  if (!m || m.length < 16) return null;
  const at = (row, col) => m[col * 4 + row];
  const degrees = 180 / Math.PI;
  return {
    yaw: Math.asin(Math.max(-1, Math.min(1, -at(2, 0)))) * degrees,
    pitch: Math.atan2(at(2, 1), at(2, 2)) * degrees,
    roll: Math.atan2(at(1, 0), at(0, 0)) * degrees
  };
}

// One camera frame: { usable: false, reason } or { usable: true, gaze, headTurn, features }.
//   gaze:     average iris position inside both eyes, 0.5 = looking straight ahead
//   headTurn: how far the head is turned, 0 = facing the camera, 0.5 = fully sideways
//   features: the FEATURE_NAMES numbers (head angles are null without a matrix)
export function assessFrame(faces, matrices = []) {
  if (!faces || !faces.length) return { usable: false, reason: "no-face" };
  if (faces.length > 1) return { usable: false, reason: "multiple-faces" };
  const face = faces[0];
  if (!face || face.length < 478) return { usable: false, reason: "no-face" };
  const outside = KEY_POINTS.some((index) => {
    const point = face[index];
    return !point || point.x < LIMITS.edge || point.x > 1 - LIMITS.edge || point.y < LIMITS.edge || point.y > 1 - LIMITS.edge;
  });
  if (outside) return { usable: false, reason: "partly-out-of-view" };
  const leftWidth = Math.abs(face[LANDMARKS.leftInner].x - face[LANDMARKS.leftOuter].x);
  const rightWidth = Math.abs(face[LANDMARKS.rightOuter].x - face[LANDMARKS.rightInner].x);
  const eyeWidth = (leftWidth + rightWidth) / 2;
  if (eyeWidth < LIMITS.minEyeWidth) return { usable: false, reason: "too-far" };
  const leftOpen = Math.abs(face[LANDMARKS.leftLower].y - face[LANDMARKS.leftUpper].y) / (leftWidth || 1);
  const rightOpen = Math.abs(face[LANDMARKS.rightLower].y - face[LANDMARKS.rightUpper].y) / (rightWidth || 1);
  if (Math.max(leftOpen, rightOpen) < LIMITS.minEyeOpen) return { usable: false, reason: "eyes-not-visible" };
  const gaze = (irisPosition(face, LANDMARKS.leftOuter, LANDMARKS.leftInner, LANDMARKS.leftIris)
    + irisPosition(face, LANDMARKS.rightInner, LANDMARKS.rightOuter, LANDMARKS.rightIris)) / 2;
  const from = Math.min(face[LANDMARKS.leftOuter].x, face[LANDMARKS.rightOuter].x);
  const span = Math.abs(face[LANDMARKS.rightOuter].x - face[LANDMARKS.leftOuter].x);
  const nose = span ? (face[LANDMARKS.noseTip].x - from) / span : 0.5;
  const angles = headAngles(matrices[0]);
  const features = {
    gaze_x: gaze,
    gaze_y: (irisHeight(face, LANDMARKS.leftUpper, LANDMARKS.leftLower, LANDMARKS.leftIris)
      + irisHeight(face, LANDMARKS.rightUpper, LANDMARKS.rightLower, LANDMARKS.rightIris)) / 2,
    eye_open: (leftOpen + rightOpen) / 2,
    head_turn: nose - 0.5, // signed: which way the head is turned
    face_size: eyeWidth,   // bigger = closer to the camera
    head_yaw: angles ? angles.yaw : null,
    head_pitch: angles ? angles.pitch : null,
    head_roll: angles ? angles.roll : null
  };
  return { usable: true, gaze, headTurn: Math.abs(nose - 0.5), features };
}

// Frames in, readings out. Returns null while a short glitch is being skipped.
// Readings: { timestamp, tracking, reason, score, engagement, state, gazeRatio }.
export function createReadingFilter({ holdMs = 500, windowSize = 15, smoothing = 0.28 } = {}) {
  let smoothed;
  const recent = [];
  let unusableSince = null;
  return {
    next(assessment, now) {
      if (!assessment.usable) {
        unusableSince ??= now;
        if (now - unusableSince < holdMs) return null;
        smoothed = undefined;
        recent.length = 0;
        return { timestamp: now, tracking: "unavailable", reason: assessment.reason, score: null, engagement: null, state: "Unavailable", gazeRatio: null };
      }
      unusableSince = null;
      smoothed = smoothed === undefined ? assessment.gaze : smoothed * (1 - smoothing) + assessment.gaze * smoothing;
      // How far from "facing the screen" this frame is: eyes off centre, plus any strong head turn.
      const offset = Math.abs(0.5 - smoothed) + Math.max(0, assessment.headTurn - 0.1);
      recent.push(offset);
      if (recent.length > windowSize) recent.shift();
      const lookingAway = smoothed < LIMITS.gazeLow || smoothed > LIMITS.gazeHigh || assessment.headTurn > LIMITS.headTurn;
      const meanOffset = recent.reduce((total, value) => total + value, 0) / recent.length;
      const score = Math.round(Math.max(0.1, Math.min(1, 1 - meanOffset * 2.1)) * 100);
      return {
        timestamp: now, tracking: "active", reason: null, score,
        engagement: lookingAway ? "looking-away" : "on-screen",
        state: lookingAway ? "Distracted" : "Focused",
        gazeRatio: smoothed
      };
    },
    reset() { smoothed = undefined; recent.length = 0; unusableSince = null; }
  };
}
