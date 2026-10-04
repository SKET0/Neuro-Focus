// Home page: when a user is already signed in, swap the sign-in / sign-up
// calls to action for links back to their dashboard and a sign-out option.
import { getSupabase } from "../services/supabase-client.js";

const hook = (name) => document.querySelector(`[data-session="${name}"]`);

function setLink(element, href, label) {
  if (!element) return;
  element.href = href;
  const parts = element.querySelectorAll("span");
  if (parts.length) parts[0].textContent = label;
  else element.textContent = label;
}

// A password-reset link that landed here (the project's Site URL) belongs on the login page,
// which lets the person choose a new password. Forward it before Supabase reads the link.
const forwardingReset = /type=recovery/.test(window.location.hash);
if (forwardingReset) window.location.replace(`pages/login.html?mode=reset${window.location.hash}`);

if (!forwardingReset) try {
  const supabase = await getSupabase();
  const { data: { session } } = await supabase.auth.getSession();

  if (session) {
    const { data: profile } = await supabase
      .from("profiles")
      .select("display_name, role")
      .eq("id", session.user.id)
      .maybeSingle();

    if (profile) {
      const isTeacher = profile.role === "teacher";
      const dashboard = isTeacher ? "pages/teacher.html" : "pages/student.html";
      const dashboardName = isTeacher ? "Teacher Dashboard" : "Student Workspace";

      const signOut = async (event) => {
        event.preventDefault();
        await supabase.auth.signOut();
        window.location.reload();
      };

      setLink(hook("nav-cta"), dashboard, `My ${dashboardName}`);
      setLink(hook("hero-cta"), dashboard, `Go to ${dashboardName}`);
      setLink(hook("gateway-primary"), dashboard, `Open ${dashboardName}`);
      setLink(hook("gateway-secondary"), "#", "Sign Out");
      setLink(hook("nav-signin"), "#", "Sign out");
      hook("nav-signin")?.addEventListener("click", signOut);
      hook("gateway-secondary")?.addEventListener("click", signOut);
      hook("hero-signin")?.remove();

      // "Hello, <first name> 👋" above the hero title
      const hello = hook("hello");
      if (hello) {
        const name = document.createElement("strong");
        name.textContent = (profile.display_name || "there").trim().split(/\s+/)[0];
        hello.replaceChildren("Hello, ", name, " 👋");
        hello.hidden = false;
      }

      const copy = hook("gateway-copy");
      if (copy) copy.textContent = `You're signed in as ${profile.display_name}. Continue to your ${dashboardName.toLowerCase()} or sign out.`;

      // Workspace cards: mark the user's own workspace and lock the other role's.
      const own = hook(isTeacher ? "hub-teacher" : "hub-student");
      const other = hook(isTeacher ? "hub-student" : "hub-teacher");
      const yours = document.createElement("span");
      yours.className = "hub-yours";
      yours.textContent = "· Your account";
      own?.setAttribute("href", dashboard);
      own?.closest(".hub-card")?.querySelector(".hub-badge")?.after(yours);
      if (other) {
        const locked = document.createElement("span");
        locked.className = "hub-action is-locked";
        locked.setAttribute("aria-disabled", "true");
        locked.textContent = `🔒 ${isTeacher ? "Student" : "Teacher"} account required`;
        locked.title = `You're signed in with a ${profile.role} account.`;
        other.replaceWith(locked);
      }
    }
  } else {
    // Signed out: both workspaces need a sign-in first.
    hook("hub-student")?.setAttribute("href", "pages/login.html");
    hook("hub-teacher")?.setAttribute("href", "pages/login.html");
  }
} catch (error) {
  // Leave the signed-out buttons in place if Supabase is unreachable.
  console.warn("Could not check sign-in status", error);
}
