# Neuro-Focus Implementation Report

As of 15 November 2026 · Muhammad Bilal Khalid

## How to use this report with ChatGPT

This report is the single source of truth for the Phase 2 documentation of Neuro-Focus (FYP-F25-12), describing the system as it runs on 15 November 2026. Every feature listed here is built and live at https://neurofocus.site unless it is marked otherwise.

Ground rules for writing from it:

- Describe only what this report says is built. The trained attention model (LSTM) is built and tested but **not yet live**; write it as "implemented, awaiting more training data".
- Never claim accuracy, learning improvement or ADHD benefit beyond the numbers given here. The model results so far come from one participant and must be presented as preliminary.
- Attention scores are **estimates** of where the face and eyes point, not a measure of comprehension. Keep that wording.
- The Phase 1 proposal promised a Laravel + MySQL + FastAPI system. The built system uses a different stack (section 3); the report must say so and give the reasons, not hide it.
- Use the university's final-year report template for structure (chapters listed in the last section).

Prompt to paste into ChatGPT together with this report:

```text
You are helping write the Phase 2 final-year project report for Neuro-Focus (FYP-F25-12, University of Lahore). Use ONLY the facts in the attached implementation report. Do not invent features, numbers, test results or references. Where the report says something is not done, preliminary or untested, say so plainly. Write in formal academic English, third person, past tense for work done. Follow the chapter structure I give you and ask me before adding anything the report does not support. Start with: [chapter name].
```

## Project at a glance

Neuro-Focus is a live web platform where students study and attend classes while an on-device camera tracker estimates their attention, and teachers see those estimates (numbers only, never video) in real time.

| Item | Detail |
| --- | --- |
| Project | Neuro-Focus, FYP-F25-12, Department of Software Engineering, University of Lahore, session Spring 2023–2027 |
| Team | Muhammad Bilal Khalid, Namaika Sabir |
| Live site | https://neurofocus.site (hosted on Netlify, published automatically from the `main` branch) |
| Users | Students and teachers; anyone can sign up as either (email + password, or Google) |
| Front end | Static HTML, CSS and JavaScript (ES modules), no framework; about 25,000 lines |
| Back end | Supabase: Auth, PostgreSQL with Row Level Security, Realtime channels, Storage, one Edge Function (TypeScript) |
| Computer vision | Google MediaPipe Face Landmarker (478 face points + iris + head pose matrix), running in the student's browser |
| AI | NeuroBuddy study assistant (Google Gemini by default, via an Edge Function); attention model = a small LSTM trained in PyTorch and run in the browser in plain JavaScript |
| Online classes | Zoom and Google Meet links per class, with a floating focus window during the call |
| Privacy | Video never leaves the student's device; only numbers (score, state, focus share) are sent or stored |
| Tests | 396 automated checks in 4 suites, run on every push by GitHub Actions |
| Phase 2 period | Development from 4 October 2026; submission planned for December 2026 |

## Changes from the Phase 1 proposal

The goals of the proposal were kept, but the technology changed to a browser-first design so that video never has to leave the student's computer. The report should present these as deliberate design decisions.

| Area | Phase 1 proposal | What was built | Why |
| --- | --- | --- | --- |
| Back end | Laravel (PHP) | Supabase (managed PostgreSQL, Auth, Realtime, Storage, Edge Functions) | Built-in authentication, real-time channels and row-level access rules; no server to run or secure |
| Database | MySQL | PostgreSQL (in Supabase) with Row Level Security | Access rules enforced inside the database, not only in page code; 14 versioned SQL updates |
| Vision | OpenCV + MediaPipe on a server | MediaPipe Face Landmarker in the student's browser | Camera frames are processed on the device; nothing visual is uploaded |
| AI prediction | FastAPI service running an LSTM | LSTM trained in PyTorch, exported to JSON, run in plain JavaScript in the browser | No video or features need to be sent to a server; works offline once loaded |
| Webcam capture (FR-01) | "Continuously records live video and uses snippets" | Live camera is analysed frame by frame and never recorded or stored | Privacy: the proposal's own Objective 8 (privacy-preserving processing) |
| Teacher view | "Monitor each student's webcam" | Teachers see each student's attention score and state, never video | Privacy and bandwidth; the original wording conflicted with Objective 8 |
| Cloud storage | Firebase or AWS S3 for session logs | Supabase Storage (private buckets) for files; attention stored as numbers in PostgreSQL | One provider for everything |
| Platform integration | Zoom API with web sockets | Per-class Zoom/Meet link + "Join on Zoom/Meet" + floating focus window; tracking keeps running behind the meeting | Works with both Zoom and Meet without paid API plans or app-store approval |
| Admin actor | Student, Teacher, Admin | Student and Teacher only; project owners manage data in the Supabase dashboard | No admin feature was needed for the prototype |
| Teacher accounts | Not specified | Anyone can create a teacher account; teachers only see their own classes | Simple onboarding; data is still isolated per class |
| GPU training | NVIDIA RTX 3070 | A normal laptop CPU is enough (the model is small: 24 hidden units) | The model is light by design so it can run in the browser |

