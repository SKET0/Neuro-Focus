// Shared helpers for the teacher and student class pages:
// private Supabase Realtime class channels, presence parsing, and small UI dialogs/notices.

export const classTopic = (classId) => `neurofocus-class-${classId}`;

let realtimeAuth;
// Private channels are authorised with the signed-in user's token.
function ensureRealtimeAuth(supabase) {
  realtimeAuth ??= (async () => {
    try {
      const { data } = await supabase.auth.getSession();
      const token = data?.session?.access_token;
      if (token && supabase.realtime?.setAuth) await supabase.realtime.setAuth(token);
    } catch {
      // supabase-js falls back to its own token handling.
    }
  })();
  return realtimeAuth;
}

// Opens the private channel for one class. Supabase checks the realtime.messages policies
// from the Phase 2 migrations, and retries the connection on its own after drops.
export async function openClassChannel(supabase, classId, {
  presenceKey, broadcasts = [], onSync, onJoin, onBroadcast, onReady, onError
}) {
  await ensureRealtimeAuth(supabase);
  const channel = supabase.channel(classTopic(classId), { config: { private: true, presence: { key: presenceKey } } });
  if (onSync) channel.on("presence", { event: "sync" }, () => onSync(channel.presenceState()));
  if (onJoin) channel.on("presence", { event: "join" }, ({ newPresences }) => onJoin(newPresences || []));
  broadcasts.forEach((event) => {
    channel.on("broadcast", { event }, ({ payload }) => onBroadcast?.(event, payload || {}));
  });
  let failures = 0;
  channel.subscribe((status) => {
    if (status === "SUBSCRIBED") {
      failures = 0;
      onReady?.(channel);
    } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
      failures += 1;
      if (failures === 2) onError?.(status);
    }
  });
  return channel;
}

// Presence helpers
export function onlineStudentIds(state) {
  return new Set(Object.keys(state).filter((key) => state[key].some((meta) => meta.role === "student")));
}

export function teacherStatus(state) {
  const metas = Object.values(state).flat().filter((meta) => meta.role === "teacher");
  const live = metas.find((meta) => meta.live);
  return {
    online: metas.length > 0,
    live: Boolean(live),
    since: live?.since || null,
    removed: metas.flatMap((meta) => (Array.isArray(meta.removed) ? meta.removed : []))
  };
}

// ---------- Confirmation dialog ----------
// confirmAction({ title, message, confirmLabel, danger, requireText }) -> Promise<boolean>
export function confirmAction({ title, message, confirmLabel = "Confirm", danger = false, requireText = "", cancelLabel = "Cancel" }) {
  return new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.className = "nf-dialog";
    const form = document.createElement("form");
    form.method = "dialog";
    const heading = document.createElement("h2");
    heading.textContent = title;
    const text = document.createElement("p");
    text.textContent = message;
    form.append(heading, text);

    let input;
    if (requireText) {
      const label = document.createElement("label");
      label.className = "nf-dialog-label";
      label.textContent = `Type “${requireText}” to confirm`;
      input = document.createElement("input");
      input.className = "nf-dialog-input";
      input.autocomplete = "off";
      label.append(input);
      form.append(label);
    }

    const actions = document.createElement("div");
    actions.className = "nf-dialog-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "btn-action";
    cancel.textContent = cancelLabel || "Cancel";
    cancel.hidden = !cancelLabel;
    const ok = document.createElement("button");
    ok.type = "submit";
    ok.className = danger ? "nf-btn-danger" : "btn-primary";
    ok.textContent = confirmLabel;
    if (input) {
      ok.disabled = true;
      input.addEventListener("input", () => { ok.disabled = input.value.trim() !== requireText; });
    }
    actions.append(cancel, ok);
    form.append(actions);
    dialog.append(form);
    document.body.append(dialog);

    let confirmed = false;
    cancel.addEventListener("click", () => dialog.close());
    form.addEventListener("submit", () => { confirmed = true; });
    dialog.addEventListener("close", () => {
      dialog.remove();
      resolve(confirmed);
    });
    dialog.showModal();
    (input || (cancelLabel ? cancel : ok)).focus();
  });
}

