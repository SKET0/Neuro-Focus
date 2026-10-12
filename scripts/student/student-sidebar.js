// Student sidebar: the "Your classes" list, built like the teacher dashboard's (teacher-classes.js):
// one colour per class, a live dot while the teacher's live session is on, and the open class
// marked. Class names and live sessions come from student-classes.js ("neurofocus:class-status").
import { classHue } from "../shared/class-colors.js?v=1";

const app = await window.neuroFocusReady;
const box = document.querySelector("#sidebarClasses");

if (app && box) {
  let status = window.neuroFocusClassStatus || { loaded: false, classes: [] };
  let lastKey = "";

  function render() {
    const openId = window.neuroFocusView === "class" ? window.neuroFocusRouteClassId : "";
    const classes = status.classes || [];
    const count = document.querySelector("#navClassCount");
    if (count) count.textContent = classes.length ? String(classes.length) : "";
    const key = JSON.stringify([status.loaded, openId, classes.map((c) => [c.id, c.name, c.live && !c.removed && !c.blocked])]);
    if (key === lastKey) return;
    lastKey = key;
    const focusedId = box.contains(document.activeElement) ? document.activeElement.dataset.classId : null;
    if (!status.loaded || !classes.length) {
      const empty = document.createElement("p");
      empty.className = "sidebar-empty";
      empty.textContent = status.loaded ? "No classes yet. Press + to join one." : "Loading…";
      box.replaceChildren(empty);
      return;
    }
    box.replaceChildren(...classes.map((item) => {
      const link = document.createElement("a");
      link.className = "nav-item sidebar-class";
      link.href = `#class/${item.id}`;
      link.dataset.classId = item.id;
      link.title = item.teacherName ? `${item.name} · ${item.teacherName}` : item.name;
      if (item.id === openId) link.setAttribute("aria-current", "page");
      const badge = document.createElement("span");
      badge.className = "cs-badge";
      badge.style.setProperty("--hue", String(classHue(item.id)));
      badge.setAttribute("aria-hidden", "true");
      badge.textContent = (item.name.trim()[0] || "C").toUpperCase();
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = item.name;
      link.append(badge, name);
      if (item.live && !item.removed && !item.blocked) {
        const dot = document.createElement("span");
        dot.className = "nav-live";
        dot.innerHTML = '<span class="live-dot"></span><span class="sr-only">, live now</span>';
        link.append(dot);
      }
      return link;
    }));
    if (focusedId) box.querySelector(`[data-class-id="${CSS.escape(focusedId)}"]`)?.focus();
  }

  window.addEventListener("neurofocus:class-status", (event) => { status = event.detail || status; render(); });
  window.addEventListener("neurofocus:viewchange", render);
  render();
}
