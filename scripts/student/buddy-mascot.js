// NeuroBuddy's mascot: an original little floating robot with a visor face, glowing eyes, an
// antenna and a waving arm. Colours follow the theme and accent (styles/student.css, .bot-*).
// It floats, blinks and waves (not with reduced motion), its eyes follow the pointer, and a
// press makes it smile and wave. The head on its own is the NeuroBuddy icon (#i-buddy).

const SVG = `
<svg class="bot" viewBox="0 0 200 230" aria-hidden="true" focusable="false">
  <defs>
    <radialGradient id="nbBotShine" cx="34%" cy="22%" r="85%">
      <stop offset="0" style="stop-color: var(--bot-hi)"/>
      <stop offset="1" style="stop-color: var(--bot-body)"/>
    </radialGradient>
  </defs>
  <ellipse class="bot-shadow" cx="100" cy="218" rx="46" ry="7"/>
  <g class="bot-float">
    <path class="bot-line" d="M100 40V22"/>
    <circle class="bot-antenna" cx="100" cy="16" r="7"/>
    <ellipse class="bot-part" cx="50" cy="152" rx="13" ry="25" transform="rotate(18 50 152)"/>
    <g class="bot-wave"><ellipse class="bot-part" cx="158" cy="112" rx="13" ry="26" transform="rotate(-30 158 112)"/></g>
    <path class="bot-part" d="M100 104C141 104 157 136 155 168C153 197 128 208 100 208C72 208 47 197 45 168C43 136 59 104 100 104Z"/>
    <circle class="bot-badge" cx="100" cy="160" r="13"/>
    <path class="bot-spark" d="M100 151.5l2.4 6.1 6.1 2.4-6.1 2.4-2.4 6.1-2.4-6.1-6.1-2.4 6.1-2.4Z"/>
    <rect class="bot-part" x="44" y="36" width="112" height="84" rx="42"/>
    <rect class="bot-visor" x="60" y="54" width="80" height="46" rx="23"/>
    <g class="bot-eyes">
      <rect class="bot-eye" x="78" y="68" width="12" height="18" rx="6"/>
      <rect class="bot-eye" x="110" y="68" width="12" height="18" rx="6"/>
      <path class="bot-happy" d="M78 81q6-9 12 0M110 81q6-9 12 0"/>
    </g>
    <ellipse class="bot-cheek" cx="62" cy="106" rx="7" ry="4"/>
    <ellipse class="bot-cheek" cx="138" cy="106" rx="7" ry="4"/>
  </g>
</svg>`;

// Each mascot gets its own gradient id: with two on a page (NeuroBuddy and Classes), a shared id
// would point at the hidden one's gradient and leave this one unfilled.
let count = 0;

export function createMascot() {
  const wrap = document.createElement("button");
  wrap.type = "button";
  wrap.className = "buddy-mascot";
  wrap.setAttribute("aria-label", "NeuroBuddy waves hello");
  count += 1;
  wrap.innerHTML = SVG.replaceAll("nbBotShine", `nbBotShine${count}`);
  wrap.querySelectorAll(".bot-part").forEach((part) => part.setAttribute("fill", `url(#nbBotShine${count})`));
  let timer = 0;
  wrap.addEventListener("click", () => {
    wrap.classList.remove("is-happy");
    void wrap.offsetWidth;
    wrap.classList.add("is-happy");
    window.clearTimeout(timer);
    timer = window.setTimeout(() => wrap.classList.remove("is-happy"), 1600);
  });
  return wrap;
}

// Eyes look toward the pointer while it moves over `area` (a few pixels at most).
export function followPointer(mascot, area) {
  const eyes = () => mascot.querySelector(".bot-eyes");
  let last = 0;
  const onMove = (event) => {
    const now = performance.now();
    if (now - last < 30 || !mascot.isConnected) return; // about 30 updates a second is plenty
    last = now;
    const box = mascot.getBoundingClientRect();
    const dx = event.clientX - (box.left + box.width / 2);
    const dy = event.clientY - (box.top + box.height * 0.33);
    const distance = Math.hypot(dx, dy) || 1;
    const reach = Math.min(1, distance / 260);
    eyes()?.style.setProperty("--look-x", `${((dx / distance) * 5 * reach).toFixed(2)}px`);
    eyes()?.style.setProperty("--look-y", `${((dy / distance) * 4 * reach).toFixed(2)}px`);
  };
  const onLeave = () => {
    eyes()?.style.setProperty("--look-x", "0px");
    eyes()?.style.setProperty("--look-y", "0px");
  };
  area.addEventListener("pointermove", onMove);
  area.addEventListener("pointerleave", onLeave);
  return () => { area.removeEventListener("pointermove", onMove); area.removeEventListener("pointerleave", onLeave); };
}
