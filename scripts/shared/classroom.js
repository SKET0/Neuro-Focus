// Shared by the class Posts and Assignments tabs (student-classroom.js, teacher-classroom.js).
// Files live in the private "class-files" bucket (supabase/migrations/20261010000000_class_posts_assignments.sql)
// and are only ever opened through short-lived signed links. The database checks every rule
// again (membership, deadline, own folder, type, size); the checks here just give quick, clear
// messages before an upload starts.

export const BUCKET = "class-files";
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
// Allowed files: extension -> type. The same list as the bucket and class_file_type_ok().
export const FILE_TYPES = {
  pdf: "application/pdf", doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  odt: "application/vnd.oasis.opendocument.text", ods: "application/vnd.oasis.opendocument.spreadsheet",
  odp: "application/vnd.oasis.opendocument.presentation", rtf: "application/rtf", txt: "text/plain", csv: "text/csv",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif"
};
export const ACCEPT = Object.keys(FILE_TYPES).map((ext) => `.${ext}`).join(",");
export const FILE_RULES_TEXT = "PDF, Word, PowerPoint, Excel, OpenDocument, text or CSV files, or images (PNG, JPG, WebP, GIF), up to 20 MB.";

const extensionOf = (name) => (/\.([a-z0-9]+)$/i.exec(name || "")?.[1] || "").toLowerCase();

// The type to store: the browser's own type when it matches the extension, else the extension's.
export function fileType(file) {
  const expected = FILE_TYPES[extensionOf(file.name)];
  if (!expected) return "";
  return file.type && file.type.toLowerCase() === expected ? file.type.toLowerCase() : expected;
}

// A message explaining why a file can't be used, or "" when it's fine.
export function checkFile(file) {
  if (!file) return "Choose a file first.";
  if (!FILE_TYPES[extensionOf(file.name)]) return `“${file.name}” isn’t an allowed file type. Use ${FILE_RULES_TEXT}`;
  if (!file.size) return "That file is empty.";
  if (file.size > MAX_FILE_BYTES) return `“${file.name}” is ${fileSize(file.size)}. Files must be 20 MB or smaller.`;
  return "";
}

export function fileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// A storage-safe name that keeps the original readable; the random part keeps uploads unique.
export function storageName(file) {
  const ext = extensionOf(file.name);
  const base = file.name.replace(/\.[^.]+$/, "").normalize("NFKD").replace(/[^\w.-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "file";
  const random = (crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`).slice(0, 8);
  return `${random}-${base}.${ext}`;
}

export const attachmentPath = (classId, assignmentId, file) => `${classId}/assignments/${assignmentId}/${storageName(file)}`;
export const submissionPath = (classId, assignmentId, studentId, file) => `${classId}/submissions/${assignmentId}/${studentId}/${storageName(file)}`;

export async function uploadFile(supabase, path, file) {
  const { error } = await supabase.storage.from(BUCKET).upload(path, file, { contentType: fileType(file), upsert: false });
  return error;
}

export async function removeFiles(supabase, paths) {
  const list = paths.filter(Boolean);
  if (!list.length) return null;
  const { error } = await supabase.storage.from(BUCKET).remove(list);
  return error;
}

// Opens a private file through a signed link that works for one minute.
export async function downloadFile(supabase, path, name) {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, 60, { download: name || true });
  if (error || !data?.signedUrl) return error || new Error("No link");
  const link = document.createElement("a");
  link.href = data.signedUrl;
  link.rel = "noopener";
  link.download = name || "";
  document.body.append(link);
  link.click();
  link.remove();
  return null;
}

// The database update for Posts and Assignments hasn't been run yet.
export const classroomSqlMissing = (error) => Boolean(error && (error.code === "PGRST205" || error.code === "42P01" || error.code === "PGRST202"
  || /class_posts|assignments|assignment_submissions|submit_assignment|mark_submission|class-files|Bucket not found/i.test(error.message || "")));
export const SETUP_TEXT = "Posts and assignments need a database update: run supabase/migrations/20261010000000_class_posts_assignments.sql (see README).";

// The database update for Quizzes hasn't been run yet.
export const quizSqlMissing = (error) => Boolean(error && (error.code === "PGRST205" || error.code === "42P01" || error.code === "PGRST202"
  || /quizzes|quiz_questions|quiz_state|quiz_results|join_quiz|submit_quiz_answer|quiz_open_lobby|quiz_next_question/i.test(error.message || "")));
export const QUIZ_SETUP_TEXT = "Quizzes need a database update: run supabase/migrations/20261011000000_class_quizzes.sql (see README).";
export const CHOICE_LETTERS = ["A", "B", "C", "D", "E", "F"];

// Seconds left until an ISO time, using the server's clock (serverNow) to avoid device clock drift.
export function secondsLeft(closesAt, serverNow, fetchedAt) {
  if (!closesAt) return null;
  const offset = new Date(serverNow).getTime() - fetchedAt;
  return Math.max(0, Math.ceil((new Date(closesAt).getTime() - (Date.now() + offset)) / 1000));
}

export const errorText = (error, fallback) => (error?.message && !/^\s*$/.test(error.message) ? error.message : fallback);

// "Due Fri 10 Oct, 3:00 pm · in 2 days" / "Closed · deadline was …" / "No deadline"
export function dueText(dueAt, now = Date.now()) {
  if (!dueAt) return { text: "No deadline", closed: false, soon: false };
  const due = new Date(dueAt);
  const when = due.toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
  const ms = due - now;
  if (ms < 0) return { text: `Closed · deadline was ${when}`, closed: true, soon: false };
  const hours = ms / 3600000;
  const left = hours < 1 ? `${Math.max(1, Math.round(ms / 60000))} min left` : hours < 48 ? `${Math.round(hours)} h left` : `in ${Math.round(hours / 24)} days`;
  return { text: `Due ${when} · ${left}`, closed: false, soon: hours < 24 };
}

export const whenText = (iso) => new Date(iso).toLocaleString([], { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

export const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

// A small ⓘ button that opens a short explanation (scripts/shared/info-popover.js wires it up).
let infoCount = 0;
export function infoButton(label, text) {
  infoCount += 1;
  const id = `info-pop-${infoCount}`;
  const wrap = el("span", "info-wrap");
  const button = el("button", "info-btn", "i");
  button.type = "button";
  button.setAttribute("aria-label", `More about ${label}`);
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-controls", id);
  button.dataset.info = "";
  const pop = el("span", "info-pop", text);
  pop.id = id;
  pop.setAttribute("role", "note");
  pop.hidden = true;
  wrap.append(button, pop);
  return wrap;
}
