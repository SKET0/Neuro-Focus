// Attention tracker: the camera and MediaPipe face landmarks, on this device only. Each reading
// follows scripts/shared/tracking-states.js: whether tracking is available, and only then an
// estimated score and engagement. Frames that can't be measured (no face, more than one face,
// face partly out of view, too far away, eyes not visible) give "Tracking unavailable" with no
// score, never a score of 0. During the focus timer's break readings are marked as a break.
// The score comes from the rules in gaze-reading.js. A student can switch on the trained attention
// model instead ("Trained model (beta)", off by default, while it's still being tested): it then
// scores once it has their baseline (their first 20 seconds looking at the screen, kept for as long
// as the page is open) and about two seconds of readings. Until then, or if the model can't load,
// the rules score.
import { assessFrame, createReadingFilter } from "./gaze-reading.js";
import { loadFaceLandmarker } from "./face-model.js";
import { every } from "../shared/background-clock.js";
import { loadAttentionModel, createModelWindow, createCalibration, calibrated, createScoreSmoother } from "./attention-model.js";
import { ENGAGEMENT, SAMPLE_STATE } from "../shared/tracking-states.js";
import { REASONS } from "../shared/tracking-states.js";

const video = document.querySelector("#analyzerVideo");
if (video) {
  const startButton = document.querySelector("#startAnalyzer");
  const stopButton = document.querySelector("#stopAnalyzer");
  const status = document.querySelector("#gazeStatus");
  const message = document.querySelector("#analyzerMessage");
  const scoreOutput = document.querySelector("#shiftedPercent");
  const placeholder = document.querySelector("#cameraPlaceholder");

  const defaultStartLabel = "Start attention tracking";
  const defaultMessage = "Gaze and head orientation are processed on this device.";

  let stream;
  let landmarker;
  let timer;
  let busy = false;
  let startToken = 0; // a stop while the camera is still starting cancels that start
  let starting = false;
  const filter = createReadingFilter();
  let model = null;        // the trained attention model, or null to keep using the rules
  let modelWindow = null;  // its last two seconds of usable readings
  let calibration = null;  // the student's baseline for the model
  const smoother = createScoreSmoother(); // the model's answers, averaged over about 3 seconds
  const modelToggle = document.querySelector("#modelToggle");
  const modelOn = () => Boolean(modelToggle?.checked && model);

  // A rules reading with the model's estimate instead: score = smoothed probability of focused.
  function withModel(reading, { probability, focused }) {
    return {
      ...reading,
      score: Math.round(probability * 100),
      engagement: focused ? ENGAGEMENT.ON_SCREEN : ENGAGEMENT.LOOKING_AWAY,
      state: focused ? SAMPLE_STATE.ON_SCREEN : SAMPLE_STATE.LOOKING_AWAY,
      source: "model"
    };
  }

  function resetReadings() {
    filter.reset();
    modelWindow?.reset();
    smoother.reset();
  }

  // Readings stay on this page (stats, nudges, saved history). They reach a teacher only through
  // student-classes.js, during a live session the student has joined.
  function publish(reading) {
    window.dispatchEvent(new CustomEvent("neurofocus:attention-update", { detail: reading }));
  }

  function showStatus(text, detail = defaultMessage) {
    status.textContent = text;
    message.textContent = detail;
  }

  function showReading(reading) {
    if (reading.tracking === "break") {
      showStatus("On a break · readings aren’t counted", "Tracking continues after your break.");
      if (scoreOutput) scoreOutput.textContent = "Break";
    } else if (reading.tracking === "unavailable") {
      const reason = REASONS[reading.reason] || "Can’t measure right now";
      showStatus(`Tracking unavailable · ${reason}`, reading.reason === "multiple-faces"
        ? "Only one face should be in view. Nothing is counted until then."
        : "Make sure your face is in view and well lit. Nothing is counted until tracking is back.");
      if (scoreOutput) scoreOutput.textContent = "Unavailable";
    } else if (reading.source === "model") {
      showStatus(reading.engagement === ENGAGEMENT.LOOKING_AWAY ? "Not focused" : "Focused",
        "Estimated on this device by the trained attention model, from your face and eyes over the last few seconds.");
      if (scoreOutput) scoreOutput.textContent = `${reading.score}%`;
    } else if (reading.calibrating) {
      showStatus(`Calibrating · look at your screen (${Math.round(calibration.progress * 100)}%)`,
        "For the first 20 seconds the tracker learns how your face and eyes look when you're focused.");
      if (scoreOutput) scoreOutput.textContent = `${reading.score}%`;
    } else {
      showStatus(reading.engagement === "looking-away" ? "Looking away" : "Looking at the screen",
        "Worked out on this device from where your face and eyes point.");
      if (scoreOutput) scoreOutput.textContent = `${reading.score}%`;
    }
  }

  function analyze() {
    if (!landmarker || busy) return;
    const now = Date.now();
    // The focus timer's break (student-focus.js): keep the camera on, but measure nothing.
    if (window.neuroFocusBreakActive ? window.neuroFocusBreakActive() : window.neuroFocusOnBreak) {
      resetReadings();
      const reading = { timestamp: now, tracking: "break", reason: null, score: null, engagement: null, state: "Break", gazeRatio: null };
      showReading(reading);
      publish(reading);
      return;
    }
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
    busy = true;
    try {
      const result = landmarker.detectForVideo(video, performance.now());
      const aspect = video.videoWidth ? video.videoHeight / video.videoWidth : 0.75;
      const assessment = assessFrame(result.faceLandmarks || [], result.facialTransformationMatrixes || [], aspect);
      // Only usable readings go into the model's window; a gap of more than 600 ms restarts it.
      let reading = filter.next(assessment, now);
      // The baseline only counts readings where the rules say the student is looking at the screen.
      if (modelOn() && !calibration.ready && assessment.usable && reading?.engagement === ENGAGEMENT.ON_SCREEN) {
        calibration.add(assessment.features, now);
      }
      const probability = modelOn() && assessment.usable && calibration.ready
        ? modelWindow.push(calibrated(model, assessment.features, calibration.baseline), now)
        : null;
      if (!reading) return; // a short glitch such as a blink: the last reading still stands
      if (reading.tracking === "unavailable") { modelWindow?.reset(); smoother.reset(); }
      else if (probability !== null) reading = withModel(reading, smoother.next(probability, now));
      else reading = { ...reading, source: "rules", calibrating: modelOn() && !calibration.ready };
      showReading(reading);
      publish(reading);
    } catch (error) {
      // A frame that fails to process is a gap, not a zero.
      console.error("Feature extraction frame error", error);
    } finally {
      busy = false;
    }
  }

  // Loads the trained model, only once the switch is on. Without it (file missing or from another
  // tracker version) the rules keep scoring.
  async function prepareModel() {
    if (!modelToggle?.checked || model) return;
    const trained = await loadAttentionModel();
    if (!trained || model) return;
    model = trained;
    modelWindow = createModelWindow(model);
    calibration = createCalibration(model);
  }

  async function loadAnalyzer() {
    const [faces] = await Promise.all([landmarker ?? loadFaceLandmarker(), prepareModel()]);
    landmarker = faces;
  }

  // Switching mid-session: the model starts from a fresh window (and calibrates first if needed).
  modelToggle?.addEventListener("change", () => {
    modelWindow?.reset();
    smoother.reset();
    if (modelToggle.checked && timer) void prepareModel();
  });

  function cameraProblem(error) {
    switch (error?.name) {
      case "NotAllowedError":
      case "SecurityError":
        return "Camera permission was denied. Allow camera access for this site in your browser settings, then try again.";
      case "NotFoundError":
      case "OverconstrainedError":
        return "No camera was found. Connect a camera, then try again.";
      case "NotReadableError":
      case "AbortError":
        return "The camera is being used by another app or tab. Close it there, then try again.";
      default:
        return "Could not start the camera. Try again.";
    }
  }

  async function start() {
    if (stream && timer) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      showStatus("Camera unavailable", "Camera access needs a secure page (https or localhost).");
      return;
    }
    const token = ++startToken;
    starting = true;
    startButton.disabled = true;
    showStatus(stream ? "Loading the face model…" : "Connecting to your camera…");

    try {
      if (!stream) {
        const next = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } }
        });
        if (token !== startToken) { next.getTracks().forEach((track) => track.stop()); return; }
        stream = next;
        // Camera unplugged, or taken by another app: stop and say so.
        stream.getVideoTracks().forEach((track) => track.addEventListener("ended", () => {
          if (stream === next) stop({ status: "Camera disconnected", detail: "The camera stopped. Your session so far is saved. Start tracking again when it’s back." });
        }));
        video.srcObject = stream;
        await video.play();
        placeholder.hidden = true;
        stopButton.hidden = false;
      }

      showStatus("Camera on · loading the face model…");
      try {
        await loadAnalyzer();
      } catch (error) {
        console.error("Face model load error", error);
        if (token === startToken) stop({ status: "Tracking unavailable", detail: "The face model couldn’t load. Check your internet connection, then try again." });
        return;
      }
      if (token !== startToken) return;

      resetReadings();
      // A worker keeps the beat, so tracking carries on at full speed while the student is in
      // another tab or app (e.g. Zoom or Google Meet). A page timer would slow to once a second.
      timer = every(120, analyze);
      startButton.hidden = true;
      startButton.textContent = defaultStartLabel;
      stopButton.hidden = false;
      showStatus("Looking for your face…");
      window.neuroFocusTracking = true; // read by student-quizzes.js (quizzes need the camera on)
      window.dispatchEvent(new CustomEvent("neurofocus:tracking-started"));
    } catch (error) {
      if (token !== startToken) return;
      startButton.disabled = false;
      showStatus("Camera off", cameraProblem(error));
      window.dispatchEvent(new CustomEvent("neurofocus:tracking-error", { detail: { reason: error?.name || "Error" } }));
      console.error("Camera start error", error);
    } finally {
      if (token === startToken) starting = false;
    }
  }

  function stop({ status: text = "Camera off", detail = defaultMessage } = {}) {
    startToken += 1;
    starting = false;
    const wasTracking = Boolean(timer);
    window.neuroFocusTracking = false;
    timer?.();
    timer = undefined;
    stream?.getTracks().forEach((track) => track.stop());
    stream = undefined;
    video.srcObject = null;
    placeholder.hidden = false;
    startButton.disabled = false;
    startButton.hidden = false;
    startButton.textContent = defaultStartLabel;
    stopButton.hidden = true;
    resetReadings();
    if (scoreOutput) scoreOutput.textContent = "—";
    showStatus(text, detail);
    if (wasTracking) window.dispatchEvent(new CustomEvent("neurofocus:tracking-stopped"));
  }

  startButton.addEventListener("click", start);
  window.addEventListener("neurofocus:start-camera", start);
  // Other modules can turn the camera off, e.g. when a student is removed from their class.
  window.addEventListener("neurofocus:stop-camera", () => { if (stream || timer || starting) stop(); });
  stopButton.addEventListener("click", () => stop());
  window.addEventListener("pagehide", () => stop());
}
