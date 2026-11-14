// MediaPipe Face Landmarker, loaded once per page. It runs on this device only: camera frames
// go in, face points and the head's transformation matrix come out.
const VERSION = "0.10.14";
const BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VERSION}`;
const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

let loading;

export function loadFaceLandmarker() {
  loading ??= (async () => {
    const { FaceLandmarker, FilesetResolver } = await import(`${BASE}/vision_bundle.mjs`);
    const vision = await FilesetResolver.forVisionTasks(`${BASE}/wasm`);
    return FaceLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: "CPU" },
      runningMode: "VIDEO",
      numFaces: 2, // two are looked for only to notice when more than one face is in view
      outputFaceBlendshapes: false,
      outputFacialTransformationMatrixes: true // head angles (gaze-reading.js headAngles)
    });
  })().catch((error) => {
    loading = undefined; // let a later start try again
    throw error;
  });
  return loading;
}
