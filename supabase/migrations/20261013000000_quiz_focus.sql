-- Neuro-Focus: camera focus during quizzes (mandatory).
-- Run after 20261012000000_open_teacher_signup.sql. Safe to run more than once. Adds two tables
-- and one function, and updates join_quiz, submit_quiz_answer, quiz_state and quiz_results.
--
-- While a quiz is open, each student's browser reports every few seconds whether its attention
-- tracker (camera) is on, and how focused they were on the current question so far: on-screen
-- time and measured time, in milliseconds (numbers only; video never leaves the device).
--   * A student can only join a quiz, and only answer, while their camera is on: the browser
--     must have reported "camera on" in the last 15 seconds.
--   * Focus is saved per question. Each report can only raise the saved numbers, never by more
--     than the question has been open, and on-screen time can't exceed measured time.
--   * The teacher sees, live, who has their camera on and each student's focus on the current
--     question, and each student's focus over the whole quiz in the results.
--   * A student sees their own focus in their summary. Classmates never see each other's focus,
--     even with the leaderboard on.
--   * Points never use focus: 1 point per correct answer, as before.
-- Like live class scores, the numbers come from the student's browser, so a determined student
-- could send made-up ones. The camera rule stops students from simply skipping it.

-- ============================================================
-- 1. Tables
-- ============================================================
-- The latest "camera on/off" report from each student's browser, per quiz.
create table if not exists public.quiz_camera (
  quiz_id uuid not null references public.quizzes(id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  camera_on boolean not null default false,
  seen_at timestamptz not null default now(),
  primary key (quiz_id, student_id)
);

-- Focus on each question: on-screen time and measured (usable) time, in milliseconds.
create table if not exists public.quiz_focus (
  quiz_id uuid not null references public.quizzes(id) on delete cascade,
  question_id uuid not null references public.quiz_questions(id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  on_screen_ms integer not null default 0 check (on_screen_ms >= 0),
  usable_ms integer not null default 0 check (usable_ms >= 0),
  updated_at timestamptz not null default now(),
  primary key (question_id, student_id),
  constraint quiz_focus_on_screen_within_usable check (on_screen_ms <= usable_ms)
);
create index if not exists quiz_focus_quiz_idx on public.quiz_focus(quiz_id, student_id);

alter table public.quiz_camera enable row level security;
alter table public.quiz_focus enable row level security;
-- Read and written only through the functions below.
revoke all on public.quiz_camera, public.quiz_focus from anon, authenticated;

-- ============================================================
-- 2. Helpers
-- ============================================================
-- Whether a student's camera counts as on for a quiz right now.
create or replace function public.quiz_camera_on(p_quiz_id uuid, p_student uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.quiz_camera c
    where c.quiz_id = p_quiz_id and c.student_id = p_student and c.camera_on and c.seen_at > now() - interval '15 seconds'
  );
$$;
revoke all on function public.quiz_camera_on(uuid, uuid) from public, anon, authenticated;

-- A focus share in percent, or null when nothing was measured.
create or replace function public.quiz_focus_percent(p_on_screen bigint, p_usable bigint)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case when coalesce(p_usable, 0) > 0 then round(100.0 * p_on_screen / p_usable)::integer end;
$$;
revoke all on function public.quiz_focus_percent(bigint, bigint) from public, anon;
grant execute on function public.quiz_focus_percent(bigint, bigint) to authenticated;

-- ============================================================
-- 3. Students report their camera and focus
-- ============================================================
create or replace function public.report_quiz_focus(
  p_quiz_id uuid,
  p_camera_on boolean,
  p_question_id uuid default null,
  p_on_screen_ms integer default 0,
  p_usable_ms integer default 0
)
returns json
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_quiz public.quizzes;
  v_question public.quiz_questions;
  v_limit bigint;
  v_usable integer;
  v_on_screen integer;
begin
  select * into v_quiz from public.quizzes where id = p_quiz_id;
  if not found or not public.is_class_member(v_quiz.class_id)
     or not exists (select 1 from public.profiles p where p.id = v_uid and p.role = 'student') then
    raise exception 'Only students in this class can take part in this quiz.' using errcode = '42501';
  end if;
  if v_quiz.status not in ('lobby', 'live') then
    return json_build_object('saved', false);
  end if;

  insert into public.quiz_camera (quiz_id, student_id, camera_on, seen_at)
  values (p_quiz_id, v_uid, coalesce(p_camera_on, false), now())
  on conflict (quiz_id, student_id) do update set camera_on = excluded.camera_on, seen_at = excluded.seen_at;

  -- Focus counts only for the question showing now, and only for students who joined.
  if p_question_id is not null and v_quiz.status = 'live'
     and exists (select 1 from public.quiz_participants where quiz_id = p_quiz_id and student_id = v_uid) then
    select * into v_question from public.quiz_questions where quiz_id = p_quiz_id and position = v_quiz.current_index;
    if found and v_question.id = p_question_id then
      -- No more time than the question has been showing (plus a little for clock differences).
      v_limit := greatest(0, floor(extract(epoch from (now() - coalesce(v_quiz.question_opened_at, now()))) * 1000)::bigint + 5000);
      v_usable := least(greatest(coalesce(p_usable_ms, 0), 0)::bigint, v_limit)::integer;
      v_on_screen := least(greatest(coalesce(p_on_screen_ms, 0), 0), v_usable);
      insert into public.quiz_focus (quiz_id, question_id, student_id, on_screen_ms, usable_ms, updated_at)
      values (p_quiz_id, p_question_id, v_uid, v_on_screen, v_usable, now())
      on conflict (question_id, student_id) do update
        set on_screen_ms = greatest(public.quiz_focus.on_screen_ms, excluded.on_screen_ms),
            usable_ms = greatest(public.quiz_focus.usable_ms, excluded.usable_ms),
            updated_at = now();
    end if;
  end if;
  return json_build_object('saved', true, 'camera_on', coalesce(p_camera_on, false));
end;
$$;
revoke all on function public.report_quiz_focus(uuid, boolean, uuid, integer, integer) from public, anon;
grant execute on function public.report_quiz_focus(uuid, boolean, uuid, integer, integer) to authenticated;

-- ============================================================
-- 4. Joining and answering need the camera on
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
  if not public.quiz_camera_on(p_quiz_id, v_uid) then
    raise exception 'Turn your camera on to join this quiz.' using errcode = 'P0001', hint = 'camera_required';
  end if;
  insert into public.quiz_participants (quiz_id, student_id) values (p_quiz_id, v_uid)
  on conflict (quiz_id, student_id) do nothing;  -- joining again (e.g. after a reconnect) is fine
  return json_build_object('joined', true);
end;
$$;

-- One answer per question, while it's open and the camera is on. A repeat keeps the first answer.
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
  if not public.quiz_camera_on(p_quiz_id, v_uid) then
    raise exception 'Turn your camera on to answer.' using errcode = 'P0001', hint = 'camera_required';
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
-- As before, plus: 'students' for the teacher (each joined student's camera and focus on the
-- current question), and 'my_camera_on' for the student.
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
    'my_camera_on', case when not v_teacher then public.quiz_camera_on(p_quiz_id, v_uid) end,
    'participants', (select count(*) from public.quiz_participants where quiz_id = p_quiz_id),
    'participant_names', case when v_teacher then (
      select coalesce(json_agg(coalesce(p.display_name, 'Student') order by qp.joined_at), '[]'::json)
      from public.quiz_participants qp left join public.profiles p on p.id = qp.student_id where qp.quiz_id = p_quiz_id
    ) end,
    'students', case when v_teacher then (
      select coalesce(json_agg(json_build_object(
        'name', coalesce(p.display_name, 'Student'),
        'camera_on', public.quiz_camera_on(p_quiz_id, qp.student_id),
        'answered', v_question.id is not null and exists (select 1 from public.quiz_answers a where a.question_id = v_question.id and a.student_id = qp.student_id),
        'focus', (select public.quiz_focus_percent(f.on_screen_ms, f.usable_ms) from public.quiz_focus f where f.question_id = v_question.id and f.student_id = qp.student_id)
      ) order by qp.joined_at), '[]'::json)
      from public.quiz_participants qp left join public.profiles p on p.id = qp.student_id where qp.quiz_id = p_quiz_id
    ) end,
    'question', v_question_json
  );
end;
$$;

-- As before, plus focus: the student's own ('mine.focus', and per question), and every
-- student's for the teacher. Classmates never see each other's focus.
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
      'focus', (select public.quiz_focus_percent(sum(f.on_screen_ms), sum(f.usable_ms)) from public.quiz_focus f where f.quiz_id = p_quiz_id and f.student_id = v_uid),
      'questions', (
        select coalesce(json_agg(json_build_object(
          'number', qq.position + 1, 'prompt', qq.prompt, 'options', qq.options,
          'my_choice', a.choice,
          'correct_index', qq.correct_index,
          'correct', a.is_correct,
          'focus', public.quiz_focus_percent(f.on_screen_ms, f.usable_ms)
        ) order by qq.position), '[]'::json)
        from public.quiz_questions qq
        left join public.quiz_answers a on a.question_id = qq.id and a.student_id = v_uid
        left join public.quiz_focus f on f.question_id = qq.id and f.student_id = v_uid
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
               (select count(*) from public.quiz_answers a where a.quiz_id = p_quiz_id and a.student_id = qp.student_id)::integer as answered,
               case when v_teacher then (
                 select public.quiz_focus_percent(sum(f.on_screen_ms), sum(f.usable_ms)) from public.quiz_focus f where f.quiz_id = p_quiz_id and f.student_id = qp.student_id
               ) end as focus,
               case when v_teacher then (
                 select coalesce(sum(f.usable_ms), 0) / 1000 from public.quiz_focus f where f.quiz_id = p_quiz_id and f.student_id = qp.student_id
               ) end as measured_seconds
        from public.quiz_participants qp left join public.profiles p on p.id = qp.student_id
        where qp.quiz_id = p_quiz_id
      ) r
    ) end
  );
end;
$$;

revoke all on function public.join_quiz(uuid) from public, anon;
revoke all on function public.submit_quiz_answer(uuid, uuid, integer) from public, anon;
revoke all on function public.quiz_state(uuid) from public, anon;
revoke all on function public.quiz_results(uuid) from public, anon;
grant execute on function public.join_quiz(uuid) to authenticated;
grant execute on function public.submit_quiz_answer(uuid, uuid, integer) to authenticated;
grant execute on function public.quiz_state(uuid) to authenticated;
grant execute on function public.quiz_results(uuid) to authenticated;
