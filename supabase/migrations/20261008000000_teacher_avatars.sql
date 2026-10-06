-- Neuro-Focus: show each class's teacher (name and picture) on their students' class cards.
-- Run after 20261007000000_student_profiles.sql. Safe to run more than once.
--
-- 1. my_class_teachers() also returns the teacher's built-in avatar and picture path, still
--    without giving students access to the teacher's profile row.
-- 2. A teacher's uploaded picture can now also be viewed by students in that teacher's classes
--    (through the same short-lived signed links). Nobody else can see it, and it is never public.
--    Students' pictures are unchanged: only the student and their class teachers can see them.

-- ============================================================
-- 1. Teacher name and avatar for each of the student's classes
-- ============================================================
-- The result columns change, so the function is replaced rather than altered.
drop function if exists public.my_class_teachers();
create function public.my_class_teachers()
returns table (class_id uuid, teacher_name text, teacher_avatar_preset text, teacher_avatar_path text)
language sql
stable
security definer
set search_path = ''
as $$
  select c.id, p.display_name, p.avatar_preset, p.avatar_path
  from public.class_members m
  join public.classes c on c.id = m.class_id
  join public.profiles p on p.id = c.teacher_id
  where m.student_id = (select auth.uid());
$$;

revoke all on function public.my_class_teachers() from public, anon;
grant execute on function public.my_class_teachers() to authenticated;

-- ============================================================
-- 2. Students may view their own teachers' pictures
-- ============================================================
-- True when the signed-in student is in a class taught by target_teacher.
create or replace function public.is_my_class_teacher(target_teacher uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.classes c
    join public.class_members m on m.class_id = c.id
    where c.teacher_id = target_teacher and m.student_id = (select auth.uid())
  );
$$;

revoke all on function public.is_my_class_teacher(uuid) from public, anon;
grant execute on function public.is_my_class_teacher(uuid) to authenticated;

drop policy if exists "avatars: owners and their class teachers view" on storage.objects;
drop policy if exists "avatars: owners, their class teachers and their teachers' students view" on storage.objects;
create policy "avatars: owners, their class teachers and their teachers' students view"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'avatars'
    and (
      public.can_view_profile(public.avatar_owner_id(name))       -- the owner, or a teacher of their class
      or public.is_my_class_teacher(public.avatar_owner_id(name)) -- a student viewing their own teacher
    )
  );
