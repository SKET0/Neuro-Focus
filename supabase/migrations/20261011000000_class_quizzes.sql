-- Neuro-Focus: live class quizzes (the Quizzes tab).
-- Run after 20261010000000_class_posts_assignments.sql. Safe to run more than once. Adds tables
-- and functions only; no existing table or row changes. Unrelated to Class notes' "Quiz me"
-- (AI flashcards) and to attention tracking: quiz points never use attention scores.
--
-- How a quiz runs (every step checked here, in the database):
--   draft     the teacher writes questions (text, 2–6 choices, one correct). Students can't see it.
--   lobby     the teacher opens it; class members join explicitly (join_quiz).
--   live      the teacher shows one question at a time (quiz_next_question). Students answer once
--             (submit_quiz_answer) while it's open: before the teacher reveals it, and before its
--             timer runs out if the quiz has one. The teacher reveals it (quiz_close_question).
--   finished  after the last question (or quiz_finish). Answers and points are kept.
-- Scoring: 1 point per correct answer, worked out here. No speed bonus.
-- Students never read questions or answers directly: quiz_state() gives them the current
-- question without its answer, and adds the correct choice only once that question has closed.
-- quiz_results() gives each student their own result (and the leaderboard if the teacher turned
-- it on); the teacher sees everything.

-- ============================================================
-- 1. Tables
-- ============================================================
create table if not exists public.quizzes (
  id uuid primary key default gen_random_uuid(),
  class_id uuid not null references public.classes(id) on delete cascade,
  created_by uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 1 and 200),
  time_limit_seconds integer check (time_limit_seconds is null or time_limit_seconds between 5 and 600),
  show_leaderboard boolean not null default true,
  status text not null default 'draft' check (status in ('draft', 'lobby', 'live', 'finished')),
  current_index integer not null default -1,
  question_closed boolean not null default false,  -- the teacher revealed the current question
  question_opened_at timestamptz,
  question_closes_at timestamptz,                    -- when the timer ends (null: no timer)
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);
create index if not exists quizzes_class_idx on public.quizzes(class_id, created_at desc);

create table if not exists public.quiz_questions (
  id uuid primary key default gen_random_uuid(),
  quiz_id uuid not null references public.quizzes(id) on delete cascade,
  position integer not null check (position >= 0),
  prompt text not null check (char_length(btrim(prompt)) between 1 and 500),
  options text[] not null check (array_length(options, 1) between 2 and 6),
  correct_index smallint not null,
  constraint quiz_questions_correct_in_range check (correct_index >= 0 and correct_index < array_length(options, 1)),
  unique (quiz_id, position)
);

