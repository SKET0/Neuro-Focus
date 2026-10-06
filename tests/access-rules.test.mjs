// Access-rule tests: runs every migration in supabase/migrations against an in-memory Postgres
// (PGlite) set up like Supabase (anon/authenticated roles, auth.uid(), realtime.messages), then
// checks who can read and write what: students vs classmates, teachers vs other teachers.
// Run: cd tests && npm install && npm test
import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dir = process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), "..", "supabase", "migrations");
const db = new PGlite();
let failures = 0;
const ok = (label, cond, extra = "") => { if (!cond) failures += 1; console.log(`${cond ? "✓" : "✗"} ${label}${extra ? `  ${extra}` : ""}`); };

// ---------- Supabase stand-ins ----------
await db.exec(`
  create role anon nologin; create role authenticated nologin; create role service_role nologin;
  create schema auth; create schema realtime; create schema extensions;
  grant usage on schema public, auth, realtime, extensions to anon, authenticated;
  create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}'::jsonb);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant execute on function auth.uid() to anon, authenticated;
  create table realtime.messages (id bigserial primary key, topic text, extension text, payload jsonb, event text, private boolean default true);
  alter table realtime.messages enable row level security;
  grant select, insert on realtime.messages to authenticated;
  grant usage on sequence realtime.messages_id_seq to authenticated;
  create function realtime.topic() returns text language sql stable as $$ select current_setting('realtime.topic', true) $$;
  grant execute on function realtime.topic() to authenticated;
  -- Supabase Storage stand-in (profile pictures)
  create schema storage;
  grant usage on schema storage to anon, authenticated;
  create table storage.buckets (id text primary key, name text not null, public boolean default false, file_size_limit bigint, allowed_mime_types text[]);
  create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id), name text not null, owner uuid default auth.uid(), unique (bucket_id, name));
  alter table storage.objects enable row level security;
  grant select, insert, update, delete on storage.objects to authenticated;
  grant select on storage.buckets to anon, authenticated;
  -- pgcrypto stand-in (only used for join passwords)
  create function extensions.gen_salt(text, integer default 0) returns text language sql as $$ select 'salt' $$;
  create function extensions.crypt(p text, s text) returns text language sql as $$ select split_part(s, '$', 1) || '$' || md5(p || split_part(s, '$', 1)) $$;
  -- Supabase gives anon/authenticated full privileges on new public tables by default; RLS does the rest.
  alter default privileges in schema public grant all on tables to anon, authenticated;
  alter default privileges in schema public grant all on functions to anon, authenticated;
  alter default privileges in schema public grant all on sequences to anon, authenticated;
`);

// The tracking-quality update is applied later, after some records are saved the old way, to
// check that it leaves existing history exactly as it was.
const TRACKING_QUALITY = "20261009000000_tracking_quality.sql";
const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
async function runMigration(file) {
  const sql = readFileSync(join(dir, file), "utf8").replace(/create extension if not exists pgcrypto[^;]*;/i, "");
  try { await db.exec(sql); await db.exec(sql); } catch (e) { console.log(`✗ migration ${file} failed: ${e.message}`); process.exit(1); }
}
for (const file of files.filter((f) => f !== TRACKING_QUALITY)) await runMigration(file);
console.log(`ran ${files.length - (files.includes(TRACKING_QUALITY) ? 1 : 0)} migrations twice each ✓\n`);

// ---------- People ----------
const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const T1 = id(1), T2 = id(2), S1 = id(11), S2 = id(12), S3 = id(13);
for (const [uid, name] of [[T1, "Teacher One"], [T2, "Teacher Two"], [S1, "Student One"], [S2, "Student Two"], [S3, "Student Three"]]) {
  await db.query("insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)", [uid, `${uid}@x.test`, { full_name: name }]);
}
await db.query("update public.profiles set role = 'teacher' where id in ($1, $2)", [T1, T2]);

