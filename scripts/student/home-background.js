// Home's live background: a slow "neural network" of drifting points in the student's accent
// colour, drawn on a canvas behind the page (styles/student.css frosts the cards above it, so no
// sharp movement passes behind text). It reacts gently to the mouse.
// It only runs while Home is showing and the tab is visible, at most 30 frames a second, and
// shows a still picture when the student prefers reduced motion.
import { themeColor } from "../shared/appearance.js?v=1";

const app = await window.neuroFocusReady;
const main = document.querySelector("main");

if (app && main) {
  const canvas = document.createElement("canvas");
  canvas.className = "home-bg";
  canvas.setAttribute("aria-hidden", "true");
  main.prepend(canvas);
  const ctx = canvas.getContext("2d");
  const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  const FRAME_MS = 1000 / 30;
  const LINK = 150;           // points closer than this are joined
  const pointer = { x: -9999, y: -9999 };
  let nodes = [];
  let width = 0;
  let height = 0;
  let colors = { accent: "#00d9ff", green: "#22c55e", light: false };
  let frame = 0;
  let last = 0;
  let running = false;

  const hexToRgb = (hex) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
    return m ? [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)) : [0, 217, 255];
  };

  function readColors() {
    colors = {
      accent: hexToRgb(themeColor("--accent", "#00d9ff")),
      green: hexToRgb(themeColor("--green", "#22c55e")),
      light: document.documentElement.dataset.theme === "light"
    };
  }

  // The canvas covers the visible part of main (not the sidebar) and stays put while it scrolls.
  function resize() {
    const box = main.getBoundingClientRect();
    const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
    width = Math.max(1, Math.round(box.width));
    height = window.innerHeight;
    canvas.style.left = `${box.left}px`;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    const count = Math.round(Math.min(70, Math.max(24, (width * height) / 22000)));
    while (nodes.length < count) nodes.push(newNode());
    nodes.length = count;
    nodes.forEach((node) => { node.x = Math.min(node.x, width); node.y = Math.min(node.y, height); });
  }

  function newNode() {
    return {
      x: Math.random() * (width || window.innerWidth),
      y: Math.random() * (height || window.innerHeight),
      vx: (Math.random() - 0.5) * 0.25,
      vy: (Math.random() - 0.5) * 0.25,
      r: 1 + Math.random() * 1.8,
      tint: Math.random() < 0.25 ? "green" : "accent"
    };
  }

  function draw(move) {
    ctx.clearRect(0, 0, width, height);
    const strength = colors.light ? 0.55 : 1;
    // Two slow glows give the page depth.
    const t = performance.now() / 1000;
    [[0.78 + Math.sin(t / 9) * 0.06, 0.18, colors.accent, 0.10], [0.15, 0.85 + Math.cos(t / 11) * 0.05, colors.green, 0.06]].forEach(([fx, fy, rgb, a]) => {
      const gx = fx * width;
      const gy = fy * height;
      const glow = ctx.createRadialGradient(gx, gy, 0, gx, gy, Math.max(width, height) * 0.45);
      glow.addColorStop(0, `rgba(${rgb.join(",")}, ${a * strength})`);
      glow.addColorStop(1, `rgba(${rgb.join(",")}, 0)`);
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, width, height);
    });

    nodes.forEach((node) => {
      if (move) {
        // Points drift, bounce off the edges and lean a little towards the pointer.
        const dx = pointer.x - node.x;
        const dy = pointer.y - node.y;
        const near = dx * dx + dy * dy < 200 * 200;
        if (near) { node.vx += dx * 0.00002; node.vy += dy * 0.00002; }
        node.vx = Math.max(-0.4, Math.min(0.4, node.vx));
        node.vy = Math.max(-0.4, Math.min(0.4, node.vy));
        node.x += node.vx;
        node.y += node.vy;
        if (node.x < 0 || node.x > width) node.vx *= -1;
        if (node.y < 0 || node.y > height) node.vy *= -1;
      }
    });

    ctx.lineWidth = 1;
    for (let i = 0; i < nodes.length; i += 1) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j += 1) {
        const b = nodes[j];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        if (dist > LINK) continue;
        ctx.strokeStyle = `rgba(${colors.accent.join(",")}, ${(1 - dist / LINK) * 0.22 * strength})`;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      const toPointer = Math.hypot(a.x - pointer.x, a.y - pointer.y);
      if (toPointer < 180) {
        ctx.strokeStyle = `rgba(${colors.accent.join(",")}, ${(1 - toPointer / 180) * 0.35 * strength})`;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(pointer.x, pointer.y);
        ctx.stroke();
      }
    }
    nodes.forEach((node) => {
      ctx.fillStyle = `rgba(${colors[node.tint].join(",")}, ${0.55 * strength})`;
      ctx.beginPath();
      ctx.arc(node.x, node.y, node.r, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  function loop(now) {
    if (!running) return;
    frame = requestAnimationFrame(loop);
    if (now - last < FRAME_MS) return;
    last = now;
    draw(true);
  }

  // Run only while it can be seen; a still picture for reduced motion.
  function update() {
    const visible = window.neuroFocusView === "dashboard" && document.visibilityState === "visible";
    canvas.hidden = window.neuroFocusView !== "dashboard";
    const shouldRun = visible && !motionQuery.matches;
    if (shouldRun && !running) {
      running = true;
      last = 0;
      frame = requestAnimationFrame(loop);
    } else if (!shouldRun && running) {
      running = false;
      cancelAnimationFrame(frame);
    }
    if (visible && motionQuery.matches) draw(false);
  }

  main.addEventListener("pointermove", (event) => {
    const box = canvas.getBoundingClientRect();
    pointer.x = event.clientX - box.left;
    pointer.y = event.clientY - box.top;
  }, { passive: true });
  main.addEventListener("pointerleave", () => { pointer.x = -9999; pointer.y = -9999; });
  window.addEventListener("resize", () => { resize(); if (!running) update(); });
  window.addEventListener("neurofocus:viewchange", () => { resize(); update(); });
  window.addEventListener("neurofocus:appearance-change", () => { readColors(); if (!running) update(); });
  document.addEventListener("visibilitychange", update);
  motionQuery.addEventListener("change", update);

  readColors();
  resize();
  update();
}
