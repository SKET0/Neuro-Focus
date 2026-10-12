// Animated Neuro-Focus logo for the home and login pages (Three.js r128).
// The logo (assets/images/neuro-focus-logo.svg) built from light: each stroke is a bundle of
// glowing particles whose colour flows from violet through blue and cyan to mint, ending in the
// green focus dot, with fainter depth layers behind it so it reads as a hologram when it turns.
//   - On load, a bright pen tip draws each stroke in, then the focus dot ignites.
//   - Signals flow along the strokes into the focus dot, which pulses when they arrive.
//   - Synapses link neighbouring strokes; sparks jump across them and light them up.
//   - An attention scan sweeps across the logo now and then, and firing waves ripple along it.
//   - The pointer lights the strokes up, parts the particles and sets off nearby synapses.
//   - Clicking the hero (home page) sends a focus burst.
// Behind it there is only a faint star field: no orbits, glow discs or rings.
// Renders one still frame when the visitor prefers reduced motion.
//
// Placement: by default the logo sits between a page's text and its sign-in card.
// If the page has an element with [data-brain-anchor], the logo is centred on that
// element and sized to fit it. The canvas can be fixed (full window) or placed inside a
// section; the scene always matches the canvas's own size.
(function neuralBackground() {
  const canvas = document.querySelector("#bg");
  if (!canvas || !window.THREE) return;

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const COLORS = {
    violet: new THREE.Color(0x7c6cff),
    blue: new THREE.Color(0x3b82f6),
    cyan: new THREE.Color(0x00d9ff),
    mint: new THREE.Color(0x5eead4),
    green: new THREE.Color(0x22c55e),
    ice: new THREE.Color(0xc8fbff),
    white: new THREE.Color(0xffffff)
  };
  // Colour along the logo, from where drawing starts to the focus dot.
  const RAMP = [[0, COLORS.violet], [0.3, COLORS.blue], [0.62, COLORS.cyan], [1, COLORS.mint]];
  const rampColor = (f, out) => {
    for (let i = 1; i < RAMP.length; i++) {
      if (f <= RAMP[i][0]) return out.copy(RAMP[i - 1][1]).lerp(RAMP[i][1], (f - RAMP[i - 1][0]) / (RAMP[i][0] - RAMP[i - 1][0]));
    }
    return out.copy(RAMP.at(-1)[1]);
  };

  const canvasSize = () => ({ width: canvas.clientWidth || window.innerWidth, height: canvas.clientHeight || window.innerHeight });
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(canvasSize().width, canvasSize().height, false);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, canvasSize().width / canvasSize().height, 0.1, 100);
  camera.position.set(0, 0.15, 7.2);

  // ---------- Helpers ----------
  const rand = (min, max) => min + Math.random() * (max - min);
  const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
  const ease = (value) => value * value * (3 - 2 * value);

  function randomDirection() {
    const u = Math.random() * 2 - 1;
    const theta = Math.random() * Math.PI * 2;
    const s = Math.sqrt(1 - u * u);
    return [s * Math.cos(theta), u, s * Math.sin(theta)];
  }

  // Soft round glow used for every particle.
  const sprite = (() => {
    const size = 64;
    const glow = document.createElement("canvas");
    glow.width = glow.height = size;
    const ctx = glow.getContext("2d");
    const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, "rgba(255,255,255,1)");
    gradient.addColorStop(0.25, "rgba(255,255,255,0.85)");
    gradient.addColorStop(0.6, "rgba(255,255,255,0.16)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
    return new THREE.CanvasTexture(glow);
  })();

  const glowMaterial = (size, opacity = 1) => new THREE.PointsMaterial({
    size, map: sprite, vertexColors: true, transparent: true, opacity,
    depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true
  });

  // Points that are dark at the moment (an unlit trail, a spark waiting to start) are parked out
  // of view: on the transparent canvas a black point would show as a dark speck.
  const HIDDEN_Z = 1000;
  function pointCloud(count, material) {
    const positions = new Float32Array(count * 3);
    for (let i = 2; i < positions.length; i += 3) positions[i] = HIDDEN_Z;
    const colors = new Float32Array(count * 3);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    return { points: new THREE.Points(geometry, material), positions, colors, geometry };
  }

  // ---------- The logo, as curves ----------
  // The same paths as assets/images/neuro-focus-logo.svg (viewBox 632 191 736 736), in drawing order.
  const LOGO_PATHS = [
    "M790 565 C700 572 655 525 655 465 C655 345 790 245 955 245 C1170 245 1345 390 1345 548 C1345 640 1278 700 1188 722",
    "M802 552 C780 455 865 380 990 380 C1140 380 1246 465 1246 572 C1246 630 1214 668 1186 710 C1166 740 1166 770 1168 795",
    "M790 565 C850 562 890 540 935 518 C985 495 1025 485 1070 485 C1132 485 1162 515 1162 555 C1162 612 1102 682 1012 682 C932 682 855 640 818 578",
    "M1022 688 C1062 712 1100 721 1140 721 C1160 721 1176 718 1188 714"
  ];
  const STEM = 1;                       // the path that runs down into the focus dot
  const UNIT = 330;                     // logo units per world unit
  const toWorld = (x, y) => [(x - 1000) / UNIT, -(y - 559) / UNIT];
  const DOT = { center: toWorld(1175, 835), radius: 40 / UNIT };
  const STROKE = 25 / UNIT;             // half the stroke width (a little bolder than the SVG)

  // Each path as an evenly measurable polyline: points, cumulative length, total length.
  const paths = LOGO_PATHS.map((d) => {
    const n = d.match(/-?\d+(?:\.\d+)?/g).map(Number);
    let [x0, y0] = [n[0], n[1]];
    const points = [];
    for (let i = 2; i + 5 < n.length; i += 6) {
      const [x1, y1, x2, y2, x3, y3] = n.slice(i, i + 6);
      for (let k = points.length ? 1 : 0; k <= 48; k++) {
        const t = k / 48;
        const u = 1 - t;
        points.push(toWorld(
          u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3,
          u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3
        ));
      }
      [x0, y0] = [x3, y3];
    }
    const lengths = [0];
    for (let i = 1; i < points.length; i++) {
      lengths.push(lengths[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
    }
    return { points, lengths, total: lengths.at(-1) };
  });
  const totalLength = paths.reduce((sum, path) => sum + path.total, 0);
  const pathOffset = paths.map((_, i) => paths.slice(0, i).reduce((sum, path) => sum + path.total, 0));
  const arcOf = (p, s) => (pathOffset[p] + s) / totalLength;

  // Position and direction at distance s along a path.
  function along(path, s) {
    const target = clamp(s, 0, path.total);
    let lo = 0;
    let hi = path.lengths.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (path.lengths[mid] < target) lo = mid; else hi = mid;
    }
    const span = path.lengths[hi] - path.lengths[lo] || 1;
    const f = (target - path.lengths[lo]) / span;
    const a = path.points[lo];
    const b = path.points[hi];
    const tx = (b[0] - a[0]) / span;
    const ty = (b[1] - a[1]) / span;
    const length = Math.hypot(tx, ty) || 1;
    return { x: a[0] + (b[0] - a[0]) * f, y: a[1] + (b[1] - a[1]) * f, tx: tx / length, ty: ty / length };
  }
  function pickPath() {
    let r = Math.random() * totalLength;
    for (let p = 0; p < paths.length; p++) {
      if (r < paths[p].total) return p;
      r -= paths[p].total;
    }
    return paths.length - 1;
  }

  const logo = new THREE.Group();
  scene.add(logo);

  // ---------- Fibres: the strokes, their depth layers and the focus dot ----------
  const FIBRE = 5400;
  const DEPTH = 1400;   // fainter copies behind the strokes, for a holographic depth
  const HALO = 900;     // a loose glow around the strokes
  const FOCUS = 340;
  const COUNT = FIBRE + DEPTH + HALO + FOCUS;
  const fibres = pointCloud(COUNT, glowMaterial(0.058, 1));
  const target = new Float32Array(COUNT * 3);
  const start = new Float32Array(COUNT * 3);
  const offset = new Float32Array(COUNT * 3);  // pushed aside by the pointer or a burst
  const base = new Float32Array(COUNT * 3);    // colour before light effects
  const arc = new Float32Array(COUNT);         // 0..1 along the whole logo, in drawing order
  const core = new Float32Array(COUNT);        // 1 on a stroke's centre line, 0 at its edge
  const delay = new Float32Array(COUNT);
  const kind = new Uint8Array(COUNT);          // 0 fibre, 1 depth, 2 halo, 3 focus dot
  const shade = new THREE.Color();

  // Drawing order: each stroke starts once the one before is partly drawn.
  const DRAW_SPEED = 1.7;                      // world units per second
  const pathStart = [0.15, 0.55, 1, 1.35];
  const drawnAt = (p, s) => pathStart[p] + s / DRAW_SPEED;
  const drawEnd = paths.map((path, p) => drawnAt(p, path.total));
  const FOCUS_AT = drawEnd[STEM] + 0.05;
  const IGNITE = Math.max(...drawEnd) + 0.25;

  for (let i = 0; i < COUNT; i++) {
    let x;
    let y;
    let z;
    if (i < FIBRE + DEPTH + HALO) {
      kind[i] = i < FIBRE ? 0 : i < FIBRE + DEPTH ? 1 : 2;
      const p = pickPath();
      const s = Math.random() * paths[p].total;
      const point = along(paths[p], s);
      const angle = Math.random() * Math.PI * 2;
      const radius = kind[i] === 2 ? rand(1.5, 4) * STROKE : STROKE * Math.sqrt(Math.random()) * (kind[i] === 1 ? 0.8 : 1);
      const side = Math.cos(angle) * radius;
      x = point.x - point.ty * side;
      y = point.y + point.tx * side;
      z = Math.sin(angle) * radius * 1.2;
      if (kind[i] === 1) z -= Math.random() < 0.6 ? 0.3 : 0.6;   // two depth layers behind
      if (kind[i] === 2) z *= 1.5;
      arc[i] = arcOf(p, s);
      core[i] = kind[i] === 2 ? 0 : 1 - radius / STROKE;
      delay[i] = drawnAt(p, s) + (kind[i] === 0 ? rand(0, 0.08) : rand(0.25, 0.8));
      rampColor(arc[i], shade);
      if (kind[i] === 0) shade.lerp(COLORS.ice, core[i] ** 2.2 * 0.6).multiplyScalar(rand(0.8, 1.1));
      else if (kind[i] === 1) shade.multiplyScalar(z < -0.45 ? rand(0.18, 0.3) : rand(0.3, 0.45));
      else shade.multiplyScalar(rand(0.2, 0.42));
    } else {
      // The focus dot: a bright, slightly flattened sphere.
      const [dx, dy, dz] = randomDirection();
      const radius = DOT.radius * Math.cbrt(Math.random());
      x = DOT.center[0] + dx * radius;
      y = DOT.center[1] + dy * radius;
      z = dz * radius * 0.8;
      kind[i] = 3;
      arc[i] = 1;
      core[i] = 1 - radius / DOT.radius;
      delay[i] = FOCUS_AT + rand(0, 0.15);
      shade.copy(COLORS.green).lerp(COLORS.mint, 0.5).lerp(COLORS.white, core[i] ** 2 * 0.65);
    }
    target.set([x, y, z], i * 3);
    // Strokes rise out of a loose cloud along their own path; the rest drift in from further out.
    const [sx, sy, sz] = randomDirection();
    const spread = kind[i] === 0 ? rand(0.6, 1.6) : rand(2.5, 5);
    start.set([x + sx * spread, y + sy * spread, z + sz * spread], i * 3);
    base.set([shade.r, shade.g, shade.b], i * 3);
  }
  fibres.positions.set(reduceMotion ? target : start);
  logo.add(fibres.points);

  // ---------- Pen tips that draw each stroke in ----------
  const PEN_TRAIL = 14;
  const pens = pointCloud(paths.length * PEN_TRAIL, glowMaterial(0.13, 1));
  logo.add(pens.points);
  function updatePens(t) {
    paths.forEach((path, p) => {
      const s = (t - pathStart[p]) * DRAW_SPEED;
      const drawing = s > 0 && s < path.total + 0.1;
      for (let k = 0; k < PEN_TRAIL; k++) {
        const o = (p * PEN_TRAIL + k) * 3;
        const sk = s - k * 0.03;
        const visible = drawing && sk >= 0 && sk <= path.total;
        const point = along(path, sk);
        pens.positions[o] = point.x;
        pens.positions[o + 1] = point.y;
        pens.positions[o + 2] = visible ? 0.03 : HIDDEN_Z;
        const fade = visible ? (1 - k / PEN_TRAIL) ** 1.8 : 0;
        rampColor(arcOf(p, clamp(sk, 0, path.total)), shade).lerp(COLORS.white, 0.6);
        pens.colors[o] = shade.r * fade;
        pens.colors[o + 1] = shade.g * fade;
        pens.colors[o + 2] = shade.b * fade;
      }
    });
    pens.geometry.attributes.position.needsUpdate = true;
    pens.geometry.attributes.color.needsUpdate = true;
  }

  // ---------- Focus dot: a small, tight glow ----------
  const focusGlow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: sprite, color: COLORS.mint, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending
  }));
  focusGlow.position.set(DOT.center[0], DOT.center[1], 0.02);
  logo.add(focusGlow);

  let focusFlash = 0;
  let lastFocus = -Infinity;
  function focusHit(now, strength = 1) {
    focusFlash = Math.max(focusFlash, strength);
    lastFocus = now;
  }

  // ---------- Signals flowing along the strokes ----------
  const SIGNALS = 18;
  const TRAIL = 10;
  const signalCloud = pointCloud(SIGNALS * TRAIL, glowMaterial(0.12, 0));
  logo.add(signalCloud.points);
  const signals = [];
  function sendSignal(signal, fresh = false) {
    // The stem gets more traffic: its signals end in the focus dot.
    signal.path = Math.random() < 0.4 ? STEM : pickPath();
    signal.s = fresh ? Math.random() * paths[signal.path].total : -rand(0, 0.8);
    signal.speed = rand(0.9, 1.6);
    signal.color = Math.random() < 0.3 ? COLORS.mint : Math.random() < 0.25 ? COLORS.violet : COLORS.ice;
    signal.arrived = false;
  }
  for (let i = 0; i < SIGNALS; i++) {
    const signal = {};
    sendSignal(signal, true);
    signals.push(signal);
  }

  function updateSignals(dt, now) {
    signals.forEach((signal, i) => {
      signal.s += dt * signal.speed;
      const path = paths[signal.path];
      if (signal.s - TRAIL * 0.035 > path.total) { sendSignal(signal); return; }
      if (signal.path === STEM && !signal.arrived && signal.s >= path.total) {
        signal.arrived = true;
        focusHit(now, 0.8);
      }
      for (let k = 0; k < TRAIL; k++) {
        const s = signal.s - k * 0.035;
        const o = (i * TRAIL + k) * 3;
        const visible = s >= 0 && s <= path.total;
        const point = along(path, s);
        signalCloud.positions[o] = point.x;
        signalCloud.positions[o + 1] = point.y;
        signalCloud.positions[o + 2] = visible ? 0.03 : HIDDEN_Z;
        const fade = visible ? (1 - k / TRAIL) ** 2 : 0;
        signalCloud.colors[o] = signal.color.r * fade;
        signalCloud.colors[o + 1] = signal.color.g * fade;
        signalCloud.colors[o + 2] = signal.color.b * fade;
      }
    });
    signalCloud.geometry.attributes.position.needsUpdate = true;
    signalCloud.geometry.attributes.color.needsUpdate = true;
  }

  // ---------- Synapses: links between nearby strokes, with sparks jumping across ----------
  const nodes = [];
  paths.forEach((path, p) => {
    for (let s = 0.08; s < path.total; s += 0.15) {
      const point = along(path, s + rand(-0.03, 0.03));
      nodes.push({ p, s, v: new THREE.Vector3(point.x, point.y, rand(-0.04, 0.04)) });
    }
  });
  const edges = [];
  const adjacency = nodes.map(() => []);
  nodes.forEach((node, i) => {
    nodes
      .map((other, j) => ({ j, distance: node.v.distanceTo(other.v) }))
      .filter(({ j, distance }) => j > i && distance < 0.4 && (nodes[j].p !== node.p || Math.abs(nodes[j].s - node.s) > 0.7))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 2)
      .forEach(({ j }) => {
        adjacency[i].push(edges.length);
        adjacency[j].push(edges.length);
        edges.push([i, j]);
      });
  });
  const edgePositions = new Float32Array(edges.length * 6);
  const edgeColors = new Float32Array(edges.length * 6);
  const edgeBase = edges.map(([a, b]) => rampColor((arcOf(nodes[a].p, nodes[a].s) + arcOf(nodes[b].p, nodes[b].s)) / 2, new THREE.Color()));
  edges.forEach(([a, b], e) => {
    edgePositions.set([nodes[a].v.x, nodes[a].v.y, nodes[a].v.z, nodes[b].v.x, nodes[b].v.y, nodes[b].v.z], e * 6);
    for (let end = 0; end < 2; end++) edgeColors.set([edgeBase[e].r * 0.16, edgeBase[e].g * 0.16, edgeBase[e].b * 0.16], e * 6 + end * 3);
  });
  const edgeGeometry = new THREE.BufferGeometry();
  edgeGeometry.setAttribute("position", new THREE.BufferAttribute(edgePositions, 3));
  edgeGeometry.setAttribute("color", new THREE.BufferAttribute(edgeColors, 3));
  const edgeMaterial = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
  logo.add(new THREE.LineSegments(edgeGeometry, edgeMaterial));
  const edgeGlow = new Float32Array(edges.length);

  const nodeCloud = pointCloud(nodes.length, glowMaterial(0.09, 0));
  nodes.forEach((node, i) => nodeCloud.positions.set([node.v.x, node.v.y, node.v.z], i * 3));
  logo.add(nodeCloud.points);
  const nodeFlash = new Float32Array(nodes.length);
  function fire(node, strength = 1) {
    nodeFlash[node] = Math.max(nodeFlash[node], strength);
    adjacency[node].forEach((e) => { edgeGlow[e] = Math.max(edgeGlow[e], strength); });
  }

  const SPARKS = edges.length ? 14 : 0;
  const SPARK_TRAIL = 5;
  const sparkCloud = pointCloud(Math.max(1, SPARKS * SPARK_TRAIL), glowMaterial(0.11, 0));
  logo.add(sparkCloud.points);
  const sparks = [];
  function jump(spark, fromNode) {
    const options = fromNode === undefined ? null : adjacency[fromNode];
    const edgeIndex = options && options.length && Math.random() < 0.7
      ? options[Math.floor(Math.random() * options.length)]
      : Math.floor(Math.random() * edges.length);
    const [a, b] = edges[edgeIndex];
    const forward = fromNode === undefined ? Math.random() < 0.5 : a === fromNode;
    Object.assign(spark, { edge: edgeIndex, from: forward ? a : b, to: forward ? b : a, t: -rand(0, 1), speed: rand(1.6, 2.6), color: Math.random() < 0.3 ? COLORS.mint : COLORS.ice });
  }
  for (let i = 0; i < SPARKS; i++) {
    const spark = {};
    jump(spark);
    sparks.push(spark);
  }

  function updateSynapses(dt) {
    sparks.forEach((spark, i) => {
      spark.t += dt * spark.speed;
      if (spark.t >= 1) {
        nodeFlash[spark.to] = Math.max(nodeFlash[spark.to], 0.8);
        jump(spark, Math.random() < 0.65 ? spark.to : undefined);
      }
      if (spark.t > 0) edgeGlow[spark.edge] = Math.max(edgeGlow[spark.edge], 0.8);
      const from = nodes[spark.from].v;
      const to = nodes[spark.to].v;
      for (let k = 0; k < SPARK_TRAIL; k++) {
        const t = clamp(spark.t - k * 0.05, 0, 1);
        const o = (i * SPARK_TRAIL + k) * 3;
        const fade = spark.t > 0 && spark.t < 1 ? (1 - k / SPARK_TRAIL) ** 2 : 0;
        sparkCloud.positions[o] = from.x + (to.x - from.x) * t;
        sparkCloud.positions[o + 1] = from.y + (to.y - from.y) * t;
        sparkCloud.positions[o + 2] = fade ? from.z + (to.z - from.z) * t : HIDDEN_Z;
        sparkCloud.colors[o] = spark.color.r * fade;
        sparkCloud.colors[o + 1] = spark.color.g * fade;
        sparkCloud.colors[o + 2] = spark.color.b * fade;
      }
    });
    sparkCloud.geometry.attributes.position.needsUpdate = true;
    sparkCloud.geometry.attributes.color.needsUpdate = true;

    const edgeDecay = Math.exp(-dt * 3);
    edges.forEach((_, e) => {
      edgeGlow[e] *= edgeDecay;
      const glow = Math.min(1, edgeGlow[e]);
      for (let end = 0; end < 2; end++) {
        const o = e * 6 + end * 3;
        edgeColors[o] = Math.min(1, edgeBase[e].r * 0.16 + COLORS.ice.r * 0.45 * glow);
        edgeColors[o + 1] = Math.min(1, edgeBase[e].g * 0.16 + COLORS.ice.g * 0.45 * glow);
        edgeColors[o + 2] = Math.min(1, edgeBase[e].b * 0.16 + COLORS.ice.b * 0.45 * glow);
      }
    });
    edgeGeometry.attributes.color.needsUpdate = true;

    const flashDecay = Math.exp(-dt * 2.6);
    nodes.forEach((node, i) => {
      if (Math.random() < dt * 0.04) nodeFlash[i] = 1; // spontaneous firing
      nodeFlash[i] *= flashDecay;
      const flash = Math.min(1, nodeFlash[i]);
      const c = edgeBase[adjacency[i][0]] || COLORS.cyan;
      const o = i * 3;
      nodeCloud.colors[o] = Math.min(1, c.r * 0.35 + COLORS.ice.r * flash);
      nodeCloud.colors[o + 1] = Math.min(1, c.g * 0.35 + COLORS.ice.g * flash);
      nodeCloud.colors[o + 2] = Math.min(1, c.b * 0.35 + COLORS.ice.b * flash);
    });
    nodeCloud.geometry.attributes.color.needsUpdate = true;
  }

  // ---------- Distant stars ----------
  const stars = pointCloud(700, glowMaterial(0.03, 0.5));
  for (let i = 0; i < 700; i++) {
    stars.positions.set([rand(-12, 12), rand(-7, 7), rand(-8, 2)], i * 3);
    shade.copy(COLORS.cyan).multiplyScalar(rand(0.15, 0.5));
    stars.colors.set([shade.r, shade.g, shade.b], i * 3);
  }
  scene.add(stars.points);

  // ---------- Layout ----------
  // Screen position (fraction of the window) -> world position on the z = 0 plane.
  function screenToWorld(fx, fy) {
    const halfHeight = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.position.z;
    return { x: (fx * 2 - 1) * halfHeight * camera.aspect, y: (1 - fy * 2) * halfHeight + camera.position.y };
  }

  const anchor = document.querySelector("[data-brain-anchor]");
  let baseY = 0;
  function placeLogo() {
    const { width, height } = canvasSize();
    if (anchor) {
      const box = canvas.getBoundingClientRect();
      const area = anchor.getBoundingClientRect();
      const spot = screenToWorld((area.left + area.width / 2 - box.left) / box.width, (area.top + area.height / 2 - box.top) / box.height);
      const worldPerPixel = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.position.z) / height;
      const scale = clamp((Math.min(area.width, area.height) * worldPerPixel) / 3, 0.7, 1.9);
      baseY = spot.y + 0.1 * scale;
      logo.position.set(spot.x, baseY, 0);
      logo.scale.setScalar(scale);
      return;
    }
    const compact = width < 900;
    // Wide screens: in the gap between the hero text and the sign-in card. (The focus dot, at the
    // logo's lower right, lands clear of the text's dark backdrop.) Narrow screens: lower right.
    const spot = compact ? screenToWorld(0.72, 0.62) : screenToWorld(0.54, Math.min(0.4, 360 / height));
    baseY = spot.y;
    logo.position.set(spot.x, baseY, compact ? -1 : 0);
    logo.scale.setScalar(0.95);
  }
  placeLogo();

  // ---------- Pointer ----------
  let pointerX = 0;
  let pointerY = 0;
  let tiltX = 0;
  let tiltY = 0;
  let pointerNdc = null; // over the canvas, in normalised device coordinates
  window.addEventListener("pointermove", (event) => {
    pointerX = event.clientX / window.innerWidth - 0.5;
    pointerY = event.clientY / window.innerHeight - 0.5;
    const box = canvas.getBoundingClientRect();
    const inside = event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom;
    pointerNdc = inside && event.pointerType === "mouse"
      ? new THREE.Vector2(((event.clientX - box.left) / box.width) * 2 - 1, -((event.clientY - box.top) / box.height) * 2 + 1)
      : null;
  }, { passive: true });
  document.addEventListener("pointerleave", () => { pointerNdc = null; });

  const raycaster = new THREE.Raycaster();
  const plane = new THREE.Plane();
  const planeNormal = new THREE.Vector3();
  const hit = new THREE.Vector3();
  function pointerOnLogo() {
    if (!pointerNdc) return null;
    raycaster.setFromCamera(pointerNdc, camera);
    planeNormal.set(0, 0, 1).applyQuaternion(logo.quaternion);
    plane.setFromNormalAndCoplanarPoint(planeNormal, logo.position);
    if (!raycaster.ray.intersectPlane(plane, hit)) return null;
    return logo.worldToLocal(hit.clone());
  }

  // Clicking the hero (home page): a focus burst from the dot.
  let burst = 0;
  anchor?.addEventListener("pointerdown", (event) => {
    if (event.target.closest("a, button")) return;
    burst = 1;
    focusHit(clock.elapsedTime, 1.3);
    signals.forEach((signal) => { if (signal.s < 0 || Math.random() < 0.5) { signal.path = STEM; signal.s = Math.random() * 0.4; signal.arrived = false; } });
    nodes.forEach((_, i) => { if (Math.random() < 0.35) fire(i, 1); });
  });

  // ---------- Animation ----------
  const fadeMaterials = [
    { material: edgeMaterial, to: 0.7 },
    { material: nodeCloud.points.material, to: 1 },
    { material: signalCloud.points.material, to: 1 },
    { material: sparkCloud.points.material, to: 1 },
  ];

  const clock = new THREE.Clock();
  const REPEL = 0.45;
  const SCAN_PERIOD = 6.5;
  let ignited = false;
  let wave = null;        // { x, y, age } a firing wave rippling along the logo
  let nextWave = IGNITE + 2.5;

  function frame() {
    const dt = Math.min(clock.getDelta(), 0.05);
    const t = reduceMotion ? IGNITE + 4 : clock.elapsedTime;

    // The logo faces the visitor, swaying gently and leaning towards the pointer.
    tiltX += (pointerY * 0.3 - tiltX) * 0.04;
    tiltY += (pointerX * 0.5 - tiltY) * 0.04;
    logo.rotation.set(-0.06 + tiltX, Math.sin(t * 0.3) * 0.3 + tiltY, Math.sin(t * 0.21) * 0.03);
    logo.position.y = baseY + Math.sin(t * 0.7) * 0.07;
    logo.updateMatrixWorld();
    stars.points.rotation.y = t * 0.004;

    if (!onScreen && !reduceMotion) {
      requestAnimationFrame(frame);
      return;
    }

    if (!ignited && t >= IGNITE) { ignited = true; focusHit(t, 1.4); }
    if (ignited && !reduceMotion && t - lastFocus > 3.4) focusHit(t, 0.6); // a heartbeat
    if (!reduceMotion && ignited && t > nextWave && nodes.length) {
      const node = Math.floor(Math.random() * nodes.length);
      wave = { x: nodes[node].v.x, y: nodes[node].v.y, age: 0 };
      fire(node, 1.3);
      nextWave = t + rand(3.5, 6);
    }
    if (wave) {
      wave.age += dt;
      if (wave.age > 1.6) wave = null;
    }
    const waveRadius = wave ? wave.age * 1.4 : 0;
    const waveStrength = wave ? (1 - wave.age / 1.6) ** 1.5 : 0;
    // Attention scan: a diagonal band of light crosses the logo every few seconds.
    const scanAge = (t - IGNITE - 1) % SCAN_PERIOD;
    const scanning = !reduceMotion && t > IGNITE + 1 && scanAge < 1.8;
    const scanPos = -1.6 + (scanAge / 1.8) * 3.2;
    const local = reduceMotion ? null : pointerOnLogo();
    burst *= Math.exp(-dt * 2.2);
    focusFlash *= Math.exp(-dt * 2.6);
    const igniteGlow = ignited && !reduceMotion ? Math.exp(-(t - IGNITE) * 1.6) : 0;
    const shimmer = (t * 0.18) % 1.4 - 0.2;   // a slow band of light along the strokes

    for (let i = 0; i < COUNT; i++) {
      const o = i * 3;
      const tx = target[o];
      const ty = target[o + 1];
      const tz = target[o + 2];
      const progress = reduceMotion ? 1 : ease(clamp((t - delay[i]) / (kind[i] === 0 ? 0.55 : 0.9), 0, 1));
      let ox = 0;
      let oy = 0;
      let oz = 0;
      let light = 0.7 + 0.45 * progress;
      let tint = 0;
      if (local) {
        const dx = tx - local.x;
        const dy = ty - local.y;
        const d = Math.hypot(dx, dy);
        if (d < REPEL && d > 0.0001) {
          const near = (1 - d / REPEL) ** 2;
          const push = near * 0.2;
          ox = (dx / d) * push;
          oy = (dy / d) * push;
          oz = push * 0.8;
          light += near * 0.9;
          tint += near * 0.4;
        }
      }
      if (burst > 0.01) {
        const dx = tx - DOT.center[0];
        const dy = ty - DOT.center[1];
        const d = Math.hypot(dx, dy) || 1;
        const front = Math.exp(-((d - (1 - burst) * 2.4) ** 2) / 0.08) * burst;
        ox += (dx / d) * front * 0.18;
        oy += (dy / d) * front * 0.18;
        oz += front * 0.18;
        light += front * 0.8;
      }
      offset[o] += (ox - offset[o]) * 0.12;
      offset[o + 1] += (oy - offset[o + 1]) * 0.12;
      offset[o + 2] += (oz - offset[o + 2]) * 0.12;
      fibres.positions[o] = start[o] + (tx - start[o]) * progress + offset[o];
      fibres.positions[o + 1] = start[o + 1] + (ty - start[o + 1]) * progress + offset[o + 1];
      fibres.positions[o + 2] = start[o + 2] + (tz - start[o + 2]) * progress + offset[o + 2];

      if (kind[i] === 3) {
        light += focusFlash * 0.9 + igniteGlow;
      } else {
        const strength = kind[i] === 0 ? 0.4 + 0.6 * core[i] : 0.35;
        light += Math.exp(-((arc[i] - shimmer) ** 2) / 0.004) * 0.7 * strength + igniteGlow * 0.6;
        if (scanning) {
          const band = Math.exp(-((tx * 0.7 + ty * 0.7 - scanPos) ** 2) / 0.006);
          light += band * 1.1 * strength;
          tint += band * 0.5;
        }
        if (wave) {
          const front = Math.exp(-((Math.hypot(tx - wave.x, ty - wave.y) - waveRadius) ** 2) / 0.01) * waveStrength;
          light += front * 1.1 * strength;
          tint += front * 0.35;
        }
      }
      tint = Math.min(1, tint);
      fibres.colors[o] = Math.min(1, (base[o] + (COLORS.ice.r - base[o]) * tint) * light);
      fibres.colors[o + 1] = Math.min(1, (base[o + 1] + (COLORS.ice.g - base[o + 1]) * tint) * light);
      fibres.colors[o + 2] = Math.min(1, (base[o + 2] + (COLORS.ice.b - base[o + 2]) * tint) * light);
    }
    fibres.geometry.attributes.position.needsUpdate = true;
    fibres.geometry.attributes.color.needsUpdate = true;

    // Synapses near the pointer, under the scan or on the wave front fire now and then.
    if (!reduceMotion && ignited) {
      nodes.forEach((node, i) => {
        const v = node.v;
        if (local && Math.hypot(v.x - local.x, v.y - local.y) < REPEL && Math.random() < dt * 2) fire(i, 0.9);
        if (scanning && Math.abs(v.x * 0.7 + v.y * 0.7 - scanPos) < 0.06 && Math.random() < dt * 8) fire(i, 0.85);
        if (wave && Math.abs(Math.hypot(v.x - wave.x, v.y - wave.y) - waveRadius) < 0.07 && Math.random() < dt * 12) fire(i, 0.9);
      });
    }

    const fadeIn = reduceMotion ? 1 : ease(clamp((t - 1.2) / 1.5, 0, 1));
    fadeMaterials.forEach(({ material, to }) => { material.opacity = to * fadeIn; });

    // The focus dot glows tightly and breathes; it flares when a signal arrives.
    const dotOn = reduceMotion ? 1 : ease(clamp((t - FOCUS_AT) / 0.5, 0, 1));
    focusGlow.material.opacity = dotOn * (0.18 + 0.35 * focusFlash);
    focusGlow.scale.setScalar(0.24 + 0.1 * focusFlash + Math.sin(t * 2.2) * 0.01);

    if (!reduceMotion) {
      updatePens(t);
      if (t > FOCUS_AT) updateSignals(dt, t);
    }
    updateSynapses(reduceMotion ? 0 : dt);
    renderer.render(scene, camera);
    if (!reduceMotion) requestAnimationFrame(frame);
  }

  function resize() {
    const { width, height } = canvasSize();
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
    placeLogo();
    if (reduceMotion) frame();
  }
  window.addEventListener("resize", resize);
  if ("ResizeObserver" in window) new ResizeObserver(resize).observe(canvas);

  // Skip drawing while the canvas is scrolled out of view.
  let onScreen = true;
  if ("IntersectionObserver" in window) {
    new IntersectionObserver(([entry]) => { onScreen = entry.isIntersecting; }).observe(canvas);
  }

  frame();
})();