async function as(uid, fn) {
  await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${uid || ""}', false); set role ${uid ? "authenticated" : "anon"};`);
  try { return await fn(); } finally { await db.exec("reset role"); }
}
const rows = async (uid, sql, params = []) => as(uid, async () => (await db.query(sql, params)).rows);
const tryQ = async (uid, sql, params = []) => as(uid, async () => {
  try { const r = await db.query(sql, params); return { ok: true, rows: r.rows, affected: r.affectedRows }; } catch (e) { return { ok: false, error: e.message }; }
});
const ids = (list, key = "id") => list.map((r) => r[key]).sort();

// ---------- Classes ----------
const C1 = (await rows(T1, "select public.create_class('Biology', null) as r"))[0].r;
const C2 = (await rows(T2, "select public.create_class('History', 'secret123') as r"))[0].r;
await rows(S1, "select public.join_class($1, null)", [C1.join_code]);
await rows(S2, "select public.join_class($1, null)", [C1.join_code]);
ok("join with wrong class password is refused", !(await tryQ(S3, "select public.join_class($1, 'nope12')", [C2.join_code])).ok);
await rows(S3, "select public.join_class($1, 'secret123')", [C2.join_code]);
ok("teachers can't join classes", !(await tryQ(T2, "select public.join_class($1, null)", [C1.join_code])).ok);
ok("students can't create classes", !(await tryQ(S1, "select public.create_class('Hack', null)")).ok);

console.log("\n— Profiles, classes and membership —");
ok("student sees only their own profile", JSON.stringify(ids(await rows(S1, "select id from public.profiles"))) === JSON.stringify([S1]));
ok("teacher sees own profile + their students, not other classes", JSON.stringify(ids(await rows(T1, "select id from public.profiles"))) === JSON.stringify([T1, S1, S2].sort()));
ok("other teacher can't see Biology students", !ids(await rows(T2, "select id from public.profiles")).includes(S1));
ok("student sees only classes they're in", JSON.stringify(ids(await rows(S1, "select id from public.classes"))) === JSON.stringify([C1.id]));
ok("student sees only their own membership row", (await rows(S1, "select student_id from public.class_members")).every((r) => r.student_id === S1));
ok("join passwords are unreadable", !(await tryQ(T2, "select * from public.class_access")).ok);
const roleHack = await tryQ(S1, "update public.profiles set role = 'teacher' where id = $1", [S1]);
ok("student can't make themselves a teacher", !roleHack.ok || roleHack.affected === 0);
ok("student can't add themselves to a class directly", !(await tryQ(S1, "insert into public.class_members (class_id, student_id) values ($1, $2)", [C2.id, S1])).ok);
ok("student can't remove a classmate", (await tryQ(S1, "delete from public.class_members where student_id = $1", [S2])).affected === 0);
ok("other teacher can't remove Biology students", (await tryQ(T2, "delete from public.class_members where class_id = $1", [C1.id])).affected === 0);
ok("AI usage counters are unreadable", !(await tryQ(S1, "select * from public.ai_usage_limits")).ok);

