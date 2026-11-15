// Timers that keep running while the tab is in the background (another tab open, the window
// minimised or covered, e.g. by Zoom or Google Meet).
//
// Browsers slow a hidden page's own timers to about once a second, and to about once a minute
// after 5 minutes, which would pause attention tracking. A web worker's timers aren't slowed, so a
// tiny worker keeps the beat and the page does the work on each tick. Tested in Chrome: in a
// hidden tab the tracker kept about 8 readings a second this way, against 1 with a page timer.
// Without worker support it falls back to normal timers.
let worker = null;          // the shared worker, false if workers aren't available
const callbacks = new Map(); // id -> function
let nextId = 1;

const WORKER_SOURCE = `
  const timers = new Map();
  onmessage = ({ data }) => {
    clearInterval(timers.get(data.id));
    timers.delete(data.id);
    if (!data.stop) timers.set(data.id, setInterval(() => postMessage(data.id), data.ms));
  };
`;

function clockWorker() {
  if (worker !== null) return worker;
  try {
    worker = new Worker(URL.createObjectURL(new Blob([WORKER_SOURCE], { type: "text/javascript" })));
    worker.onmessage = ({ data: id }) => callbacks.get(id)?.();
  } catch {
    worker = false;
  }
  return worker;
}

// Calls fn every `ms` milliseconds, in the background too. Returns a function that stops it.
export function every(ms, fn) {
  const clock = clockWorker();
  if (!clock) {
    const timer = window.setInterval(fn, ms);
    return () => window.clearInterval(timer);
  }
  const id = nextId;
  nextId += 1;
  callbacks.set(id, fn);
  clock.postMessage({ id, ms });
  return () => {
    if (!callbacks.delete(id)) return;
    clock.postMessage({ id, stop: true });
  };
}
