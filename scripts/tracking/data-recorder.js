// Model data recorder (pages/model-data.html). A guided set of short tasks, each labelled
// focused (1) or distracted (0), while the same tracker as the app measures the face. Only the
// numbers are kept (gaze-reading.js FEATURE_NAMES plus the current rule-based score) and they
// are saved as a CSV file on this computer. No video is stored and nothing is uploaded.
import { assessFrame, createReadingFilter, FEATURE_NAMES } from "./gaze-reading.js";
import { loadFaceLandmarker } from "./face-model.js";
import { REASONS } from "../shared/tracking-states.js";

const TICK_MS = 120;   // the same rate as the app's tracker (eye-analyzer.js)
const PREP_SECONDS = 5;

const TASKS = {
  read: { label: 1, seconds: 40, title: "Read the text", text: "Read the text on the screen at your normal pace. Scroll down if you reach the end." },
  dot: { label: 1, seconds: 40, title: "Follow the dot", text: "Follow the moving dot with your eyes, all around the screen." },
  phone: { label: 0, seconds: 30, title: "Use your phone", text: "Pick up your phone and scroll through it, held where you normally hold it. No phone? Look down at your lap." },
  away: { label: 0, seconds: 30, title: "Look away", text: "Look away from the screen: around the room, out of a window or at something beside you." },
  tired: { label: 0, seconds: 30, title: "Act tired", text: "Lean back and let your eyes get heavy, as if you're very tired. Keep them partly open." }
};
const LOOK_BACK = "You'll hear a beep when it's time to look back at the screen.";

const PASSAGES = [
  [
    "Honeybees share directions with a dance. When a forager finds a good patch of flowers, she returns to the hive and walks in a figure of eight on the wall of the comb, waggling her body along the straight middle part.",
    "The angle of that straight run tells the other bees which way to fly. Straight up the comb means towards the sun; a run tilted to the left means the flowers lie that far to the left of the sun. The longer the waggle lasts, the further away the food is.",
    "Other bees crowd around the dancer, touching her with their antennae and picking up the scent of the flowers she visited. Then they leave the hive and search in the direction she described.",
    "Because the sun moves across the sky during the day, the bees adjust the angle of their dance as time passes. A dancer coming back an hour later points a little differently, even though the flowers have not moved.",
    "Scientists worked this out by moving feeding dishes to new places and watching how the dances changed. It is one of the clearest examples of animals passing on abstract information about a place none of them can see."
  ],
  [
    "Lighthouses were once kept by people who lived beside them all year. Every evening the keeper climbed the tower, trimmed the wick, polished the glass and wound the clockwork that turned the lens.",
    "The lens was the clever part. Rings of glass prisms bent the light from a small flame into a single strong beam that ships could see from many kilometres away. Each lighthouse flashed in its own pattern, so sailors could tell which one they were looking at.",
    "Keepers wrote down the weather, the ships that passed and anything that went wrong. On stormy nights they might stay awake until morning, making sure the light never went out.",
    "Over the last century most lighthouses were changed to electric lamps that switch on by themselves. Satellite navigation now guides most ships, but many lights still work as a backup when other systems fail.",
    "Some old keepers' cottages have become museums or holiday homes. Visitors can climb the narrow stairs, stand beside the great lens and look out over the same water the keepers watched for years."
  ]
];

const $ = (selector) => document.querySelector(selector);
const els = {
  setup: $("#setup"), stage: $("#stage"), done: $("#done"), form: $("#setupForm"), formError: $("#formError"),
  participant: $("#participant"), glasses: $("#glasses"), camera: $("#camera"), lighting: $("#lighting"), consent: $("#consent"),
  video: $("#video"), videoHome: $("#videoHome"), miniVideo: $("#miniVideo"),
  faceDot: $("#faceDot"), faceStatus: $("#faceStatus"), faceDetail: $("#faceDetail"),
  cameraButton: $("#cameraButton"), beginButton: $("#beginButton"),
  progressLabel: $("#progressLabel"), progressBar: $("#progressBar"), stageDot: $("#stageDot"), stopButton: $("#stopButton"), stageBody: $("#stageBody"),
  doneTitle: $("#doneTitle"), doneText: $("#doneText"), downloadButton: $("#downloadButton"), againButton: $("#againButton"),
  summaryRows: $("#summaryRows"), summaryNote: $("#summaryNote")
};

