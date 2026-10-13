# Neuro-Focus

A student-centered classroom prototype built with static HTML/CSS/JavaScript, Supabase Auth/Postgres, and a Supabase Edge Function for OpenAI-powered study support.

## Local setup

1. Create a Supabase project.
2. In **Project Settings → API**, copy the project URL and the publishable key (or legacy anon key) into `scripts/services/supabase-client.js`.
   - These browser credentials are public by design. Never put a `service_role` key in browser code.
3. Apply `supabase/migrations/20261001000000_learning_classes.sql` in the Supabase SQL Editor, or install the Supabase CLI and run:

   ```sh
   supabase login
   supabase link --project-ref awklqioisiiyaqixnnbl
   supabase db push
   ```
4. In **Authentication → URL Configuration**, set **Site URL** to `http://localhost:8000` and add `http://localhost:8000/**` and `http://127.0.0.1:8000/**` to **Redirect URLs** (plus `http://localhost:8001/**` etc. if you run extra test ports). Email confirmation, password reset and Google sign-in links only return to addresses on this list.
5. From the project folder, start the included dev server. It serves the project root and turns off browser caching so your edits always show up:

   ```sh
   python3 tools/serve.py
   ```

   Then open `http://localhost:8000`. Do not use `file://`; ES modules and camera access require localhost or HTTPS. To run several test accounts side by side, add ports: `python3 tools/serve.py 8000 8001 8002`.

## Live site (https://neurofocus.site)

The site is hosted on Netlify, which publishes `main` automatically on every push. `netlify.toml` publishes only the website files (`index.html`, the redirect pages, `pages/`, `scripts/`, `styles/`, `assets/`); the report drafts, backend, database, Supabase project files and tests are never public. The domain is registered at Namecheap; its DNS (Advanced DNS) points at Netlify, and `neurofocus.site` is the primary address (`www.neurofocus.site` redirects to it).

For sign-in and NeuroBuddy to work on the live site:

- **Supabase → Authentication → URL Configuration:** Site URL `https://neurofocus.site`; Redirect URLs also include `https://neurofocus.site/**` (keep the localhost entries for development).
- **Google Cloud Console:** nothing to add for the domain. Google only ever returns people to Supabase (`https://awklqioisiiyaqixnnbl.supabase.co/auth/v1/callback`, already an Authorized redirect URI), and Supabase sends them on to the site. For anyone (not just listed test users) to sign in with Google, the app's **Google Auth Platform → Audience → Publishing status** must be **In production**.
- **Supabase → Edge Functions → Secrets:** `APP_ORIGIN` = `https://neurofocus.site` (localhost stays allowed).

## Project layout

```
index.html                 Home page (project root)
login.html, student.html,  Small redirects to pages/, so old links and emailed
teacher.html               sign-in / reset links keep working
pages/                     login.html, student.html, teacher.html (+ an old teacher landing backup)
styles/                    Shared stylesheets (each page also has its own inline styles)
scripts/
  auth/                    Login page (auth.js) and dashboard sign-in guard (auth-guard.js)
  home/                    Home page behaviour
  student/                 Student dashboard: classes, focus, history, notes, NeuroBuddy chat
  teacher/                 Teacher dashboard: classes, attendance, live analytics
  tracking/                On-device attention tracker (MediaPipe)
  services/                Supabase client and the NeuroBuddy (Edge Function) API
  shared/                  Used by more than one page: live channels, Markdown, dashboard nav, 3D background
assets/images/             Images
assets/models/             3D models
backend/                   Optional Python prediction service (not used by the web app yet)
tools/                     Local dev server
database/                  Reference MySQL schema
supabase/                  Supabase config, Edge Functions and SQL migrations
tests/                     Database access-rule tests
```

## Sign-in options: Google and password reset

The login page has **Continue with Google**, **Forgot password?** and a confirm-password box on sign-up.

**Password reset** works once the Redirect URLs above are set. Supabase emails a link that opens `pages/login.html?mode=reset`, where the person chooses a new password. Supabase's built-in email sender only sends a few emails per hour, so before real use add your own sender in **Authentication → Emails → SMTP Settings**.

