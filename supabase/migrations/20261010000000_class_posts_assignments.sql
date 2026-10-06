-- Neuro-Focus: class Posts and Assignments.
-- Run after 20261009000000_tracking_quality.sql. Safe to run more than once. Adds tables, a
-- private storage bucket and two functions; it doesn't change any existing table or row.
--
-- 1. class_posts: announcements. Only the class's teacher writes them; the teacher and the
--    class's students read them.
-- 2. assignments: title, instructions, optional deadline, optional "marks out of" and an optional
--    attachment. Only the class's teacher writes them; the teacher and the class's students read them.
-- 3. assignment_submissions: one file per student per assignment. A student sees only their own;
--    the class's teacher sees all of them. Rows can't be written directly: students submit with
--    submit_assignment() (class member, before the deadline, their own uploaded file, allowed type
--    and size) and teachers mark with mark_submission() (their own class, marks in range).
-- 4. The private "class-files" storage bucket (20 MB per file, documents and images only):
--      <class id>/assignments/<assignment id>/<file>               teacher uploads; class reads
--      <class id>/submissions/<assignment id>/<student id>/<file>  that student (before the
--                                                                   deadline) and the teacher
--    Files are only ever reached through short-lived signed links; nothing is public.
-- Personal notes (student_notes) are separate and unchanged.

