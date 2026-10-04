// Calls the learning-assistant Edge Function and streams the answer as it is written.
// streamAssistant(supabase, payload, onText) -> Promise<full text>; onText(textSoFar) runs as text arrives.
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./supabase-client.js";

const NOT_CONNECTED = "NeuroBuddy isn’t connected yet. Deploy the learning-assistant function and add your AI API key secret first.";

export async function streamAssistant(supabase, payload, onText = () => {}, { signal } = {}) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error("Your session expired. Sign in again.");

  let response;
  try {
    response = await fetch(`${SUPABASE_URL}/functions/v1/learning-assistant`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${session.access_token}`,
        "apikey": SUPABASE_PUBLISHABLE_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ ...payload, stream: true }),
      signal
    });
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    throw new Error("Couldn’t reach NeuroBuddy. Check your internet connection and try again.");
  }

  const type = response.headers.get("Content-Type") || "";
  if (!response.ok || type.includes("application/json")) {
    const details = await response.json().catch(() => null);
    if (details?.error) throw new Error(details.error);
    if (details?.text) { onText(details.text); return details.text; }
    throw new Error(response.status === 404 ? NOT_CONNECTED : "NeuroBuddy couldn’t answer right now. Please try again in a moment.");
  }

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let text = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    text += value;
    onText(text);
  }
  text = text.trim();
  if (!text) throw new Error("The AI service returned no text. Try again.");
  return text;
}
