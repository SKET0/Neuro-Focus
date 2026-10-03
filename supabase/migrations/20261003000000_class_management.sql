-- Neuro-Focus Phase 2: simpler class management and live sessions.
-- Run after 20261002000000_attention_history_and_private_live.sql. Safe to run more than once.

-- ============================================================
-- 1. Class settings
-- ============================================================

-- Teachers can close a class to new students. Existing students can still rejoin.
alter table public.classes add column if not exists joining_open boolean not null default true;

-- Teachers may rename a class and open/close joining (the update policy limits this to their own classes).
grant update (name, joining_open) on public.classes to authenticated;

-- Teachers delete their own classes. Members, notes and join settings are removed with the class;
-- saved attention sessions are kept but no longer linked to it.
drop policy if exists "teachers delete their classes" on public.classes;
create policy "teachers delete their classes"
  on public.classes for delete to authenticated
  using (teacher_id = (select auth.uid()));
grant delete on public.classes to authenticated;

-- Teachers remove students from their classes; students leave classes themselves.
drop policy if exists "teachers remove students and students leave" on public.class_members;
create policy "teachers remove students and students leave"
  on public.class_members for delete to authenticated
  using (student_id = (select auth.uid()) or public.is_class_teacher(class_id));
grant delete on public.class_members to authenticated;

-- New join code, for example after removing a student who should not come back.
create or replace function public.regenerate_join_code(p_class_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_code text;
begin
  if not public.is_class_teacher(p_class_id) then
    raise exception 'Only this class''s teacher can change its join code.';
  end if;
  loop
    v_code := 'NF-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 16));
    exit when not exists (select 1 from public.classes c where c.join_code = v_code);
  end loop;
  update public.classes set join_code = v_code where id = p_class_id;
  return v_code;
end;
$$;

-- Set, change or remove (empty value) the class join password. The hash never leaves the database.
create or replace function public.set_class_password(p_class_id uuid, p_password text default null)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_password text := nullif(p_password, '');
begin
  if not public.is_class_teacher(p_class_id) then
    raise exception 'Only this class''s teacher can change its password.';
  end if;
  if v_password is not null and (char_length(v_password) < 6 or char_length(v_password) > 64) then
    raise exception 'Class passwords must be 6 to 64 characters.';
  end if;
  insert into public.class_access (class_id, join_password_hash)
  values (
    p_class_id,
    case when v_password is null then null else extensions.crypt(v_password, extensions.gen_salt('bf', 10)) end
  )
  on conflict (class_id) do update set join_password_hash = excluded.join_password_hash;
  update public.classes set join_password_protected = v_password is not null where id = p_class_id;
  return v_password is not null;
end;
$$;

-- Joining: existing members always get back in ("rejoined"); new students need joining to be open.
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

  if exists (select 1 from public.class_members m where m.class_id = v_class.id and m.student_id = v_uid) then
    return jsonb_build_object('id', v_class.id, 'name', v_class.name, 'join_code', v_class.join_code, 'rejoined', true);
  end if;

  if not v_class.joining_open then
    raise exception 'This class isn''t accepting new students right now. Ask your teacher to open joining.';
  end if;

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

  return jsonb_build_object('id', v_class.id, 'name', v_class.name, 'join_code', v_class.join_code, 'rejoined', false);
end;
$$;

revoke all on function public.regenerate_join_code(uuid) from public, anon;
revoke all on function public.set_class_password(uuid, text) from public, anon;
revoke all on function public.join_class(text, text) from public, anon;
grant execute on function public.regenerate_join_code(uuid) to authenticated;
grant execute on function public.set_class_password(uuid, text) to authenticated;
grant execute on function public.join_class(text, text) to authenticated;

-- ============================================================
-- 2. Live sessions over the private class channel
-- ============================================================
-- The teacher announces "live session on/off" (and recently removed students) with Presence,
-- which the class's students can read. Students still send attention scores that only the
-- teacher can receive.

drop policy if exists "neurofocus class channels: send" on realtime.messages;
create policy "neurofocus class channels: send"
  on realtime.messages for insert to authenticated
  with check (
    (
      realtime.messages.extension in ('presence', 'broadcast')
      and public.is_class_member(public.class_id_from_realtime_topic((select realtime.topic())))
    )
    or (
      realtime.messages.extension = 'presence'
      and public.is_class_teacher(public.class_id_from_realtime_topic((select realtime.topic())))
    )
  );