-- ============================================================
-- 1. Posts
-- ============================================================
create table if not exists public.class_posts (
  id uuid primary key default gen_random_uuid(),
  class_id uuid not null references public.classes(id) on delete cascade,
  author_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  title text check (title is null or char_length(title) between 1 and 200),
  body text not null check (char_length(btrim(body)) between 1 and 5000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists class_posts_class_idx on public.class_posts(class_id, created_at desc);
alter table public.class_posts enable row level security;

drop policy if exists "class posts: teacher and members read" on public.class_posts;
create policy "class posts: teacher and members read"
  on public.class_posts for select to authenticated
  using (public.is_class_teacher(class_id) or public.is_class_member(class_id));

drop policy if exists "class posts: teacher writes" on public.class_posts;
create policy "class posts: teacher writes"
  on public.class_posts for insert to authenticated
  with check (author_id = (select auth.uid()) and public.is_class_teacher(class_id));

drop policy if exists "class posts: teacher edits" on public.class_posts;
create policy "class posts: teacher edits"
  on public.class_posts for update to authenticated
  using (public.is_class_teacher(class_id))
  with check (public.is_class_teacher(class_id));

drop policy if exists "class posts: teacher deletes" on public.class_posts;
create policy "class posts: teacher deletes"
  on public.class_posts for delete to authenticated
  using (public.is_class_teacher(class_id));

revoke all on public.class_posts from anon, authenticated;
grant select, insert, delete on public.class_posts to authenticated;
grant update (title, body, updated_at) on public.class_posts to authenticated;

-- ============================================================
-- 2. Assignments
-- ============================================================
create table if not exists public.assignments (
  id uuid primary key default gen_random_uuid(),
  class_id uuid not null references public.classes(id) on delete cascade,
  created_by uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 1 and 200),
  instructions text not null default '' check (char_length(instructions) <= 10000),
  due_at timestamptz,
  max_marks numeric(6, 2) check (max_marks is null or (max_marks > 0 and max_marks <= 1000)),
  attachment_path text,
  attachment_name text check (attachment_name is null or char_length(attachment_name) between 1 and 255),
  attachment_size integer check (attachment_size is null or attachment_size between 1 and 20971520),
  attachment_type text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- An attachment can only live in this assignment's own folder.
  constraint assignments_attachment_in_folder check (
    attachment_path is null or attachment_path like class_id::text || '/assignments/' || id::text || '/%'
  )
);
create index if not exists assignments_class_idx on public.assignments(class_id, created_at desc);
alter table public.assignments enable row level security;

drop policy if exists "assignments: teacher and members read" on public.assignments;
create policy "assignments: teacher and members read"
  on public.assignments for select to authenticated
  using (public.is_class_teacher(class_id) or public.is_class_member(class_id));

drop policy if exists "assignments: teacher creates" on public.assignments;
create policy "assignments: teacher creates"
  on public.assignments for insert to authenticated
  with check (created_by = (select auth.uid()) and public.is_class_teacher(class_id));

drop policy if exists "assignments: teacher edits" on public.assignments;
create policy "assignments: teacher edits"
  on public.assignments for update to authenticated
  using (public.is_class_teacher(class_id))
  with check (public.is_class_teacher(class_id));

drop policy if exists "assignments: teacher deletes" on public.assignments;
create policy "assignments: teacher deletes"
  on public.assignments for delete to authenticated
  using (public.is_class_teacher(class_id));

revoke all on public.assignments from anon, authenticated;
grant select, insert, delete on public.assignments to authenticated;
grant update (title, instructions, due_at, max_marks, attachment_path, attachment_name, attachment_size, attachment_type, updated_at)
  on public.assignments to authenticated;

-- ============================================================
-- 3. Submissions
-- ============================================================
create table if not exists public.assignment_submissions (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null references public.assignments(id) on delete cascade,
  class_id uuid not null references public.classes(id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  file_path text not null,
  file_name text not null check (char_length(file_name) between 1 and 255),
  file_size integer not null check (file_size between 1 and 20971520),
  file_type text not null,
  submitted_at timestamptz not null default now(),
  marks numeric(6, 2) check (marks is null or marks >= 0),
  feedback text check (feedback is null or char_length(feedback) <= 5000),
  marked_at timestamptz,
  marked_by uuid references public.profiles(id) on delete set null,
  unique (assignment_id, student_id)
);
create index if not exists assignment_submissions_assignment_idx on public.assignment_submissions(assignment_id);
create index if not exists assignment_submissions_student_idx on public.assignment_submissions(student_id);
alter table public.assignment_submissions enable row level security;

-- A student sees only their own submissions; the class's teacher sees all of the class's.
drop policy if exists "submissions: own or class teacher read" on public.assignment_submissions;
create policy "submissions: own or class teacher read"
  on public.assignment_submissions for select to authenticated
  using (student_id = (select auth.uid()) or public.is_class_teacher(class_id));

-- No direct writes: submit_assignment() and mark_submission() below do all the checks.
revoke all on public.assignment_submissions from anon, authenticated;
grant select on public.assignment_submissions to authenticated;

-- ---------- File rules shared by the bucket and the functions ----------
create or replace function public.class_file_uuid(object_name text, part integer)
returns uuid
language sql
immutable
set search_path = ''
as $$
  select case
    when split_part(object_name, '/', part) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then split_part(object_name, '/', part)::uuid
  end;
$$;

-- Documents and images only, checked by both the file's type and its extension.
create or replace function public.class_file_type_ok(file_name text, file_type text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select lower(coalesce(file_type, '')) = any (array[
      'application/pdf', 'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.oasis.opendocument.text', 'application/vnd.oasis.opendocument.spreadsheet',
      'application/vnd.oasis.opendocument.presentation', 'application/rtf', 'text/plain', 'text/csv',
      'image/png', 'image/jpeg', 'image/webp', 'image/gif'])
    and lower(coalesce(file_name, '')) ~ '\.(pdf|doc|docx|ppt|pptx|xls|xlsx|odt|ods|odp|rtf|txt|csv|png|jpg|jpeg|webp|gif)$';
$$;

-- Whether files can be added under an assignment's folder: it exists in that class, and for a
-- submission the deadline hasn't passed.
create or replace function public.class_file_assignment_open(target_class uuid, target_assignment uuid, for_submission boolean)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.assignments a
    where a.id = target_assignment and a.class_id = target_class
      and (not for_submission or a.due_at is null or now() <= a.due_at)
  );
$$;

revoke all on function public.class_file_uuid(text, integer) from public, anon;
revoke all on function public.class_file_type_ok(text, text) from public, anon;
revoke all on function public.class_file_assignment_open(uuid, uuid, boolean) from public, anon;
grant execute on function public.class_file_uuid(text, integer) to authenticated;
grant execute on function public.class_file_type_ok(text, text) to authenticated;
grant execute on function public.class_file_assignment_open(uuid, uuid, boolean) to authenticated;

-- ---------- Submitting (students) ----------
-- Records (or replaces) the student's file for an assignment, after uploading it to their own
-- folder. Returns { submission, previous_path } so the old file can be removed.
create or replace function public.submit_assignment(
  p_assignment_id uuid, p_file_path text, p_file_name text, p_file_size integer, p_file_type text
)
returns json
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_assignment public.assignments;
  v_previous text;
  v_row public.assignment_submissions;
begin
  if v_uid is null or not exists (select 1 from public.profiles p where p.id = v_uid and p.role = 'student') then
    raise exception 'Only students can submit assignments.' using errcode = '42501';
  end if;
  select * into v_assignment from public.assignments where id = p_assignment_id;
  if not found or not public.is_class_member(v_assignment.class_id) then
    raise exception 'You can only submit to assignments in your own classes.' using errcode = '42501';
  end if;
  if v_assignment.due_at is not null and now() > v_assignment.due_at then
    raise exception 'The deadline has passed, so this assignment can no longer be submitted or replaced.' using errcode = 'P0001';
  end if;
  if p_file_path is null
     or p_file_path not like v_assignment.class_id::text || '/submissions/' || v_assignment.id::text || '/' || v_uid::text || '/%' then
    raise exception 'The file must be uploaded to your own submission folder.' using errcode = '42501';
  end if;
  if not exists (select 1 from storage.objects o where o.bucket_id = 'class-files' and o.name = p_file_path) then
    raise exception 'The uploaded file was not found. Upload it again.' using errcode = 'P0001';
  end if;
  if not public.class_file_type_ok(p_file_name, p_file_type) then
    raise exception 'That file type isn''t allowed. Use a document (PDF, Word, PowerPoint, Excel, text) or an image.' using errcode = 'P0001';
  end if;
  if p_file_size is null or p_file_size < 1 or p_file_size > 20971520 then
    raise exception 'Files must be smaller than 20 MB.' using errcode = 'P0001';
  end if;

  select file_path into v_previous from public.assignment_submissions
  where assignment_id = v_assignment.id and student_id = v_uid;

  insert into public.assignment_submissions (assignment_id, class_id, student_id, file_path, file_name, file_size, file_type, submitted_at)
  values (v_assignment.id, v_assignment.class_id, v_uid, p_file_path, left(p_file_name, 255), p_file_size, lower(p_file_type), now())
  on conflict (assignment_id, student_id) do update
    set file_path = excluded.file_path, file_name = excluded.file_name, file_size = excluded.file_size,
        file_type = excluded.file_type, submitted_at = excluded.submitted_at
  returning * into v_row;

  return json_build_object('submission', row_to_json(v_row), 'previous_path', nullif(v_previous, p_file_path));
end;
$$;

-- ---------- Marking (teachers) ----------
-- Optional marks (0 up to the assignment's "out of", or 1000 when none is set) and feedback.
create or replace function public.mark_submission(p_submission_id uuid, p_marks numeric, p_feedback text)
returns json
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.assignment_submissions;
  v_max numeric;
begin
  select * into v_row from public.assignment_submissions where id = p_submission_id;
  if not found or not public.is_class_teacher(v_row.class_id) then
    raise exception 'Only the class''s teacher can mark this submission.' using errcode = '42501';
  end if;
  select max_marks into v_max from public.assignments where id = v_row.assignment_id;
  if p_marks is not null and (p_marks < 0 or p_marks > coalesce(v_max, 1000)) then
    raise exception 'Marks must be between 0 and %.', coalesce(v_max, 1000) using errcode = 'P0001';
  end if;
  if p_feedback is not null and char_length(p_feedback) > 5000 then
    raise exception 'Feedback must be 5000 characters or fewer.' using errcode = 'P0001';
  end if;
  update public.assignment_submissions
    set marks = p_marks,
        feedback = nullif(btrim(coalesce(p_feedback, '')), ''),
        marked_at = case when p_marks is null and nullif(btrim(coalesce(p_feedback, '')), '') is null then null else now() end,
        marked_by = v_uid
  where id = p_submission_id
  returning * into v_row;
  return row_to_json(v_row);
end;
$$;

revoke all on function public.submit_assignment(uuid, text, text, integer, text) from public, anon;
revoke all on function public.mark_submission(uuid, numeric, text) from public, anon;
grant execute on function public.submit_assignment(uuid, text, text, integer, text) to authenticated;
grant execute on function public.mark_submission(uuid, numeric, text) to authenticated;

-- ============================================================
-- 4. Private file storage
-- ============================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('class-files', 'class-files', false, 20971520, array[
  'application/pdf', 'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.oasis.opendocument.text', 'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.presentation', 'application/rtf', 'text/plain', 'text/csv',
  'image/png', 'image/jpeg', 'image/webp', 'image/gif'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "class files: read" on storage.objects;
create policy "class files: read"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'class-files'
    and (
      public.is_class_teacher(public.class_file_uuid(name, 1))
      or (split_part(name, '/', 2) = 'assignments' and public.is_class_member(public.class_file_uuid(name, 1)))
      or (split_part(name, '/', 2) = 'submissions'
          and public.class_file_uuid(name, 4) = (select auth.uid())
          and public.is_class_member(public.class_file_uuid(name, 1)))
    )
  );

drop policy if exists "class files: upload" on storage.objects;
create policy "class files: upload"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'class-files'
    and (
      (split_part(name, '/', 2) = 'assignments'
        and public.is_class_teacher(public.class_file_uuid(name, 1))
        and public.class_file_assignment_open(public.class_file_uuid(name, 1), public.class_file_uuid(name, 3), false))
      or (split_part(name, '/', 2) = 'submissions'
        and public.class_file_uuid(name, 4) = (select auth.uid())
        and public.is_class_member(public.class_file_uuid(name, 1))
        and public.class_file_assignment_open(public.class_file_uuid(name, 1), public.class_file_uuid(name, 3), true))
    )
  );

-- Removing a file: the class's teacher any file of their class (attachments, and everything when
-- an assignment is deleted); a student their own submission files, before the deadline (used when
-- a submission is replaced).
drop policy if exists "class files: delete" on storage.objects;
create policy "class files: delete"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'class-files'
    and (
      public.is_class_teacher(public.class_file_uuid(name, 1))
      or (split_part(name, '/', 2) = 'submissions'
        and public.class_file_uuid(name, 4) = (select auth.uid())
        and public.class_file_assignment_open(public.class_file_uuid(name, 1), public.class_file_uuid(name, 3), true))
    )
  );
-- No update policy: files are never changed in place; a replacement is a new file.
