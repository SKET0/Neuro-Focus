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
  -- pgcrypto stand-in (only used for join passwords)
  create function extensions.gen_salt(text, integer default 0) returns text language sql as $$ select 'salt' $$;
  create function extensions.crypt(p text, s text) returns text language sql as $$ select split_part(s, '$', 1) || '$' || md5(p || split_part(s, '$', 1)) $$;
  -- Supabase gives anon/authenticated full privileges on new public tables by default; RLS does the rest.
  alter default privileges in schema public grant all on tables to anon, authenticated;
  alter default privileges in schema public grant all on functions to anon, authenticated;
  alter default privileges in schema public grant all on sequences to anon, authenticated;
`);

const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
for (const file of files) {
  const sql = readFileSync(join(dir, file), "utf8").replace(/create extension if not exists pgcrypto[^;]*;/i, "");
  try { await db.exec(sql); await db.exec(sql); } catch (e) { console.log(`✗ migration ${file} failed: ${e.message}`); process.exit(1); }
}
console.log(`ran ${files.length} migrations twice each ✓\n`);

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
ok("student can't make themselves a teacher", (await tryQ(S1, "update public.profiles set role = 'teacher' where id = $1", [S1])).affected === 0);
ok("student can't add themselves to a class directly", !(await tryQ(S1, "insert into public.class_members (class_id, student_id) values ($1, $2)", [C2.id, S1])).ok);
ok("student can't remove a classmate", (await tryQ(S1, "delete from public.class_members where student_id = $1", [S2])).affected === 0);
ok("other teacher can't remove Biology students", (await tryQ(T2, "delete from public.class_members where class_id = $1", [C1.id])).affected === 0);
ok("AI usage counters are unreadable", !(await tryQ(S1, "select * from public.ai_usage_limits")).ok);

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

console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
process.exitCode = failures ? 1 : 0;
