// ⓘ buttons: short extra explanations that open on click, tap or keyboard (Enter/Space) and close
// with Escape, a second press, or a click elsewhere. Markup (static or added later):
//   <span class="info-wrap">
//     <button type="button" class="info-btn" data-info aria-label="More about …" aria-expanded="false" aria-controls="ID">i</button>
//     <span class="info-pop" id="ID" role="note" hidden>…</span>
//   </span>
// Essential instructions, errors, camera status and sharing notices are never put behind these.
(function infoPopovers() {
  let open = null; // the button whose explanation is showing

  function close({ focus = false } = {}) {
    if (!open) return;
    const pop = document.getElementById(open.getAttribute("aria-controls"));
    if (pop) pop.hidden = true;
    open.setAttribute("aria-expanded", "false");
    if (focus) open.focus();
    open = null;
  }

  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-info]");
    if (button) {
      event.preventDefault();
      const wasOpen = open === button;
      close();
      if (wasOpen) return;
      const pop = document.getElementById(button.getAttribute("aria-controls"));
      if (!pop) return;
      pop.hidden = false;
      button.setAttribute("aria-expanded", "true");
      open = button;
      return;
    }
    if (open && !event.target.closest(".info-pop")) close();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && open) {
      event.stopPropagation();
      close({ focus: true });
    }
  });
})();
