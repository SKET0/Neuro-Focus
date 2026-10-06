// Teacher Demo (#demoView): how the live monitor looks with a class, using eight sample students
// and generated readings. It is deliberately cut off from everything real:
//   - no database access at all (it never touches Supabase), so it can't create attendance,
//     history or class records;
//   - it sends no app events (nothing reaches teacher-classes.js, teacher-analytics.js or a
//     student), and it uses its own page, tables, chart and alerts;
//   - sample students are made up and marked "sample" everywhere;
//   - it only runs while the Demo page is open, and stops when the teacher leaves it.
// Readings follow the same meanings as real ones (scripts/shared/tracking-states.js), including
// "Tracking unavailable" and "On a break", which never count as a score of 0.
import { themeColor, withAlpha } from "../shared/appearance.js?v=1";
import { SCORE_BANDS, BAND_LABELS, scoreBand, REASONS } from "../shared/tracking-states.js?v=1";

const view = document.querySelector("#demoView");

if (view) {
  const $ = (selector) => view.querySelector(selector);
  const HISTORY = 30;
  const HEAT_COLUMNS = 20;
  const FLAG_AFTER = 2;
  // Sample students. Two show the tracking states: one sometimes can't be measured (no face in
  // view), one sometimes takes a break.
  const SAMPLES = [
    { name: "Ayesha (sample)" }, { name: "Hamza (sample)" }, { name: "Fatima (sample)" }, { name: "Usman (sample)", unavailable: true },
    { name: "Zainab (sample)" }, { name: "Bilal (sample)", breaks: true }, { name: "Hira (sample)" }, { name: "Saad (sample)" }
  ];

  let students = [];
  let history = [];
  let lowest = [];
  let labels = [];
  let tick = 0;
  let flags = 0;
  let timer = null;
  let chart = null;

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const clock = (readings) => {
    const seconds = Math.floor((readings * Number($("#demoSpeed").value)) / 1000);
    return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  };
  const stateFor = (score) => (score >= SCORE_BANDS.HIGH ? "Focused" : score >= SCORE_BANDS.MIDDLE ? "Drifting" : "Distracted");
  const initials = (name) => name.replace(/\(sample\)/, "").trim().slice(0, 2).toUpperCase();
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  function createStudents() {
    students = SAMPLES.map((sample) => {
      const baseline = 68 + Math.random() * 24;
      return { ...sample, baseline, value: baseline, score: baseline, status: "active", lapse: 0, offFor: 0, flagged: false, low: 0, heat: [] };
    });
  }

  // One generated reading per sample student.
  function step() {
    tick += 1;
    students.forEach((s) => {
      if (s.offFor > 0) {
        s.offFor -= 1;
      } else if (s.unavailable && Math.random() < 0.06) {
        s.offFor = 3 + Math.floor(Math.random() * 3);
        s.status = "unavailable";
      } else if (s.breaks && Math.random() < 0.04) {
        s.offFor = 4 + Math.floor(Math.random() * 3);
        s.status = "break";
      } else {
        s.status = "active";
      }
      if (s.offFor > 0 && s.status !== "active") {
        // No measurement: no score, and it never counts towards an alert.
        s.score = null;
        s.low = 0;
        s.flagged = false;
      } else {
        s.status = "active";
        if (s.lapse > 0) {
          s.lapse -= 1;
          s.value = clamp(s.value - 8 - Math.random() * 8, 15, 100);
        } else {
          if (Math.random() < 0.02) s.lapse = 2 + Math.floor(Math.random() * 3);
          s.value = clamp(s.value + (s.baseline - s.value) * 0.35 + (Math.random() - 0.5) * 8, 15, 100);
        }
        s.score = Math.round(s.value);
        s.low = s.score < SCORE_BANDS.MIDDLE ? s.low + 1 : 0;
        if (s.low === FLAG_AFTER) addAlert(s);
        if (s.score >= SCORE_BANDS.HIGH) s.flagged = false;
      }
      s.heat.push(s.score);
      if (s.heat.length > HEAT_COLUMNS) s.heat.shift();
    });
    const measured = students.filter((s) => s.score !== null).map((s) => s.score);
    history.push(measured.length ? measured.reduce((a, b) => a + b, 0) / measured.length : null);
    lowest.push(measured.length ? Math.min(...measured) : null);
    labels.push(clock(tick));
    if (history.length > HISTORY) { history.shift(); lowest.shift(); labels.shift(); }
    render();
  }

  function addAlert(s) {
    s.flagged = true;
    flags += 1;
    const list = $("#demoAlerts");
    list.querySelector(".empty-state")?.remove();
    const item = el("li");
    const body = el("div");
    body.append(el("strong", "", `${s.name} may need a check-in`), el("small", "", `Sample estimate ${s.score}% for ${FLAG_AFTER}+ readings · may be looking at notes`));
    item.append(el("span", "alert-dot"), body, el("time", "", clock(tick)));
    list.prepend(item);
    while (list.children.length > 6) list.lastElementChild.remove();
  }

  function render() {
    const measured = students.filter((s) => s.score !== null);
    const latest = [...history].reverse().find((v) => v !== null);
    $("#demoAverage").textContent = latest === undefined ? "—" : `${Math.round(latest)}%`;
    $("#demoAverageNote").textContent = !students.length ? "Press Start demo" : `${measured.length} of ${students.length} sample students measured`;
    const onScreen = measured.filter((s) => s.score >= SCORE_BANDS.HIGH).length;
    $("#demoFocused").textContent = measured.length ? `${onScreen}/${measured.length}` : "—";
    $("#demoFocusedNote").textContent = measured.length ? "Sample estimates of 70% or more" : " ";
    $("#demoFlags").textContent = String(flags);
    $("#demoTime").textContent = clock(tick);

    // Sample students table: rows are not part of the real roster and never exported.
    const rows = $("#demoRows");
    if (!students.length) {
      const row = el("tr");
      const cell = el("td", "empty-state", "Press Start demo to see sample students.");
      cell.colSpan = 3;
      row.append(cell);
      rows.replaceChildren(row);
    } else {
      rows.replaceChildren(...[...students].sort((a, b) => (a.score ?? 101) - (b.score ?? 101)).map((s) => {
        const row = el("tr");
        const measuredNow = s.score !== null;
        const state = measuredNow ? stateFor(s.score) : s.status === "break" ? "Break" : "Unavailable";
        const name = el("td");
        name.append(el("span", "mini-avatar demo-avatar", initials(s.name)), " ", el("span", "", s.name));
        const score = el("td");
        const bar = el("span", "score-bar");
        const fill = el("span");
        fill.style.width = measuredNow ? `${s.score}%` : "0%";
        fill.dataset.state = state;
        bar.append(fill);
        score.append(el("span", "score-value", measuredNow ? `${s.score}%` : "—"), bar);
        const status = el("td");
        const pill = el("span", "state-pill", measuredNow
          ? (s.flagged ? `${BAND_LABELS[scoreBand(s.score)]} · Check in?` : BAND_LABELS[scoreBand(s.score)])
          : s.status === "break" ? "On a break" : `Tracking unavailable · ${REASONS["no-face"]}`);
        pill.dataset.state = state;
        status.append(pill);
        row.append(name, score, status);
        return row;
      }));
    }

    const heat = $("#demoHeatmap");
    heat.replaceChildren();
    students.forEach((s) => {
      heat.append(el("div", "heat-label", s.name));
      const offset = HEAT_COLUMNS - s.heat.length;
      for (let i = 0; i < HEAT_COLUMNS; i += 1) {
        const cell = el("div", "heat-cell");
        const value = i >= offset ? s.heat[i - offset] : null;
        if (value !== null && value !== undefined) {
          cell.dataset.state = stateFor(value);
          cell.style.setProperty("--level", (0.25 + (value / 100) * 0.75).toFixed(2));
          cell.title = `${s.name}: ${value}% (sample estimate)`;
        }
        heat.append(cell);
      }
    });

    if (chart) {
      chart.data.labels = labels;
      chart.data.datasets[0].data = history;
      chart.data.datasets[1].data = lowest;
      chart.update("none");
    }
  }

  function setupChart() {
    if (!window.Chart || chart) return;
    chart = new window.Chart($("#demoChart"), {
      type: "line",
      data: {
        labels,
        datasets: [
          { label: "Sample class average", data: history, borderWidth: 2, tension: 0.35, pointRadius: 0, fill: true, spanGaps: false },
          { label: "Lowest sample student", data: lowest, borderWidth: 1.5, borderDash: [4, 4], tension: 0.35, pointRadius: 0, fill: false, spanGaps: false }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        interaction: { mode: "index", intersect: false },
        scales: {
          y: { min: 0, max: 100, ticks: { callback: (v) => `${v}%`, stepSize: 25 }, grid: {}, border: { display: false } },
          x: { ticks: { maxTicksLimit: 6 }, grid: { display: false }, border: {} }
        },
        plugins: {
          legend: { labels: { boxWidth: 10, boxHeight: 10, usePointStyle: true } },
          tooltip: { filter: (item) => item.parsed.y !== null, callbacks: { label: (ctx) => `${ctx.dataset.label}: ${Math.round(ctx.parsed.y)}%` } }
        }
      }
    });
    paint();
  }

  function paint() {
    if (!chart) return;
    const demo = themeColor("--amber", "#f5b748");
    const muted = themeColor("--text-muted");
    chart.data.datasets[0].borderColor = demo;
    chart.data.datasets[0].backgroundColor = withAlpha(demo, 0.12);
    chart.data.datasets[1].borderColor = themeColor("--text-soft", "#b4b4bc");
    chart.options.scales.y.ticks.color = muted;
    chart.options.scales.x.ticks.color = muted;
    chart.options.scales.y.grid.color = themeColor("--surface-hover", "#1c1c20");
    chart.options.scales.x.border.color = themeColor("--border", "#222226");
    chart.options.plugins.legend.labels.color = themeColor("--text-main", "#f4f4f5");
    chart.update("none");
  }

  function setRunning(running) {
    window.clearInterval(timer);
    timer = running ? window.setInterval(step, Number($("#demoSpeed").value)) : null;
    $("#demoToggle").textContent = running ? "Pause demo" : tick ? "Resume demo" : "Start demo";
    view.dataset.running = String(running);
  }

  function reset() {
    setRunning(false);
    students = [];
    history = [];
    lowest = [];
    labels = [];
    tick = 0;
    flags = 0;
    $("#demoAlerts").replaceChildren(el("li", "empty-state", "No sample alerts yet."));
    render();
  }

  $("#demoToggle").addEventListener("click", () => {
    setupChart();
    if (!students.length) createStudents();
    setRunning(!timer);
    if (timer && !tick) step();
  });
  $("#demoReset").addEventListener("click", reset);
  $("#demoSpeed").addEventListener("change", () => { if (timer) setRunning(true); });
  $("#demoLookAway").addEventListener("click", () => {
    if (!students.length) { setupChart(); createStudents(); }
    const candidates = students.filter((s) => s.lapse === 0 && s.status === "active");
    const target = candidates[Math.floor(Math.random() * candidates.length)] || students[0];
    target.lapse = 4;
    if (!timer) setRunning(true);
  });
  window.addEventListener("neurofocus:appearance-change", paint);
  // Only runs while the Demo page is open (teacher-classes.js shows and hides it).
  window.addEventListener("neurofocus:viewchange", (event) => {
    if (event.detail?.name === "demo") {
      setupChart();
      window.requestAnimationFrame(() => chart?.resize());
      view.classList.add("is-entering");
      window.setTimeout(() => view.classList.remove("is-entering"), 900);
    } else if (timer) {
      setRunning(false);
    }
  });
  render();
}