console.log("\n— Tracking quality update keeps old history —");
// Saved the old way: a personal session whose no-face time is an 'Away' sample with score 0.
const oldSession = (await rows(S1, "insert into public.attention_sessions (student_id, tracked_seconds, focus_percent, average_score, lapses) values ($1, 300, 62, 70, 3) returning *", [S1]))[0];
await rows(S1, "insert into public.attention_samples (session_id, student_id, score, state) values ($1, $2, 80, 'Focused'), ($1, $2, 0, 'Away')", [oldSession.id, S1]);
const oldBefore = JSON.stringify([(await db.query("select * from public.attention_sessions where id = $1", [oldSession.id])).rows, (await db.query("select * from public.attention_samples where session_id = $1 order by state", [oldSession.id])).rows]);
ok("before the update, an unavailable sample with no score is refused", !(await tryQ(S1, "insert into public.attention_samples (session_id, student_id, score, state) values ($1, $2, null, 'Unavailable')", [oldSession.id, S1])).ok);
if (files.includes(TRACKING_QUALITY)) await runMigration(TRACKING_QUALITY);
const oldAfter = (await db.query("select * from public.attention_sessions where id = $1", [oldSession.id])).rows;
ok("old session and samples are unchanged by the update (run twice)", JSON.stringify([oldAfter.map(({ usable_seconds, unavailable_seconds, break_seconds, tracking_version, ...rest }) => rest), (await db.query("select * from public.attention_samples where session_id = $1 order by state", [oldSession.id])).rows]) === oldBefore);
ok("old session has no tracking-quality information (shown as the older method)", oldAfter[0].usable_seconds === null && oldAfter[0].tracking_version === null);
ok("old 'Away' sample keeps its stored 0 (the app reads it as not measured)", (await db.query("select score from public.attention_samples where session_id = $1 and state = 'Away'", [oldSession.id])).rows[0]?.score === 0);
const quality = await tryQ(S1, "insert into public.attention_sessions (student_id, tracking_version) values ($1, 2) returning id", [S1]);
ok("student saves a session with tracking_version 2", quality.ok, quality.error || "");
const qid = quality.rows?.[0]?.id;
ok("student records measured, unavailable and break time", (await tryQ(S1, "update public.attention_sessions set tracked_seconds = 600, usable_seconds = 420, unavailable_seconds = 120, break_seconds = 60, focus_percent = 71 where id = $1", [qid])).affected === 1);
ok("unavailable sample with no score is saved", (await tryQ(S1, "insert into public.attention_samples (session_id, student_id, score, state) values ($1, $2, null, 'Unavailable')", [qid, S1])).ok);
ok("break sample with no score is saved", (await tryQ(S1, "insert into public.attention_samples (session_id, student_id, score, state) values ($1, $2, null, 'Break')", [qid, S1])).ok);
ok("an unavailable sample can't carry a score", !(await tryQ(S1, "insert into public.attention_samples (session_id, student_id, score, state) values ($1, $2, 0, 'Unavailable')", [qid, S1])).ok);
ok("a measured sample must have a score", !(await tryQ(S1, "insert into public.attention_samples (session_id, student_id, score, state) values ($1, $2, null, 'Focused')", [qid, S1])).ok);
ok("unknown sample states are still refused", !(await tryQ(S1, "insert into public.attention_samples (session_id, student_id, score, state) values ($1, $2, 50, 'Bored')", [qid, S1])).ok);
ok("a classmate can't change someone's measured time", (await tryQ(S2, "update public.attention_sessions set usable_seconds = 1 where id = $1", [qid])).affected === 0);

