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
const ATTEMPT_TIMEOUT_MS = 15000;
const ATTEMPTS = [
  { model: primaryModel, delayMs: 0 },
  { model: backupModel, delayMs: 400 },
  { model: primaryModel, delayMs: 1200 }
];

type AttemptResult = { status: number; text: string; error?: { message?: string; status?: string; type?: string } };

async function askModel(model: string, body: Record<string, unknown>): Promise<AttemptResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ATTEMPT_TIMEOUT_MS);
  try {
    const response = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${aiApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, ...body }),
      signal: controller.signal
    });
    const payload = await response.json().catch(() => null);
    // Gemini sometimes wraps errors in an array.
    const error = Array.isArray(payload) ? payload[0]?.error : payload?.error;
    const text = response.ok ? String(payload?.choices?.[0]?.message?.content ?? "").trim() : "";
    return { status: response.status, text, error };
  } catch (error) {
    // status 0 = timed out or network failure
    return { status: 0, text: "", error: { message: error instanceof Error ? error.name : "network error" } };
  } finally {
    clearTimeout(timeout);
  }
}
const configuredOrigin = Deno.env.get("APP_ORIGIN");
const allowedOrigins = new Set([
  "http://localhost:8000",
  "http://127.0.0.1:8000",
  ...(configuredOrigin ? [configuredOrigin] : [])
]);

function json(body: unknown, status = 200, origin = "http://localhost:8000") {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info, x-supabase-api-version",
      "Vary": "Origin"
    }
  });
}

Deno.serve(async (request) => {
  const origin = request.headers.get("origin") || "";
  const responseOrigin = allowedOrigins.has(origin) ? origin : "null";
  if (request.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        "Access-Control-Allow-Origin": responseOrigin,
        "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info, x-supabase-api-version",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Vary": "Origin"
      }
    });
  }
  if (request.method !== "POST") return json({ error: "Use POST for assistant requests." }, 405, responseOrigin);
  if (!allowedOrigins.has(origin)) return json({ error: "This site is not allowed to use the assistant." }, 403, responseOrigin);
  if (!aiApiKey) return json({ error: "The AI service is not configured yet." }, 503, responseOrigin);

  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) return json({ error: "Sign in to use the learning assistant." }, 401, responseOrigin);

  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false }
  });
  const accessToken = authorization.slice("Bearer ".length);
  const { data: userData, error: userError } = await supabase.auth.getUser(accessToken);
  if (userError || !userData.user) return json({ error: "Your session expired. Sign in again." }, 401, responseOrigin);
  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", userData.user.id)
    .maybeSingle();
  if (profileError || profile?.role !== "student") return json({ error: "The student learning helper is available to student accounts." }, 403, responseOrigin);

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Request body must be JSON." }, 400, responseOrigin);
  }

  const task = body.task;
  const classId = typeof body.classId === "string" ? body.classId : "";
  if (task !== "tutor" && task !== "notes") return json({ error: "Unknown assistant task." }, 400, responseOrigin);
  if (task === "notes" && !classId) return json({ error: "Choose one of your classes before organizing class notes." }, 400, responseOrigin);

  // Class context is optional for the tutor. If provided, RLS verifies membership.
  let className = "";
  if (classId) {
    const { data: classRow, error: classError } = await supabase
      .from("classes")
      .select("id, name")
      .eq("id", classId)
      .maybeSingle();
    if (classError || !classRow) return json({ error: "That class is not available to your account." }, 403, responseOrigin);
    className = classRow.name;
  }

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

    instructions = `You are NeuroBuddy, the friendly AI study buddy inside the Neuro-Focus learning platform. If asked who you are, say you are NeuroBuddy. You are a kind, patient learning helper for a neurodivergent student. Explain ideas without judgement. Use short paragraphs and plain language. Follow the requested support style: ${style}. Ask one question at a time when clarification would help. Do not diagnose, infer disability, grade the student, or claim certainty when unsure. Help the student understand rather than simply doing graded work for them. Never ask for identifying personal details.`;
    messages = [...history, { role: "user", content: `${className ? `Class context (class name only): ${className}\n` : ""}Question: ${prompt}` }];
  } else {
    const studentInput = typeof body.studentInput === "string" ? body.studentInput.trim() : "";
    if (!studentInput || studentInput.length > 12000) return json({ error: "Add class text or ideas (up to 12,000 characters)." }, 400, responseOrigin);
    instructions = "Create clear, editable study notes for a neurodivergent student. Use a short title, key ideas, useful vocabulary, and questions to revisit. Keep the language plain and organize ideas into small chunks. Only use the student's supplied input; do not invent lecture content. Mark unclear items as questions instead of guessing. These notes are a draft for the student to review.";
    messages = [{ role: "user", content: `Class context (class name only): ${className}\n\nTurn this student-provided class input into notes:\n\n${studentInput}` }];
  }

  const { error: quotaError } = await supabase.rpc("consume_learning_request");
  if (quotaError) {
    const atLimit = quotaError.message.includes("Daily learning assistant limit reached");
    return json({ error: atLimit
      ? "You’ve reached today’s NeuroBuddy limit. You can keep using your notes and try again tomorrow."
      : "Could not check your learning helper allowance. Please try again." }, atLimit ? 429 : 503, responseOrigin);
  }

  const userHash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(userData.user.id));
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
    const result = await askModel(attempt.model, requestBody);
    if (result.text) return json({ text: result.text }, 200, responseOrigin);
    last = result;
    console.error("AI attempt failed", providerName, attempt.model, result.status,
      result.error?.status || result.error?.type || "", String(result.error?.message || (result.status === 200 ? "empty answer" : "")).slice(0, 200));
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
