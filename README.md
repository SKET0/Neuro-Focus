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

Each student account is limited to 30 NeuroBuddy requests per day, and free tiers also have provider-wide per-minute limits shared by all students. **Privacy:** on Gemini's free tier, Google may use prompts and responses to improve its products (the paid tier does not). NeuroBuddy only sends the student's question, the class name and recent chat turns, and tells students to avoid personal details.

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

## The full class workflow

1. **Teacher creates a class** (`create_class`) and shares the join code.
2. **Student joins** (`join_class`) and appears on the teacher's master list straight away.
3. **Teacher starts a live session** (`start_class_session`): a saved session is created and everyone on the master list is invited.
4. **Student joins and tracks:** the attention tracker runs on the student's device. While they're in the session their browser checks in every 30 seconds (`check_in_session`, marking them present or late) and sends numbers only (score, state, focus) to the teacher. Video never leaves the device.
5. **Teacher receives updates** on the Live monitor every second, and can remove a student from the session, let them back in or invite them again.
6. **Session ends** (`end_class_session`, or automatically after the dashboard has been gone for 15 minutes): no-shows are marked absent.
7. **Saved records:** attendance (Attendance tab, spreadsheet download), shared attention history per session (History tab, plus a Focus column in each session's attendance), and the student's own Focus history, which includes their personal tracking too.

## Privacy and access rules

Enforced by the database (Row Level Security), not just by the pages:

| Data | Student | Their teacher | Classmates / other teachers |
|---|---|---|---|
| Profile name | Own only | Students in their classes | No |
| Class membership | Own rows | Their classes | No |
| Attendance | Own rows | Their classes | No |
| Attention history and samples | All of their own | Only what was shared during that teacher's live sessions | No |
| Notes | Own | No | No |
| Live scores (realtime) | Can send in their own classes | Receives | Never receive |

`tests/access-rules.test.mjs` checks all of this against every migration in an in-memory Postgres: `cd tests && npm install && npm test`.

**Demonstration data:** the Live monitor's **Simulator (demo)** only uses made-up "Demo ·" learners, never real students. It shows a DEMO MODE banner, saves nothing, and its export is named `DEMO-simulated` and marked as demo. The dashboard always opens on the live classroom, and starting a real session switches out of the simulator.

**Known limits:**
- Live scores are reported by each student's browser, so a student could send made-up numbers for themselves. Realtime messages can't prove who sent them, so another class member could also post numbers under a classmate's ID to the teacher's live view. Students act on "removed" messages only after checking with the database. The saved records (attendance and history) are always written as the signed-in student and checked by the database.
- Students in a class can see which (anonymous) account IDs are online in it, because Supabase presence is shared by everyone on the channel. They can't look those IDs up to find names.

## Test a teacher and a student side by side

A browser keeps one sign-in per web address, shared by all its tabs, so two tabs on `http://localhost:8000` are always the same account. Use two addresses instead:

1. Tab 1: open http://localhost:8000 and sign in as the **teacher**. Click **＋ New class**, then **Copy join code**.
2. Tab 2: open http://127.0.0.1:8000 (or a private window) and sign in as the **student**. Click **＋ Join a class** in the sidebar and paste the code. The teacher gets a "joined" (or "rejoined") notice and the student appears on the **Students** tab with a green online dot.
3. Teacher: press **▶ Start live session**. The student gets a notice and a red **Live session** banner.
4. Student: press **Join session**. Their attention tracker starts and the teacher's **Live monitor** shows their score every second. **End live session** stops sharing.

If one tab's account changes because another tab on the same address signed in or out, that tab shows a notice instead of silently acting as the other account.

## How classes and learning tools work

- Teachers create classes and get a unique join code. They can add a password; class passwords are hashed in the database and are never returned to the browser.
- Each class has five tabs for the teacher: **Live monitor**, **Master list** (online status, session status, attendance rate, **Remove from session**, **Remove from class**), **Attendance**, **History** (saved attention sessions) and **Settings** (rename, open/close joining, late threshold, password, new join code, delete).
- Students join by code, and must also provide the password if one was set. Students already in a class can always rejoin; new students need joining to be open.
- Students share attention scores (never video) only while their teacher runs a live session in the class they are working in. Outside a live session their saved history is personal and teachers can't see it.
- A student's notes belong to their account (Row Level Security). They can file a note under one of their classes or keep it personal. Teachers do not have access to those notes.
- The tutor receives the selected class name and the student's submitted question. The note organizer receives the note's class name and the rough text the student submits; **Quiz me** receives the class name and the text of that one note. Nothing records a live class, meeting, audio, or video.
- Notes are drafts for the student to review. The experimental camera preview remains optional, local, and separate from teacher reporting.

Before using real student data, finish deployment configuration and review privacy, consent, data-retention, and applicable school requirements.
