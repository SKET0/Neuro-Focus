import { createClient } from "npm:@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

// NeuroBuddy can use any provider with an OpenAI-compatible Chat Completions API.
// Choose one with the AI_PROVIDER secret and store that provider's key as its secret.
// The first model is the default; the second is a backup tried when the first is busy.
type Provider = { baseUrl: string; models: string[]; reasoningEffort?: string; keySecret: string };
const providers: Record<string, Provider> = {
  gemini: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    models: ["gemini-3.1-flash-lite", "gemini-3.8-flash"],
    reasoningEffort: "minimal", // Gemini 3 always "thinks"; minimal keeps answers fast
    keySecret: "GEMINI_API_KEY"
  },
  groq: {
    baseUrl: "https://api.groq.com/openai/v1",
    models: ["openai/gpt-oss-120b", "openai/gpt-oss-20b"],
    reasoningEffort: "low",
    keySecret: "GROQ_API_KEY"
  },
  openai: { baseUrl: "https://api.openai.com/v1", models: ["gpt-6-luna"], keySecret: "OPENAI_API_KEY" }
};
const providerName = (Deno.env.get("AI_PROVIDER") || "gemini").toLowerCase();
const provider = providers[providerName] ?? providers.gemini;
const aiApiKey = Deno.env.get(provider.keySecret);
const primaryModel = Deno.env.get("AI_MODEL") || provider.models[0];
const backupModel = provider.models.find((name) => name !== primaryModel) ?? primaryModel;

// Free tiers are often briefly busy or overloaded, so temporary failures are retried.
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const FIRST_TEXT_TIMEOUT_MS = 15000; // a model that hasn't started writing by then is retried
const TOTAL_TIMEOUT_MS = 90000;
const ATTEMPTS = [
  { model: primaryModel, delayMs: 0 },
  { model: backupModel, delayMs: 400 },
  { model: primaryModel, delayMs: 1200 }
];

type AttemptResult = {
  status: number;
  stream?: ReadableStream<Uint8Array>;
  error?: { message?: string; status?: string; type?: string };
};

// Asks the model to stream its answer. Resolves once the first words arrive, so a busy or
// silent model can still be retried; the rest of the answer is passed on as plain text.
async function startAnswer(model: string, body: Record<string, unknown>): Promise<AttemptResult> {
  const controller = new AbortController();
  let timer = setTimeout(() => controller.abort(), FIRST_TEXT_TIMEOUT_MS);
  try {
    const response = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${aiApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, ...body, stream: true }),
      signal: controller.signal
    });
    if (!response.ok || !response.body) {
      const payload = await response.json().catch(() => null);
      clearTimeout(timer);
      // Gemini sometimes wraps errors in an array.
      return { status: response.status, error: Array.isArray(payload) ? payload[0]?.error : payload?.error };
    }

    // Server-sent events: "data: {json}" lines, ending with "data: [DONE]".
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    const nextText = async (): Promise<string | null> => {
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") return null;
          try {
            const text = JSON.parse(data)?.choices?.[0]?.delta?.content;
            if (text) return text;
          } catch { /* ignore keep-alive or partial lines */ }
          continue;
        }
        const { value, done } = await reader.read();
        if (done) return null;
        buffer += value;
      }
    };

    const first = await nextText();
    clearTimeout(timer);
    if (!first) return { status: 200, error: { message: "empty answer" } };
    timer = setTimeout(() => controller.abort(), TOTAL_TIMEOUT_MS);
    const encoder = new TextEncoder();
    const finish = () => { clearTimeout(timer); reader.cancel().catch(() => {}); };
    const stream = new ReadableStream<Uint8Array>({
      start(output) { output.enqueue(encoder.encode(first)); },
      async pull(output) {
        try {
          const text = await nextText();
          if (text === null) { finish(); output.close(); } else output.enqueue(encoder.encode(text));
        } catch {
          finish();
          output.close();
        }
      },
      cancel() { finish(); controller.abort(); }
    });
    return { status: 200, stream };
  } catch (error) {
    clearTimeout(timer);
    // status 0 = timed out or network failure
    return { status: 0, error: { message: error instanceof Error ? error.name : "network error" } };
  }
}

async function readAll(stream: ReadableStream<Uint8Array>) {
  let text = "";
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) return text.trim();
    text += value;
  }
}

