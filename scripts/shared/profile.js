// Profile settings, shared by the student workspace and the teacher dashboard: display name, profile
// picture (a built-in avatar or an uploaded photo cropped to a square), theme and accent colour.
// Saved to the signed-in account with update_my_profile() and the private "avatars" storage
// bucket (supabase/migrations/20261007000000_student_profiles.sql), so they follow the person to
// any device. Also keeps every avatar and name on the page up to date and runs the header's
// account menu. Each page provides window.neuroFocusNavigate and "neurofocus:viewchange" events.
import { AVATAR_PRESETS, avatarPreset, paintAvatar, avatarUrl, forgetAvatarUrl } from "./avatars.js?v=1";
import { applyAppearance, cacheAppearance, normalizeAppearance } from "./appearance.js?v=1";
import { notify } from "./class-live.js?v=9";

const app = await window.neuroFocusReady;

if (app) {
  const { supabase } = app;
  const $ = (selector) => document.querySelector(selector);
  const NAME_MAX = 40;
  const FILE_MAX_MB = 5;
  const FILE_TYPES = ["image/jpeg", "image/png", "image/webp"];
  const OUTPUT_SIZE = 512;
  const SETUP_TEXT = "Saving your profile needs a one-time database update: run supabase/migrations/20261007000000_student_profiles.sql in Supabase (see README).";
  const els = {
    form: $("#profileForm"), name: $("#displayNameInput"), nameError: $("#displayNameError"), count: $("#displayNameCount"),
    preview: $("#profileAvatarPreview"), caption: $("#avatarCaption"), options: $("#avatarOptions"),
    file: $("#avatarFile"), upload: $("#avatarUploadButton"), uploadLabel: $("#avatarUploadLabel"), remove: $("#avatarRemoveButton"),
    avatarError: $("#avatarError"), crop: $("#cropPanel"), stage: $("#cropStage"), canvas: $("#cropCanvas"), zoom: $("#cropZoom"),
    status: $("#profileStatus"), save: $("#profileSave"), cancel: $("#profileCancel"),
    actions: $("#profileActions"), announce: $("#profileAnnounce")
  };

  // ---------- What is saved on the account ----------
  const saved = {
    display_name: app.profile.display_name || "Student",
    avatar_preset: app.profile.avatar_preset || null,
    avatar_path: app.profile.avatar_path || null,
    ...normalizeAppearance(app.profile)
  };
  let savedUrl = null; // signed link to the saved picture
  const savedChoice = () => (saved.avatar_path ? "picture" : saved.avatar_preset || "initials");

  // Every avatar and name on the page (sidebar, header, account menu, Home).
  function paintEverywhere() {
    document.querySelectorAll("[data-profile-avatar]").forEach((el) => {
      paintAvatar(el, { name: saved.display_name, preset: saved.avatar_preset, url: savedUrl });
    });
    document.querySelectorAll("[data-profile-name]").forEach((el) => { el.textContent = saved.display_name; });
  }

  async function loadSavedPicture() {
    savedUrl = saved.avatar_path ? await avatarUrl(supabase, saved.avatar_path) : null;
    paintEverywhere();
    if (!pendingUpload) renderDraft();
  }

  // ---------- Account menu ----------
  const menuButton = $("#accountButton");
  const menu = $("#accountMenu");
  const menuItems = () => [...menu.querySelectorAll('[role="menuitem"]')];
  $("#accountMenuEmail").textContent = app.user.email || "";

  function openMenu(focus = "first") {
    menu.hidden = false;
    menuButton.setAttribute("aria-expanded", "true");
    const items = menuItems();
    (focus === "last" ? items[items.length - 1] : items[0])?.focus();
  }
  function closeMenu({ returnFocus = false } = {}) {
    if (menu.hidden) return;
    menu.hidden = true;
    menuButton.setAttribute("aria-expanded", "false");
    if (returnFocus) menuButton.focus();
  }
  menuButton.addEventListener("click", () => (menu.hidden ? openMenu() : closeMenu()));
  menuButton.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") { event.preventDefault(); openMenu("first"); }
    if (event.key === "ArrowUp") { event.preventDefault(); openMenu("last"); }
  });
  menu.addEventListener("keydown", (event) => {
    const items = menuItems();
    const index = items.indexOf(document.activeElement);
    const move = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: items.length - 1 }[event.key];
    if (move !== undefined) {
      event.preventDefault();
      items[(move + items.length) % items.length]?.focus();
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeMenu({ returnFocus: true });
    } else if (event.key === "Tab") closeMenu();
  });
  menu.addEventListener("click", (event) => {
    if (event.target.closest('[role="menuitem"]')) closeMenu();
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".account-menu")) closeMenu();
  });

  // ---------- Draft (unsaved edits) ----------
  // choice: "initials", a built-in avatar id, or "picture" (the saved picture, or a new upload).
  let draft = { choice: savedChoice(), theme: saved.theme, accent: saved.accent };
  let pendingUpload = null; // { img, width, height, zoom, cx, cy, previewUrl, objectUrl } until saved
  let saving = false;
  let nameTouched = false;

  const cleanName = (value) => String(value || "").trim().replace(/\s+/g, " ");
  function nameProblem(value) {
    const name = cleanName(value);
    const length = [...name].length;
    if (!name) return "Enter a display name. It can’t be empty.";
    if (length > NAME_MAX) return `Display names can be up to ${NAME_MAX} characters. This one has ${length}.`;
    if (/[\u0000-\u001f\u007f]/.test(name)) return "Display names can only contain letters, numbers, spaces and punctuation.";
    return "";
  }

  const isDirty = () => cleanName(els.name.value) !== saved.display_name
    || draft.choice !== savedChoice()
    || Boolean(draft.choice === "picture" && pendingUpload)
    || draft.theme !== saved.theme
    || draft.accent !== saved.accent;

  function setStatus(text, state = "") {
    els.status.textContent = text;
    els.status.dataset.state = state;
    syncBar();
  }

  // Save changes and Cancel only appear once something is changed (and while saving). A problem,
  // such as a failed save or the missing database update, keeps the bar showing its message.
  function syncBar() {
    if (!els.actions) return;
    const editing = saving || isDirty();
    const wasShown = !els.actions.hidden;
    els.save.hidden = !editing;
    els.cancel.hidden = !editing;
    els.actions.hidden = !editing && els.status.dataset.state !== "error";
    // Keep keyboard focus on the page when the bar it was in goes away.
    if (wasShown && els.actions.hidden && els.actions.contains(document.activeElement)) els.name.focus();
  }
  const announce = (text) => { if (els.announce) els.announce.textContent = text; };

  function updateButtons() {
    const dirty = isDirty();
    syncBar();
    els.save.disabled = saving || !dirty || app.profileSetupMissing;
    els.cancel.disabled = saving || !dirty;
    els.upload.disabled = saving || app.profileSetupMissing;
    els.remove.disabled = saving;
  }

  function showNameState({ force = false } = {}) {
    const length = [...cleanName(els.name.value)].length;
    els.count.textContent = `${length} / ${NAME_MAX}`;
    els.count.dataset.state = length > NAME_MAX ? "over" : "";
    const problem = nameProblem(els.name.value);
    const show = problem && (nameTouched || force);
    els.nameError.textContent = show ? problem : "";
    els.name.setAttribute("aria-invalid", String(Boolean(show)));
  }

  function draftAvatar() {
    const name = cleanName(els.name.value) || saved.display_name;
    if (draft.choice === "picture") return { name, url: pendingUpload ? pendingUpload.previewUrl : savedUrl };
    if (draft.choice === "initials") return { name };
    return { name, preset: draft.choice };
  }

  function renderDraft() {
    paintAvatar(els.preview, draftAvatar());
    els.caption.textContent = draft.choice === "picture"
      ? (pendingUpload ? "New picture (not saved yet)" : "Your picture")
      : draft.choice === "initials" ? "Your initials" : `${avatarPreset(draft.choice)?.label || "Built-in"} avatar`;
    renderAvatarOptions();
    const hasPicture = draft.choice === "picture";
    els.remove.hidden = !hasPicture;
    els.uploadLabel.textContent = saved.avatar_path || pendingUpload ? "Upload a different picture" : "Upload a picture";
    els.crop.hidden = !(hasPicture && pendingUpload);
    els.form.querySelectorAll('input[name="theme"]').forEach((input) => { input.checked = input.value === draft.theme; });
    els.form.querySelectorAll('input[name="accent"]').forEach((input) => { input.checked = input.value === draft.accent; });
    showNameState();
    updateButtons();
  }

  // Built-in avatars, the student's initials and (if there is one) their picture, as one radio group.
  let optionsKey = "";
  function renderAvatarOptions() {
    const showPicture = Boolean(saved.avatar_path || pendingUpload);
    const key = `${showPicture}`;
    if (key !== optionsKey) {
      optionsKey = key;
      const choices = [
        ...(showPicture ? [{ value: "picture", label: "Your picture" }] : []),
        { value: "initials", label: "Initials" },
        ...AVATAR_PRESETS.map((preset) => ({ value: preset.id, label: preset.label }))
      ];
      els.options.replaceChildren(...choices.map(({ value, label }) => {
        const option = document.createElement("label");
        option.className = "avatar-option";
        const input = document.createElement("input");
        input.type = "radio";
        input.name = "avatar";
        input.value = value;
        const face = document.createElement("span");
        face.className = "nf-avatar";
        face.dataset.option = value;
        const text = document.createElement("span");
        text.className = "label";
        text.textContent = label;
        option.append(input, face, text);
        return option;
      }));
    }
    const name = cleanName(els.name.value) || saved.display_name;
    els.options.querySelectorAll("input").forEach((input) => {
      input.checked = input.value === draft.choice;
      const face = input.nextElementSibling;
      if (input.value === "picture") paintAvatar(face, { name, url: pendingUpload ? pendingUpload.previewUrl : savedUrl });
      else if (input.value === "initials") paintAvatar(face, { name });
      else if (face.dataset.kind !== "preset") paintAvatar(face, { name, preset: input.value });
    });
  }

  // Back to what is saved (on load, Cancel and after saving).
  function resetDraft() {
    discardUpload();
    draft = { choice: savedChoice(), theme: saved.theme, accent: saved.accent };
    els.name.value = saved.display_name;
    nameTouched = false;
    els.avatarError.textContent = "";
    renderDraft();
  }

  // ---------- Editing ----------
  els.name.addEventListener("input", () => {
    renderDraft();
    if (isDirty()) setStatus("You have unsaved changes.", "dirty");
  });
  els.name.addEventListener("blur", () => {
    nameTouched = true;
    showNameState();
  });
  els.options.addEventListener("change", (event) => {
    if (event.target.name !== "avatar") return;
    draft.choice = event.target.value;
    els.avatarError.textContent = "";
    renderDraft();
    setStatus(isDirty() ? "You have unsaved changes." : "", isDirty() ? "dirty" : "");
  });
  // Theme and accent preview straight away on the whole page; they're kept only when saved.
  els.form.addEventListener("change", (event) => {
    if (event.target.name !== "theme" && event.target.name !== "accent") return;
    draft[event.target.name] = event.target.value;
    applyAppearance(draft, { animate: true });
    updateButtons();
    setStatus(isDirty() ? "Previewing your new look. Press Save changes to keep it, or Cancel to go back." : "", isDirty() ? "dirty" : "");
  });

  // ---------- Uploading and cropping a picture ----------
  els.upload.addEventListener("click", () => els.file.click());
  els.file.addEventListener("change", async () => {
    const file = els.file.files?.[0];
    els.file.value = ""; // choosing the same file again still triggers a change
    if (!file) return;
    els.avatarError.textContent = "";
    const typeOk = FILE_TYPES.includes(file.type) || (!file.type && /\.(jpe?g|png|webp)$/i.test(file.name));
    if (!typeOk) {
      els.avatarError.textContent = "Choose a JPG, PNG or WebP picture.";
      return;
    }
    if (file.size > FILE_MAX_MB * 1024 * 1024) {
      els.avatarError.textContent = `That picture is ${(file.size / 1024 / 1024).toFixed(1)} MB. Choose one under ${FILE_MAX_MB} MB.`;
      return;
    }
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();
    img.src = objectUrl;
    try {
      await img.decode();
      if (img.naturalWidth < 32 || img.naturalHeight < 32) throw new Error("too small");
    } catch {
      URL.revokeObjectURL(objectUrl);
      els.avatarError.textContent = "That file couldn’t be used as a picture. Try a different JPG, PNG or WebP image (at least 32 × 32 pixels).";
      return;
    }
    discardUpload();
    const width = img.naturalWidth;
    const height = img.naturalHeight;
    pendingUpload = { img, width, height, zoom: 1, cx: width / 2, cy: height / 2, previewUrl: null, objectUrl };
    draft.choice = "picture";
    els.zoom.value = "1";
    drawCrop({ preview: true });
    renderDraft();
    setStatus("New picture ready. Adjust the crop, then press Save changes.", "dirty");
    els.stage.focus();
  });

  function discardUpload() {
    if (!pendingUpload) return;
    URL.revokeObjectURL(pendingUpload.objectUrl);
    pendingUpload = null;
  }

  // The crop is a square (side = shorter edge / zoom) centred on (cx, cy) in picture pixels.
  const cropSide = (crop) => Math.min(crop.width, crop.height) / crop.zoom;
  function clampCrop(crop) {
    const half = cropSide(crop) / 2;
    crop.cx = Math.min(Math.max(crop.cx, half), crop.width - half);
    crop.cy = Math.min(Math.max(crop.cy, half), crop.height - half);
  }
  function paintCrop(canvas, crop, size) {
    const ctx = canvas.getContext("2d");
    const side = cropSide(crop);
    canvas.width = size;
    canvas.height = size;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(crop.img, crop.cx - side / 2, crop.cy - side / 2, side, side, 0, 0, size, size);
  }
  let previewFrame = 0;
  function drawCrop({ preview = false } = {}) {
    if (!pendingUpload) return;
    clampCrop(pendingUpload);
    paintCrop(els.canvas, pendingUpload, els.canvas.width || 440);
    if (!preview) return;
    // The circular previews update at most once per frame.
    window.cancelAnimationFrame(previewFrame);
    previewFrame = window.requestAnimationFrame(() => {
      if (!pendingUpload) return;
      const small = document.createElement("canvas");
      paintCrop(small, pendingUpload, 240);
      pendingUpload.previewUrl = small.toDataURL("image/jpeg", 0.85);
      paintAvatar(els.preview, draftAvatar());
      const face = els.options.querySelector('[data-option="picture"]');
      if (face) paintAvatar(face, draftAvatar());
    });
  }

  els.zoom.addEventListener("input", () => {
    if (!pendingUpload) return;
    pendingUpload.zoom = Number(els.zoom.value) || 1;
    drawCrop({ preview: true });
  });
  let drag = null;
  els.stage.addEventListener("pointerdown", (event) => {
    if (!pendingUpload) return;
    drag = { x: event.clientX, y: event.clientY };
    els.stage.setPointerCapture(event.pointerId);
  });
  els.stage.addEventListener("pointermove", (event) => {
    if (!drag || !pendingUpload) return;
    // Dragging moves the picture under the square, so the crop moves the other way.
    const scale = cropSide(pendingUpload) / els.stage.clientWidth;
    pendingUpload.cx -= (event.clientX - drag.x) * scale;
    pendingUpload.cy -= (event.clientY - drag.y) * scale;
    drag = { x: event.clientX, y: event.clientY };
    drawCrop();
  });
  const endDrag = () => {
    if (!drag) return;
    drag = null;
    drawCrop({ preview: true });
  };
  els.stage.addEventListener("pointerup", endDrag);
  els.stage.addEventListener("pointercancel", endDrag);
  els.stage.addEventListener("keydown", (event) => {
    if (!pendingUpload) return;
    const step = cropSide(pendingUpload) * (event.shiftKey ? 0.1 : 0.03);
    const moves = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    if (moves[event.key]) {
      pendingUpload.cx += moves[event.key][0];
      pendingUpload.cy += moves[event.key][1];
    } else if (event.key === "+" || event.key === "=" || event.key === "-" || event.key === "_") {
      const zoom = Number(els.zoom.value) + (event.key === "+" || event.key === "=" ? 0.1 : -0.1);
      els.zoom.value = String(Math.min(Number(els.zoom.max), Math.max(1, zoom)));
      pendingUpload.zoom = Number(els.zoom.value);
    } else return;
    event.preventDefault();
    drawCrop({ preview: true });
  });
  $("#cropReset").addEventListener("click", () => {
    if (!pendingUpload) return;
    Object.assign(pendingUpload, { zoom: 1, cx: pendingUpload.width / 2, cy: pendingUpload.height / 2 });
    els.zoom.value = "1";
    drawCrop({ preview: true });
  });
  $("#cropDiscard").addEventListener("click", () => {
    discardUpload();
    if (draft.choice === "picture" && !saved.avatar_path) draft.choice = saved.avatar_preset || "initials";
    renderDraft();
    setStatus(isDirty() ? "You have unsaved changes." : "", isDirty() ? "dirty" : "");
    els.upload.focus();
  });
  els.remove.addEventListener("click", () => {
    discardUpload();
    draft.choice = "initials";
    renderDraft();
    setStatus(isDirty() ? "Your picture will be removed when you press Save changes." : "", isDirty() ? "dirty" : "");
    els.options.querySelector('input[value="initials"]')?.focus();
  });

  // A square picture, as WebP where the browser can make one (otherwise JPEG).
  function exportCrop() {
    const canvas = document.createElement("canvas");
    paintCrop(canvas, pendingUpload, OUTPUT_SIZE);
    const toBlob = (type) => new Promise((resolve) => canvas.toBlob(resolve, type, 0.9));
    return toBlob("image/webp").then((blob) => (blob?.type === "image/webp" ? blob : toBlob("image/jpeg")));
  }

  // ---------- Save and Cancel ----------
  const missingSetup = (error) => Boolean(error && (error.code === "PGRST202" || error.code === "42883" || /update_my_profile|bucket not found/i.test(error.message || "")));
  function saveErrorText(error) {
    if (missingSetup(error)) return SETUP_TEXT;
    if (error?.code === "22023" && error.message) return `${error.message} Your changes are still here.`;
    if (error?.stage === "upload") return `${error.message} Your previous picture hasn’t changed.`;
    return "Couldn’t save your profile. Check your connection and try again. Your changes are still here.";
  }
  function uploadErrorText(error) {
    const text = error?.message || "";
    if (/bucket not found/i.test(text)) return SETUP_TEXT;
    if (/size|too large|exceed/i.test(text)) return "That picture is too large to upload. Try a smaller one.";
    if (/mime|type/i.test(text)) return "That picture type isn’t allowed. Use JPG, PNG or WebP.";
    return "Couldn’t upload your picture.";
  }

  function setSaving(value) {
    saving = value;
    els.save.replaceChildren(...(value ? [Object.assign(document.createElement("span"), { className: "spinner" }), "Saving…"] : ["Save changes"]));
    els.form.setAttribute("aria-busy", String(value));
    updateButtons();
  }

  els.form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (saving) return;
    nameTouched = true;
    showNameState({ force: true });
    if (nameProblem(els.name.value)) {
      setStatus("Check your display name, then try again.", "error");
      els.name.focus();
      return;
    }
    if (app.profileSetupMissing) {
      setStatus(SETUP_TEXT, "error");
      return;
    }
    if (!isDirty()) {
      setStatus("Everything is already saved.", "success");
      return;
    }

    // Save is disabled while saving, which drops keyboard focus; put it back on the form after.
    const keyboardSave = els.actions.contains(document.activeElement);
    setSaving(true);
    let newPath = null;
    let newPreview = null;
    try {
      if (draft.choice === "picture" && pendingUpload) {
        setStatus("Uploading your picture…");
        const blob = await exportCrop();
        if (!blob) throw Object.assign(new Error("Couldn’t prepare your picture."), { stage: "upload" });
        const ext = blob.type === "image/webp" ? "webp" : "jpg";
        const random = crypto.getRandomValues(new Uint32Array(2)).reduce((text, n) => text + n.toString(36), "");
        const path = `${app.user.id}/${Date.now().toString(36)}-${random}.${ext}`;
        const { error } = await supabase.storage.from("avatars").upload(path, blob, { contentType: blob.type, cacheControl: "3600", upsert: false });
        if (error) throw Object.assign(new Error(uploadErrorText(error)), { stage: "upload", code: /bucket not found/i.test(error.message || "") ? "PGRST202" : undefined });
        newPath = path;
        newPreview = pendingUpload.previewUrl;
      }
      setStatus("Saving your profile…");
      const path = draft.choice === "picture" ? newPath || saved.avatar_path : null;
      const preset = draft.choice !== "picture" && draft.choice !== "initials" ? draft.choice : null;
      const { data, error } = await supabase.rpc("update_my_profile", {
        p_display_name: cleanName(els.name.value),
        p_avatar_preset: preset,
        p_avatar_path: path,
        p_theme: draft.theme,
        p_accent: draft.accent
      });
      if (error) throw error;

      const oldPath = saved.avatar_path;
      Object.assign(saved, {
        display_name: data.display_name,
        avatar_preset: data.avatar_preset || null,
        avatar_path: data.avatar_path || null,
        ...normalizeAppearance(data)
      });
      // The old picture is no longer used: delete it (if that fails it just stays private).
      if (oldPath && oldPath !== saved.avatar_path) {
        forgetAvatarUrl(oldPath);
        void supabase.storage.from("avatars").remove([oldPath]).catch(() => {});
      }
      if (!saved.avatar_path) savedUrl = null;
      else if (newPath) savedUrl = (await avatarUrl(supabase, newPath)) || newPreview;

      Object.assign(app.profile, saved);
      cacheAppearance(app.user.id, saved);
      applyAppearance(saved);
      resetDraft();
      paintEverywhere();
      // Home's greeting, and (for students) their teachers' class lists via student-classes.js.
      window.dispatchEvent(new CustomEvent("neurofocus:profile-updated", { detail: { ...saved, avatarUrl: savedUrl } }));
      setStatus("Saved. Your profile and look are updated on every device.", "success");
      // The bar tucks away once everything is saved, so say so where it stays visible.
      notify({ title: "Changes saved", text: "Your profile and look are updated on every device.", kind: "success", timeoutMs: 4000 });
      announce("Changes saved.");
      // (Chrome keeps focus on the disabled button until the bar hides, so check both.)
      if (keyboardSave && (!document.activeElement || document.activeElement === document.body || els.actions.contains(document.activeElement))) els.name.focus();
    } catch (error) {
      // Keep the previous picture: remove a new upload that didn't make it onto the profile.
      if (newPath) void supabase.storage.from("avatars").remove([newPath]).catch(() => {});
      console.warn("Profile save failed", error);
      if (missingSetup(error)) app.profileSetupMissing = true;
      setStatus(saveErrorText(error), "error");
    } finally {
      setSaving(false);
    }
  });

  els.cancel.addEventListener("click", () => {
    resetDraft();
    applyAppearance(saved, { animate: true });
    setStatus("Changes discarded. You’re seeing your saved profile.", "");
    announce("Changes discarded. You’re seeing your saved profile.");
    els.name.focus();
  });

  // ---------- Leaving and coming back ----------
  // A theme preview only lasts while Profile settings is open; unsaved edits wait in the form.
  window.addEventListener("neurofocus:viewchange", (event) => {
    const { name, previous } = event.detail || {};
    if (previous === "profile" && name !== "profile") {
      applyAppearance(saved, { animate: true });
      closeMenu();
      if (isDirty()) {
        notify({
          title: "Your profile changes aren’t saved yet",
          text: "The theme preview was turned off. Go back to Profile settings to save or cancel them.",
          kind: "info",
          timeoutMs: 9000,
          actions: [{ label: "Back to Profile settings", primary: true, onClick: () => window.neuroFocusNavigate?.("profile") }]
        });
      }
    } else if (name === "profile" && previous !== "profile" && isDirty()) {
      applyAppearance(draft);
      setStatus("You have unsaved changes.", "dirty");
    }
  });
  window.addEventListener("beforeunload", (event) => {
    if (!isDirty() || saving) return;
    event.preventDefault();
    event.returnValue = "";
  });

  // ---------- Start ----------
  $("#factAccountId").textContent = app.user.id;
  $("#factRole").textContent = app.profile.role === "teacher" ? "Teacher" : "Student";
  resetDraft();
  paintEverywhere();
  if (app.profileSetupMissing) {
    setStatus(SETUP_TEXT, "error");
  } else {
    setStatus("All changes saved.", "");
  }
  if (window.neuroFocusView === "profile" && isDirty()) applyAppearance(draft);
  await loadSavedPicture();
  // Signed links expire after an hour: refresh the picture's link while the page stays open.
  window.setInterval(() => { if (saved.avatar_path) void loadSavedPicture(); }, 45 * 60 * 1000);
}
