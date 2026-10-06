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

console.log("\n— Class posts —");
const post = await tryQ(T1, "insert into public.class_posts (class_id, title, body) values ($1, 'Welcome', 'Quiz on Friday') returning id", [C1.id]);
ok("teacher posts an announcement in their class", post.ok, post.error || "");
ok("class members read it", (await rows(S1, "select body from public.class_posts")).some((r) => r.body === "Quiz on Friday"));
ok("students of other classes and other teachers don't", (await rows(S3, "select 1 from public.class_posts")).length === 0 && (await rows(T2, "select 1 from public.class_posts")).length === 0);
ok("students can't post", !(await tryQ(S1, "insert into public.class_posts (class_id, body) values ($1, 'hi')", [C1.id])).ok);
ok("another teacher can't post in this class", !(await tryQ(T2, "insert into public.class_posts (class_id, body) values ($1, 'hi')", [C1.id])).ok);
ok("a post can't be written as someone else", !(await tryQ(T1, "insert into public.class_posts (class_id, author_id, body) values ($1, $2, 'hi')", [C1.id, T2])).ok);
ok("students can't edit or delete posts", (await tryQ(S1, "update public.class_posts set body = 'x'")).affected === 0 && (await tryQ(S1, "delete from public.class_posts")).affected === 0);
ok("an empty post is refused", !(await tryQ(T1, "insert into public.class_posts (class_id, body) values ($1, '   ')", [C1.id])).ok);
ok("students' personal notes stay private (posts are a separate table)", (await rows(T1, "select 1 from public.student_notes")).length === 0);

console.log("\n— Assignments —");
const newAssignment = async (uid, classId, title, due, max = null) => tryQ(uid, "insert into public.assignments (class_id, title, instructions, due_at, max_marks) values ($1, $2, 'Read chapter 4', $3, $4) returning id", [classId, title, due, max]);
const open = await newAssignment(T1, C1.id, "Cells essay", new Date(Date.now() + 86400000).toISOString(), 10);
ok("teacher creates an assignment with a deadline and marks out of 10", open.ok, open.error || "");
const A1 = open.rows?.[0]?.id;
const closedA = await newAssignment(T1, C1.id, "Old worksheet", new Date(Date.now() - 3600000).toISOString());
const A2 = closedA.rows?.[0]?.id;
ok("students can't create assignments", !(await newAssignment(S1, C1.id, "Mine", null)).ok);
ok("another teacher can't add one to this class", !(await newAssignment(T2, C1.id, "Theirs", null)).ok);
ok("class members see the class's assignments", (await rows(S2, "select id from public.assignments")).length === 2);
ok("students of other classes don't", (await rows(S3, "select id from public.assignments")).length === 0);
ok("students can't change an assignment", (await tryQ(S1, "update public.assignments set due_at = null")).affected === 0);
// Attachment: only in that assignment's own folder, uploaded by the teacher.
const attachPath = `${C1.id}/assignments/${A1}/guide.pdf`;
const putFile = (uid, name) => tryQ(uid, "insert into storage.objects (bucket_id, name) values ('class-files', $1) returning id", [name]);
ok("teacher uploads an attachment", (await putFile(T1, attachPath)).ok);
ok("students can't upload attachments", !(await putFile(S1, `${C1.id}/assignments/${A1}/fake.pdf`)).ok);
ok("teacher saves the attachment on the assignment", (await tryQ(T1, "update public.assignments set attachment_path = $2, attachment_name = 'guide.pdf', attachment_size = 1000, attachment_type = 'application/pdf' where id = $1", [A1, attachPath])).affected === 1);
ok("an attachment from another folder is refused", !(await tryQ(T1, "update public.assignments set attachment_path = $2 where id = $1", [A1, `${C1.id}/assignments/${A2}/other.pdf`])).ok);
const seesFile = async (uid, name) => (await rows(uid, "select name from storage.objects where bucket_id = 'class-files'")).some((r) => r.name === name);
ok("class members can read the attachment", await seesFile(S1, attachPath));
ok("students of other classes can't", !(await seesFile(S3, attachPath)) && !(await seesFile(T2, attachPath)));

