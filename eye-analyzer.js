const video = document.querySelector("#analyzerVideo");
if (video) {
  const startButton = document.querySelector("#startAnalyzer");
  const stopButton = document.querySelector("#stopAnalyzer");
  const status = document.querySelector("#gazeStatus");
  const message = document.querySelector("#analyzerMessage");
  const shiftedOutput = document.querySelector("#shiftedPercent");
  const placeholder = document.querySelector("#cameraPlaceholder");

  // Communication channel shared with the teacher dashboard
  const attentionChannel = new BroadcastChannel("neurofocus_telemetry");

  const visionVersion = "0.10.14";
  const visionBase = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${visionVersion}`;
  const modelUrl = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
  
  let stream;
  let landmarker;
  let timer;
  let busy = false;
  let smoothedRatio;
  let sampleCount = 0;
  let awayCount = 0;
  
  const sequenceWindow = [];
  const SEQUENCE_WINDOW_SIZE = 15;
  const defaultStartLabel = "Start attention tracking";

  function publish(payload) {
    // 1. Custom event for listeners on this page (stats, nudges, session log)
    window.dispatchEvent(new CustomEvent("neurofocus:attention-update", { detail: payload }));
    // 2. Broadcast to other open tabs in this browser
    attentionChannel.postMessage(payload);
  }

  const cumulative = () => (sampleCount ? Math.max(0, Math.round(((sampleCount - awayCount) / sampleCount) * 100)) : 100);

  function showError(text) {
    status.textContent = "AI Vision Engine unavailable";
    message.textContent = text;
  }

  function irisCenter(landmarks, indexes) {
    const points = indexes.map((index) => landmarks[index]);
    return points.reduce((sum, point) => sum + point.x, 0) / points.length;
  }

  function eyeRatio(landmarks, outer, inner, irisIndexes) {
    const left = landmarks[outer].x;
    const right = landmarks[inner].x;
    const min = Math.min(left, right);
    const width = Math.abs(right - left);
    if (!width) return 0.5;
    return (irisCenter(landmarks, irisIndexes) - min) / width;
  }

  function analyze() {
    if (!landmarker || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || busy) return;
    busy = true;
    try {
      const result = landmarker.detectForVideo(video, performance.now());
      const face = result.faceLandmarks?.[0];
      if (!face || face.length < 478) {
        status.textContent = "Subject out of frame";
        message.textContent = "Face the webcam directly. Real-time landmark tracking paused.";
        publish({ timestamp: Date.now(), score: 0, attentionScore: 0, cumulativeFocus: cumulative(), state: "Away", gazeRatio: null });
        return;
      }

      const left = eyeRatio(face, 33, 133, [468, 469, 470, 471, 472]);
      const right = eyeRatio(face, 362, 263, [473, 474, 475, 476, 477]);
      const ratio = (left + right) / 2;
      smoothedRatio = smoothedRatio === undefined ? ratio : smoothedRatio * 0.72 + ratio * 0.28;
      sampleCount += 1;

      sequenceWindow.push(smoothedRatio);
      if (sequenceWindow.length > SEQUENCE_WINDOW_SIZE) {
        sequenceWindow.shift();
      }

      let gazeState = "Optimal (Screen focused)";
      let isDistracted = false;

      if (smoothedRatio < 0.36) {
        gazeState = "Distracted (Gaze left)";
        isDistracted = true;
      } else if (smoothedRatio > 0.64) {
        gazeState = "Distracted (Gaze right)";
        isDistracted = true;
      }

      if (isDistracted) awayCount += 1;

      const windowDeviation = sequenceWindow.reduce((acc, val) => acc + Math.abs(0.5 - val), 0) / sequenceWindow.length;
      const instantaneousScore = Math.max(0.1, Math.min(1.0, 1.0 - (windowDeviation * 2.1)));
      const cumulativeFocus = cumulative();
      const finalScorePercent = Math.round(instantaneousScore * 100);

      status.textContent = gazeState;
      if (shiftedOutput) {
        shiftedOutput.textContent = `${cumulativeFocus}% Focus (${finalScorePercent} Score)`;
      }

      message.textContent = `MediaPipe Active · Frames: ${sampleCount} · Gaze: ${smoothedRatio.toFixed(2)}`;

      publish({
        timestamp: Date.now(),
        score: finalScorePercent,
        attentionScore: instantaneousScore,
        cumulativeFocus,
        state: isDistracted ? "Distracted" : "Focused",
        gazeRatio: smoothedRatio
      });

    } catch (error) {
      showError("Could not process video frame.");
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
      numFaces: 1,
      outputFaceBlendshapes: false,
      outputFacialTransformationMatrixes: false
    });
  }

  async function start() {
    if (stream && timer) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      showError("Camera access requires HTTPS or localhost.");
      return;
    }

    startButton.disabled = true;
    status.textContent = stream ? "Loading MediaPipe AI model…" : "Connecting webcam stream…";

    try {
      if (!stream) {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } }
        });
        video.srcObject = stream;
        await video.play();
        placeholder.hidden = true;
        stopButton.hidden = false;
      }

      status.textContent = "Camera active · Initializing face mesh";
      await loadAnalyzer();

      timer = window.setInterval(analyze, 120);
      startButton.hidden = true;
      startButton.textContent = defaultStartLabel;
      stopButton.hidden = false;
      status.textContent = "Tracking head pose and gaze vectors…";
      window.dispatchEvent(new CustomEvent("neurofocus:tracking-started"));
    } catch (error) {
      startButton.disabled = false;
      showError("Could not start camera tracker.");
      console.error("Camera start error", error);
    }
  }

  function stop() {
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
    smoothedRatio = undefined;
    sampleCount = 0;
    awayCount = 0;
    sequenceWindow.length = 0;
    if (shiftedOutput) shiftedOutput.textContent = "—";
    status.textContent = "Monitoring terminated";
    if (wasTracking) window.dispatchEvent(new CustomEvent("neurofocus:tracking-stopped"));
  }

  startButton.addEventListener("click", start);
  window.addEventListener("neurofocus:start-camera", start);
  // Other modules can turn the camera off, e.g. when a student is removed from their class.
  window.addEventListener("neurofocus:stop-camera", () => { if (stream) stop(); });
  stopButton.addEventListener("click", stop);
  window.addEventListener("pagehide", stop);
}