console.log("\n— Attention history —");
const personal = await tryQ(S1, "insert into public.attention_sessions (student_id) values ($1) returning id", [S1]);
ok("student saves personal history", personal.ok);
ok("class-linked history is refused outside a live session", !(await tryQ(S1, "insert into public.attention_sessions (student_id, class_id) values ($1, $2)", [S1, C1.id])).ok);
const live = (await rows(T1, "select public.start_class_session($1) as r", [C1.id]))[0].r;
ok("live session invites both Biology students", live.invited === 2);
const shared = await tryQ(S1, "insert into public.attention_sessions (student_id, class_id, class_session_id) values ($1, $2, $3) returning id", [S1, C1.id, live.id]);
ok("student shares history during the live session", shared.ok, shared.error || "");
ok("class id without a session id is refused", !(await tryQ(S1, "insert into public.attention_sessions (student_id, class_id) values ($1, $2)", [S1, C1.id])).ok);
ok("can't attach history to another class's session", !(await tryQ(S3, "insert into public.attention_sessions (student_id, class_id, class_session_id) values ($1, $2, $3)", [S3, C1.id, live.id])).ok);
ok("can't save history as someone else", !(await tryQ(S1, "insert into public.attention_sessions (student_id) values ($1)", [S2])).ok);
const sharedId = shared.rows?.[0]?.id;
const personalId = personal.rows?.[0]?.id;
ok("teacher sees shared history", ids(await rows(T1, "select id from public.attention_sessions")).includes(sharedId));
ok("teacher can't see personal history", !ids(await rows(T1, "select id from public.attention_sessions")).includes(personalId));
ok("classmate sees none of it", (await rows(S2, "select id from public.attention_sessions")).length === 0);
ok("other teacher sees none of it", (await rows(T2, "select id from public.attention_sessions")).length === 0);
ok("classmate can't edit it", (await tryQ(S2, "update public.attention_sessions set focus_percent = 1 where id = $1", [sharedId])).affected === 0);
ok("student can't move history to another class", !(await tryQ(S1, "update public.attention_sessions set class_id = $2 where id = $1", [personalId, C1.id])).ok);
ok("student records samples in shared history", (await tryQ(S1, "insert into public.attention_samples (session_id, student_id, class_id, score, state) values ($1, $2, $3, 80, 'Focused')", [sharedId, S1, C1.id])).ok);
ok("samples can't be added to someone else's history", !(await tryQ(S2, "insert into public.attention_samples (session_id, student_id, class_id, score, state) values ($1, $2, $3, 10, 'Away')", [sharedId, S2, C1.id])).ok);
ok("teacher sees shared samples; classmate doesn't", (await rows(T1, "select 1 from public.attention_samples")).length === 1 && (await rows(S2, "select 1 from public.attention_samples")).length === 0);

console.log("\n— Live session + attendance —");
ok("student can't start a session", !(await tryQ(S1, "select public.start_class_session($1)", [C1.id])).ok);
ok("other teacher can't start it", !(await tryQ(T2, "select public.start_class_session($1)", [C1.id])).ok);
await rows(S1, "select public.check_in_session($1)", [live.id]);
ok("student sees only their own attendance", (await rows(S1, "select student_id from public.session_attendance")).every((r) => r.student_id === S1));
ok("teacher sees the whole class's attendance", (await rows(T1, "select student_id from public.session_attendance where session_id = $1", [live.id])).length === 2);
ok("other teacher and other students see none", (await rows(T2, "select 1 from public.session_attendance")).length === 0 && (await rows(S3, "select 1 from public.session_attendance")).length === 0);
ok("students can't mark attendance", !(await tryQ(S1, "select public.set_attendance($1, $2, 'present')", [live.id, S2])).ok);
ok("students can't edit attendance rows directly", !(await tryQ(S1, "update public.session_attendance set status = 'present'")).ok);
ok("students can't remove classmates from a session", !(await tryQ(S1, "select public.set_session_removed($1, $2, true)", [live.id, S2])).ok);
ok("students can't check in to another class's session", !(await tryQ(S3, "select public.check_in_session($1)", [live.id])).ok);
await rows(T1, "select public.set_session_removed($1, $2, true)", [live.id, S2]);
ok("removed student can't share history into the session", !(await tryQ(S2, "insert into public.attention_sessions (student_id, class_id, class_session_id) values ($1, $2, $3)", [S2, C1.id, live.id])).ok);
ok("removed student can still keep personal history", (await tryQ(S2, "insert into public.attention_sessions (student_id) values ($1)", [S2])).ok);
ok("removed student is still on the master list", (await rows(T1, "select 1 from public.class_members where student_id = $1", [S2])).length === 1);
ok("students can't keep a session alive", !(await tryQ(S1, "select public.keep_session_alive($1)", [live.id])).ok);
ok("teacher keeps it alive", (await rows(T1, "select public.keep_session_alive($1) as r", [live.id]))[0].r === true);
await rows(T1, "select public.end_class_session($1)", [live.id]);
const marks = Object.fromEntries((await rows(T1, "select student_id, status from public.session_attendance where session_id = $1", [live.id])).map((r) => [r.student_id, r.status]));
ok("after ending: joined student present, never-joined absent", marks[S1] === "present" && marks[S2] === "absent", JSON.stringify(marks));
ok("no shared history after the session ended", !(await tryQ(S1, "insert into public.attention_sessions (student_id, class_id, class_session_id) values ($1, $2, $3)", [S1, C1.id, live.id])).ok);
ok("shared history can still be finalized after the end", (await tryQ(S1, "update public.attention_sessions set ended_at = now(), tracked_seconds = 60 where id = $1", [sharedId])).affected === 1);
// The student page checks this before ending a focus session with the teacher's (student-classes.js).
const endedRow = await rows(S1, "select ended_at from public.class_sessions where id = $1", [live.id]);
ok("class member sees the session has ended", endedRow.length === 1 && endedRow[0].ended_at !== null);
ok("even a student removed from it can see it ended", (await rows(S2, "select ended_at from public.class_sessions where id = $1", [live.id]))[0]?.ended_at != null);
ok("students of other classes can't see it", (await rows(S3, "select 1 from public.class_sessions where id = $1", [live.id])).length === 0);