Note for the report: the proposal's requirement numbering is inconsistent (in Table 2.2 FR-07 is "AI Engine" and FR-08 is "Assignment Upload", but in section 2.7 FR-07 is "Assignment Upload", FR-08 "Assessment Monitoring" and FR-09 "Platform Integration"). The next section uses the Table 2.2 numbering; pick one numbering and state it.

## Requirements status

Nine of the ten Phase 1 functional requirements are met and live; FR-04 (LSTM prediction) is implemented and tested but waits for more training data before it goes live.

| ID (Table 2.2) | Requirement | Status | How it is met |
| --- | --- | --- | --- |
| FR-01 | Webcam capture | Done (changed) | Camera opened in the browser on the student's click; frames analysed about 8 times a second and never recorded |
| FR-02 | Eye-gaze detection | Done | MediaPipe iris points give horizontal and vertical eye direction and eye openness |
| FR-03 | Head-pose detection | Done | Head yaw, pitch and roll from MediaPipe's face transformation matrix, plus a nose-based head turn |
| FR-04 | Attention prediction with LSTM | Built, not live | PyTorch LSTM, browser version matches PyTorch exactly; trained on one participant so far; rules are used live meanwhile |
| FR-05 | Dashboard analytics | Done | Teacher live board, class history, attendance, all-students and attendance report pages; student Home, My progress and Focus coach |
| FR-06 | Adaptive feedback | Done | Gentle nudges after 4 s looking away; "Feeling sleepy?" nudge for eyes closed; teacher board flags students to check in on |
| FR-07 | AI engine (MediaPipe) | Done | MediaPipe Face Landmarker in the browser (same as FR-02/03) |
| FR-08 | Assignment upload | Done | Assignments with instructions, deadline, marks and attachment; student submissions, marking and feedback |
| FR-09 | Assessment monitoring | Done | Live class quizzes require the camera; focus saved per question; teacher sees it live and in results |
| FR-10 | Platform integration (Zoom, Google Meet) | Done | Class meeting link, "Join on Zoom/Meet", floating focus window, tracking continues behind the meeting |

Objectives (section 1.3): 1 (gaze and head pose), 3 (real-time scores), 4 (teacher dashboard), 5 (adaptive prompts), 6 (monitored assessments), 7 (Zoom/Meet) and 8 (privacy) are met. Objective 2 (LSTM) is partly met as above.

Non-functional requirements:

| Requirement | Status |
| --- | --- |
| Performance (real-time) | Teacher receives each student's reading about once a second; the tracker reads about 8 times a second, also in a background tab |
| Security | Supabase Auth; every table protected by Row Level Security; 262 database access checks pass |
| Reliability | Unusable camera frames are recorded as "unavailable", never as 0; offline readings are queued; sessions left open are closed automatically |
| Scalability | Supabase handles many classes; not load-tested yet (open item) |
| Usability | Guided tours for new students and teachers; plain-language labels; works on phone widths; no formal usability study yet (open item) |
| Availability | Hosted on Netlify + Supabase; a scheduled job keeps the free Supabase project from pausing |

## Architecture

Neuro-Focus has no server of its own: the browser does the tracking, Supabase stores and relays numbers, and outside services are only called for AI answers and meetings.