**Continue with Google** needs a one-time setup (until then the button explains that it isn't turned on):

1. In [Google Cloud Console](https://console.cloud.google.com/), open **APIs & Services → OAuth consent screen**, choose **External**, and fill in the app name and support email. While the app is in *Testing*, add the Gmail accounts that may sign in under **Test users**.
2. Go to **Credentials → Create credentials → OAuth client ID → Web application**.
   - **Authorized JavaScript origins:** `http://localhost:8000` (and any other addresses you use).
   - **Authorized redirect URIs:** `https://awklqioisiiyaqixnnbl.supabase.co/auth/v1/callback`
3. Copy the client ID and client secret into **Supabase → Authentication → Sign In / Providers → Google**, turn it on and save.

People who continue with Google get a student account named after their Google profile. Teachers are promoted with the SQL below, the same as email accounts. If someone already has an email account with the same Gmail address, Supabase links the two.

## Enable a teacher account

New accounts always receive the student role. The teacher choice at signup is a request and cannot grant privileges by itself. After a trusted teacher account has been created and confirmed, the project owner can promote it in the Supabase SQL Editor:

```sql
update public.profiles
set role = 'teacher'
where id = (select id from auth.users where lower(email) = lower('teacher@example.com'));
```

Sign out and back in after changing a role. Never let an untrusted user run this SQL.

## Connect NeuroBuddy (free with Google Gemini)

NeuroBuddy, the student study assistant and note organizer, calls the `learning-assistant` Supabase Edge Function. The function checks the signed-in student and class membership, then calls an AI provider through its OpenAI-compatible Chat Completions API. API keys live only in Supabase Function Secrets, never in a browser file.

| `AI_PROVIDER` | Cost | Key secret | Get a key | Default model |
|---|---|---|---|---|
| `gemini` (default) | Free tier, no card | `GEMINI_API_KEY` | https://aistudio.google.com/apikey | `gemini-3.8-flash` |
| `groq` | Free tier, no card | `GROQ_API_KEY` | https://console.groq.com/keys | `openai/gpt-oss-120b` |
| `openai` (ChatGPT models) | Paid API credit | `OPENAI_API_KEY` | https://platform.openai.com/api-keys | `gpt-6-luna` |

1. **Get a free Gemini API key** at https://aistudio.google.com/apikey (sign in with a Google account).
2. **Add secrets** in **Supabase Dashboard → Edge Functions → Secrets**:
   - `GEMINI_API_KEY`: your key
   - `AI_PROVIDER` (optional): `gemini`, `groq` or `openai`; defaults to `gemini`
   - `AI_MODEL` (optional): overrides the default model, for example `gemini-3.1-flash-lite` if you hit free-tier rate limits
   - `APP_ORIGIN` (optional): your HTTPS production origin once deployed; `http://localhost:8000` is always allowed
3. **Deploy the function.** The Supabase CLI runs through `npx` (Node is required):

   ```sh
   npx supabase login
   npx supabase link --project-ref awklqioisiiyaqixnnbl
   npx supabase functions deploy learning-assistant
   ```

   Or, without the CLI: **Supabase Dashboard → Edge Functions → Deploy a new function → Via editor**, name it `learning-assistant`, paste `supabase/functions/learning-assistant/index.ts`, and keep **Verify JWT** on.

Each student account is limited to 30 NeuroBuddy requests per day (each answer or flashcard deck counts as one), and free tiers also have provider-wide per-minute limits shared by all students. **Privacy:** on Gemini's free tier, Google may use prompts and responses to improve its products (the paid tier does not). NeuroBuddy only sends the student's question, the class name, recent chat turns and the text of files the student added to that chat, and tells students to avoid personal details.

### NeuroBuddy chats, files and flashcards

- **Chats:** students start as many chats as they like (**New chat**), search, rename and delete them. Each chat can have a class for context. Chats are saved in the browser on that device (per account), like before; the old single chat per class becomes chats automatically the first time.
- **Files:** the paperclip (or drag and drop, or paste a picture) adds PDF, Word (.docx), PowerPoint (.pptx), text, Markdown or CSV files, or photos (JPG, PNG, WebP), up to 15 MB each and 5 files per chat. Files are read **on the student's device**: only their text (up to 30,000 characters each) is kept with the chat and sent with questions. Pictures are shrunk and sent with that one message; they aren't kept. Scanned PDFs have no text, so students are asked to add a photo instead. The PDF, Word and PowerPoint readers load from cdnjs the first time they're needed, checked against fixed integrity hashes.
- **Explanation style** (Direct & simple, Step by step, With examples, Short answers) is a menu in the message box, remembered on the device.
- **Flashcards:** from the chat, one of its files, or any topic, 5–20 cards. Practising works like a pile: *Got it* takes a card out, *Again* puts it back a few cards later until it’s known. The summary lists the tricky cards; those come first next time. Decks are saved with the chat.
- **Update the function** to use files and topic flashcards: redeploy `learning-assistant` (step 3 above). Version 2 of the function reads files and pictures and adds the `flashcards` task. Until it's redeployed, chats still work, flashcards from a chat or file fall back to the older 10-card quiz, and NeuroBuddy tells students it can't read files yet. Pictures need a provider that accepts images (`gemini` or `openai`; not `groq`).

## Phase 2 database update (saved history + private live channels)

Run this once. It is safe to run again.

1. Open **Supabase Dashboard → SQL Editor → New query**.
2. Paste the whole of `supabase/migrations/20261002000000_attention_history_and_private_live.sql` and click **Run**.

It adds:

- `attention_sessions` and `attention_samples` (the ERD's Session and Attention Score): one session per tracking run and one sample every 5 seconds. Students can only write their own data; teachers can only read their own classes. Only numbers are stored, never video.
- Rules for the private live channels: a class's teacher receives live scores; its students can send them and see who is online, but never receive classmates' scores.

Optional: in **Project Settings → Realtime**, turn off **Allow public access** so only private channels are allowed.

## Phase 2 class management update

Run this once, after the update above. It is safe to run again.

1. Open **Supabase Dashboard → SQL Editor → New query**.
2. Paste the whole of `supabase/migrations/20261003000000_class_management.sql` and click **Run**.

It lets teachers remove students, open or close joining, change the join password or code, rename and delete classes, and announce live sessions to their students. Students can leave classes, and rejoining a class they were already in always works.

## Notes update (many notes per class, formatting, quizzes)

Run this once. It is safe to run again.

1. Open **Supabase Dashboard → SQL Editor → New query**.
2. Paste the whole of `supabase/migrations/20261004000000_student_notes.sql` and click **Run**.
3. Redeploy the assistant so answers stream in as they're written and **Quiz me** works:

   ```sh
   npx supabase functions deploy learning-assistant
   ```

   (Or paste the new `supabase/functions/learning-assistant/index.ts` into the function in the dashboard editor and deploy.)

It adds `student_notes`: each student can keep any number of notes, filed under one of their classes or kept personal. Existing class notes are copied in automatically. Students always keep their own notes, even after leaving a class, and teachers can never read them. The old `class_notes` table is no longer used by the app.

## Sessions and attendance update (master list invites, remove from session, attendance)

Run this once, after the updates above. It is safe to run again.

1. Open **Supabase Dashboard → SQL Editor → New query**.
2. Paste the whole of `supabase/migrations/20261005000000_sessions_attendance.sql` and click **Run**.

It saves every live session (`class_sessions`) and takes attendance (`session_attendance`):

- **Master list:** everyone who has joined a class. Starting a live session invites the whole list automatically, including students who join the class during the session. **Invite again** re-sends the invite to a student who hasn't joined.
- **Remove from session:** takes a student out of the current live session only. Their focus stops being shared and they can't rejoin it until you press **Let back in**. They stay on the master list and are invited to the next session. **⋯ → Remove from class** is still there for taking someone off the list.
- **Attendance:** students are marked present when they join, late if they join after the class's late threshold (10 minutes by default, set in **Settings**), and absent if they never join before you end the session. Teachers can change any mark to present, late, absent or excused in the **Attendance** tab and download a spreadsheet. Attendance records keep the student's name, so they survive the student leaving the class. Students see their own attendance on their class cards.

Without this update, live sessions still work as before, but nothing is saved and attendance isn't taken.

## Live workflow update (run after the sessions and attendance update)

Run `supabase/migrations/20261006000000_live_workflow_hardening.sql` once in the SQL Editor. It is safe to run again.

- **Shared attention history is tied to the live session it came from.** The database only lets a student save class-linked history while that class has an open live session they haven't been removed from. Everything else stays personal, so teachers only ever see attention recorded during their own live sessions.
- **Sessions can't be left open forever.** The teacher's dashboard checks in every minute while live. If it was closed without pressing **End**, the session is ended at the dashboard's last activity the next time the teacher opens Neuro-Focus, and students who never joined are marked absent.

## Student profiles update (Home dashboard, Profile settings, themes)

Run `supabase/migrations/20261007000000_student_profiles.sql` once in **Supabase Dashboard → SQL Editor** (paste the whole file, click **Run**). It is safe to run again. It doesn't change any existing data.

- **Profile settings:** adds a picture or built-in avatar, a theme (`default`, `light`, `dark`) and an accent colour (`default`, `blue`, `purple`, `green`, `orange`) to `profiles`. Students change their own profile only through `update_my_profile()`, which checks every value (display names: 1–40 characters) and can never change the role. Profiles can't be edited directly.
- **Private `avatars` storage bucket** (2 MB per file; JPG, PNG or WebP). Each person can only upload, replace or delete pictures in their own folder. A picture can be viewed by its owner and by the teachers of classes the owner is in, through links that expire after an hour. It is never public.
- **`my_class_teachers()`:** lets students see their teacher's name on class cards without being able to read the teacher's profile.

Check it worked: **Storage** should now list a private bucket named `avatars`. Until this update is run, the student pages still work with the default look and initials, and Profile settings explains that saving needs the update.

What students get:
- **Home** is the page they land on after signing in, kept deliberately simple: a greeting with one main action (back to a live session they're in → join a live class → join a first class → continue a recent note → start a focus session); three small charts (focus score, focus time per day this week, day streak); **Today**, a checklist of their own steps (shared with Solo focus) plus any live class to join; **Jump back in** (latest note, NeuroBuddy chat and focus session); and the Focus coach: practical tips from whatever sessions they have, even just one (no minimum), most useful first with **Next tip** for the rest. Each tip says what it is based on ("From your last session", "From 4 sessions"), patterns from little data are marked as early signs, and tips never claim that something improves focus. With no sessions yet, general tips are shown and labelled as such. No timetable is connected, so nothing is guessed. The camera never starts until they press a button.
- **Focus session** is about the session in progress: the attention tracker, live scores, lapses and the live focus timeline, the timer and steps. **My progress** is the student's track record: finished, saved sessions, summaries, charts, date ranges and insights. A session still being recorded is left out of My progress until it is stopped; one that was never stopped (e.g. the page was closed) is marked *Unfinished*.
- **Profile settings** (account menu, or the picture on Home): display name, built-in avatars or an uploaded picture with a square crop, and theme/accent with a live preview. **Save changes** stores everything on the account; **Cancel** goes back to what is saved.
- **Sign-in and security** (in Profile settings, for students and teachers; saved on its own): change the sign-in email or password. Both ask for the current password first. A new email only takes effect after the person opens the confirmation link Supabase emails (with Supabase's default *Secure email change*, a link goes to both the old and new address; the sign-in page says when one is left). Accounts that only use Google get an emailed link to set a password instead. Nothing here needs a database update; it uses Supabase Auth. In Supabase → Authentication → URL Configuration, `…/pages/login.html` must be an allowed redirect URL (it already is if sign-up confirmation and password reset work).

The chosen theme is also remembered in the browser for that account only, so pages open in the right colours straight away. It is cleared on sign-out and ignored if a different account signs in. Teacher pages always keep the default look.

## Teacher avatars update (teacher name and picture on students' class cards)

Run `supabase/migrations/20261008000000_teacher_avatars.sql` once in **Supabase Dashboard → SQL Editor**, after the student profiles update. It is safe to run again and doesn't change any data.

- Students' class cards show their teacher's name and avatar (built-in avatar or uploaded picture).
- A teacher's uploaded picture can be viewed by the teacher and by students in that teacher's classes, through the same short-lived signed links. Nobody else can see it and it is never public. Students' pictures are unchanged: only the student and their class teachers can see them.

Until it is run, class cards show the teacher's name with initials.

## Tracking quality update (unavailable time is not zero attention)

Run `supabase/migrations/20261009000000_tracking_quality.sql` once in **Supabase Dashboard → SQL Editor**, after the earlier updates. It is safe to run again. It only adds columns and allows new sample states; no existing row is deleted or changed.

- Each saved session records how much time the tracker could actually measure (`usable_seconds`), how much it couldn't (`unavailable_seconds`: no face, more than one face, no readings) and break time (`break_seconds`). `focus_percent` is the estimated on-screen share of the measured time only.
- Samples can be saved as `Unavailable` or `Break` with no score, so gaps are stored as gaps, never as 0.
- Older sessions keep their numbers and are shown as "older method": back then, time with no face in view counted as not focused. They still appear in history and totals, but Focus Coach only uses sessions with tracking-quality information for personal suggestions.

Until it is run, the app still works: unavailable and break samples aren't saved (they show as gaps), and a session's tracked time is its measured time, so its percentage keeps the same meaning. Attendance never depends on any of this.

## Class Posts and Assignments update

Run `supabase/migrations/20261010000000_class_posts_assignments.sql` once in **Supabase Dashboard → SQL Editor**, after the tracking quality update. It is safe to run again and doesn't change any existing table or row.

- **Posts:** the class's teacher publishes announcements; the class's students read them.
- **Assignments:** title, instructions, optional deadline, optional "marks out of" and an optional attachment. Students upload one file each and can replace it until the deadline. The teacher sees every submission, downloads the files and gives optional marks and feedback.
- **Privacy:** files go in the private `class-files` bucket (20 MB, documents and images only) and are only opened through one-minute signed links. A student sees only their own submission; classmates and other classes see nothing. Submitting and marking go through `submit_assignment()` and `mark_submission()`, which check membership, the deadline, the student's own folder, the file type and size, and the marks range.
- Personal notes (`student_notes`) are separate and unchanged.

Until it is run, the Posts and Assignments tabs say the update is needed; everything else keeps working.

## Class Quizzes update

Run `supabase/migrations/20261011000000_class_quizzes.sql` once in **Supabase Dashboard → SQL Editor**, after the Posts and Assignments update. It is safe to run again and doesn't change any existing table or row.

- **Writing:** the class's teacher writes multiple-choice quizzes (2–6 choices per question) with an optional timer per question and an optional leaderboard. Drafts are invisible to students.
- **Running:** the teacher opens a lobby, students join explicitly from the Quizzes tab, then the teacher starts, reveals each answer (or lets the timer run out) and moves on (`quiz_open_lobby`, `quiz_next_question`, `quiz_close_question`, `quiz_finish`).
- **Answering and scoring:** `join_quiz()` and `submit_quiz_answer()` check class membership, that the question is the open one, the timer and the choice. Each student answers a question once (a repeat is refused, not double-counted). Scoring is done in the database: 1 point per correct answer, no speed bonus. Attention and focus scores are never used.
- **What students see:** `quiz_state()` only includes the correct answer and the answer counts once a question has closed; the class's answers are only readable by the teacher. Results are saved; `quiz_results()` gives each student their own summary, and the leaderboard only if the teacher left it on.
- Class Notes "Quiz Me" is separate and unchanged.

Until it is run, the Quizzes tabs say the update is needed; everything else keeps working.

## The full class workflow

1. **Teacher creates a class** (`create_class`) and shares the join code.
2. **Student joins** (`join_class`) and appears on the teacher's master list straight away.
3. **Teacher starts a live session** (`start_class_session`): a saved session is created and everyone on the master list is invited.
4. **Student joins and tracks:** the attention tracker runs on the student's device. While they're in the session their browser checks in every 30 seconds (`check_in_session`, marking them present or late) and sends numbers only (score, state, focus) to the teacher. Video never leaves the device.
5. **Teacher receives updates** on the class's Live focus tab every second, and can remove a student from the session, let them back in or invite them again.
6. **Session ends** (`end_class_session`, or automatically after the dashboard has been gone for 15 minutes): no-shows are marked absent.
7. **Saved records:** attendance (Attendance tab, spreadsheet download), shared attention history per session (History tab, plus a Focus column in each session's attendance), and the student's own Focus history, which includes their personal tracking too.

## Privacy and access rules

Enforced by the database (Row Level Security), not just by the pages:

| Data | Student | Their teacher | Classmates / other teachers |
|---|---|---|---|
| Profile name | Own only | Students in their classes | No |
| Profile picture, theme | Own (only they can change them) | Pictures of students in their classes | No |
| Teacher's name and picture | Of their own classes' teachers | — | No |
| Class membership | Own rows | Their classes | No |
| Attendance | Own rows | Their classes | No |
| Attention history and samples | All of their own | Only what was shared during that teacher's live sessions | No |
| Notes | Own | No | No |
| Live scores (realtime) | Can send in their own classes | Receives | Never receive |

`tests/access-rules.test.mjs` checks all of this against every migration in an in-memory Postgres: `cd tests && npm install && npm test`.

**Known limits:**
- Live scores are reported by each student's browser, so a student could send made-up numbers for themselves. Realtime messages can't prove who sent them, so another class member could also post numbers under a classmate's ID to the teacher's live view. Students act on "removed" messages only after checking with the database. The saved records (attendance and history) are always written as the signed-in student and checked by the database.
- Students in a class can see which (anonymous) account IDs are online in it, because Supabase presence is shared by everyone on the channel. They can't look those IDs up to find names.

## Test a teacher and a student side by side

A browser keeps one sign-in per web address, shared by all its tabs, so two tabs on `http://localhost:8000` are always the same account. Use two addresses instead:

1. Tab 1: open http://localhost:8000 and sign in as the **teacher**. Click **＋ New class**, then **Copy join code**.
2. Tab 2: open http://127.0.0.1:8000 (or a private window) and sign in as the **student**. Open **Classes**, click **＋ Join a class** and paste the code. The teacher gets a "joined" (or "rejoined") notice and the student appears on the **Students** tab with a green online dot.
3. Teacher: press **▶ Start live session**. The student gets a notice, and the class's **Live focus** tab shows a live dot.
4. Student: press **Join live session**. Their attention tracker starts and the teacher's **Live focus** tab shows their score every second. **End live session** stops sharing.

If one tab's account changes because another tab on the same address signed in or out, that tab shows a notice instead of silently acting as the other account.

## Finding your way around

- **Both dashboards share one sidebar layout:** the main pages at the top, then **Your classes** (each class in its own colour, the same everywhere, with a red dot while it is live; **+** creates or joins a class), and at the bottom the **Take the tour** card and a **Profile settings** card. The shared parts live in `styles/dashboard-layout.css`, `scripts/shared/class-colors.js` and `scripts/shared/tour.js`.
- **Students:** Home, Classes, Solo focus, My notes, My progress. NeuroBuddy is the one button in the header on every page; Profile settings is in the account menu and at the bottom of the sidebar. New students get the same kind of guided tour as teachers the first time they open Home.
- **Teachers:** Home, Classes, All students and Attendance report, then **Your classes** (every class with who's online and a live dot; **+** creates one). A running session also gets a **Live now** shortcut, and Home's badge counts submissions waiting to be marked. New teachers get a short guided tour the first time they open Home; **Take the tour** at the bottom of the sidebar replays it. Whether it has been seen is saved on the account (auth user metadata), so it doesn't come back on another device.
- **Inside a class:** Posts, Assignments, Quizzes, Live focus (teachers then have Master list, Attendance, History and Settings). A class opens on Live focus while its session is live, otherwise on Posts. Arrow keys move between tabs.
- The header breadcrumb shows where you are (Home / Classes / Biology / Posts) and every part of it is a link; on phones it shows the last two parts. Old links (`#home`, `#class/<id>`, `#students`, `#attendance-report`, `#buddy`, …) still work.
- Opening a page never turns the camera on. Only **Start focus session**, **Join live session** and **Turn camera on** do; the Zoom and Google Meet links on Solo focus only open the meeting.

## How classes and learning tools work

- Teachers create classes and get a unique join code. They can add a password; class passwords are hashed in the database and are never returned to the browser.
- Each class has the same first tabs for teachers and students: **Posts**, **Assignments**, **Quizzes** and **Live focus** (the teacher's live monitor). Teachers also get **Master list** (online status, session status, attendance rate, **Remove from session**, **Remove from class**), **Attendance**, **History** (saved attention sessions) and **Settings** (rename, open/close joining, late threshold, password, new join code, delete).
- Students join by code, and must also provide the password if one was set. Students already in a class can always rejoin; new students need joining to be open.
- Students share attention scores (never video) only while their teacher runs a live session in the class they are working in. Outside a live session their saved history is personal and teachers can't see it.
- A student's notes belong to their account (Row Level Security). They can file a note under one of their classes or keep it personal. Teachers do not have access to those notes.
- The tutor receives the selected class name and the student's submitted question. The note organizer receives the note's class name and the rough text the student submits; **Quiz me** receives the class name and the text of that one note. Nothing records a live class, meeting, audio, or video.
- Notes are drafts for the student to review. The experimental camera preview remains optional, local, and separate from teacher reporting.

Before using real student data, finish deployment configuration and review privacy, consent, data-retention, and applicable school requirements.