// The gateway has already verified the token (Verify JWT); this reads its user id so the
// profile and class checks can run at the same time as getUser.
function tokenSubject(token: string) {
  try {
    const part = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const claims = JSON.parse(atob(part.padEnd(Math.ceil(part.length / 4) * 4, "=")));
    return typeof claims.sub === "string" ? claims.sub : "";
  } catch {
    return "";
  }
}

const configuredOrigin = Deno.env.get("APP_ORIGIN");
const allowedOrigins = new Set([
  "http://localhost:8000",
  "http://127.0.0.1:8000",
  ...(configuredOrigin ? [configuredOrigin] : [])
]);

function corsHeaders(origin: string) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info, x-supabase-api-version",
    "Vary": "Origin"
  };
}

function json(body: unknown, status = 200, origin = "http://localhost:8000") {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) }
  });
}

Deno.serve(async (request) => {
  const origin = request.headers.get("origin") || "";
  const responseOrigin = allowedOrigins.has(origin) ? origin : "null";
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: { ...corsHeaders(responseOrigin), "Access-Control-Allow-Methods": "POST, OPTIONS" } });
  }
  if (request.method !== "POST") return json({ error: "Use POST for assistant requests." }, 405, responseOrigin);
  if (!allowedOrigins.has(origin)) return json({ error: "This site is not allowed to use the assistant." }, 403, responseOrigin);
  if (!aiApiKey) return json({ error: "The AI service is not configured yet." }, 503, responseOrigin);

  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) return json({ error: "Sign in to use the learning assistant." }, 401, responseOrigin);
  const accessToken = authorization.slice("Bearer ".length);
  const userId = tokenSubject(accessToken);
  if (!userId) return json({ error: "Your session expired. Sign in again." }, 401, responseOrigin);

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Request body must be JSON." }, 400, responseOrigin);
  }
  const task = body.task;
  const classId = typeof body.classId === "string" ? body.classId : "";
  const wantsStream = body.stream === true;
  if (task !== "tutor" && task !== "notes" && task !== "quiz") return json({ error: "Unknown assistant task." }, 400, responseOrigin);

  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false }
  });
  // Check the session, the student role and the class together. Class context is optional;
  // when given, RLS only returns the class if the student is a member.
  const [userResult, profileResult, classResult] = await Promise.all([
    supabase.auth.getUser(accessToken),
    supabase.from("profiles").select("role").eq("id", userId).maybeSingle(),
    classId ? supabase.from("classes").select("id, name").eq("id", classId).maybeSingle() : Promise.resolve({ data: null, error: null })
  ]);
  if (userResult.error || userResult.data.user?.id !== userId) return json({ error: "Your session expired. Sign in again." }, 401, responseOrigin);
  if (profileResult.error || profileResult.data?.role !== "student") return json({ error: "The student learning helper is available to student accounts." }, 403, responseOrigin);
  if (classId && (classResult.error || !classResult.data)) return json({ error: "That class is not available to your account." }, 403, responseOrigin);
  const className = classResult.data?.name || "";
  const classLine = className ? `Class (name only): ${className}\n\n` : "";

  let instructions: string;
  let messages: Array<{ role: "user" | "assistant"; content: string }>;
  if (task === "tutor") {
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    const supportedStyles = new Set(["step-by-step", "simple", "examples", "short"]);
    const style = typeof body.style === "string" && supportedStyles.has(body.style) ? body.style : "step-by-step";
    const history = Array.isArray(body.history)
      ? body.history.filter((entry) => entry && typeof entry === "object"
        && ((entry as Record<string, unknown>).role === "user" || (entry as Record<string, unknown>).role === "assistant")
        && typeof (entry as Record<string, unknown>).content === "string")
        .slice(-8)
        .map((entry) => ({
          role: (entry as { role: "user" | "assistant" }).role,
          content: String((entry as { content: string }).content).slice(0, 2000)
        }))
      : [];
    if (!prompt || prompt.length > 2000) return json({ error: "Ask a question up to 2,000 characters." }, 400, responseOrigin);

    instructions = `You are NeuroBuddy, the friendly AI study buddy inside the Neuro-Focus learning platform. If asked who you are, say you are NeuroBuddy. You are a kind, patient learning helper for a neurodivergent student. Explain ideas without judgement. Use short paragraphs and plain language. Follow the requested support style: ${style}. Ask one question at a time when clarification would help. Do not diagnose, infer disability, grade the student, or claim certainty when unsure. Help the student understand rather than simply doing graded work for them. Never ask for identifying personal details.
Formatting: plain text with simple Markdown only: "- " bullets, "1." numbered steps, **bold** for key words and "### " for a short heading when an answer has parts. No tables, code blocks or HTML.`;
    messages = [...history, { role: "user", content: `${className ? `Class context (class name only): ${className}\n` : ""}Question: ${prompt}` }];
  } else if (task === "notes") {
    const studentInput = typeof body.studentInput === "string" ? body.studentInput.trim() : "";
    if (!studentInput || studentInput.length > 12000) return json({ error: "Add class text or ideas (up to 12,000 characters)." }, 400, responseOrigin);
    instructions = `You turn a student's rough class notes into clear study notes for a neurodivergent learner.
Output Markdown only, in this shape:
# A short title (up to 8 words)
## Section heading
- one idea per bullet, under 20 words

Use 2 to 5 sections, choosing from: Key ideas, Important words, Steps or examples, Questions to revisit. Skip sections that don't apply. Use "1." lists only for steps in order. Put key terms in **bold**; under Important words write "- **term**: short meaning".
Rules: use only information in the student's text and do not add facts. If something is unclear or looks wrong, list it under Questions to revisit instead of guessing. Keep the notes no longer than the input needs. Write in the same language as the student's notes. No tables, code blocks, emojis, HTML or text before the title.`;
    messages = [{ role: "user", content: `${classLine}Student's rough notes:\n\n${studentInput}` }];
  } else {
    const noteText = typeof body.noteText === "string" ? body.noteText.trim() : "";
    const count = Math.min(10, Math.max(3, Number(body.count) || 5));
    if (noteText.length < 40) return json({ error: "Write a bit more in this note first, then NeuroBuddy can quiz you on it." }, 400, responseOrigin);
    if (noteText.length > 20000) return json({ error: "This note is too long to quiz on. Try a shorter note." }, 400, responseOrigin);
    instructions = `Write ${count} flashcards that help a student review their own study notes. Use only facts that are in the notes. Mix "what", "why" and "how" questions and cover different parts of the notes. Keep each question under 20 words and each answer under 30 words, in the same language as the notes.
Output exactly this plain-text format, with a blank line between cards and nothing else:
Q: question
A: answer`;
    messages = [{ role: "user", content: `${classLine}Notes:\n\n${noteText}` }];
  }

  const { error: quotaError } = await supabase.rpc("consume_learning_request");
  if (quotaError) {
    const atLimit = quotaError.message.includes("Daily learning assistant limit reached");
    return json({ error: atLimit
      ? "You’ve reached today’s NeuroBuddy limit. You can keep using your notes and try again tomorrow."
      : "Could not check your learning helper allowance. Please try again." }, atLimit ? 429 : 503, responseOrigin);
  }

  const userHash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(userId));
  const safetyIdentifier = `nf_${Array.from(new Uint8Array(userHash), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  const requestBody: Record<string, unknown> = {
    messages: [{ role: "system", content: instructions }, ...messages],
    ...(provider.reasoningEffort ? { reasoning_effort: provider.reasoningEffort } : {}),
    // OpenAI uses a hashed ID to spot abuse; other providers don't accept this field.
    ...(provider === providers.openai ? { safety_identifier: safetyIdentifier } : {})
  };

  let last: AttemptResult | undefined;
  for (const attempt of ATTEMPTS) {
    if (attempt.delayMs) await new Promise((resolve) => setTimeout(resolve, attempt.delayMs));
    const result = await startAnswer(attempt.model, requestBody);
    if (result.stream) {
      // Streaming clients show the answer as it is written; others get it as JSON at the end.
      if (!wantsStream) return json({ text: await readAll(result.stream) }, 200, responseOrigin);
      return new Response(result.stream, {
        headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff", ...corsHeaders(responseOrigin) }
      });
    }
    last = result;
    console.error("AI attempt failed", providerName, attempt.model, result.status,
      result.error?.status || result.error?.type || "", String(result.error?.message || "").slice(0, 200));
    if (result.status === 400 && "reasoning_effort" in requestBody) {
      // A model that rejects reasoning_effort gets one retry without it.
      delete requestBody.reasoning_effort;
      continue;
    }
    // Retry only temporary problems: busy, overloaded, timeouts, empty answers.
    const temporary = result.status === 0 || result.status === 200 || RETRYABLE_STATUS.has(result.status);
    if (!temporary) break;
  }

  return json({ error: last?.status === 429
    ? "NeuroBuddy is busy right now (free usage limit reached). Wait a minute and try again."
    : "NeuroBuddy couldn’t answer right now. Please try again in a moment." }, 502, responseOrigin);
});