console.log("\n— Submissions —");
const subPath = (studentId, assignmentId, file) => `${C1.id}/submissions/${assignmentId}/${studentId}/${file}`;
const submit = (uid, assignmentId, path, name = "essay.pdf", size = 2048, type = "application/pdf") =>
  tryQ(uid, "select public.submit_assignment($1, $2, $3, $4, $5) as r", [assignmentId, path, name, size, type]);
const s1First = subPath(S1, A1, "a-essay.pdf");
ok("student uploads into their own submission folder", (await putFile(S1, s1First)).ok);
ok("student can't upload into a classmate's folder", !(await putFile(S1, subPath(S2, A1, "x.pdf"))).ok);
ok("student of another class can't upload here", !(await putFile(S3, subPath(S3, A1, "x.pdf"))).ok);
ok("nobody can upload after the deadline", !(await putFile(S1, subPath(S1, A2, "late.pdf"))).ok);
const first = await submit(S1, A1, s1First);
ok("student submits their file", first.ok && first.rows[0].r.submission.file_name === "essay.pdf", first.error || "");
const s1Second = subPath(S1, A1, "b-essay.pdf");
await putFile(S1, s1Second);
const second = await submit(S1, A1, s1Second, "essay-v2.pdf");
ok("replacing before the deadline keeps one submission and returns the old file to remove", second.ok && second.rows[0].r.previous_path === s1First
  && (await db.query("select count(*)::int n from public.assignment_submissions where assignment_id = $1 and student_id = $2", [A1, S1])).rows[0].n === 1);
ok("student removes their replaced file", (await tryQ(S1, "delete from storage.objects where name = $1", [s1First])).affected === 1);
ok("submitting a file that wasn't uploaded is refused", !(await submit(S1, A1, subPath(S1, A1, "missing.pdf"))).ok);
ok("submitting someone else's file is refused", !(await submit(S2, A1, s1Second)).ok);
ok("a disallowed file type is refused", !(await submit(S1, A1, s1Second, "virus.exe", 100, "application/x-msdownload")).ok);
ok("a file over 20 MB is refused", !(await submit(S1, A1, s1Second, "huge.pdf", 30 * 1024 * 1024)).ok);
ok("submitting after the deadline is refused", !(await submit(S1, A2, subPath(S1, A2, "late.pdf"))).ok);
ok("teachers can't submit", !(await submit(T1, A1, s1Second)).ok);
ok("students of other classes can't submit", !(await submit(S3, A1, s1Second)).ok);
ok("submission rows can't be written directly", !(await tryQ(S1, "insert into public.assignment_submissions (assignment_id, class_id, student_id, file_path, file_name, file_size, file_type) values ($1, $2, $3, 'x', 'x.pdf', 1, 'application/pdf')", [A1, C1.id, S1])).ok
  && !(await tryQ(S1, "update public.assignment_submissions set marks = 10")).ok);
const s2Path = subPath(S2, A1, "s2.pdf");
await putFile(S2, s2Path);
await submit(S2, A1, s2Path, "mine.pdf");
ok("a student sees only their own submission", JSON.stringify((await rows(S1, "select student_id from public.assignment_submissions")).map((r) => r.student_id)) === JSON.stringify([S1]));
ok("a student can't open a classmate's file", !(await seesFile(S2, s1Second)) && await seesFile(S1, s1Second));
ok("a classmate can't delete someone's file", (await tryQ(S2, "delete from storage.objects where name = $1", [s1Second])).affected === 0);
ok("the class's teacher sees every submission and file", (await rows(T1, "select 1 from public.assignment_submissions")).length === 2 && await seesFile(T1, s1Second) && await seesFile(T1, s2Path));
ok("other teachers and other classes see none", (await rows(T2, "select 1 from public.assignment_submissions")).length === 0 && !(await seesFile(T2, s1Second)) && !(await seesFile(S3, s1Second)));

