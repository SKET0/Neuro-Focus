// Get these values from Supabase Dashboard → Project Settings → API.
// The publishable/anon key is intended for browser use. Never put a service_role key here.
export const SUPABASE_URL = "https://awklqioisiiyaqixnnbl.supabase.co";
export const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_NNY55ArTOwOhB7GwYmyHVQ_d7D7hOcw";

const configured = SUPABASE_URL.startsWith("https://")
  && !SUPABASE_URL.includes("PASTE_")
  && !SUPABASE_PUBLISHABLE_KEY.includes("PASTE_");

let clientPromise;

export async function getSupabase() {
  if (!configured) {
    throw new Error("Add your Supabase project URL and publishable key in supabase-client.js first.");
  }

  clientPromise ??= import("https://esm.sh/@supabase/supabase-js@2")
    .then(({ createClient }) => createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY));
  return clientPromise;
}
