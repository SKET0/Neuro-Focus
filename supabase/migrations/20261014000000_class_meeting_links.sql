-- Neuro-Focus: a Zoom or Google Meet link per class (online classes).
-- Run after 20261013000000_quiz_focus.sql. Safe to run more than once. Adds one column; no
-- existing row changes.
--
-- The class's teacher saves the link for the class's online lessons in Settings. Students in the
-- class see "Join on Zoom" / "Join on Google Meet" when a live session starts: it joins the live
-- session (attendance and focus sharing, exactly as before), opens a small floating focus window
-- and opens the meeting. Tracking keeps running while the meeting is in front.
--   * Only https links on zoom.us / zoom.com (and their subdomains, e.g. us06web.zoom.us) or
--     meet.google.com are accepted, so a class can't point students somewhere else.
--   * Who can see it: the same people who can see the class (its teacher and its students).
--   * Who can change it: only the class's teacher (the existing "teachers update their classes" rule).

alter table public.classes add column if not exists meeting_url text;

alter table public.classes drop constraint if exists classes_meeting_url_valid;
alter table public.classes add constraint classes_meeting_url_valid check (
  meeting_url is null or (
    char_length(meeting_url) <= 500
    and meeting_url !~ '\s'
    and (
      meeting_url ~* '^https://([a-z0-9-]+\.)*zoom\.(us|com)(/|$)'
      or meeting_url ~* '^https://meet\.google\.com(/|$)'
    )
  )
);

-- Teachers could already change these columns of their own classes; the link joins them.
grant update (name, joining_open, late_after_minutes, meeting_url) on public.classes to authenticated;
