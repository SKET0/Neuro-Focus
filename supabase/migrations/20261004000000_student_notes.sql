-- Notes update: many notes per student instead of one note per class.
-- Safe to run more than once.
--
-- Each note belongs to one student. It can be filed under one of their classes, or kept
-- as a personal note (class_id is null). Teachers can never read students' notes.
-- The body is Markdown text (headings, lists, bold) written by the student or drafted
-- by NeuroBuddy from text the student supplied.

create table if not exists public.student_notes (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  class_id uuid references public.classes(id) on delete set null,
  title text not null default '' check (char_length(title) <= 200),
  body text not null default '' check (char_length(body) <= 50000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists student_notes_student_idx on public.student_notes(student_id, updated_at desc);

alter table public.student_notes enable row level security;

-- A student always keeps their own notes, even after leaving a class. New notes, and
-- notes moved to another class, can only be filed under classes the student is in.
drop policy if exists "students read their own notes" on public.student_notes;
create policy "students read their own notes"
  on public.student_notes for select to authenticated
  using (student_id = (select auth.uid()));

drop policy if exists "students create their own notes" on public.student_notes;
create policy "students create their own notes"
  on public.student_notes for insert to authenticated
  with check (student_id = (select auth.uid()) and (class_id is null or public.is_class_member(class_id)));

drop policy if exists "students edit their own notes" on public.student_notes;
create policy "students edit their own notes"
  on public.student_notes for update to authenticated
  using (student_id = (select auth.uid()))
  with check (student_id = (select auth.uid()) and (class_id is null or public.is_class_member(class_id)));

drop policy if exists "students delete their own notes" on public.student_notes;
create policy "students delete their own notes"
  on public.student_notes for delete to authenticated
  using (student_id = (select auth.uid()));

grant select, insert, update, delete on public.student_notes to authenticated;

-- Copy each existing one-per-class note into the new table once.
insert into public.student_notes (student_id, class_id, title, body, created_at, updated_at)
select
  n.student_id,
  n.class_id,
  left(coalesce(nullif(btrim(substring(n.note_text from '^\s*#+\s*([^\n]+)')), ''), c.name || ' notes'), 200),
  left(n.note_text, 50000),
  n.updated_at,
  n.updated_at
from public.class_notes n
join public.classes c on c.id = n.class_id
where btrim(n.note_text) <> ''
  and not exists (
    select 1 from public.student_notes s
    where s.student_id = n.student_id and s.class_id = n.class_id and s.body = left(n.note_text, 50000)
  );