let stream;
let landmarker;
let loop;
let faceUsable = false;
const filter = createReadingFilter();

let rows = [];
let meta = null;      // { participant, glasses, camera, lighting, session }
let current = null;   // the task being recorded: { round, task, label, startedAt }
let runToken = 0;     // a Stop cancels the running sequence
let audio;

// ---------- Camera and measuring ----------
function showFace(assessment) {
  faceUsable = assessment.usable;
  for (const dot of [els.faceDot, els.stageDot]) dot.className = `dot ${assessment.usable ? "ok" : "bad"}`;
  if (assessment.usable) {
    els.faceStatus.textContent = "Face found";
    els.faceDetail.textContent = "You're ready. Keep sitting like this.";
  } else {
    els.faceStatus.textContent = REASONS[assessment.reason] || "Can't measure right now";
    els.faceDetail.textContent = "Move so your whole face is in view and well lit.";
  }
  if (!meta) els.beginButton.disabled = !assessment.usable;
}

function measure() {
  if (!landmarker || els.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
  const now = Date.now();
  let result;
  try {
    result = landmarker.detectForVideo(els.video, performance.now());
  } catch (error) {
    console.error("Frame error", error);
    return;
  }
  const assessment = assessFrame(result.faceLandmarks || [], result.facialTransformationMatrixes || []);
  const reading = filter.next(assessment, now); // the app's current rule-based score, for comparison
  showFace(assessment);
  if (current) record(assessment, reading, now);
}

async function startCamera() {
  els.cameraButton.disabled = true;
  els.faceStatus.textContent = "Connecting to your camera…";
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } } });
    els.video.srcObject = stream;
    await els.video.play();
    els.faceStatus.textContent = "Loading the face model…";
    landmarker = await loadFaceLandmarker();
    loop = window.setInterval(measure, TICK_MS);
    els.cameraButton.hidden = true;
  } catch (error) {
    console.error("Camera start error", error);
    els.cameraButton.disabled = false;
    els.faceStatus.textContent = "Camera didn't start";
    els.faceDetail.textContent = error?.name === "NotAllowedError"
      ? "Camera permission was denied. Allow it for this site in your browser settings, then try again."
      : "Check your camera and internet connection, then try again.";
  }
}

function stopCamera() {
  window.clearInterval(loop);
  stream?.getTracks().forEach((track) => track.stop());
  stream = undefined;
  els.video.srcObject = null;
  landmarker = undefined;
}

// ---------- Recording ----------
const round = (value, digits) => (value === null || value === undefined ? "" : Number(value.toFixed(digits)));

function record(assessment, reading, now) {
  const features = assessment.usable ? assessment.features : {};
  rows.push({
    ...meta,
    round: current.round,
    task: current.task,
    label: current.label,
    t_ms: now - current.startedAt,
    usable: assessment.usable ? 1 : 0,
    reason: assessment.usable ? "" : assessment.reason,
    ...Object.fromEntries(FEATURE_NAMES.map((name) => [name, round(features[name], name.startsWith("head_") && name !== "head_turn" ? 2 : 5)])),
    rule_tracking: reading ? reading.tracking : "skipped",
    rule_score: reading?.score ?? "",
    rule_engagement: reading?.engagement ?? ""
  });
}

const COLUMNS = ["participant", "glasses", "camera", "lighting", "session", "round", "task", "label", "t_ms", "usable", "reason", ...FEATURE_NAMES, "rule_tracking", "rule_score", "rule_engagement"];

