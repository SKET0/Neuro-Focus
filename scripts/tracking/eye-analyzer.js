// Attention tracker: the camera and MediaPipe face landmarks, on this device only. Each reading
// follows scripts/shared/tracking-states.js: whether tracking is available, and only then an
// estimated score and engagement. Frames that can't be measured (no face, more than one face,
// face partly out of view, too far away, eyes not visible) give "Tracking unavailable" with no
// score, never a score of 0. During the focus timer's break readings are marked as a break.
import { assessFrame, createReadingFilter } from "./gaze-reading.js";
import { REASONS } from "../shared/tracking-states.js";

const video = document.querySelector("#analyzerVideo");
if (video) {
  const startButton = document.querySelector("#startAnalyzer");
  const stopButton = document.querySelector("#stopAnalyzer");
  const status = document.querySelector("#gazeStatus");
  const message = document.querySelector("#analyzerMessage");
  const scoreOutput = document.querySelector("#shiftedPercent");
  const placeholder = document.querySelector("#cameraPlaceholder");

  const visionVersion = "0.10.14";
  const visionBase = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${visionVersion}`;
  const modelUrl = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
  const defaultStartLabel = "Start attention tracking";
  const defaultMessage = "Gaze and head orientation are processed on this device.";

  let stream;
  let landmarker;
  let timer;
  let busy = false;
  let startToken = 0; // a stop while the camera is still starting cancels that start
  let starting = false;
  const filter = createReadingFilter();

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
      filter.reset();
      const reading = { timestamp: now, tracking: "break", reason: null, score: null, engagement: null, state: "Break", gazeRatio: null };
      showReading(reading);
      publish(reading);
      return;
    }
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
    busy = true;
    try {
      const result = landmarker.detectForVideo(video, performance.now());
      const reading = filter.next(assessFrame(result.faceLandmarks || []), now);
      if (!reading) return; // a short glitch such as a blink: the last reading still stands
      showReading(reading);
      publish(reading);
    } catch (error) {
      // A frame that fails to process is a gap, not a zero.
      console.error("Feature extraction frame error", error);
    } finally {
      busy = false;
    }
  }

  async function loadAnalyzer() {
    if (landmarker) return;
    const { FaceLandmarker, FilesetResolver } = await import(`${visionBase}/vision_bundle.mjs`);
    const vision = await FilesetResolver.forVisionTasks(`${visionBase}/wasm`);
    landmarker = await FaceLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: modelUrl, delegate: "CPU" },
      runningMode: "VIDEO",
      numFaces: 2, // two are looked for only to notice when more than one face is in view
      outputFaceBlendshapes: false,
      outputFacialTransformationMatrixes: false
    });
  }

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

      filter.reset();
      timer = window.setInterval(analyze, 120);
      startButton.hidden = true;
      startButton.textContent = defaultStartLabel;
      stopButton.hidden = false;
      showStatus("Looking for your face…");
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
    window.clearInterval(timer);
    timer = undefined;
    stream?.getTracks().forEach((track) => track.stop());
    stream = undefined;
    video.srcObject = null;
    placeholder.hidden = false;
    startButton.disabled = false;
    startButton.hidden = false;
    startButton.textContent = defaultStartLabel;
    stopButton.hidden = true;
    filter.reset();
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