The shared doc has this as a drawn diagram. In text form:

```text
Student's browser (video stays here)
  MediaPipe face tracker   camera frames stay here; 478 points + head pose
        |
  Attention score          rules now, LSTM built; 8 readings a second
        |                        --saved-->  Supabase PostgreSQL + RLS (20 tables, 14 updates)
  Student pages            focus, classes, quizzes, notes, NeuroBuddy, floating focus window
        |                        --live--->  Supabase Realtime channels (live scores, who's online)
        |
        +--- Join on Zoom/Meet opens the meeting ---> Zoom / Google Meet (tracking keeps running behind it)

Supabase (cloud)
  Auth                     email or Google sign-in
  PostgreSQL + RLS         access rules enforced in the database
  Realtime channels        ---> Teacher's browser: live board, attendance, quizzes, history (scores only, no video)
  Storage + AI function    private files; NeuroBuddy ---> Google Gemini
```

The student's browser turns camera frames into scores; saved history goes to PostgreSQL and live scores go through Realtime channels to the teacher's browser. NeuroBuddy questions go through a Supabase Edge Function to Google Gemini, so no AI key is ever in the browser. Both students and teachers sign in through Supabase Auth.

## Student features

Students get a personal study space (solo focus, notes, AI help, progress) and a class space (posts, assignments, quizzes, live sessions); the camera only ever starts when they press a button.

| Feature | What the student can do |
| --- | --- |
| Sign-up and sign-in | Email + password (with confirmation email and password reset) or Google; choose Student or Teacher at sign-up |
| Home | One main action chosen from real data (back to a live session, join a live class, continue a note, start focusing); three small charts (focus score, focus time this week, day streak); Today checklist; Jump back in; a Focus coach tip |
| Solo focus | Attention tracker with live score and state, focus timeline (last 2 minutes), Pomodoro-style focus timer with breaks, micro-goals (small steps), nudges and optional chime; private to the student |
| Session summary | When a teacher ends a live session: duration, share of measured time on screen, attention over the session |
| My progress | Saved sessions for 7 days, 30 days or all time: time focused, days focused, focus score, streak, chart, session list, Focus coach |
| Focus coach | Practical tips from the student's own sessions; states what each tip is based on; never claims a technique improves focus |
| Classes | Join with a code (and password if set); class cards with teacher name and picture, attendance, live dot |
| Live sessions | Join when the teacher goes live; attendance taken automatically (present / late); score shared with the teacher, never video; can pause sharing or leave |
| Join on Zoom / Google Meet | One click joins the live session, opens a floating focus window and the class meeting |
| Posts and assignments | Read announcements; submit one file per assignment (replace until the deadline); see marks and feedback |
| Quizzes | Join a live quiz (camera required), answer each question once, see the correct answer when it closes, own score, own focus per question, leaderboard if enabled |
| My notes | Unlimited private notes, filed under a class or personal; formatting editor (saved as Markdown); teachers can never read them |
| NeuroBuddy (AI study assistant) | Many chats; add PDF, Word, PowerPoint, text or photos (read on the device); explanation styles; organise rough notes into a clean note; flashcards (5–20 cards) with spaced practice; 30 requests per day |
| Profile settings | Display name, built-in avatar or uploaded picture (cropped), theme (light/dark/default) and accent colour; change email or password |
| Guided tour | First-time tour of the dashboard; replay any time |

## Teacher features

Teachers run classes end to end: create a class, go live, watch the class's attention board, take attendance automatically, set work and quizzes, and review history; they only ever see their own classes.