console.log("\n— Abandoned sessions —");
const stale = (await rows(T1, "select public.start_class_session($1) as r", [C1.id]))[0].r;
await db.query("update public.class_sessions set last_active_at = now() - interval '20 minutes' where id = $1", [stale.id]);
ok("another teacher can't close it", (await rows(T2, "select public.close_stale_sessions() as r"))[0].r.length === 0);
const closed = (await rows(T1, "select public.close_stale_sessions() as r"))[0].r;
const after = (await db.query("select ended_at, last_active_at, started_at from public.class_sessions where id = $1", [stale.id])).rows[0];
ok("teacher's abandoned session closes at its last activity", closed.length === 1 && +after.ended_at === Math.max(+after.last_active_at, +after.started_at || 0));
ok("its no-shows are marked absent", (await db.query("select count(*)::int n from public.session_attendance where session_id = $1 and status = 'absent'", [stale.id])).rows[0].n === 2);

console.log("\n— Notes —");
ok("student writes a private note", (await tryQ(S1, "insert into public.student_notes (student_id, class_id, title, body) values ($1, $2, 'Mine', 'secret')", [S1, C1.id])).ok);
ok("classmate and teacher can't read it", (await rows(S2, "select 1 from public.student_notes")).length === 0 && (await rows(T1, "select 1 from public.student_notes")).length === 0);
ok("can't file a note under a class you're not in", !(await tryQ(S1, "insert into public.student_notes (student_id, class_id, title) values ($1, $2, 'x')", [S1, C2.id])).ok);

console.log("\n— Realtime class channels —");
await db.query("insert into realtime.messages (topic, extension, event) values ($1, 'broadcast', 'attention'), ($1, 'presence', 'sync')", [`neurofocus-class-${C1.id}`]);
const channel = async (uid, classId, sql) => as(uid, async () => {
  await db.query("select set_config('realtime.topic', $1, false)", [`neurofocus-class-${classId}`]);
  try { return (await db.query(sql)).rows; } catch (e) { return { error: e.message }; }
});
const recv = (uid, classId) => channel(uid, classId, "select extension from realtime.messages order by extension");
ok("teacher receives scores and presence", JSON.stringify((await recv(T1, C1.id)).map((r) => r.extension)) === '["broadcast","presence"]');
ok("students receive presence only, never classmates' scores", JSON.stringify((await recv(S1, C1.id)).map((r) => r.extension)) === '["presence"]');
ok("outsiders receive nothing", (await recv(S3, C1.id)).length === 0 && (await recv(T2, C1.id)).length === 0);
const send = (uid, classId, ext) => channel(uid, classId, `insert into realtime.messages (topic, extension) values (realtime.topic(), '${ext}')`);
ok("student can send scores in their class", !(await send(S1, C1.id, "broadcast")).error);
ok("student can't send into another class", Boolean((await send(S1, C2.id, "broadcast")).error));
ok("teacher announces with presence", !(await send(T1, C1.id, "presence")).error);