create table if not exists public.quiz_participants (
  quiz_id uuid not null references public.quizzes(id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (quiz_id, student_id)
);

create table if not exists public.quiz_answers (
  id uuid primary key default gen_random_uuid(),
  quiz_id uuid not null references public.quizzes(id) on delete cascade,
  question_id uuid not null references public.quiz_questions(id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  choice smallint not null,
  is_correct boolean not null,
  points integer not null default 0,
  answered_at timestamptz not null default now(),
  unique (question_id, student_id)  -- one answer per student per question
);
create index if not exists quiz_answers_quiz_idx on public.quiz_answers(quiz_id, student_id);

alter table public.quizzes enable row level security;
alter table public.quiz_questions enable row level security;
alter table public.quiz_participants enable row level security;
alter table public.quiz_answers enable row level security;

-- Quizzes: the teacher sees theirs; class members see them once opened (not drafts).
drop policy if exists "quizzes: teacher and members read" on public.quizzes;
create policy "quizzes: teacher and members read"
  on public.quizzes for select to authenticated
  using (public.is_class_teacher(class_id) or (status <> 'draft' and public.is_class_member(class_id)));

drop policy if exists "quizzes: teacher creates drafts" on public.quizzes;
create policy "quizzes: teacher creates drafts"
  on public.quizzes for insert to authenticated
  with check (created_by = (select auth.uid()) and public.is_class_teacher(class_id) and status = 'draft' and current_index = -1);

-- Only drafts can be edited directly; running a quiz goes through the functions below.
drop policy if exists "quizzes: teacher edits drafts" on public.quizzes;
create policy "quizzes: teacher edits drafts"
  on public.quizzes for update to authenticated
  using (public.is_class_teacher(class_id) and status = 'draft')
  with check (public.is_class_teacher(class_id) and status = 'draft');

drop policy if exists "quizzes: teacher deletes" on public.quizzes;
create policy "quizzes: teacher deletes"
  on public.quizzes for delete to authenticated
  using (public.is_class_teacher(class_id) and status in ('draft', 'finished'));

-- Questions (with their answers): only the teacher, and only changed while the quiz is a draft.
create or replace function public.is_draft_quiz_teacher(target_quiz uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.quizzes q where q.id = target_quiz and q.status = 'draft' and public.is_class_teacher(q.class_id));
$$;
create or replace function public.is_quiz_teacher(target_quiz uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.quizzes q where q.id = target_quiz and public.is_class_teacher(q.class_id));
$$;
revoke all on function public.is_draft_quiz_teacher(uuid) from public, anon;
revoke all on function public.is_quiz_teacher(uuid) from public, anon;
grant execute on function public.is_draft_quiz_teacher(uuid) to authenticated;
grant execute on function public.is_quiz_teacher(uuid) to authenticated;

drop policy if exists "quiz questions: teacher reads" on public.quiz_questions;
create policy "quiz questions: teacher reads"
  on public.quiz_questions for select to authenticated
  using (public.is_quiz_teacher(quiz_id));
drop policy if exists "quiz questions: teacher writes drafts" on public.quiz_questions;
create policy "quiz questions: teacher writes drafts"
  on public.quiz_questions for insert to authenticated
  with check (public.is_draft_quiz_teacher(quiz_id));
drop policy if exists "quiz questions: teacher edits drafts" on public.quiz_questions;
create policy "quiz questions: teacher edits drafts"
  on public.quiz_questions for update to authenticated
  using (public.is_draft_quiz_teacher(quiz_id))
  with check (public.is_draft_quiz_teacher(quiz_id));
drop policy if exists "quiz questions: teacher deletes drafts" on public.quiz_questions;
create policy "quiz questions: teacher deletes drafts"
  on public.quiz_questions for delete to authenticated
  using (public.is_draft_quiz_teacher(quiz_id));

-- Participants and answers: the teacher reads them; students get theirs through the functions.
drop policy if exists "quiz participants: teacher reads" on public.quiz_participants;
create policy "quiz participants: teacher reads"
  on public.quiz_participants for select to authenticated
  using (public.is_quiz_teacher(quiz_id));
drop policy if exists "quiz answers: teacher reads" on public.quiz_answers;
create policy "quiz answers: teacher reads"
  on public.quiz_answers for select to authenticated
  using (public.is_quiz_teacher(quiz_id));

revoke all on public.quizzes, public.quiz_questions, public.quiz_participants, public.quiz_answers from anon, authenticated;
grant select, insert, delete on public.quizzes to authenticated;
grant update (title, time_limit_seconds, show_leaderboard) on public.quizzes to authenticated;
grant select, insert, update, delete on public.quiz_questions to authenticated;
grant select on public.quiz_participants, public.quiz_answers to authenticated;

-- ============================================================
-- 2. Helpers
-- ============================================================
-- Whether the current question has closed: revealed by the teacher, or its timer ran out.
create or replace function public.quiz_question_closed(q public.quizzes)
returns boolean
language sql
stable
set search_path = ''
as $$
  select q.question_closed or (q.question_closes_at is not null and now() > q.question_closes_at);
$$;
revoke all on function public.quiz_question_closed(public.quizzes) from public, anon;
grant execute on function public.quiz_question_closed(public.quizzes) to authenticated;

-- Loads a quiz for a teacher action, refusing anyone but the class's teacher.
create or replace function public.quiz_for_teacher(p_quiz_id uuid)
returns public.quizzes
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_quiz public.quizzes;
begin
  select * into v_quiz from public.quizzes where id = p_quiz_id;
  if not found or not public.is_class_teacher(v_quiz.class_id) then
    raise exception 'Only the class''s teacher can run this quiz.' using errcode = '42501';
  end if;
  return v_quiz;
end;
$$;
revoke all on function public.quiz_for_teacher(uuid) from public, anon, authenticated;

-- ============================================================
-- 3. Teacher controls
-- ============================================================
create or replace function public.quiz_open_lobby(p_quiz_id uuid)
returns json
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_quiz public.quizzes := public.quiz_for_teacher(p_quiz_id);
begin
  if v_quiz.status <> 'draft' then
    raise exception 'This quiz has already been opened.' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.quiz_questions where quiz_id = p_quiz_id) then
    raise exception 'Add at least one question first.' using errcode = 'P0001';
  end if;
  update public.quizzes set status = 'lobby' where id = p_quiz_id returning * into v_quiz;
  return row_to_json(v_quiz);
end;
$$;

-- Shows the next question (the first one starts the quiz). After the last one, finishes.
create or replace function public.quiz_next_question(p_quiz_id uuid)
returns json
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_quiz public.quizzes := public.quiz_for_teacher(p_quiz_id);
  v_count integer;
begin
  if v_quiz.status not in ('lobby', 'live') then
    raise exception 'Open the lobby first.' using errcode = 'P0001';
  end if;
  if v_quiz.status = 'live' and not public.quiz_question_closed(v_quiz) then
    raise exception 'Reveal the current question before moving on.' using errcode = 'P0001';
  end if;
  select count(*) into v_count from public.quiz_questions where quiz_id = p_quiz_id;
  if v_quiz.current_index + 1 >= v_count then
    update public.quizzes set status = 'finished', question_closed = true, finished_at = now() where id = p_quiz_id returning * into v_quiz;
  else
    update public.quizzes
      set status = 'live',
          started_at = coalesce(started_at, now()),
          current_index = current_index + 1,
          question_closed = false,
          question_opened_at = now(),
          question_closes_at = case when time_limit_seconds is null then null else now() + make_interval(secs => time_limit_seconds) end
    where id = p_quiz_id
    returning * into v_quiz;
  end if;
  return row_to_json(v_quiz);
end;
$$;

-- Reveals the current question: no more answers, and the correct choice becomes visible.
create or replace function public.quiz_close_question(p_quiz_id uuid)
returns json
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_quiz public.quizzes := public.quiz_for_teacher(p_quiz_id);
begin
  if v_quiz.status <> 'live' then
    raise exception 'No question is showing.' using errcode = 'P0001';
  end if;
  update public.quizzes set question_closed = true where id = p_quiz_id returning * into v_quiz;
  return row_to_json(v_quiz);
end;
$$;

-- Ends the quiz early (or from the lobby). Answers given so far count.
create or replace function public.quiz_finish(p_quiz_id uuid)
returns json
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_quiz public.quizzes := public.quiz_for_teacher(p_quiz_id);
begin
  if v_quiz.status not in ('lobby', 'live') then
    raise exception 'This quiz isn''t running.' using errcode = 'P0001';
  end if;
  update public.quizzes set status = 'finished', question_closed = true, finished_at = now() where id = p_quiz_id returning * into v_quiz;
  return row_to_json(v_quiz);
end;
$$;

-- ============================================================
-- 4. Students: join and answer
-- ============================================================
create or replace function public.join_quiz(p_quiz_id uuid)
returns json
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_quiz public.quizzes;
begin
  select * into v_quiz from public.quizzes where id = p_quiz_id;
  if not found or not public.is_class_member(v_quiz.class_id)
     or not exists (select 1 from public.profiles p where p.id = v_uid and p.role = 'student') then
    raise exception 'Only students in this class can join this quiz.' using errcode = '42501';
  end if;
  if v_quiz.status not in ('lobby', 'live') then
    raise exception 'This quiz isn''t open to join.' using errcode = 'P0001';
  end if;
  insert into public.quiz_participants (quiz_id, student_id) values (p_quiz_id, v_uid)
  on conflict (quiz_id, student_id) do nothing;  -- joining again (e.g. after a reconnect) is fine
  return json_build_object('joined', true);
end;
$$;

-- One answer per question, while it's open. A repeat (double tap, reconnect) keeps the first answer.
create or replace function public.submit_quiz_answer(p_quiz_id uuid, p_question_id uuid, p_choice integer)
returns json
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_quiz public.quizzes;
  v_question public.quiz_questions;
  v_existing public.quiz_answers;
begin
  select * into v_quiz from public.quizzes where id = p_quiz_id;
  if not found or not public.is_class_member(v_quiz.class_id) then
    raise exception 'Only students in this class can answer.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.quiz_participants where quiz_id = p_quiz_id and student_id = v_uid) then
    raise exception 'Join the quiz first.' using errcode = '42501';
  end if;
  select * into v_question from public.quiz_questions where quiz_id = p_quiz_id and position = v_quiz.current_index;
  if v_quiz.status <> 'live' or not found or v_question.id <> p_question_id then
    raise exception 'That question isn''t open any more.' using errcode = 'P0001';
  end if;
  select * into v_existing from public.quiz_answers where question_id = p_question_id and student_id = v_uid;
  if found then
    return json_build_object('accepted', false, 'reason', 'already_answered', 'choice', v_existing.choice);
  end if;
  if public.quiz_question_closed(v_quiz) then
    raise exception 'Time’s up for this question.' using errcode = 'P0001';
  end if;
  if p_choice is null or p_choice < 0 or p_choice >= array_length(v_question.options, 1) then
    raise exception 'That isn''t one of the choices.' using errcode = 'P0001';
  end if;
  insert into public.quiz_answers (quiz_id, question_id, student_id, choice, is_correct, points)
  values (p_quiz_id, p_question_id, v_uid, p_choice, p_choice = v_question.correct_index, case when p_choice = v_question.correct_index then 1 else 0 end)
  on conflict (question_id, student_id) do nothing;
  if not found then
    select * into v_existing from public.quiz_answers where question_id = p_question_id and student_id = v_uid;
    return json_build_object('accepted', false, 'reason', 'already_answered', 'choice', v_existing.choice);
  end if;
  return json_build_object('accepted', true, 'choice', p_choice);
end;
$$;

-- ============================================================
-- 5. What each person sees
-- ============================================================
-- The live state of a quiz. The correct choice and the answer counts appear only once the
-- current question has closed (for students), or always for the teacher.
create or replace function public.quiz_state(p_quiz_id uuid)
returns json
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_quiz public.quizzes;
  v_teacher boolean;
  v_question public.quiz_questions;
  v_closed boolean;
  v_mine public.quiz_answers;
  v_count integer;
  v_question_json json;
begin
  select * into v_quiz from public.quizzes where id = p_quiz_id;
  if not found then
    raise exception 'Quiz not found.' using errcode = '42501';
  end if;
  v_teacher := public.is_class_teacher(v_quiz.class_id);
  if not v_teacher and not (public.is_class_member(v_quiz.class_id) and v_quiz.status <> 'draft') then
    raise exception 'Only this class can see this quiz.' using errcode = '42501';
  end if;
  select count(*) into v_count from public.quiz_questions where quiz_id = p_quiz_id;
  v_closed := public.quiz_question_closed(v_quiz);
  if v_quiz.status = 'live' then
    select * into v_question from public.quiz_questions where quiz_id = p_quiz_id and position = v_quiz.current_index;
    select * into v_mine from public.quiz_answers where question_id = v_question.id and student_id = v_uid;
    v_question_json := json_build_object(
      'id', v_question.id,
      'number', v_quiz.current_index + 1,
      'prompt', v_question.prompt,
      'options', v_question.options,
      'closed', v_closed,
      'closes_at', v_quiz.question_closes_at,
      'answered', (select count(*) from public.quiz_answers a where a.question_id = v_question.id),
      'my_choice', v_mine.choice,
      'correct_index', case when v_closed or v_teacher then v_question.correct_index end,
      'my_correct', case when v_closed then v_mine.is_correct end,
      'counts', case when v_closed or v_teacher then (
        select json_agg(coalesce((select count(*) from public.quiz_answers a where a.question_id = v_question.id and a.choice = i - 1), 0) order by i)
        from generate_series(1, array_length(v_question.options, 1)) as i
      ) end
    );
  end if;
  return json_build_object(
    'quiz', json_build_object('id', v_quiz.id, 'title', v_quiz.title, 'status', v_quiz.status, 'question_count', v_count,
      'time_limit_seconds', v_quiz.time_limit_seconds, 'show_leaderboard', v_quiz.show_leaderboard),
    'now', now(),
    'is_teacher', v_teacher,
    'joined', exists (select 1 from public.quiz_participants where quiz_id = p_quiz_id and student_id = v_uid),
    'participants', (select count(*) from public.quiz_participants where quiz_id = p_quiz_id),
    'participant_names', case when v_teacher then (
      select coalesce(json_agg(coalesce(p.display_name, 'Student') order by qp.joined_at), '[]'::json)
      from public.quiz_participants qp left join public.profiles p on p.id = qp.student_id where qp.quiz_id = p_quiz_id
    ) end,
    'question', v_question_json
  );
end;
$$;

-- Results. A student gets their own score and answers (once each question has closed), plus the
-- leaderboard when the teacher turned it on and the quiz has finished. The teacher gets everyone.
create or replace function public.quiz_results(p_quiz_id uuid)
returns json
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_quiz public.quizzes;
  v_teacher boolean;
  v_count integer;
begin
  select * into v_quiz from public.quizzes where id = p_quiz_id;
  if not found then
    raise exception 'Quiz not found.' using errcode = '42501';
  end if;
  v_teacher := public.is_class_teacher(v_quiz.class_id);
  if not v_teacher and not (public.is_class_member(v_quiz.class_id) and v_quiz.status <> 'draft') then
    raise exception 'Only this class can see these results.' using errcode = '42501';
  end if;
  select count(*) into v_count from public.quiz_questions where quiz_id = p_quiz_id;
  return json_build_object(
    'status', v_quiz.status,
    'question_count', v_count,
    'show_leaderboard', v_quiz.show_leaderboard,
    'mine', case when not v_teacher then json_build_object(
      'joined', exists (select 1 from public.quiz_participants where quiz_id = p_quiz_id and student_id = v_uid),
      'score', (select coalesce(sum(points), 0) from public.quiz_answers where quiz_id = p_quiz_id and student_id = v_uid),
      'answered', (select count(*) from public.quiz_answers where quiz_id = p_quiz_id and student_id = v_uid),
      'questions', (
        select coalesce(json_agg(json_build_object(
          'number', qq.position + 1, 'prompt', qq.prompt, 'options', qq.options,
          'my_choice', a.choice,
          'correct_index', qq.correct_index,
          'correct', a.is_correct
        ) order by qq.position), '[]'::json)
        from public.quiz_questions qq
        left join public.quiz_answers a on a.question_id = qq.id and a.student_id = v_uid
        where qq.quiz_id = p_quiz_id
          and (v_quiz.status = 'finished' or qq.position < v_quiz.current_index
               or (qq.position = v_quiz.current_index and public.quiz_question_closed(v_quiz)))
      )
    ) end,
    'leaderboard', case when v_teacher or (v_quiz.show_leaderboard and v_quiz.status = 'finished') then (
      select coalesce(json_agg(row_to_json(r) order by r.score desc, r.name), '[]'::json)
      from (
        select coalesce(p.display_name, 'Student') as name,
               case when v_teacher then qp.student_id end as student_id,
               qp.student_id = v_uid as is_me,
               (select coalesce(sum(a.points), 0) from public.quiz_answers a where a.quiz_id = p_quiz_id and a.student_id = qp.student_id)::integer as score,
               (select count(*) from public.quiz_answers a where a.quiz_id = p_quiz_id and a.student_id = qp.student_id)::integer as answered
        from public.quiz_participants qp left join public.profiles p on p.id = qp.student_id
        where qp.quiz_id = p_quiz_id
      ) r
    ) end
  );
end;
$$;

revoke all on function public.quiz_question_closed(public.quizzes) from public, anon;
revoke all on function public.quiz_open_lobby(uuid) from public, anon;
revoke all on function public.quiz_next_question(uuid) from public, anon;
revoke all on function public.quiz_close_question(uuid) from public, anon;
revoke all on function public.quiz_finish(uuid) from public, anon;
revoke all on function public.join_quiz(uuid) from public, anon;
revoke all on function public.submit_quiz_answer(uuid, uuid, integer) from public, anon;
revoke all on function public.quiz_state(uuid) from public, anon;
revoke all on function public.quiz_results(uuid) from public, anon;
grant execute on function public.quiz_open_lobby(uuid) to authenticated;
grant execute on function public.quiz_next_question(uuid) to authenticated;
grant execute on function public.quiz_close_question(uuid) to authenticated;
grant execute on function public.quiz_finish(uuid) to authenticated;
grant execute on function public.join_quiz(uuid) to authenticated;
grant execute on function public.submit_quiz_answer(uuid, uuid, integer) to authenticated;
grant execute on function public.quiz_state(uuid) to authenticated;
grant execute on function public.quiz_results(uuid) to authenticated;