| Feature | What the teacher can do |
| --- | --- |
| Home | Live-session banner; quick actions (go live, post, assignment, quiz); class switcher; "Needs your attention" list; insights and recent activity; all from real data |
| Classes | Create classes with a unique join code and optional password (stored hashed); open/close joining; new code; rename; delete |
| Master list | Everyone who joined: online status, session status, attendance rate; remove from session, let back in, invite again, remove from class |
| Live sessions | Start/end a live session; every student on the master list is invited; sessions left open are closed automatically |
| Live focus board | Each student's live score and state (Focused / Mixed / Looking away / Eyes closed / Can't measure / On a break / Joined, camera off / Not joined); "check in?" flag after several low readings in a row; class average chart; heat map; filters |
| Attendance | Present / late (after a set number of minutes, 10 by default) / absent, taken automatically; editable marks incl. excused; spreadsheet (CSV) download |
| History | Saved live sessions with each student's shared focus |
| Posts | Announcements to the class |
| Assignments | Instructions, deadline, "marks out of", attachment; download submissions; marks and feedback |
| Quizzes | Multiple choice (2–6 choices), optional timer per question, optional leaderboard; lobby → questions → reveal → results; sees each student's camera, focus per question and answers; results with a Focus column |
| Online class link | Save a Zoom or Google Meet link per class (Settings, or "Add Zoom/Meet link" under Start live session); "Open Zoom/Meet" button |
| All students / Attendance report | Every student across classes; attendance rate = (present + late) / (present + late + absent) |
| Profile and tour | Display name, picture, email/password; guided tour |

## Attention tracking

The tracker turns each camera frame into a reading about 8 times a second (every 120 ms) on the student's device; a frame that cannot be measured is "unavailable" and never counted as 0 or as distracted.

From frame to score:

1. The camera (640×480) feeds MediaPipe Face Landmarker: 478 face points, iris points and a 4×4 head transformation matrix.
2. Each frame is checked: exactly one face, fully in view, close enough (3D eye width at least 2.5% of the frame width, allowing for head turn), eyes open enough (lid gap at least 10% of eye width).
3. A usable frame gives 8 numbers: horizontal and vertical eye direction, eye openness, signed head turn, face size, head yaw, pitch and roll.
4. Rule-based score (live today): smoothed eye direction and head turn; looking aside if the iris is outside 36–64% of the eye or the head is turned past 25% of the face width. Score = share of the last ~2 s pointed at the screen (10–100).
5. LSTM score (built, not live): the last 16 usable readings go through the trained model; score = probability of being focused; below 50% = not focused.
6. The reading goes to the student's screen, the saved history (one sample every 5 s) and, during a live session, to the teacher (about once a second).

| State | Meaning | Counted? |
| --- | --- | --- |
| Active · on screen | Face and eyes point at the screen | Yes, focused |
| Active · looking away | Eyes or head turned away | Yes, not focused |
| Active · eyes closed (drowsy) | Eyes shut for 3 s or more while facing the screen | Yes, not focused (score 10) |
| Unavailable | No face, more than one face, face partly out of view, too far, eyes not visible, eyes shut under 3 s | No (a gap, never 0) |
| Break | The focus timer's break | No |
| Off | Camera off | No |

Other tracking work done this phase:

- **Drowsiness:** blinks (under 0.5 s) change nothing; eyes shut 0.5–3 s = unavailable; 3 s or more = "Eyes closed". Only when the head is turned under 30° and bowed under 35°, so reading notes on a desk is not mistaken for sleep. Students get a "Feeling sleepy?" nudge; teachers see "Eyes closed". On the recorded data, about 17% of the "act tired" task reads as eyes closed and no other task triggers it.
- **Background tracking:** browsers slow hidden tabs' timers to once a second (once a minute after 5 minutes), which paused tracking when students switched to Zoom or Meet. A small web worker now keeps time for the tracker, attendance check-ins, saves, the focus timer and quiz reports, and the Supabase live connection's heartbeat also runs in a worker. Measured in Chrome with the tab hidden for 60 s: 8.3 readings a second, against 1.0 before.
- **Too-far fix:** eye width is measured in 3D and allows for head yaw, so turning the head is no longer read as "too far from the camera".
- **Saved sessions** record measured, unavailable and break time separately; the focus percentage uses measured time only.

## AI attention model (LSTM)

The LSTM pipeline is complete (data recorder, training script, browser model, tests); on one participant it caught 97.8% of distracted moments against 34.8% for the current rules, but it stays off the live site until 5–6 more people are recorded.

