-- Neuro-Focus: tracking quality for saved attention history.
-- Run after 20261002000000_attention_history_and_private_live.sql (and the later updates).
-- Safe to run more than once. It only adds columns and widens what can be saved:
-- no existing row is deleted or changed.
--
-- Why: time when the camera couldn't measure (no face in view, more than one face, face partly
-- out of view, a break) used to be saved as an attention score of 0 ("Away"). Now it is saved as
-- what it is, with no score, and each session records how much time was actually measured.
--
-- 1. attention_sessions gets:
--      usable_seconds       time the tracker could measure (the base for focus_percent)
--      unavailable_seconds  time it couldn't (no face, several faces, no readings, ...)
--      break_seconds        time on an intentional break (the focus timer's break)
--      tracking_version     2 for sessions saved with these rules; null for older sessions
--    focus_percent for new sessions = estimated on-screen share of usable time.
--    Older sessions keep their values; the app shows them as "recorded by an older method"
--    (their focus_percent counted time with no face in view as not focused).
-- 2. attention_samples can be saved as 'Unavailable' or 'Break' with no score. A score is required
--    for measured samples ('Focused' = estimated on screen, 'Distracted' = estimated looking away).
--    Old 'Away' samples (score 0) stay as they are; the app reads them as "not measured".
-- Attendance (session_attendance) doesn't use any of this and is unchanged.

-- ============================================================
-- 1. Session summaries: measured, unavailable and break time
-- ============================================================
alter table public.attention_sessions
  add column if not exists usable_seconds integer check (usable_seconds between 0 and 86400),
  add column if not exists unavailable_seconds integer check (unavailable_seconds between 0 and 86400),
  add column if not exists break_seconds integer check (break_seconds between 0 and 86400),
  add column if not exists tracking_version smallint check (tracking_version between 1 and 100);

comment on column public.attention_sessions.usable_seconds is 'Seconds the tracker could measure; focus_percent is the estimated on-screen share of this time. Null for sessions saved before tracking-quality checks.';
comment on column public.attention_sessions.unavailable_seconds is 'Seconds the camera was on but could not measure (no face, several faces, no readings). Never counted as looking away.';
comment on column public.attention_sessions.break_seconds is 'Seconds on an intentional break. Not counted in attention results.';
comment on column public.attention_sessions.tracking_version is '2 = saved with tracking-quality checks. Null = older method (no-face time counted as not focused).';

-- Students may set these on their own sessions (the existing policies still decide which rows).
grant update (usable_seconds, unavailable_seconds, break_seconds, tracking_version) on public.attention_sessions to authenticated;

-- ============================================================
-- 2. Samples: unavailable and break samples have no score
-- ============================================================
alter table public.attention_samples alter column score drop not null;

alter table public.attention_samples drop constraint if exists attention_samples_state_check;
alter table public.attention_samples add constraint attention_samples_state_check
  check (state in ('Focused', 'Distracted', 'Away', 'Unavailable', 'Break'));

-- Measured samples need a score; unavailable and break samples must not have one.
-- ('Away' only exists in old rows, which keep their score of 0.)
alter table public.attention_samples drop constraint if exists attention_samples_score_matches_state;
alter table public.attention_samples add constraint attention_samples_score_matches_state
  check (
    (state in ('Focused', 'Distracted') and score is not null)
    or (state in ('Unavailable', 'Break') and score is null)
    or state = 'Away'
  );

comment on column public.attention_samples.state is 'Focused = estimated looking at the screen; Distracted = estimated looking away; Unavailable = could not measure (no score); Break = intentional break (no score); Away = older rows only, meaning no face found (saved as 0, read as not measured).';