console.log("\n— Marks and feedback —");
const subId = (await rows(T1, "select id from public.assignment_submissions where student_id = $1", [S1]))[0].id;
const mark = (uid, marks, feedback) => tryQ(uid, "select public.mark_submission($1, $2, $3) as r", [subId, marks, feedback]);
ok("teacher gives marks and feedback", (await mark(T1, 8.5, "Clear and well argued.")).ok);
ok("the student sees their marks and feedback", (await rows(S1, "select marks, feedback from public.assignment_submissions"))[0]?.feedback === "Clear and well argued." && Number((await rows(S1, "select marks from public.assignment_submissions"))[0]?.marks) === 8.5);
ok("marks above the assignment's maximum are refused", !(await mark(T1, 11, null)).ok);
ok("negative marks are refused", !(await mark(T1, -1, null)).ok);
ok("feedback without marks is allowed", (await mark(T1, null, "See me after class.")).ok);
ok("students can't mark", !(await mark(S1, 10, "self-marked")).ok);
ok("another teacher can't mark", !(await mark(T2, 10, null)).ok);
ok("a classmate can't read the feedback", (await rows(S2, "select feedback from public.assignment_submissions where student_id = $1", [S1])).length === 0);

console.log("\n— Quizzes: drafts and questions —");
const quizIns = await tryQ(T1, "insert into public.quizzes (class_id, title, time_limit_seconds, show_leaderboard) values ($1, 'Cells quiz', 30, true) returning id", [C1.id]);
ok("teacher creates a quiz draft", quizIns.ok, quizIns.error || "");
const Q = quizIns.rows?.[0]?.id;
const addQ = (uid, pos, prompt, options, correct) => tryQ(uid, "insert into public.quiz_questions (quiz_id, position, prompt, options, correct_index) values ($1, $2, $3, $4, $5) returning id", [Q, pos, prompt, options, correct]);
const q1 = (await addQ(T1, 0, "Powerhouse of the cell?", ["Nucleus", "Mitochondria", "Ribosome"], 1)).rows?.[0]?.id;
const q2 = (await addQ(T1, 1, "Holds DNA?", ["Nucleus", "Membrane"], 0)).rows?.[0]?.id;
ok("teacher adds questions", Boolean(q1 && q2));
ok("a question needs at least two choices", !(await addQ(T1, 2, "Bad", ["Only one"], 0)).ok);
ok("the correct choice must be one of the choices", !(await addQ(T1, 2, "Bad", ["A", "B"], 5)).ok);
ok("students can't add questions", !(await addQ(S1, 2, "Mine", ["A", "B"], 0)).ok);
ok("another teacher can't create a quiz in this class", !(await tryQ(T2, "insert into public.quizzes (class_id, title) values ($1, 'x')", [C1.id])).ok);
ok("a quiz can't be created already running", !(await tryQ(T1, "insert into public.quizzes (class_id, title, status) values ($1, 'x', 'live')", [C1.id])).ok);
ok("students can't see a draft", (await rows(S1, "select 1 from public.quizzes")).length === 0);
ok("students can never read questions or answers directly", (await rows(S1, "select 1 from public.quiz_questions")).length === 0);
ok("students can't read a draft's state either", !(await tryQ(S1, "select public.quiz_state($1)", [Q])).ok);
ok("students can't start the quiz", !(await tryQ(S1, "select public.quiz_open_lobby($1)", [Q])).ok);
ok("another teacher can't start it", !(await tryQ(T2, "select public.quiz_open_lobby($1)", [Q])).ok);
ok("a teacher can't jump a draft to running directly", (await tryQ(T1, "update public.quizzes set status = 'live' where id = $1", [Q])).ok === false);

