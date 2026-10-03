-- Neuro-Focus class membership and access rules.
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default 'Student',
  role text not null default 'student' check (role in ('student', 'teacher')),
  created_at timestamptz not null default now()
);

create table if not exists public.classes (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null references public.profiles(id) on delete cascade,
  name text not null check (char_length(name) between 2 and 80),
  join_code text not null unique,
  join_password_protected boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.classes add column if not exists join_password_protected boolean not null default false;

create table if not exists public.class_access (
  class_id uuid primary key references public.classes(id) on delete cascade,
  join_password_hash text
);

create table if not exists public.class_members (
  class_id uuid not null references public.classes(id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (class_id, student_id)
);

create table if not exists public.class_notes (
  class_id uuid not null references public.classes(id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  note_text text not null default '' check (char_length(note_text) <= 20000),
  updated_at timestamptz not null default now(),
  primary key (class_id, student_id)
);

create table if not exists public.ai_usage_limits (
  student_id uuid not null references public.profiles(id) on delete cascade,
  usage_date date not null default current_date,
  request_count integer not null default 0 check (request_count between 0 and 30),
  primary key (student_id, usage_date)
);

create index if not exists classes_teacher_id_idx on public.classes(teacher_id);
create index if not exists class_members_student_id_idx on public.class_members(student_id);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Never grant teacher privileges from user-editable signup metadata.
  insert into public.profiles (id, display_name, role)
  values (
    new.id,
    coalesce(nullif(btrim(new.raw_user_meta_data ->> 'full_name'), ''), 'Student'),
    'student'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- Backfill accounts that were created before this migration was installed.
insert into public.profiles (id, display_name, role)
select
  u.id,
  coalesce(nullif(btrim(u.raw_user_meta_data ->> 'full_name'), ''), 'Student'),
  'student'
from auth.users u
on conflict (id) do nothing;

create or replace function public.is_class_teacher(target_class uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.classes c
    where c.id = target_class and c.teacher_id = (select auth.uid())
  );
$$;

create or replace function public.is_class_member(target_class uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.class_members m
    where m.class_id = target_class and m.student_id = (select auth.uid())
  );
$$;

create or replace function public.can_view_profile(target_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select target_user = (select auth.uid()) or exists (
    select 1
    from public.class_members m
    join public.classes c on c.id = m.class_id
    where c.teacher_id = (select auth.uid()) and m.student_id = target_user
  );
$$;

alter table public.profiles enable row level security;
alter table public.classes enable row level security;
alter table public.class_access enable row level security;
alter table public.class_members enable row level security;
alter table public.class_notes enable row level security;
alter table public.ai_usage_limits enable row level security;

drop policy if exists "profile readers are self or class teacher" on public.profiles;
create policy "profile readers are self or class teacher"
  on public.profiles for select to authenticated
  using (public.can_view_profile(id));

drop policy if exists "classes visible to owner and members" on public.classes;
create policy "classes visible to owner and members"
  on public.classes for select to authenticated
  using (teacher_id = (select auth.uid()) or public.is_class_member(id));

drop policy if exists "teachers update their classes" on public.classes;
create policy "teachers update their classes"
  on public.classes for update to authenticated
  using (teacher_id = (select auth.uid()))
  with check (teacher_id = (select auth.uid()));

drop policy if exists "members and class teachers can view membership" on public.class_members;
create policy "members and class teachers can view membership"
  on public.class_members for select to authenticated
  using (student_id = (select auth.uid()) or public.is_class_teacher(class_id));

drop policy if exists "students manage their own notes in joined classes" on public.class_notes;
create policy "students manage their own notes in joined classes"
  on public.class_notes for all to authenticated
  using (student_id = (select auth.uid()) and public.is_class_member(class_id))
  with check (student_id = (select auth.uid()) and public.is_class_member(class_id));

-- The password hash is deliberately not readable by any client role.
revoke all on public.class_access from anon, authenticated;
revoke all on public.ai_usage_limits from anon, authenticated;
grant select on public.profiles, public.classes, public.class_members to authenticated;
grant select, insert, update, delete on public.class_notes to authenticated;
grant update (name) on public.classes to authenticated;

create or replace function public.create_class(p_name text, p_join_password text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_name text := btrim(p_name);
  v_password text := nullif(p_join_password, '');
  v_code text;
  v_class public.classes;
begin
  if v_uid is null then raise exception 'Sign in to create a class.'; end if;
  if not exists (select 1 from public.profiles p where p.id = v_uid and p.role = 'teacher') then
    raise exception 'A teacher account is required to create a class.';
  end if;
  if v_name is null or char_length(v_name) < 2 or char_length(v_name) > 80 then
    raise exception 'Class name must be between 2 and 80 characters.';
  end if;
  if v_password is not null and char_length(v_password) < 6 then
    raise exception 'Optional class passwords must be at least 6 characters.';
  end if;
  if v_password is not null and char_length(v_password) > 64 then
    raise exception 'Class password is too long.';
  end if;

  loop
    v_code := 'NF-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 16));
    exit when not exists (select 1 from public.classes c where c.join_code = v_code);
  end loop;

  insert into public.classes (teacher_id, name, join_code, join_password_protected)
  values (v_uid, v_name, v_code, v_password is not null)
  returning * into v_class;

  insert into public.class_access (class_id, join_password_hash)
  values (
    v_class.id,
    case when v_password is null then null else extensions.crypt(v_password, extensions.gen_salt('bf', 10)) end
  );

  return jsonb_build_object('id', v_class.id, 'name', v_class.name, 'join_code', v_class.join_code, 'password_protected', v_password is not null);
end;
$$;

create or replace function public.join_class(p_join_code text, p_join_password text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_class public.classes;
  v_password_hash text;
begin
  if v_uid is null then raise exception 'Sign in to join a class.'; end if;
  if not exists (select 1 from public.profiles p where p.id = v_uid and p.role = 'student') then
    raise exception 'Only student accounts can join a class.';
  end if;

  select c.* into v_class
  from public.classes c
  where c.join_code = upper(btrim(coalesce(p_join_code, '')));
  if not found then raise exception 'That class code or password is not valid.'; end if;

  select a.join_password_hash into v_password_hash
  from public.class_access a where a.class_id = v_class.id;
  if v_password_hash is not null and (
    nullif(p_join_password, '') is null
    or extensions.crypt(p_join_password, v_password_hash) <> v_password_hash
  ) then
    raise exception 'That class code or password is not valid.';
  end if;

  insert into public.class_members (class_id, student_id)
  values (v_class.id, v_uid)
  on conflict (class_id, student_id) do nothing;

  return jsonb_build_object('id', v_class.id, 'name', v_class.name, 'join_code', v_class.join_code);
end;
$$;

create or replace function public.consume_learning_request()
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_count integer;
begin
  if v_uid is null or not exists (
    select 1 from public.profiles p where p.id = v_uid and p.role = 'student'
  ) then
    raise exception 'A student account is required.';
  end if;

  insert into public.ai_usage_limits as existing_usage (student_id, usage_date, request_count)
  values (v_uid, current_date, 1)
  on conflict (student_id, usage_date) do update
    set request_count = existing_usage.request_count + 1
    where existing_usage.request_count < 30
  returning request_count into v_count;

  if v_count is null then raise exception 'Daily learning assistant limit reached.'; end if;
  return true;
end;
$$;

revoke all on function public.create_class(text, text) from public, anon;
revoke all on function public.join_class(text, text) from public, anon;
revoke all on function public.consume_learning_request() from public, anon;
grant execute on function public.create_class(text, text) to authenticated;
grant execute on function public.join_class(text, text) to authenticated;
grant execute on function public.consume_learning_request() to authenticated;
grant execute on function public.is_class_teacher(uuid) to authenticated;
grant execute on function public.is_class_member(uuid) to authenticated;
grant execute on function public.can_view_profile(uuid) to authenticated;
