-- Neuro-Focus: student profiles (display name, profile picture, appearance).
-- Run after 20261006000000_live_workflow_hardening.sql. Safe to run more than once.
--
-- 1. Profile settings on public.profiles: a built-in avatar or an uploaded picture, a theme and an
--    accent colour. Profiles still can't be edited directly: students change their own profile
--    only through update_my_profile(), which checks every value and never touches the role.
-- 2. A private "avatars" storage bucket. Each person uploads, replaces and deletes pictures only in
--    their own folder (<user id>/...). A picture can be read by its owner and by the teachers of
--    classes the owner is in (through short-lived signed links). It is never public.
-- 3. my_class_teachers(): the teacher's display name for each class the signed-in student is in,
--    without giving students access to the teacher's profile row.

-- ============================================================
-- 1. Profile settings
-- ============================================================
alter table public.profiles add column if not exists avatar_preset text;
alter table public.profiles add column if not exists avatar_path text;
alter table public.profiles add column if not exists theme text not null default 'default';
alter table public.profiles add column if not exists accent text not null default 'default';
alter table public.profiles add column if not exists updated_at timestamptz not null default now();

alter table public.profiles drop constraint if exists profiles_avatar_preset_check;
alter table public.profiles add constraint profiles_avatar_preset_check
  check (avatar_preset is null or avatar_preset in ('spark', 'rocket', 'leaf', 'planet', 'book', 'bolt', 'wave', 'star'));
alter table public.profiles drop constraint if exists profiles_avatar_path_check;
alter table public.profiles add constraint profiles_avatar_path_check
  check (avatar_path is null or avatar_path ~ ('^' || id::text || '/[A-Za-z0-9_-]{1,64}\.(jpg|png|webp)$'));
alter table public.profiles drop constraint if exists profiles_theme_check;
alter table public.profiles add constraint profiles_theme_check check (theme in ('default', 'light', 'dark'));
alter table public.profiles drop constraint if exists profiles_accent_check;
alter table public.profiles add constraint profiles_accent_check check (accent in ('default', 'blue', 'purple', 'green', 'orange'));

-- Profiles are written only by the sign-up trigger and the functions below.
revoke insert, update, delete on public.profiles from anon, authenticated;

create or replace function public.update_my_profile(
  p_display_name text,
  p_avatar_preset text default null,
  p_avatar_path text default null,
  p_theme text default 'default',
  p_accent text default 'default'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_name text := regexp_replace(btrim(coalesce(p_display_name, '')), '\s+', ' ', 'g');
  v_profile public.profiles;
begin
  if v_uid is null then raise exception 'Sign in to update your profile.'; end if;

  if v_name = '' then
    raise exception 'Enter a display name.' using errcode = '22023';
  end if;
  if char_length(v_name) > 40 then
    raise exception 'Display names can be up to 40 characters.' using errcode = '22023';
  end if;
  if v_name ~ '[[:cntrl:]]' then
    raise exception 'Display names can only contain letters, numbers, spaces and punctuation.' using errcode = '22023';
  end if;

  if p_avatar_preset is not null and p_avatar_preset not in ('spark', 'rocket', 'leaf', 'planet', 'book', 'bolt', 'wave', 'star') then
    raise exception 'Choose one of the built-in avatars.' using errcode = '22023';
  end if;

  -- An uploaded picture must be in the signed-in person's own folder (the page uploads it first;
  -- storage rules stop anyone writing into another person's folder).
  if p_avatar_path is not null and p_avatar_path !~ ('^' || v_uid::text || '/[A-Za-z0-9_-]{1,64}\.(jpg|png|webp)$') then
    raise exception 'That picture can''t be used. Upload it again.' using errcode = '22023';
  end if;

  if coalesce(p_theme, '') not in ('default', 'light', 'dark') then
    raise exception 'Choose one of the themes.' using errcode = '22023';
  end if;
  if coalesce(p_accent, '') not in ('default', 'blue', 'purple', 'green', 'orange') then
    raise exception 'Choose one of the accent colours.' using errcode = '22023';
  end if;

  -- The role is never changed here.
  update public.profiles
  set display_name = v_name,
      avatar_path = p_avatar_path,
      avatar_preset = case when p_avatar_path is null then p_avatar_preset end,
      theme = p_theme,
      accent = p_accent,
      updated_at = now()
  where id = v_uid
  returning * into v_profile;
  if not found then raise exception 'Your profile could not be found. Sign out and in again.'; end if;

  return jsonb_build_object(
    'display_name', v_profile.display_name,
    'avatar_preset', v_profile.avatar_preset,
    'avatar_path', v_profile.avatar_path,
    'theme', v_profile.theme,
    'accent', v_profile.accent,
    'updated_at', v_profile.updated_at
  );
end;
$$;

-- ============================================================
-- 2. Private profile pictures
-- ============================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', false, 2097152, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- The account a picture belongs to: the first folder of its path, if that is a user id.
create or replace function public.avatar_owner_id(object_name text)
returns uuid
language sql
immutable
set search_path = ''
as $$
  select case
    when split_part(object_name, '/', 1) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then split_part(object_name, '/', 1)::uuid
  end;
$$;

drop policy if exists "avatars: owners upload into their own folder" on storage.objects;
create policy "avatars: owners upload into their own folder"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'avatars' and public.avatar_owner_id(name) = (select auth.uid()));

drop policy if exists "avatars: owners replace their own pictures" on storage.objects;
create policy "avatars: owners replace their own pictures"
  on storage.objects for update to authenticated
  using (bucket_id = 'avatars' and public.avatar_owner_id(name) = (select auth.uid()))
  with check (bucket_id = 'avatars' and public.avatar_owner_id(name) = (select auth.uid()));

drop policy if exists "avatars: owners delete their own pictures" on storage.objects;
create policy "avatars: owners delete their own pictures"
  on storage.objects for delete to authenticated
  using (bucket_id = 'avatars' and public.avatar_owner_id(name) = (select auth.uid()));

-- can_view_profile: the person themselves, or a teacher of a class they are in.
drop policy if exists "avatars: owners and their class teachers view" on storage.objects;
create policy "avatars: owners and their class teachers view"
  on storage.objects for select to authenticated
  using (bucket_id = 'avatars' and public.can_view_profile(public.avatar_owner_id(name)));

-- ============================================================
-- 3. Teacher names for a student's classes
-- ============================================================
create or replace function public.my_class_teachers()
returns table (class_id uuid, teacher_name text)
language sql
stable
security definer
set search_path = ''
as $$
  select c.id, p.display_name
  from public.class_members m
  join public.classes c on c.id = m.class_id
  join public.profiles p on p.id = c.teacher_id
  where m.student_id = (select auth.uid());
$$;

revoke all on function public.update_my_profile(text, text, text, text, text) from public, anon;
revoke all on function public.my_class_teachers() from public, anon;
grant execute on function public.update_my_profile(text, text, text, text, text) to authenticated;
grant execute on function public.my_class_teachers() to authenticated;
grant execute on function public.avatar_owner_id(text) to authenticated;