console.log("\n— Quizzes: lobby and joining —");
ok("teacher opens the lobby", (await tryQ(T1, "select public.quiz_open_lobby($1)", [Q])).ok);
ok("questions can't be changed once opened", (await tryQ(T1, "update public.quiz_questions set correct_index = 0 where id = $1", [q1])).affected === 0);
ok("class members now see the quiz", (await rows(S1, "select id from public.quizzes")).some((r) => r.id === Q));
ok("students of other classes don't", (await rows(S3, "select 1 from public.quizzes")).length === 0 && !(await tryQ(S3, "select public.quiz_state($1)", [Q])).ok);
ok("a student of another class can't join", !(await tryQ(S3, "select public.join_quiz($1)", [Q])).ok);
ok("teachers can't join as players", !(await tryQ(T1, "select public.join_quiz($1)", [Q])).ok);
ok("students join explicitly", (await tryQ(S1, "select public.join_quiz($1)", [Q])).ok && (await tryQ(S2, "select public.join_quiz($1)", [Q])).ok);
ok("joining again (a reconnect) is harmless", (await tryQ(S1, "select public.join_quiz($1)", [Q])).ok
  && (await db.query("select count(*)::int n from public.quiz_participants where quiz_id = $1", [Q])).rows[0].n === 2);
ok("students can't add themselves to participants directly", !(await tryQ(S1, "insert into public.quiz_participants (quiz_id, student_id) values ($1, $2)", [Q, S1])).ok);
const stateOf = async (uid) => (await rows(uid, "select public.quiz_state($1) as s", [Q]))[0].s;
ok("the teacher sees who joined", JSON.stringify((await stateOf(T1)).participant_names) === JSON.stringify(["Sam Rivera", "Student Two"]), JSON.stringify((await stateOf(T1)).participant_names));
ok("students don't see the list of who joined", (await stateOf(S1)).participant_names === null);

console.log("\n— Quizzes: answering —");
ok("answering in the lobby is refused", !(await tryQ(S1, "select public.submit_quiz_answer($1, $2, 1)", [Q, q1])).ok);
ok("teacher shows the first question", (await tryQ(T1, "select public.quiz_next_question($1)", [Q])).ok);
const s1Live = await stateOf(S1);
ok("students see the question and choices", s1Live.question?.prompt === "Powerhouse of the cell?" && s1Live.question.options.length === 3);
ok("the correct choice is hidden while the question is open", s1Live.question.correct_index === null && s1Live.question.counts === null);
ok("the teacher sees the correct choice", (await stateOf(T1)).question.correct_index === 1);
const answer = (uid, qid, choice) => tryQ(uid, "select public.submit_quiz_answer($1, $2, $3) as r", [Q, qid, choice]);
const a1 = await answer(S1, q1, 1);
ok("a student answers", a1.ok && a1.rows[0].r.accepted === true);
const again = await answer(S1, q1, 0);
ok("a second answer is ignored and the first kept", again.ok && again.rows[0].r.accepted === false && again.rows[0].r.choice === 1
  && (await db.query("select count(*)::int n from public.quiz_answers where question_id = $1 and student_id = $2", [q1, S1])).rows[0].n === 1);