console.log("\n— Student profiles —");
const profileOf = async (uid) => (await db.query("select display_name, role, avatar_preset, avatar_path, theme, accent from public.profiles where id = $1", [uid])).rows[0];
const saveProfile = (uid, name, preset, path, theme = "default", accent = "default") =>
  tryQ(uid, "select public.update_my_profile($1, $2, $3, $4, $5) as r", [name, preset, path, theme, accent]);
const renamed = await saveProfile(S1, "  Sam   Rivera ", "rocket", null, "light", "purple");
ok("student saves name, avatar and appearance", renamed.ok && renamed.rows[0].r.display_name === "Sam Rivera", renamed.error || "");
const saved = await profileOf(S1);
ok("saved values persist; role is still student", saved.role === "student" && saved.avatar_preset === "rocket" && saved.theme === "light" && saved.accent === "purple");
ok("teacher's class list shows the new name", (await rows(T1, "select display_name from public.profiles where id = $1", [S1]))[0]?.display_name === "Sam Rivera");
ok("empty name is refused", !(await saveProfile(S1, "   ", null, null)).ok);
ok("41-character name is refused", !(await saveProfile(S1, "x".repeat(41), null, null)).ok);
ok("unknown theme / accent / avatar are refused",
  !(await saveProfile(S1, "Sam", null, null, "neon")).ok && !(await saveProfile(S1, "Sam", null, null, "dark", "pink")).ok && !(await saveProfile(S1, "Sam", "dragon", null)).ok);
ok("a failed save leaves the profile unchanged", JSON.stringify(await profileOf(S1)) === JSON.stringify(saved));
ok("profiles can't be edited directly", !(await tryQ(S1, "update public.profiles set display_name = 'x' where id = $1", [S1])).ok);
ok("a student's appearance doesn't touch the teacher's", (await profileOf(T1)).theme === "default" && (await profileOf(T1)).accent === "default");
ok("signed-out visitors can't update profiles", !(await saveProfile(null, "Ghost", null, null)).ok);

console.log("\n— Profile pictures —");
ok("avatars bucket is private", (await db.query("select public from storage.buckets where id = 'avatars'")).rows[0]?.public === false);
const putPicture = (uid, name) => tryQ(uid, "insert into storage.objects (bucket_id, name) values ('avatars', $1) returning name", [name]);
const s1Pic = `${S1}/pic-1.webp`;
ok("student uploads into their own folder", (await putPicture(S1, s1Pic)).ok);
ok("can't upload into someone else's folder", !(await putPicture(S2, `${S1}/sneaky.webp`)).ok);
ok("can't upload outside a user folder", !(await putPicture(S1, "public/pic.webp")).ok);
ok("saving an uploaded picture works and clears the built-in avatar", (await saveProfile(S1, "Sam Rivera", "rocket", s1Pic)).ok && (await profileOf(S1)).avatar_path === s1Pic && (await profileOf(S1)).avatar_preset === null);
ok("can't point a profile at someone else's picture", !(await saveProfile(S2, "Student Two", null, s1Pic)).ok);
ok("picture paths must be plain file names", !(await saveProfile(S1, "Sam Rivera", null, `${S1}/../${S2}/x.webp`)).ok && !(await saveProfile(S1, "Sam Rivera", null, `${S1}/pic.gif`)).ok);
const canSee = async (uid) => (await rows(uid, "select name from storage.objects where bucket_id = 'avatars'")).some((r) => r.name === s1Pic);
ok("owner can view their picture", await canSee(S1));
ok("their class teacher can view it", await canSee(T1));
ok("classmates, other teachers and other students can't", !(await canSee(S2)) && !(await canSee(T2)) && !(await canSee(S3)));
ok("signed-out visitors can't", !(await tryQ(null, "select name from storage.objects")).ok || !(await canSee(null)));
ok("teacher can't delete it; classmate can't either",
  (await tryQ(T1, "delete from storage.objects where name = $1", [s1Pic])).affected === 0 && (await tryQ(S2, "delete from storage.objects where name = $1", [s1Pic])).affected === 0);
