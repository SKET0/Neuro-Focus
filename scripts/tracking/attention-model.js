// The trained attention model (LSTM), run on this device. The weights come from
// ml/train_lstm.py --export, saved in assets/models/attention-lstm.json. Plain JavaScript, no
// library: one LSTM layer, then one output that gives the probability the student is focused.
//
// The model reads the last 16 usable readings (about 2 seconds). Unusable readings are gaps,
// never inputs, the same as in training: a gap of more than 600 ms starts a new window, and
// until 16 readings are collected there's no model score (the rules give the score meanwhile).
//
// Calibration: eye openness, face size and the up/down readings differ a lot from person to
// person (and camera to camera), so the model reads those as differences from the student's own
// baseline: the median over their first 20 seconds looking at the screen (at least 40 readings).
// Until the baseline is ready the rules give the score.
import { TRACKER_VERSION } from "./gaze-reading.js";

const MODEL_URL = new URL("../../assets/models/attention-lstm.json", import.meta.url);
const MAX_GAP_MS = 600; // same as MAX_GAP_MS in ml/train_lstm.py

const sigmoid = (v) => 1 / (1 + Math.exp(-v));

// Checks a saved model file and returns a model that scores one window, or throws.
export function createAttentionModel(data) {
  if (data?.format !== "neurofocus-attention-lstm-1") throw new Error("Unknown model file format.");
  if (data.tracker_version !== TRACKER_VERSION) throw new Error("The model was trained on readings from a different tracker version.");
  const { features, window: size, mean, std, hidden, lstm, output, threshold } = data;
  const calibration = data.calibration ?? null;
  if (calibration && (!Array.isArray(calibration.features) || calibration.features.some((name) => !features.includes(name)))) {
    throw new Error("The model file's calibration doesn't match its readings.");
  }
  const n = features.length;
  const gates = 4 * hidden;
  if (lstm.weight_ih.length !== gates || lstm.weight_ih[0].length !== n || lstm.weight_hh.length !== gates || lstm.bias.length !== gates || output.weight.length !== hidden) {
    throw new Error("The model file's sizes don't match.");
  }

  // The logit (score before the sigmoid) for one window: `size` readings, each a list of
  // feature values in the model's feature order.
  function logit(window) {
    let h = new Array(hidden).fill(0);
    let c = new Array(hidden).fill(0);
    const z = new Array(gates);
    for (const reading of window) {
      const x = reading.map((value, i) => (value - mean[i]) / std[i]);
      for (let g = 0; g < gates; g += 1) {
        let sum = lstm.bias[g];
        const wi = lstm.weight_ih[g];
        const wh = lstm.weight_hh[g];
        for (let i = 0; i < n; i += 1) sum += wi[i] * x[i];
        for (let j = 0; j < hidden; j += 1) sum += wh[j] * h[j];
        z[g] = sum;
      }
      // PyTorch's gate order: input, forget, cell, output.
      const nextH = new Array(hidden);
      for (let j = 0; j < hidden; j += 1) {
        const input = sigmoid(z[j]);
        const forget = sigmoid(z[hidden + j]);
        const cell = Math.tanh(z[2 * hidden + j]);
        const out = sigmoid(z[3 * hidden + j]);
        c[j] = forget * c[j] + input * cell;
        nextH[j] = out * Math.tanh(c[j]);
      }
      h = nextH;
    }
    return h.reduce((sum, value, j) => sum + value * output.weight[j], output.bias);
  }

  return {
    features,
    size,
    threshold,
    calibration,
    logit,
    probability: (window) => sigmoid(logit(window))
  };
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

// Collects the student's baseline. add() takes the features of a usable reading taken while
// they look at the screen, and its time; it returns the baseline ({ eye_open: …, … }) once it's
// ready (20 seconds after the first reading and at least 40 readings), or null until then. A
// model without calibration needs no baseline: ready is true straight away.
export function createCalibration(model) {
  const spec = model.calibration;
  const samples = [];
  let firstAt = null;
  let lastAt = null;
  let baseline = spec ? null : {};
  return {
    get ready() { return baseline !== null; },
    get baseline() { return baseline; },
    // How far along it is, 0 to 1 (for "Calibrating…" messages).
    get progress() {
      if (baseline) return 1;
      if (firstAt === null) return 0;
      return Math.min(samples.length / spec.min_readings, (lastAt - firstAt) / (spec.seconds * 1000), 0.99);
    },
    add(features, at) {
      if (baseline) return baseline;
      const values = spec.features.map((name) => features?.[name]);
      if (values.some((value) => typeof value !== "number" || !Number.isFinite(value))) return null;
      firstAt ??= at;
      lastAt = at;
      samples.push(values);
      if (at - firstAt >= spec.seconds * 1000 && samples.length >= spec.min_readings) {
        baseline = Object.fromEntries(spec.features.map((name, i) => [name, median(samples.map((sample) => sample[i]))]));
        samples.length = 0;
      }
      return baseline;
    }
  };
}

// A reading's features measured against the baseline, ready for the model.
export function calibrated(model, features, baseline) {
  if (!model.calibration) return features;
  const out = { ...features };
  for (const name of model.calibration.features) out[name] = features[name] - baseline[name];
  return out;
}

// Smooths the model's answers over time. The model is usually very sure either way, so its raw
// probability jumps (5% one moment, 95% the next). This averages it over about 3 seconds and only
// switches between focused and not focused on a clear change: below 40% to become not focused,
// above 60% to become focused again. Tested leave-one-person-out on the recordings
// (ml/results/report.md), it changes state about 6 times less often and is slightly more accurate.
// next() takes a probability and its time and returns { probability, focused }.
export function createScoreSmoother({ seconds = 3, low = 0.4, high = 0.6, restartMs = 2000 } = {}) {
  let value = null;
  let focused = null;
  let lastAt = null;
  return {
    next(probability, at) {
      if (value === null || at - lastAt > restartMs) {
        // First answer, or after a break in the answers: start from this one.
        value = probability;
        focused = probability >= 0.5;
      } else {
        value += (1 - Math.exp(-(at - lastAt) / (seconds * 1000))) * (probability - value);
        if (focused && value < low) focused = false;
        else if (!focused && value > high) focused = true;
      }
      lastAt = at;
      return { probability: value, focused };
    },
    reset() { value = null; focused = null; lastAt = null; }
  };
}

// Keeps the last readings and scores them once there are enough. push() takes the features of
// a usable reading ({ gaze_x: …, … }) and its time, and returns the probability of focused, or
// null while the window is still filling. reset() after anything unusable.
export function createModelWindow(model, { maxGapMs = MAX_GAP_MS } = {}) {
  const readings = [];
  let lastAt = null;
  return {
    push(features, at) {
      const values = model.features.map((name) => features?.[name]);
      if (values.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
        // Missing readings (e.g. no head angles) were never used in training: treat as a gap.
        readings.length = 0;
        lastAt = null;
        return null;
      }
      if (lastAt !== null && at - lastAt > maxGapMs) readings.length = 0;
      lastAt = at;
      readings.push(values);
      if (readings.length > model.size) readings.shift();
      return readings.length === model.size ? model.probability(readings) : null;
    },
    reset() { readings.length = 0; lastAt = null; }
  };
}

// Loads the model file once. Resolves to null if there's no usable model, so the app keeps
// using the rules.
let loading = null;
export function loadAttentionModel() {
  loading ??= fetch(MODEL_URL)
    .then((response) => (response.ok ? response.json() : null))
    .then((data) => (data ? createAttentionModel(data) : null))
    .catch((error) => {
      console.warn("Attention model not used:", error.message);
      return null;
    });
  return loading;
}