ok("an invalid choice is refused", !(await answer(S2, q1, 7)).ok);
ok("answering a question that isn't showing is refused", !(await answer(S2, q2, 0)).ok);
ok("a student of another class can't answer", !(await answer(S3, q1, 1)).ok);
ok("answers can't be written directly", !(await tryQ(S2, "insert into public.quiz_answers (quiz_id, question_id, student_id, choice, is_correct, points) values ($1, $2, $3, 1, true, 100)", [Q, q1, S2])).ok);
ok("students can't read anyone's answers directly", (await rows(S1, "select 1 from public.quiz_answers")).length === 0);
// The timer runs out (moved into the past here): answers are refused and the answer is revealed.
await db.query("update public.quizzes set question_closes_at = now() - interval '1 second' where id = $1", [Q]);
ok("answering after the timer ran out is refused", !(await answer(S2, q1, 1)).ok);
const s1Closed = await stateOf(S1);
ok("once closed, students see the correct choice and how everyone answered", s1Closed.question.correct_index === 1 && JSON.stringify(s1Closed.question.counts) === "[0,1,0]" && s1Closed.question.my_correct === true);
ok("students can't move the quiz on", !(await tryQ(S1, "select public.quiz_next_question($1)", [Q])).ok);
ok("teacher shows the next question", (await tryQ(T1, "select public.quiz_next_question($1)", [Q])).ok);
ok("moving on before revealing is refused", !(await tryQ(T1, "select public.quiz_next_question($1)", [Q])).ok);
ok("one student answers the second question (wrongly)", (await answer(S1, q2, 1)).ok);
ok("teacher reveals it", (await tryQ(T1, "select public.quiz_close_question($1)", [Q])).ok);
ok("a new answer after the reveal is refused", !(await answer(S2, q2, 0)).ok);
ok("after the last question, Next finishes the quiz", (await tryQ(T1, "select public.quiz_next_question($1)", [Q])).ok && (await stateOf(T1)).quiz.status === "finished");

console.log("\n— Quizzes: results —");
const resultsOf = async (uid) => (await rows(uid, "select public.quiz_results($1) as r", [Q]))[0].r;
const r1 = await resultsOf(S1);
ok("scores are worked out by the database: 1 point per correct answer", r1.mine.score === 1 && r1.mine.answered === 2 && r1.question_count === 2);
ok("a student's summary shows their answers and the correct ones", r1.mine.questions.length === 2 && r1.mine.questions[0].correct === true && r1.mine.questions[1].correct === false && r1.mine.questions[1].correct_index === 0);
ok("with the leaderboard on, students see it after the quiz", r1.leaderboard.length === 2 && r1.leaderboard.some((r) => r.is_me) && r1.leaderboard.every((r) => r.student_id === null));
const r2 = await resultsOf(S2);
ok("the other student's score is right too (missed by the timer, then too late)", r2.mine.score === 0 && r2.mine.answered === 0);
ok("the teacher sees every student's score", (await resultsOf(T1)).leaderboard.map((r) => r.score).sort().join() === "0,1");
ok("students of other classes can't see results", !(await tryQ(S3, "select public.quiz_results($1)", [Q])).ok);
// Without a leaderboard, students only see their own result.
const quiet = (await rows(T1, "insert into public.quizzes (class_id, title, show_leaderboard) values ($1, 'Quiet quiz', false) returning id", [C1.id]))[0].id;
await rows(T1, "insert into public.quiz_questions (quiz_id, position, prompt, options, correct_index) values ($1, 0, 'Q', '{A,B}', 0)", [quiet]);
await rows(T1, "select public.quiz_open_lobby($1)", [quiet]);
await rows(S1, "select public.join_quiz($1)", [quiet]);
await rows(T1, "select public.quiz_next_question($1)", [quiet]);
const quietQ = (await db.query("select id from public.quiz_questions where quiz_id = $1", [quiet])).rows[0].id;
ok("a class member who didn't join can't answer", !(await tryQ(S2, "select public.submit_quiz_answer($1, $2, 0)", [quiet, quietQ])).ok);
await rows(T1, "select public.quiz_close_question($1)", [quiet]);
await rows(T1, "select public.quiz_finish($1)", [quiet]);
ok("with the leaderboard off, students see only their own result", (await rows(S1, "select public.quiz_results($1) as r", [quiet]))[0].r.leaderboard === null);
ok("quiz points have nothing to do with attention: no attention tables are touched", (await db.query("select count(*)::int n from public.quiz_answers where points > 1")).rows[0].n === 0);

console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
process.exitCode = failures ? 1 : 0;
