const meetingStorageKey = "neuroFocusMeetingLinks";
// The attention log is kept per account, so on a shared computer one student can never
// export another's readings. (The old shared key is cleared.)
const sessionLogKey = () => `neuroFocusSessionLogs:${window.neuroFocus?.user?.id || "signed-out"}`;
try { localStorage.removeItem("neuroFocusSessionLogs"); } catch { /* storage unavailable */ }
const defaultMeetingLinks = { zoom: "", meet: "" };

// Capture live attention events and maintain a stored session log
let lastLoggedAt = 0;
window.addEventListener("neurofocus:attention-update", (event) => {
  const { timestamp, attentionScore, cumulativeFocus, state, gazeRatio } = event.detail;
  // The tracker reports ~8 times a second; one reading per second is enough for reports
  if (timestamp - lastLoggedAt < 1000) return;
  lastLoggedAt = timestamp;
  try {
    const existing = JSON.parse(localStorage.getItem(sessionLogKey()) || "[]");
    existing.push({
      timestamp: new Date(timestamp).toLocaleTimeString(),
      attentionScore: Math.round(attentionScore * 100),
      cumulativeFocus: `${cumulativeFocus}%`,
      state,
      gazeRatio: Number.isFinite(gazeRatio) ? gazeRatio.toFixed(3) : ""
    });
    // Keep the most recent 15 minutes of readings
    if (existing.length > 900) existing.splice(0, existing.length - 900);
    localStorage.setItem(sessionLogKey(), JSON.stringify(existing));
  } catch (err) {
    console.error("Failed to update attention session logs", err);
  }
});

function getMeetingLinks() {
  try {
    return { ...defaultMeetingLinks, ...JSON.parse(localStorage.getItem(meetingStorageKey) || "{}") };
  } catch {
    return { ...defaultMeetingLinks };
  }
}

function validMeetingUrl(provider, value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return false;
    return provider === "zoom"
      ? (url.hostname === "zoom.us" || url.hostname.endsWith(".zoom.us"))
      : (url.hostname === "meet.google.com" || url.hostname.endsWith(".meet.google.com"));
  } catch {
    return false;
  }
}

function configureMeeting(provider) {
  const label = provider === "zoom" ? "Zoom" : "Google Meet";
  const links = getMeetingLinks();
  const value = window.prompt(`Paste your ${label} meeting link (https://…)`, links[provider] || "");
  if (value === null) return false;
  const trimmed = value.trim();
  if (trimmed && !validMeetingUrl(provider, trimmed)) {
    window.alert(`Enter a valid ${label} meeting URL.`);
    return false;
  }
  links[provider] = trimmed;
  localStorage.setItem(meetingStorageKey, JSON.stringify(links));
  window.alert(trimmed ? `${label} link saved on this device.` : `${label} link cleared.`);
  return Boolean(trimmed);
}

document.querySelectorAll("[data-open]").forEach((button) => {
  button.addEventListener("click", () => {
    const provider = button.dataset.open;
    const links = getMeetingLinks();
    const url = links[provider];
    if (!url) {
      const saved = configureMeeting(provider);
      if (saved) {
        const savedUrl = getMeetingLinks()[provider];
        if (validMeetingUrl(provider, savedUrl)) window.open(savedUrl, "_blank", "noopener,noreferrer");
        if (button.hasAttribute("data-start-camera")) window.dispatchEvent(new CustomEvent("neurofocus:start-camera"));
      }
      return;
    }
    if (!validMeetingUrl(provider, url)) {
      window.alert(`The saved ${provider === "zoom" ? "Zoom" : "Google Meet"} link is invalid. Please set it again.`);
      return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
    if (button.hasAttribute("data-start-camera")) {
      window.dispatchEvent(new CustomEvent("neurofocus:start-camera"));
    }
  });
});

document.querySelectorAll("[data-configure]").forEach((button) => {
  button.addEventListener("click", () => configureMeeting(button.dataset.configure));
});

// data-export-report="session" exports this device's attention log (student);
// data-export-report="roster" exports the live student table (teacher dashboard)
document.querySelectorAll("[data-export-report]").forEach((button) => {
  button.addEventListener("click", () => {
    let csv = "";
    const kind = button.dataset.exportReport;
    let sessionLogs = [];
    if (kind !== "roster") {
      try { sessionLogs = JSON.parse(localStorage.getItem(sessionLogKey()) || "[]"); } catch { sessionLogs = []; }
    }

    if (kind === "session" && !sessionLogs.length) {
      window.alert("No attention readings yet. Start attention tracking, then export your session.");
      return;
    }

    if (sessionLogs.length > 0) {
      const headers = ["Timestamp", "Instant Attention Score", "Cumulative Focus", "Engagement State", "Gaze Ratio"];
      const rows = sessionLogs.map((log) => [
        log.timestamp,
        log.attentionScore,
        log.cumulativeFocus,
        log.state,
        log.gazeRatio
      ]);
      csv = [headers, ...rows]
        .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
        .join("\r\n");
    } else {
      // Teacher snapshot of the live table. Simulator data is clearly marked as a demo.
      const demo = document.querySelector("#liveStudentRows")?.dataset.source === "sim";
      const rows = [...document.querySelectorAll("[data-roster-row]")].map((row) => [
        row.cells[0].textContent.replace(/^[A-Z]{2}\s*/, "").replace(/\s+/g, " ").trim(),
        row.cells[1].textContent.replace(/\s+/g, " ").trim(),
        row.cells[2].textContent.replace(/\s+/g, " ").trim(),
        demo ? "Simulated (demo, not a real student)" : "Live classroom"
      ]);
      if (!rows.length) {
        window.alert("Nothing to export yet. Open a class with students first.");
        return;
      }
      csv = [["Learner", "Attention Score", "Engagement Status", "Data source"], ...rows]
        .map((row) => row.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(","))
        .join("\r\n");
      if (demo) csv = `"DEMO DATA: generated by the simulator, not real attention readings"\r\n${csv}`;
      button.dataset.filePrefix = demo ? "DEMO-simulated" : "live-snapshot";
    }

    const file = new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(file);
    const download = document.createElement("a");
    download.href = url;
    download.download = `neurofocus-${button.dataset.filePrefix || "attention-report"}-${Date.now()}.csv`;
    download.click();
    URL.revokeObjectURL(url);
  });
});

document.querySelectorAll("[data-copy-prompt]").forEach((button) => {
  button.addEventListener("click", async () => {
    const original = button.textContent;
    try {
      await navigator.clipboard.writeText("Adaptive Hint: Notice your attention shifting. Take a brief breath, look toward your focal point, and continue.");
      button.textContent = "Adaptive Alert Copied";
      window.setTimeout(() => { button.textContent = original; }, 1800);
    } catch {
      button.textContent = "Copy unavailable";
      window.setTimeout(() => { button.textContent = original; }, 1800);
    }
  });
});
