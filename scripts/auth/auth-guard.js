import { getSupabase } from "../services/supabase-client.js";
import { applyAppearance, cacheAppearance, clearAppearanceCache } from "../shared/appearance.js?v=1";

const requiredRole = document.body.dataset.requiredRole;

function showSetupMessage(message) {
  document.documentElement.classList.remove("auth-check-pending");
  const main = document.querySelector(".portal-main");
  if (main) {
    main.replaceChildren();
    const section = document.createElement("section");
    section.className = "portal-card access-message";
    const heading = document.createElement("h1");
    heading.textContent = "Authentication Required";
    const details = document.createElement("p");
    details.textContent = message;
    const link = document.createElement("a");
    link.className = "btn-solid";
    link.href = "login.html";
    link.textContent = "Back to Sign In";
    section.append(heading, details, link);
    main.append(section);
  }
}

// A browser keeps one Supabase sign-in per site, shared by all its tabs. If another tab
// signs in as someone else (or signs out), this tab's account has changed underneath it.
function showAccountChangedNotice() {
  if (document.querySelector("#accountChangedNotice")) return;
  const otherHost = window.location.hostname === "127.0.0.1" ? "localhost" : "127.0.0.1";
  const otherUrl = `${window.location.protocol}//${otherHost}:${window.location.port || "8000"}/pages/login.html`;
  const overlay = document.createElement("div");
  overlay.id = "accountChangedNotice";
  overlay.setAttribute("role", "alertdialog");
  overlay.setAttribute("aria-labelledby", "accountChangedTitle");
  overlay.style.cssText = "position:fixed;inset:0;z-index:100;display:grid;place-items:center;padding:16px;background:rgba(9,9,11,0.82);backdrop-filter:blur(6px);";
  const card = document.createElement("div");
  card.style.cssText = "max-width:440px;background:#141417;border:1px solid #2e2e34;border-radius:14px;padding:24px;color:#f4f4f5;font-size:13.5px;line-height:1.55;box-shadow:0 16px 40px rgba(0,0,0,0.5);";
  const title = document.createElement("h2");
  title.id = "accountChangedTitle";
  title.style.cssText = "font-size:17px;margin-bottom:8px;";
  title.textContent = "This tab's account changed";
  const text = document.createElement("p");
  text.style.color = "#b4b4bc";
  text.textContent = "Another tab signed in to a different account or signed out. A browser can only be signed in to one Neuro-Focus account per address, so all its tabs share it.";
  const tip = document.createElement("p");
  tip.style.cssText = "color:#b4b4bc;margin-top:10px;";
  tip.append("To test a teacher and a student side by side, sign in to the second account at ");
  const link = document.createElement("a");
  link.href = otherUrl;
  link.target = "_blank";
  link.rel = "noopener";
  link.style.color = "#00d9ff";
  link.textContent = otherUrl.replace("/pages/login.html", "");
  tip.append(link, " or in a private window.");
  const reload = document.createElement("button");
  reload.type = "button";
  reload.textContent = "Reload this tab";
  reload.style.cssText = "margin-top:16px;background:#f4f4f5;color:#000;border:0;border-radius:6px;padding:9px 16px;font-weight:600;cursor:pointer;";
  reload.addEventListener("click", () => window.location.reload());
  card.append(title, text, tip, reload);
  overlay.append(card);
  document.body.append(overlay);
  reload.focus();
}

window.neuroFocusReady = (async () => {
  try {
    const supabase = await getSupabase();
    const { data: { session }, error: sessionError } = await supabase.auth.getSession();
    if (sessionError) throw sessionError;

    // Strict authentication enforcement: logged-out visitors MUST sign in
    if (!session) {
      clearAppearanceCache();
      window.location.replace("login.html");
      return null;
    }

    // Profile settings (picture, theme, accent) come from the student profiles database update;
    // before it is run, only the name and role are loaded and everything else uses defaults.
    const loadProfile = (fields) => supabase.from("profiles").select(fields).eq("id", session.user.id).maybeSingle();
    let profileSetupMissing = false;
    let { data: profile, error: profileError } = await loadProfile("id, display_name, role, avatar_preset, avatar_path, theme, accent");
    if (profileError && (profileError.code === "42703" || /avatar_|theme|accent/.test(profileError.message || ""))) {
      profileSetupMissing = true;
      ({ data: profile, error: profileError } = await loadProfile("id, display_name, role"));
    }

    if (profileError || !profile) {
      showSetupMessage("Your profile could not be loaded. Please sign in again.");
      window.location.replace("login.html");
      return null;
    }

    // Role-based portal routing
    if (requiredRole && profile.role !== requiredRole) {
      window.location.replace(profile.role === "teacher" ? "teacher.html" : "student.html");
      return null;
    }

    // Each account's saved look (Profile settings → Theme and accent) applies to its own dashboard only.
    if (requiredRole) {
      applyAppearance(profile);
      cacheAppearance(session.user.id, profile);
    }

    window.neuroFocus = { supabase, session, user: session.user, profile, profileSetupMissing };
    document.querySelectorAll("[data-profile-name]").forEach((el) => { el.textContent = profile.display_name; });
    document.documentElement.classList.remove("auth-check-pending");

    // Sign out button handler
    let signingOut = false;
    const signOut = document.querySelector("#signOutButton");
    signOut?.addEventListener("click", async () => {
      signingOut = true;
      signOut.disabled = true;
      clearAppearanceCache();
      await supabase.auth.signOut();
      window.location.replace("login.html");
    });

    supabase.auth.onAuthStateChange((event, nextSession) => {
      if (signingOut || event === "INITIAL_SESSION") return;
      if (!nextSession || nextSession.user.id !== session.user.id) {
        // This page belongs to the previous account: stop showing its appearance.
        if (requiredRole) applyAppearance({});
        showAccountChangedNotice();
      }
    });

    return window.neuroFocus;
  } catch (error) {
    console.error("Auth check failed:", error);
    window.location.replace("login.html");
    return null;
  }
})();