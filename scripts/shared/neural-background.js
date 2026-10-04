// Animated "neural brain" background for the home and login pages (Three.js r128).
// A point-cloud brain with a folded cortex, a network of neurons firing signals across
// its surface, and signal comets orbiting around it. Renders a still frame when the
// visitor prefers reduced motion.
//
// Placement: by default the brain sits between a page's text and its sign-in card.
// If the page has an element with [data-brain-anchor], the brain is centred on that
// element and sized to fit it. The canvas can be fixed (full window) or placed inside a
// section; the scene always matches the canvas's own size.
(function neuralBackground() {
  const canvas = document.querySelector("#bg");
  if (!canvas || !window.THREE) return;

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const COLORS = {
    cyan: new THREE.Color(0x00d9ff),
    ice: new THREE.Color(0xa8f7ff),
    green: new THREE.Color(0x22c55e),
    sulcus: new THREE.Color(0x1673e0),
    gyrus: new THREE.Color(0xaaf8ff)
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

  function pointCloud(count, material) {
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    return { points: new THREE.Points(geometry, material), positions, colors, geometry };
  }

  // ---------- Brain shape ----------
  // Ridge value of the cortical folds: positive on gyri, negative in sulci.
  function fold(x, y, z) {
    return Math.sin(9.5 * z + 3.2 * Math.sin(4.1 * y) + 2.1 * x) * Math.cos(7.3 * y - 2.6 * Math.sin(3.7 * z))
      + 0.55 * Math.sin(15.1 * x * y + 12.7 * z + 1.3);
  }

  function cerebrumPoint() {
    for (;;) {
      const [dx, dy, dz] = randomDirection();
      const side = Math.random() < 0.5 ? -1 : 1;
      const lateral = dx * side; // > 0 on the outer face of the hemisphere
      if (lateral < -0.2 && Math.random() < 0.6) continue; // fewer points on the inner wall
      const ridge = clamp(fold(lateral, dy, dz) / 1.55, -1, 1);
      // Sulci get far fewer points, so the folds read as dark grooves.
      if (Math.random() > 0.25 + 0.75 * ((ridge + 1) / 2) ** 1.6) continue;
      const bump = 1 + 0.035 * ridge;
      let x = side * 0.5 + dx * (lateral >= 0 ? 0.5 : 0.44);
      let y = dy * (dy >= 0 ? 0.8 : 0.52);
      const z = dz * 1.18;
      // Temporal lobe bulge on the lower side.
      const temporal = Math.exp(-((dy + 0.55) ** 2) / 0.06 - ((dz - 0.1) ** 2) / 0.22) * Math.max(0, lateral);
      x += side * 0.1 * temporal;
      y -= 0.08 * temporal;
      if (dz > 0.4) y -= 0.05 * (dz - 0.4);
      return { x: x * bump, y: y * bump, z: z * bump, glow: (ridge + 1) / 2 };
    }
  }

  function cerebellumPoint() {
    for (;;) {
      const [dx, dy, dz] = randomDirection();
      const x = dx * 0.62;
      const y = -0.52 + dy * 0.3;
      const z = -0.78 + dz * 0.42;
      if (z > -0.45 && y > -0.45) continue; // tucked under the cerebrum
      const stripe = Math.sin(dy * 34 + dz * 6);
      if (Math.random() > 0.35 + 0.65 * Math.max(0, stripe)) continue;
      return { x, y, z, glow: 0.35 + 0.4 * Math.max(0, stripe) };
    }
  }

  function stemPoint() {
    const angle = Math.random() * Math.PI * 2;
    const t = Math.random();
    return { x: Math.cos(angle) * 0.15 * (1 - t * 0.3), y: -0.42 - t * 0.75, z: -0.3 + Math.sin(angle) * 0.15 - t * 0.12, glow: 0.35 };
  }

  const brain = new THREE.Group();
  scene.add(brain);

  // ---------- Cortex point cloud (assembles on load) ----------
  const SURFACE = 4200;
  const surface = pointCloud(SURFACE, glowMaterial(0.06, 1));
  const target = new Float32Array(SURFACE * 3);
  const start = new Float32Array(SURFACE * 3);
  const delay = new Float32Array(SURFACE);
  const shade = new THREE.Color();
  for (let i = 0; i < SURFACE; i++) {
    const roll = i / SURFACE;
    const point = roll < 0.88 ? cerebrumPoint() : roll < 0.96 ? cerebellumPoint() : stemPoint();
    target.set([point.x, point.y, point.z], i * 3);
    const [sx, sy, sz] = randomDirection();
    const spread = rand(4, 8);
    start.set([sx * spread, sy * spread, sz * spread], i * 3);
    delay[i] = Math.random() * 0.9;
    shade.copy(COLORS.sulcus).lerp(COLORS.gyrus, point.glow).multiplyScalar(rand(0.7, 1.15));
    surface.colors.set([shade.r, shade.g, shade.b], i * 3);
  }
  surface.positions.set(reduceMotion ? target : start);
  brain.add(surface.points);

  // ---------- Neuron network on the surface ----------
  const NEURONS = 120;
  const neurons = [];
  for (let i = 0; i < NEURONS; i++) {
    const point = cerebrumPoint();
    neurons.push(new THREE.Vector3(point.x, point.y, point.z).multiplyScalar(1.06));
  }
  const edges = [];
  const adjacency = neurons.map(() => []);
  const linked = new Set();
  neurons.forEach((neuron, i) => {
    neurons
      .map((other, j) => ({ j, distance: i === j ? Infinity : neuron.distanceTo(other) }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 3)
      .forEach(({ j, distance }) => {
        const key = i < j ? `${i}-${j}` : `${j}-${i}`;
        if (distance > 0.8 || linked.has(key)) return;
        linked.add(key);
        adjacency[i].push(edges.length);
        adjacency[j].push(edges.length);
        edges.push([i, j]);
      });
  });

  const edgePositions = new Float32Array(edges.length * 6);
  const edgeColors = new Float32Array(edges.length * 6);
  edges.forEach(([a, b], e) => {
    edgePositions.set([neurons[a].x, neurons[a].y, neurons[a].z, neurons[b].x, neurons[b].y, neurons[b].z], e * 6);
  });
  const edgeGeometry = new THREE.BufferGeometry();
  edgeGeometry.setAttribute("position", new THREE.BufferAttribute(edgePositions, 3));
  edgeGeometry.setAttribute("color", new THREE.BufferAttribute(edgeColors, 3));
  const edgeMaterial = new THREE.LineBasicMaterial({
    vertexColors: true, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending
  });
  brain.add(new THREE.LineSegments(edgeGeometry, edgeMaterial));
  const edgeGlow = new Float32Array(edges.length);

  const nodes = pointCloud(NEURONS, glowMaterial(0.1, 0));
  neurons.forEach((neuron, i) => nodes.positions.set([neuron.x, neuron.y, neuron.z], i * 3));
  brain.add(nodes.points);
  const nodeFlash = new Float32Array(NEURONS);

  // ---------- Signals travelling neuron to neuron ----------
  const PULSES = 48;
  const TRAIL = 5;
  const pulseCloud = pointCloud(PULSES * TRAIL, glowMaterial(0.14, 0));
  brain.add(pulseCloud.points);
  const pulses = [];

  function launch(pulse, fromNode) {
    const options = fromNode === undefined ? null : adjacency[fromNode];
    const edgeIndex = options && options.length && Math.random() < 0.85
      ? options[Math.floor(Math.random() * options.length)]
      : Math.floor(Math.random() * edges.length);
    const [a, b] = edges[edgeIndex];
    const forward = fromNode === undefined ? Math.random() < 0.5 : a === fromNode;
    Object.assign(pulse, {
      edge: edgeIndex, from: forward ? a : b, to: forward ? b : a, t: 0,
      speed: rand(0.9, 1.8), color: Math.random() < 0.18 ? COLORS.green : COLORS.ice
    });
  }
  for (let i = 0; i < PULSES; i++) {
    const pulse = {};
    launch(pulse);
    pulse.t = Math.random();
    pulses.push(pulse);
  }

  function updateSignals(dt) {
    pulses.forEach((pulse, i) => {
      pulse.t += dt * pulse.speed;
      if (pulse.t >= 1) {
        nodeFlash[pulse.to] = 1;
        launch(pulse, Math.random() < 0.85 ? pulse.to : undefined); // chain reaction
      }
      edgeGlow[pulse.edge] = Math.max(edgeGlow[pulse.edge], 0.6);
      const from = neurons[pulse.from];
      const to = neurons[pulse.to];
      for (let k = 0; k < TRAIL; k++) {
        const along = Math.max(0, pulse.t - k * 0.045);
        const offset = (i * TRAIL + k) * 3;
        pulseCloud.positions[offset] = from.x + (to.x - from.x) * along;
        pulseCloud.positions[offset + 1] = from.y + (to.y - from.y) * along;
        pulseCloud.positions[offset + 2] = from.z + (to.z - from.z) * along;
        const fade = (1 - k / TRAIL) ** 2;
        pulseCloud.colors[offset] = pulse.color.r * fade;
        pulseCloud.colors[offset + 1] = pulse.color.g * fade;
        pulseCloud.colors[offset + 2] = pulse.color.b * fade;
      }
    });
    pulseCloud.geometry.attributes.position.needsUpdate = true;
    pulseCloud.geometry.attributes.color.needsUpdate = true;

    const edgeDecay = Math.exp(-dt * 2.8);
    edges.forEach((_, e) => {
      edgeGlow[e] *= edgeDecay;
      const glow = edgeGlow[e];
      for (let end = 0; end < 2; end++) {
        const offset = e * 6 + end * 3;
        edgeColors[offset] = COLORS.cyan.r * 0.3 + COLORS.ice.r * 0.7 * glow;
        edgeColors[offset + 1] = COLORS.cyan.g * 0.3 + COLORS.ice.g * 0.7 * glow;
        edgeColors[offset + 2] = COLORS.cyan.b * 0.3 + COLORS.ice.b * 0.7 * glow;
      }
    });
    edgeGeometry.attributes.color.needsUpdate = true;

    const flashDecay = Math.exp(-dt * 2.5);
    for (let i = 0; i < NEURONS; i++) {
      if (Math.random() < dt * 0.05) nodeFlash[i] = 1; // spontaneous firing
      nodeFlash[i] *= flashDecay;
      const offset = i * 3;
      nodes.colors[offset] = COLORS.cyan.r * 0.45 + COLORS.ice.r * nodeFlash[i];
      nodes.colors[offset + 1] = COLORS.cyan.g * 0.45 + COLORS.ice.g * nodeFlash[i];
      nodes.colors[offset + 2] = COLORS.cyan.b * 0.45 + COLORS.ice.b * nodeFlash[i];
    }
    nodes.geometry.attributes.color.needsUpdate = true;
  }

  // ---------- Signal comets orbiting the brain ----------
  const COMET_TRAIL = 40;
  const orbits = [
    { rx: 1.95, rz: 1.35, tilt: [0.35, 0, 0.5], speed: 0.32, color: COLORS.cyan, comets: 2 },
    { rx: 2.15, rz: 1.55, tilt: [-0.55, 0.3, -0.35], speed: -0.24, color: COLORS.ice, comets: 2 },
    { rx: 1.7, rz: 1.75, tilt: [1.25, 0.2, 0.1], speed: 0.4, color: COLORS.green, comets: 1 }
  ].map((orbit) => {
    const pivot = new THREE.Group();
    pivot.rotation.set(...orbit.tilt);
    brain.add(pivot);
    const RING = 220;
    const ring = pointCloud(RING, glowMaterial(0.035, 0));
    for (let i = 0; i < RING; i++) {
      const angle = (i / RING) * Math.PI * 2;
      ring.positions.set([Math.cos(angle) * orbit.rx, 0, Math.sin(angle) * orbit.rz], i * 3);
      ring.colors.set([orbit.color.r * 0.45, orbit.color.g * 0.45, orbit.color.b * 0.45], i * 3);
    }
    const comets = pointCloud(orbit.comets * COMET_TRAIL, glowMaterial(0.13, 0));
    pivot.add(ring.points, comets.points);
    return { ...orbit, ring, comets, phase: Math.random() * Math.PI * 2 };
  });

  function updateOrbits(t) {
    orbits.forEach((orbit) => {
      for (let c = 0; c < orbit.comets; c++) {
        const head = orbit.phase + t * orbit.speed + (c * Math.PI * 2) / orbit.comets;
        for (let k = 0; k < COMET_TRAIL; k++) {
          const angle = head - Math.sign(orbit.speed) * k * 0.028;
          const offset = (c * COMET_TRAIL + k) * 3;
          orbit.comets.positions[offset] = Math.cos(angle) * orbit.rx;
          orbit.comets.positions[offset + 1] = 0;
          orbit.comets.positions[offset + 2] = Math.sin(angle) * orbit.rz;
          const fade = (1 - k / COMET_TRAIL) ** 1.6;
          orbit.comets.colors[offset] = orbit.color.r * fade;
          orbit.comets.colors[offset + 1] = orbit.color.g * fade;
          orbit.comets.colors[offset + 2] = orbit.color.b * fade;
        }
      }
      orbit.comets.geometry.attributes.position.needsUpdate = true;
      orbit.comets.geometry.attributes.color.needsUpdate = true;
    });
  }

  // ---------- Soft holographic glow behind the brain ----------
  const aura = new THREE.Sprite(new THREE.SpriteMaterial({
    map: sprite, color: COLORS.cyan, transparent: true, opacity: 0,
    depthWrite: false, blending: THREE.AdditiveBlending
  }));
  aura.scale.set(4.2, 3.4, 1);
  aura.position.set(0, -0.05, -0.6);
  brain.add(aura);

  // ---------- Floating dust and distant stars ----------
  const dust = pointCloud(320, glowMaterial(0.035, 0.55));
  for (let i = 0; i < 320; i++) {
    const [x, y, z] = randomDirection();
    const radius = rand(2.4, 4.2);
    dust.positions.set([x * radius, y * radius * 0.8, z * radius], i * 3);
    shade.copy(COLORS.cyan).multiplyScalar(rand(0.2, 0.6));
    dust.colors.set([shade.r, shade.g, shade.b], i * 3);
  }
  brain.add(dust.points);

  const stars = pointCloud(700, glowMaterial(0.03, 0.5));
  for (let i = 0; i < 700; i++) {
    stars.positions.set([rand(-12, 12), rand(-7, 7), rand(-8, 2)], i * 3);
    shade.copy(COLORS.cyan).multiplyScalar(rand(0.15, 0.5));
    stars.colors.set([shade.r, shade.g, shade.b], i * 3);
  }
  scene.add(stars.points);

  // ---------- Layout, pointer and animation ----------
  // Screen position (fraction of the window) -> world position on the z = 0 plane.
  function screenToWorld(fx, fy) {
    const halfHeight = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.position.z;
    return { x: (fx * 2 - 1) * halfHeight * camera.aspect, y: (1 - fy * 2) * halfHeight + camera.position.y };
  }

  let baseY = 0;
  function placeBrain() {
    const { width, height } = canvasSize();
    const anchor = document.querySelector("[data-brain-anchor]");
    if (anchor) {
      const box = canvas.getBoundingClientRect();
      const area = anchor.getBoundingClientRect();
      const spot = screenToWorld((area.left + area.width / 2 - box.left) / box.width, (area.top + area.height / 2 - box.top) / box.height);
      const worldPerPixel = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.position.z) / height;
      baseY = spot.y;
      brain.position.set(spot.x, baseY, 0);
      brain.scale.setScalar(clamp((Math.min(area.width, area.height) * worldPerPixel) / 3.4, 0.7, 1.8));
      return;
    }
    const compact = width < 900;
    // Wide screens: in the gap between the hero text and the sign-in card.
    // Narrow screens: lower right, behind the stacked content.
    const spot = compact ? screenToWorld(0.72, 0.62) : screenToWorld(0.535, Math.min(0.36, 330 / height));
    baseY = spot.y;
    brain.position.set(spot.x, baseY, compact ? -1 : 0);
    brain.scale.setScalar(compact ? 1 : 1.4);
  }
  placeBrain();

  let pointerX = 0;
  let pointerY = 0;
  let tiltX = 0;
  let tiltY = 0;
  window.addEventListener("pointermove", (event) => {
    pointerX = event.clientX / window.innerWidth - 0.5;
    pointerY = event.clientY / window.innerHeight - 0.5;
  }, { passive: true });

  const fadeMaterials = [
    { material: edgeMaterial, to: 0.9 },
    { material: nodes.points.material, to: 1 },
    { material: pulseCloud.points.material, to: 1 },
    { material: aura.material, to: 0.13 },
    ...orbits.flatMap((orbit) => [
      { material: orbit.ring.points.material, to: 0.8 },
      { material: orbit.comets.points.material, to: 1 }
    ])
  ];

  const clock = new THREE.Clock();
  let assembled = reduceMotion;

  function frame() {
    const dt = Math.min(clock.getDelta(), 0.05);
    const t = clock.elapsedTime;

    if (!assembled) {
      for (let i = 0; i < SURFACE; i++) {
        const progress = ease(clamp((t - 0.2 - delay[i]) / 1.6, 0, 1));
        for (let axis = 0; axis < 3; axis++) {
          const offset = i * 3 + axis;
          surface.positions[offset] = start[offset] + (target[offset] - start[offset]) * progress;
        }
      }
      surface.geometry.attributes.position.needsUpdate = true;
      if (t > 2.8) assembled = true;
    }

    const fadeIn = reduceMotion ? 1 : ease(clamp((t - 1) / 1.6, 0, 1));
    fadeMaterials.forEach(({ material, to }) => { material.opacity = to * fadeIn; });

    tiltX += (pointerY * 0.25 - tiltX) * 0.04;
    tiltY += (pointerX * 0.4 - tiltY) * 0.04;
    brain.rotation.set(-0.12 + tiltX, -0.7 + t * 0.1 + tiltY, -0.06);
    brain.position.y = baseY + Math.sin(t * 0.7) * 0.08;
    dust.points.rotation.y = -t * 0.03;
    stars.points.rotation.y = t * 0.004;

    if (!onScreen && !reduceMotion) {
      requestAnimationFrame(frame);
      return;
    }
    updateSignals(reduceMotion ? 0 : dt);
    updateOrbits(t);
    renderer.render(scene, camera);
    if (!reduceMotion) requestAnimationFrame(frame);
  }

  function resize() {
    const { width, height } = canvasSize();
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
    placeBrain();
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