// A message the user must acknowledge (one button).
export function showMessage({ title, message, buttonLabel = "OK" }) {
  return confirmAction({ title, message, confirmLabel: buttonLabel, cancelLabel: null });
}

// ---------- Notices (top-right, stack and fade) ----------
// notify({ title, text, kind: "info" | "success" | "live" | "error", actions: [{ label, onClick, primary }], timeoutMs })
export function notify({ title, text = "", kind = "info", actions = [], timeoutMs = 6000 }) {
  let stack = document.querySelector(".nf-notices");
  if (!stack) {
    stack = document.createElement("div");
    stack.className = "nf-notices";
    stack.setAttribute("role", "status");
    stack.setAttribute("aria-live", "polite");
    document.body.append(stack);
  }
  const notice = document.createElement("div");
  notice.className = "nf-notice";
  notice.dataset.kind = kind;
  const strong = document.createElement("strong");
  strong.textContent = title;
  notice.append(strong);
  if (text) {
    const body = document.createElement("p");
    body.textContent = text;
    notice.append(body);
  }
  const close = () => notice.remove();
  if (actions.length) {
    const row = document.createElement("div");
    row.className = "nf-notice-actions";
    actions.forEach(({ label, onClick, primary }) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = primary ? "btn-primary" : "btn-action";
      button.textContent = label;
      button.addEventListener("click", () => { close(); onClick?.(); });
      row.append(button);
    });
    notice.append(row);
  }
  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "nf-notice-close";
  dismiss.setAttribute("aria-label", "Dismiss");
  dismiss.textContent = "×";
  dismiss.addEventListener("click", close);
  notice.append(dismiss);
  stack.append(notice);
  while (stack.children.length > 4) stack.firstElementChild.remove();
  if (timeoutMs) window.setTimeout(close, timeoutMs);
  return close;
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

// ---------- Database setup check ----------
// Lists the Phase 2 migration files that haven't been run in this Supabase project yet.
export const MIGRATIONS = {
  history: "supabase/migrations/20261002000000_attention_history_and_private_live.sql",
  classes: "supabase/migrations/20261003000000_class_management.sql"
};

export async function missingDatabaseUpdates(supabase) {
  const missing = [];
  const history = await supabase.from("attention_sessions").select("id").limit(1);
  if (history.error && (history.error.code === "PGRST205" || history.error.code === "42P01")) missing.push(MIGRATIONS.history);
  const settings = await supabase.from("classes").select("joining_open").limit(1);
  if (settings.error && (settings.error.code === "42703" || /joining_open/.test(settings.error.message || ""))) missing.push(MIGRATIONS.classes);
  return missing;
}

export function showSetupBanner(missing, { forTeacher = false } = {}) {
  document.querySelector(".nf-setup")?.remove();
  if (!missing.length) return;
  const banner = document.createElement("section");
  banner.className = "nf-setup";
  banner.setAttribute("role", "alert");
  const title = document.createElement("strong");
  title.textContent = "Database setup needed";
  const text = document.createElement("p");
  text.textContent = forTeacher
    ? "Live sessions, saved history and class management won’t work until these files are run in Supabase → SQL Editor, in this order:"
    : "Live sessions and saved history won’t work until your teacher or project owner runs these files in Supabase → SQL Editor, in this order:";
  const list = document.createElement("ol");
  missing.forEach((file) => {
    const item = document.createElement("li");
    const code = document.createElement("code");
    code.textContent = file;
    item.append(code);
    list.append(item);
  });
  const after = document.createElement("p");
  after.textContent = "Paste each whole file into a new query, click Run, then refresh this page.";
  banner.append(title, text, list, after);
  document.querySelector(".portal-main")?.prepend(banner);
}
