# Neuro-Focus

A student-centered classroom prototype built with static HTML/CSS/JavaScript, Supabase Auth/Postgres, and a Supabase Edge Function for OpenAI-powered study support.

## Local setup

1. Create a Supabase project.
2. In **Project Settings → API**, copy the project URL and the publishable key (or legacy anon key) into `supabase-client.js`.
   - These browser credentials are public by design. Never put a `service_role` key in browser code.
3. Apply `supabase/migrations/20261001000000_learning_classes.sql` in the Supabase SQL Editor, or install the Supabase CLI and run:

   ```sh
   supabase login
   supabase link --project-ref awklqioisiiyaqixnnbl
   supabase db push
   ```
4. Add `http://localhost:8000/login.html` to **Authentication → URL Configuration → Redirect URLs**.
5. Serve this folder over HTTP with the included dev server, which turns off browser caching so your edits always show up:

   ```sh
   python3 serve.py
   ```

   Then open `http://localhost:8000`. Do not use `file://`; ES modules and camera access require localhost or HTTPS.

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

## Test a teacher and a student side by side

A browser keeps one sign-in per web address, shared by all its tabs, so two tabs on `http://localhost:8000` are always the same account. Use two addresses instead:

1. Tab 1: open http://localhost:8000 and sign in as the **teacher**. Click **＋ New class**, then **Copy join code**.
2. Tab 2: open http://127.0.0.1:8000 (or a private window) and sign in as the **student**. Click **＋ Join a class** in the sidebar and paste the code. The teacher gets a "joined" (or "rejoined") notice and the student appears on the **Students** tab with a green online dot.
3. Teacher: press **▶ Start live session**. The student gets a notice and a red **Live session** banner.
4. Student: press **Join session**. Their attention tracker starts and the teacher's **Live monitor** shows their score every second. **End live session** stops sharing.

If one tab's account changes because another tab on the same address signed in or out, that tab shows a notice instead of silently acting as the other account.

## How classes and learning tools work

- Teachers create classes and get a unique join code. They can add a password; class passwords are hashed in the database and are never returned to the browser.
- Each class has four tabs for the teacher: **Live monitor**, **Students** (online status, **Remove**), **History** (saved sessions) and **Settings** (rename, open/close joining, password, new join code, delete).
- Students join by code, and must also provide the password if one was set. Students already in a class can always rejoin; new students need joining to be open.
- Students share attention scores (never video) only while their teacher runs a live session in the class they are working in. Outside a live session their saved history is personal and teachers can't see it.
- A student's notes belong to their account (Row Level Security). They can file a note under one of their classes or keep it personal. Teachers do not have access to those notes.
- The tutor receives the selected class name and the student's submitted question. The note organizer receives the note's class name and the rough text the student submits; **Quiz me** receives the class name and the text of that one note. Nothing records a live class, meeting, audio, or video.
- Notes are drafts for the student to review. The experimental camera preview remains optional, local, and separate from teacher reporting.

Before using real student data, finish deployment configuration and review privacy, consent, data-retention, and applicable school requirements.
