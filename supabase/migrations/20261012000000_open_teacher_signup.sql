-- Neuro-Focus: open teacher sign-up (no manual approval).
-- Run after 20261011000000_class_quizzes.sql. Safe to run more than once.
--
-- Before: every new account was a student, and a project owner promoted teachers by hand.
-- Now: the role picked on "Create account" is the role the account gets.
--   * Email sign-up sends role_request = 'teacher' or 'student' with the sign-up; the trigger
--     below reads it. Anything else becomes a student.
--   * Google sign-up can't send extra details, so the sign-in page calls choose_teacher_role()
--     right after a brand-new Google account comes back. It only works on an account that was
--     created in the last 15 minutes, is still a student and hasn't joined any class, so it
--     can't be used later to turn an existing student into a teacher.
-- A teacher can still only see the classes they create and the students who join them.
-- One-off: earlier teacher requests that are still waiting (student accounts that asked to be a
-- teacher at sign-up and haven't joined any class) become teachers.

-- ============================================================
-- 1. New accounts get the role they picked
-- ============================================================
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name, role)
  values (
    new.id,
    coalesce(nullif(btrim(new.raw_user_meta_data ->> 'full_name'), ''), 'Student'),
    case when new.raw_user_meta_data ->> 'role_request' = 'teacher' then 'teacher' else 'student' end
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

-- ============================================================
-- 2. Teacher role for brand-new Google accounts
-- ============================================================
create or replace function public.choose_teacher_role()
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Sign in first.';
  end if;
  if exists (select 1 from public.profiles p where p.id = v_uid and p.role = 'teacher') then
    return 'teacher';
  end if;
  if not exists (
    select 1 from auth.users u where u.id = v_uid and u.created_at > now() - interval '15 minutes'
  ) then
    raise exception 'Only a new account can choose to be a teacher.';
  end if;
  if exists (select 1 from public.class_members m where m.student_id = v_uid) then
    raise exception 'This account has already joined a class as a student.';
  end if;

  update public.profiles set role = 'teacher' where id = v_uid and role = 'student';
  return 'teacher';
end;
$$;

revoke all on function public.choose_teacher_role() from public, anon;
grant execute on function public.choose_teacher_role() to authenticated;

-- ============================================================
-- 3. Approve the teacher requests that were waiting
-- ============================================================
update public.profiles p
set role = 'teacher'
from auth.users u
where u.id = p.id
  and p.role = 'student'
  and u.raw_user_meta_data ->> 'role_request' = 'teacher'
  and not exists (select 1 from public.class_members m where m.student_id = p.id);