function toCsv() {
  const cell = (value) => {
    const text = String(value ?? "");
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [COLUMNS.join(","), ...rows.map((row) => COLUMNS.map((column) => cell(row[column])).join(","))].join("\n");
}

// ---------- The task sequence ----------
function shuffle(list) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// Two rounds of every task in a random order, never the same task twice in a row.
function buildPlan() {
  const names = Object.keys(TASKS);
  const first = shuffle(names);
  let second = shuffle(names);
  while (second[0] === first[first.length - 1]) second = shuffle(names);
  return [...first.map((task) => ({ round: 1, task })), ...second.map((task) => ({ round: 2, task }))];
}

function beep(times = 1) {
  if (!audio) return;
  for (let i = 0; i < times; i += 1) {
    const start = audio.currentTime + i * 0.22;
    const tone = audio.createOscillator();
    const volume = audio.createGain();
    tone.frequency.value = 880;
    volume.gain.setValueAtTime(0.2, start);
    volume.gain.exponentialRampToValueAtTime(0.001, start + 0.18);
    tone.connect(volume).connect(audio.destination);
    tone.start(start);
    tone.stop(start + 0.2);
  }
}

const wait = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

function showPrep(step, count) {
  const task = TASKS[step.task];
  els.stageBody.innerHTML = "";
  const box = document.createElement("div");
  box.className = "prep";
  box.innerHTML = `<p class="timer">Next</p><h2></h2><p class="text"></p><div class="count"></div>`;
  box.querySelector("h2").textContent = task.title;
  box.querySelector(".text").textContent = task.label ? task.text : `${task.text} ${LOOK_BACK}`;
  box.querySelector(".count").textContent = count;
  els.stageBody.append(box);
  return box.querySelector(".count");
}

// Shows the task and returns a function that stops any animation it started.
function showTask(step) {
  const task = TASKS[step.task];
  els.stageBody.innerHTML = "";
  if (step.task === "read") {
    const box = document.createElement("div");
    box.className = "reading";
    const article = document.createElement("article");
    PASSAGES[(step.round - 1) % PASSAGES.length].forEach((text) => {
      const p = document.createElement("p");
      p.textContent = text;
      article.append(p);
    });
    box.append(article);
    els.stageBody.append(box);
    return () => {};
  }
  if (step.task === "dot") {
    const dot = document.createElement("div");
    dot.className = "target";
    els.stageBody.append(dot);
    let frame;
    const started = performance.now();
    const move = (time) => {
      const t = (time - started) / 1000;
      dot.style.left = `${(0.5 + 0.44 * Math.sin(t * 0.9)) * 100}%`;
      dot.style.top = `${(0.5 + 0.4 * Math.sin(t * 1.3 + 0.6)) * 100}%`;
      frame = requestAnimationFrame(move);
    };
    frame = requestAnimationFrame(move);
    return () => cancelAnimationFrame(frame);
  }
  const box = document.createElement("div");
  box.className = "instruction";
  box.innerHTML = `<h2></h2><p></p><p class="timer"></p>`;
  box.querySelector("h2").textContent = task.title;
  box.querySelector("p").textContent = task.text;
  box.querySelector(".timer").textContent = LOOK_BACK;
  els.stageBody.append(box);
  return () => {};
}

async function runSequence() {
  const token = ++runToken;
  const plan = buildPlan();
  const total = plan.reduce((sum, step) => sum + PREP_SECONDS + TASKS[step.task].seconds, 0);
  let elapsed = 0;
  const progress = (step, index, seconds) => {
    els.progressLabel.textContent = `Task ${index + 1} of ${plan.length} · ${TASKS[step.task].title}`;
    els.progressBar.style.width = `${Math.min(100, ((elapsed + seconds) / total) * 100)}%`;
  };

  for (const [index, step] of plan.entries()) {
    const countEl = showPrep(step, PREP_SECONDS);
    for (let s = PREP_SECONDS; s > 0; s -= 1) {
      countEl.textContent = s;
      progress(step, index, PREP_SECONDS - s);
      await wait(1000);
      if (token !== runToken) return;
    }
    elapsed += PREP_SECONDS;

    const task = TASKS[step.task];
    const stopAnimation = showTask(step);
    beep(1);
    current = { round: step.round, task: step.task, label: task.label, startedAt: Date.now() };
    for (let s = 0; s < task.seconds; s += 1) {
      progress(step, index, s);
      await wait(1000);
      if (token !== runToken) { stopAnimation(); return; }
    }
    current = null;
    stopAnimation();
    elapsed += task.seconds;
    beep(2);
  }
  finish(true);
}

// ---------- Screens ----------
function begin(event) {
  event?.preventDefault();
  const participant = els.participant.value.trim().replace(/[^A-Za-z0-9_-]/g, "").slice(0, 12);
  const problem = !participant ? "Enter your participant code." : !els.consent.checked ? "Tick the box to agree before recording." : "";
  els.formError.textContent = problem;
  els.formError.hidden = !problem;
  if (problem) return;
  if (!faceUsable) return;

  audio ??= new (window.AudioContext || window.webkitAudioContext)();
  meta = {
    participant, glasses: els.glasses.value, camera: els.camera.value, lighting: els.lighting.value,
    session: Math.random().toString(36).slice(2, 10)
  };
  rows = [];
  els.miniVideo.append(els.video);
  els.setup.hidden = true;
  els.done.hidden = true;
  els.stage.hidden = false;
  document.documentElement.requestFullscreen?.().catch(() => {});
  void runSequence();
}

function finish(completed) {
  runToken += 1;
  current = null;
  els.stageBody.innerHTML = "";
  els.stage.hidden = true;
  els.done.hidden = false;
  els.videoHome.append(els.video);
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});

  els.doneTitle.textContent = completed ? "Thank you, that's everything" : "Recording stopped";
  els.doneText.textContent = rows.length
    ? "Download your file and send it to the Neuro-Focus team. It contains only the numbers described at the start."
    : "Nothing was recorded. You can start again when you're ready.";
  els.downloadButton.disabled = !rows.length;

  els.summaryRows.innerHTML = "";
  for (const name of Object.keys(TASKS)) {
    const mine = rows.filter((row) => row.task === name);
    const tr = document.createElement("tr");
    const usable = mine.length ? Math.round((mine.filter((row) => row.usable).length / mine.length) * 100) : 0;
    [TASKS[name].title, mine.length, mine.length ? `${usable}%` : "—"].forEach((text) => {
      const td = document.createElement("td");
      td.textContent = text;
      tr.append(td);
    });
    els.summaryRows.append(tr);
  }
  const focusedRows = rows.filter((row) => row.label === 1);
  const focusedUsable = focusedRows.length ? focusedRows.filter((row) => row.usable).length / focusedRows.length : 1;
  els.summaryNote.textContent = focusedUsable < 0.6
    ? "Your face often couldn't be measured while reading or following the dot. If you can, try again with more light or closer to the camera."
    : "It's normal for the face to be measurable less often when looking away or at a phone.";
}

function download() {
  const blob = new Blob([toCsv()], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
  const link = document.createElement("a");
  link.href = url;
  link.download = `neurofocus-${meta.participant}-${stamp}.csv`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function again() {
  meta = null;
  rows = [];
  els.done.hidden = true;
  els.setup.hidden = false;
  els.beginButton.disabled = !faceUsable;
}

els.cameraButton.addEventListener("click", startCamera);
els.beginButton.addEventListener("click", begin);
els.form.addEventListener("submit", begin);
els.stopButton.addEventListener("click", () => finish(false));
els.downloadButton.addEventListener("click", download);
els.againButton.addEventListener("click", again);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !els.stage.hidden) finish(false);
});
window.addEventListener("pagehide", stopCamera);