ok("classmate can't replace it", (await tryQ(S2, "update storage.objects set name = $2 where name = $1", [s1Pic, `${S2}/taken.webp`])).affected === 0);
ok("owner can't move a picture into someone else's folder", !(await tryQ(S1, "update storage.objects set name = $2 where name = $1", [s1Pic, `${S2}/gift.webp`])).ok);
ok("removing the picture from the profile works", (await saveProfile(S1, "Sam Rivera", null, null)).ok && (await profileOf(S1)).avatar_path === null);
ok("owner deletes their old picture", (await tryQ(S1, "delete from storage.objects where name = $1", [s1Pic])).affected === 1);

console.log("\n— Teacher profiles —");
const teacherSave = await saveProfile(T1, "Ms Rivera", "star", null, "dark", "blue");
ok("teacher saves their own name, avatar and look", teacherSave.ok, teacherSave.error || "");
ok("teacher keeps the teacher role", (await profileOf(T1)).role === "teacher" && (await profileOf(T1)).theme === "dark");
const t1Pic = `${T1}/me.webp`;
ok("teacher uploads a picture into their own folder", (await putPicture(T1, t1Pic)).ok && (await saveProfile(T1, "Ms Rivera", null, t1Pic, "dark", "blue")).ok);
const seesTeacherPic = async (uid) => (await rows(uid, "select name from storage.objects where bucket_id = 'avatars'")).some((r) => r.name === t1Pic);
ok("teacher's picture: the teacher and their own students see it", (await seesTeacherPic(T1)) && (await seesTeacherPic(S1)) && (await seesTeacherPic(S2)));
ok("teacher's picture: other teachers and students of other classes don't", !(await seesTeacherPic(T2)) && !(await seesTeacherPic(S3)));
ok("a student can't put a picture in a teacher's folder", !(await putPicture(S1, `${T1}/fake.webp`)).ok);
ok("students see the new teacher name on class cards", (await rows(S1, "select teacher_name from public.my_class_teachers()"))[0]?.teacher_name === "Ms Rivera");
const cardTeacher = (await rows(S1, "select teacher_name, teacher_avatar_preset, teacher_avatar_path from public.my_class_teachers()"))[0];
ok("class cards also get the teacher's avatar and picture", cardTeacher?.teacher_avatar_path === t1Pic && cardTeacher?.teacher_avatar_preset === null);
ok("a student still can't see a classmate's picture", !(await rows(S2, "select name from storage.objects")).some((r) => r.name.startsWith(S1)));

console.log("\n— Teacher names on class cards —");
const teachersFor = async (uid) => (await rows(uid, "select class_id, teacher_name from public.my_class_teachers()")).map((r) => `${r.class_id === C1.id ? "Biology" : "History"}:${r.teacher_name}`).sort();
ok("student sees their class's teacher name", JSON.stringify(await teachersFor(S1)) === JSON.stringify(["Biology:Ms Rivera"]));
ok("another student sees only their own classes' teachers", JSON.stringify(await teachersFor(S3)) === JSON.stringify(["History:Teacher Two"]));
ok("students still can't read teacher profile rows", (await rows(S1, "select 1 from public.profiles where id = $1", [T1])).length === 0);
ok("signed-out visitors can't list teachers", !(await tryQ(null, "select * from public.my_class_teachers()")).ok);

console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
process.exitCode = failures ? 1 : 0;