**Data collection.** A recorder page (https://neurofocus.site/pages/model-data.html, unlinked) guides a participant through about 6 minutes of tasks, each done twice in random order with beeps: read a text and follow a moving dot (labelled focused); use your phone, look away and act tired (labelled distracted). It saves the 8 tracker numbers per reading to a CSV the participant downloads. No video or pictures are kept and nothing is uploaded. Participants use a code (P01, P02…), not their name, and tick a consent box. Each file records the tracker version so recordings made with different tracker rules are never mixed.

**Training** (`ml/train_lstm.py`, PyTorch): windows of 16 readings (about 2 s), a new window every 4 readings; the first second of each task skipped; unusable readings are gaps, never inputs. Model: one LSTM layer with 24 hidden units and one output (probability of focused); 40 epochs, Adam, learning rate 0.005, classes weighted equally; every window also used mirrored left-right so the model handles turning either way. Testing is leave-one-person-out (each person tested by a model trained only on others); with one person, round 1 trains and round 2 tests.

**In the browser** (`scripts/tracking/attention-model.js`): the exported weights are run in plain JavaScript; tests confirm it gives the same output as PyTorch to 5 decimal places. If the model is missing or from another tracker version, the rules are used.

**Results so far (participant P02 only, preliminary):**

| Measure | LSTM | Current rules |
| --- | --- | --- |
| Accuracy | 88.8% | 66.7% |
| Balanced accuracy | 89.0% | 65.7% |
| Distracted moments caught (recall) | 97.8% | 34.8% |
| Distracted flags that were right (precision) | 82.3% | 90.6% |
| Focused moments left alone | 80.3% | 96.6% |
| AUC | 92.8% | 72.7% |

By task (LSTM vs rules): read 93% vs 100%; follow the dot 67% vs 93%; phone 94% vs 0%; look away 100% vs 87%; act tired 100% vs 0%. The model's weak spot is false alarms on the follow-the-dot task (looking at screen edges). These numbers come from acted tasks by one person and show only that the approach works; they are not real-classroom accuracy.

**Status and next steps:** collect recordings from 5–6 or more people (varied glasses, cameras, lighting), retrain, report leave-one-person-out results, then switch the live site to the model and retire the old placeholder `backend/ai_service.py` (a FastAPI stub that only simulates a score and is not used by the app).

## Online classes: Zoom and Google Meet

Students join a class's Zoom or Google Meet call from inside Neuro-Focus, and their attention keeps being tracked and shared while the meeting is in front; this meets FR-10 and Objective 7.

How it works:

1. The teacher saves the class's Zoom or Meet link (Settings → Online class, or "Add Zoom/Meet link" under Start live session). Only https links on zoom.us, zoom.com (and subdomains) or meet.google.com are accepted; the database refuses anything else, including look-alike addresses.
2. The teacher starts a live session; an "Open Zoom/Meet" button opens their own meeting.
3. Students see "Join on Zoom" / "Join on Google Meet" on the class page, the Classes live strip and the invitation notice. One click joins the live session (attendance + focus sharing) and opens a small always-on-top **floating focus window** (Document Picture-in-Picture, Chrome and Edge).
4. The floating window shows the tracking state and score, an "Open Zoom/Meet" button and "Leave session". In other browsers the meeting opens in a new tab instead. "Join here only" joins without the meeting.
5. Tracking continues in the Neuro-Focus tab behind the meeting (background tracking, section 8).

Options considered (useful for the design chapter): an official Zoom App / Meet add-on (rejected: developer approval needed and unclear camera access inside their panels); a browser extension inside the meeting page (kept as possible future work); the Zoom/Meet APIs for attendance sync (future work: may need a paid Zoom plan or a Google Workspace account).

Limits: phones are not supported (they pause background pages and block a second app from using the camera); with the Zoom desktop app on Windows some webcams work in only one app at a time, so Zoom in the browser is recommended there. Tested by the team for a few minutes in a real meeting; a test of more than 5 minutes hidden is still to be done.

## Database, security and privacy

All data lives in Supabase PostgreSQL across 20 tables and 2 private file buckets; who can read or change what is enforced by the database itself (Row Level Security and checked functions), not only by the web pages.

**Tables** (useful for the ERD): `profiles`, `classes`, `class_access` (hashed join passwords), `class_members`, `class_sessions` (live sessions), `session_attendance`, `attention_sessions` and `attention_samples` (saved focus, one sample per 5 s), `student_notes` (and the older `class_notes`), `class_posts`, `assignments`, `assignment_submissions`, `quizzes`, `quiz_questions`, `quiz_participants`, `quiz_answers`, `quiz_camera` (camera on/off reports), `quiz_focus` (focus per question), `ai_usage_limits` (30 assistant requests a day). Storage buckets: `avatars` (2 MB, pictures) and `class-files` (20 MB, documents and images), both private, opened only through short-lived signed links.

**Database updates** (all in `supabase/migrations/`, run in order, each safe to run again):

| Update | Adds |
| --- | --- |
| 20261001 learning_classes | Profiles, classes, membership, join codes and passwords, notes, AI usage limits |
| 20261002 attention_history_and_private_live | Saved attention sessions and samples; private live channels |
| 20261003 class_management | Remove students, open/close joining, new code, rename, delete, leave class |
| 20261004 student_notes | Many private notes per student |
| 20261005 sessions_attendance | Saved live sessions, automatic attendance, late threshold, remove from session |
| 20261006 live_workflow_hardening | Shared history tied to a live session; stale sessions closed automatically |
| 20261007 student_profiles | Avatars, theme, accent, avatar storage, teacher names for students |
| 20261008 teacher_avatars | Teacher picture visible to their students |
| 20261009 tracking_quality | Measured, unavailable and break time; unavailable samples stored as gaps |
| 20261010 class_posts_assignments | Posts, assignments, submissions, marking, private class files |
| 20261011 class_quizzes | Live quizzes, scoring in the database, results, leaderboard |
| 20261012 open_teacher_signup | Role chosen at sign-up; Google sign-ups can choose Teacher |
| 20261013 quiz_focus | Camera required to join/answer quizzes; focus per question |
| 20261014 class_meeting_links | Zoom/Meet link per class with strict link check |

**Who sees what:**

| Data | The student | Their teacher | Classmates / other teachers |
| --- | --- | --- | --- |
| Profile name and picture | Own | Students in their classes | No |
| Attendance | Own | Their classes | No |
| Saved attention history | All of their own | Only what was shared during that teacher's live sessions | No |
| Notes | Own | No | No |
| Live scores | Sends during a live session | Receives | Never |
| Quiz focus | Own | Their classes | Never (not even on the leaderboard) |
| Assignment submissions | Own | Their classes | No |

**Privacy design:** no video, pictures or audio leave the device; only numbers are sent or stored; the camera starts only on the student's click; solo sessions are private; class passwords are hashed; uploaded files are private; the recorder keeps no video and uses participant codes; a privacy policy page is linked from the home page. **Known limits:** live scores come from the student's browser, so a determined student could send made-up numbers; saved attendance and history are always written as the signed-in student and checked by the database.

## Testing evidence

396 automated checks in 4 suites all pass, and GitHub Actions runs them on every push to `main` (a green tick or red cross appears next to each commit on GitHub).

| Suite (in `tests/`) | Checks | What it proves |
| --- | --- | --- |
| `access-rules.test.mjs` | 262 | Runs every database update twice in an in-memory PostgreSQL set up like Supabase, then checks who can read and write what: students vs classmates, teachers vs other teachers, signed-out visitors; classes, live sessions, attendance, notes, posts, assignments, quizzes, quiz camera/focus rules, teacher sign-up, meeting links (incl. 8 look-alike links refused) |
| `tracking.test.mjs` | 93 | Tracker rules: no face, two faces, out of view, too far, head turn, blinks, looking away; reading states; session numbers; saved samples; Focus coach wording |
| `drowsiness.test.mjs` | 22 | Eyes closed vs eyes not visible; the 0.5 s / 3 s rule; slow blinks never count; eyes-closed time counted as measured, not focused |
| `meeting-links.test.mjs` | 19 | The page's Zoom/Meet link check accepts and refuses the same links as the database |

Also tested this phase:

- **Attention model:** with the model in place, 12 more checks confirm the browser LSTM matches PyTorch's output to 5 decimal places and handles gaps (these join the suite when the model goes live).
- **Background tracking experiment:** three timing methods compared in real Chrome with the tab hidden for 60 s: page timer 1.0 readings/s, worker timer 8.3/s, worker reading the camera 7.5/s; the worker-timer method was adopted.
- **Model evaluation:** the training script reports accuracy, balanced accuracy, recall, precision, F1, AUC, per task and per person, against the rules on the same windows (section 9).
- **Manual checks in the browser** of each feature, including phone width (375 px) layouts, and by the team with real accounts (quiz camera rule, Join on Meet, drowsiness with a real camera).

Still to do for the testing chapter: a test table (test ID, requirement, steps, expected, actual, pass/fail, date) built from the above; a usability study (e.g. the System Usability Scale) with real users; a long-session test (over 5 minutes in a background tab); load testing with many students.

## Deployment and tools

The site deploys itself: every push to the `main` branch on GitHub is published by Netlify to https://neurofocus.site within about a minute, and database changes are applied as SQL files in the Supabase dashboard.

| Tool / service | Used for |
| --- | --- |
| GitHub | Source code, version history, GitHub Actions (tests on every push; a job every 3 days that keeps the free Supabase project from pausing) |
| Netlify | Hosting; publishes only the website files (reports, tests and database files stay private) |
| Namecheap | The neurofocus.site domain and DNS; email forwarding for contact@neurofocus.site |
| Supabase | Auth (email, Google), PostgreSQL, Realtime, Storage, Edge Function `learning-assistant` |
| Brevo | Sending sign-up, password-reset and email-change emails from no-reply@neurofocus.site (branded templates) |
| Google Cloud | "Continue with Google" sign-in |
| Google Gemini (default; Groq or OpenAI optional) | NeuroBuddy AI answers, note organising and flashcards, through the Edge Function (keys never in the browser) |
| MediaPipe Tasks Vision 0.10.14 | Face landmarks and head pose in the browser |
| PyTorch 2.8, NumPy 2.0 (Python) | Training and evaluating the LSTM |
| Chart.js | Charts on dashboards |
| PGlite + Node.js | In-memory PostgreSQL for the database tests |
| Python dev server (tools/serve.py) | Running the site locally with browser caching turned off |

Accounts and environments: local development runs at http://localhost:8000 (`python3 tools/serve.py`); the live site and local copy use the same Supabase project.

## Limitations and future work

The main limitation is evidence, not features: the attention model has data from one person, and there is no usability study or long-session test yet.

Limitations to state honestly in the report:

- **Model data:** one participant (P02) so far; results are from acted tasks, not real lessons; possible false alarms when looking at screen edges.
- **What is measured:** scores estimate where the face and eyes point. Looking away is not proof of distraction (a student may be thinking or reading notes), and looking at the screen is not proof of understanding.
- **Trust:** live scores come from the student's browser and could be faked by a determined student; attendance and saved history are checked by the database.
- **Devices:** a laptop or desktop webcam in Chrome or Edge is needed for the full experience; phones are not supported during Zoom/Meet calls; the Zoom desktop app on Windows may block a second camera user.
- **Background tabs:** proven for 60 s hidden in Chrome on macOS and a few minutes by the team; longer periods, minimised windows and other browsers still need testing.
- **Lighting, glasses and camera quality** affect tracking; frames that cannot be measured are shown as unavailable rather than guessed.
- **No admin role** and no load testing with many simultaneous students.
- **Free tiers:** the Supabase free project pauses after a week without use (a scheduled job prevents it); the AI assistant has daily limits.

Future work: collect more recordings and switch the live score to the LSTM; Zoom/Meet attendance sync through their APIs; a browser extension that shows Neuro-Focus inside the meeting page; teacher insight linking quiz focus to correct answers; a usability study; splitting the largest code files before the viva.

## Recent changes log

Phase 2 development ran from 4 October 2026; the latest round (14–15 November) closed the last proposal gaps except the live LSTM.

| Date | Change | Summary |
| --- | --- | --- |
| 15 Nov 2026 | Drowsiness detection | Eyes closed 3 s+ while facing the screen counts as not focused; sleepy nudge; "Eyes closed" for teachers |
| 15 Nov 2026 | Zoom / Google Meet integration | Class meeting link, Join on Zoom/Meet, floating focus window, easy-to-find link button |
| 15 Nov 2026 | Background tracking | Tracker, check-ins, saves, timer, quiz reports and live connection keep running in hidden tabs |
| 15 Nov 2026 | Clean-up and automatic tests | Unused files removed; tests run on every push |
| 15 Nov 2026 | Quiz attention monitoring | Camera required for quizzes; focus per question for teachers and students |
| 15 Nov 2026 | Open teacher sign-up | No manual approval; the role is chosen at sign-up (also via Google) |
| 15 Nov 2026 | Tracker accuracy fixes | 3D eye width and head-angle allowance: turning the head no longer reads as "too far"; mirrored training data |
| 15 Nov 2026 | Reliability | Clear sign-in message when the server can't be reached; job keeping the Supabase project awake |
| 14 Nov 2026 | Attention model pipeline | Data recorder page with richer tracker readings; LSTM training and evaluation script |
| 10 Nov 2026 | Clean-up | Unused code and styles removed |
| 14 Oct 2026 | Class pages and live board | Class pages, live classroom board, end-of-session summaries; Solo focus layout; branded emails |
| 13 Oct 2026 | Privacy policy | Privacy policy page linked from the home page |
| 12 Oct 2026 | Deployment and NeuroBuddy dock | Live at neurofocus.site on Netlify; floating NeuroBuddy chat; teacher Home rework, shared sidebar and tours; Phase 2 report draft started |
| 10 Oct 2026 | Neuro-Focus v2 | Tracking quality (unavailable is not zero), class posts, assignments and quizzes |
| 7 Oct 2026 | Classroom hub | Class/solo separation, posts and assignments, quizzes |
| 5–6 Oct 2026 | Dashboards | Student Home, profiles and themes, Focus coach, teacher Home, tracking reliability, Google sign-in messages |
| 4 Oct 2026 | Start of Phase 2 code | Project set-up |

## What to write next

The existing working draft (`documentation/phase-2/NeuroFocus-Phase-2-Working-Draft.md`, dated 10 October) is out of date: it calls the LSTM a simulated stub and lists quiz monitoring and Zoom/Meet as missing, so update it from this report chapter by chapter.

| Report chapter | Feed it from these sections | Notes |
| --- | --- | --- |
| 1 Introduction (purpose, objectives, existing solutions, gap analysis) | Project at a glance; Requirements status | Existing-solutions comparison still needs real references |
| 2 Software Requirement Specification | Requirements status; Changes from the proposal | State the FR numbering used; update FR-01 wording (no recording) |
| 3 Use Case Analysis | Student features; Teacher features; Online classes | Actors: Student, Teacher (no Admin); Zoom/Meet as external systems |
| 4 Design | Architecture; Attention tracking; Database; AI model | Diagrams needed: architecture, ERD (20 tables), sequence for a live session and for Join on Meet, tracker state diagram |
| 5 Testing | Testing evidence; AI model results | Build the test table; add usability and long-session tests if time allows |
| 6 Tools and Techniques | Deployment and tools | |
| 7 Summary and Conclusion | Requirements status; Limitations | Write after the final model results |
| 8 User Manual | Student features; Teacher features; Online classes | Screenshots from the live site |
| 9 Lessons Learnt and Future Enhancements | Changes from the proposal; Limitations and future work | Stack change, privacy-first design, background-tab problem, data collection |

Open questions for the team:

- [ ] Confirm with the supervisor/coordinators that the stack change (Supabase instead of Laravel/MySQL/FastAPI) is accepted and how to present it.
- [ ] Ask whether Zoom/Meet attendance sync through their APIs is expected, or whether the floating focus window meets FR-10.
- [ ] Collect attention recordings from 5–6+ more people so final model results can go into Chapters 4, 5 and 7.
- [ ] Decide whether to run a short usability study (e.g. System Usability Scale) with recording participants.
- [ ] Take screenshots of each main screen for the user manual and design chapters.
- [ ] Confirm title-page details (supervisor, IDs, submission date).
