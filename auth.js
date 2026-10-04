// Login page: sign in, create account (with password confirmation), continue with Google,
// "forgot password" emails, and choosing a new password from the emailed link.
// Modes: login | signup | forgot | reset. Elements show per mode with data-modes="…".
import { getSupabase, SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./supabase-client.js";

const form = document.querySelector("#authForm");
if (form) {
  const $ = (selector) => document.querySelector(selector);
  const messageBox = $("#authMessageBox");
  const message = $("#authMessage");
  const messageAction = $("#authMessageAction");
  const email = $("#emailField");
  const password = $("#passwordField");
  const confirm = $("#confirmField");
  const passwordLabel = $("#passwordLabel");
  const passwordToggle = $("#passwordToggle");
  const matchHint = $("#matchHint");
  const fullName = $("#fullNameField");
  const submit = form.querySelector("[type='submit']");
  const submitLabel = $("#submitLabel");
  const title = $("#auth-title");
  const subtitle = $("#authSubtitle");
  const googleButton = $("#googleButton");
  const roleButtons = document.querySelectorAll("[data-role]");
  const modeButtons = document.querySelectorAll("[data-mode]");
  const params = new URLSearchParams(window.location.search);
  const hashParams = new URLSearchParams(window.location.hash.slice(1));

  const COPY = {
    login: { title: "Sign in", subtitle: "Use the email and password for your account.", submit: "Sign in" },
    signup: { title: "Create your account", subtitle: "Free for students and teachers.", submit: "Create account" },
    forgot: { title: "Reset your password", subtitle: "Enter your account email and we’ll send you a link to choose a new password.", submit: "Send reset link" },
    reset: { title: "Choose a new password", subtitle: "", submit: "Save new password" }
  };
  const teacherNote = "Teacher accounts start as a request. A project owner approves them before teacher tools unlock.";
  let mode = ["signup", "forgot"].includes(params.get("mode")) ? params.get("mode") : "login";
  let roleRequest = "student";
  let resetEmail = "";

  // state: "" (info), "error" or "success"; an empty text hides the message.
  // action: optional { label, onClick } shown as a link under the message.
  const showMessage = (text, state = "", action = null) => {
    message.textContent = text;
    messageBox.dataset.state = state === true ? "error" : state;
    messageBox.hidden = !text;
    messageAction.hidden = !action;
    messageAction.textContent = action?.label || "";
    messageAction.onclick = action ? action.onClick : null;
  };

  // ---------- Modes ----------
  function paint() {
    document.querySelectorAll("[data-modes]").forEach((element) => {
      const visible = element.dataset.modes.split(" ").includes(mode);
      element.hidden = !visible;
      // Hidden fields must not block the form or be sent.
      element.querySelectorAll("input").forEach((input) => { input.disabled = !visible; });
    });
    roleButtons.forEach((button) => {
      button.classList.toggle("active", button.dataset.role === roleRequest);
      button.setAttribute("aria-pressed", String(button.dataset.role === roleRequest));
    });
    modeButtons.forEach((button) => {
      button.classList.toggle("active", button.dataset.mode === mode);
      button.setAttribute("aria-pressed", String(button.dataset.mode === mode));
    });
    const copy = COPY[mode];
    title.textContent = copy.title;
    subtitle.textContent = mode === "reset" ? `For ${resetEmail || "your account"}. Use at least 8 characters.` : copy.subtitle;
    submitLabel.textContent = copy.submit;
    document.title = `${copy.title} · Neuro-Focus`;
    passwordLabel.textContent = mode === "reset" ? "New password" : "Password";
    password.autocomplete = mode === "login" ? "current-password" : "new-password";
    password.placeholder = { login: "Your password", signup: "Create a password", reset: "New password" }[mode] || "";
    updateMatch();
  }

  function setMode(next, { focus = false } = {}) {
    mode = next;
    showMessage(mode === "signup" && roleRequest === "teacher" ? teacherNote : "");
    paint();
    if (focus) ({ signup: fullName, reset: password }[mode] || email).focus();
  }

  roleButtons.forEach((button) => button.addEventListener("click", () => {
    roleRequest = button.dataset.role;
    showMessage(roleRequest === "teacher" ? teacherNote : "");
    paint();
  }));
  modeButtons.forEach((button) => button.addEventListener("click", () => setMode(button.dataset.mode)));
  document.querySelectorAll("[data-mode-link]").forEach((button) => button.addEventListener("click", () => {
    setMode(button.dataset.modeLink, { focus: true });
  }));

  // ---------- Passwords ----------
  // The confirm box must match before the form can be sent; the hint updates as you type.
  function updateMatch() {
    if (confirm.disabled || !confirm.value) {
      confirm.setCustomValidity("");
      matchHint.textContent = "";
      matchHint.dataset.state = "";
      return;
    }
    const same = confirm.value === password.value;
    confirm.setCustomValidity(same ? "" : "The passwords don’t match.");
    matchHint.textContent = same ? "✓ Passwords match" : "Passwords don’t match yet";
    matchHint.dataset.state = same ? "ok" : "error";
  }
  password.addEventListener("input", updateMatch);
  confirm.addEventListener("input", updateMatch);

  passwordToggle.addEventListener("click", () => {
    const show = password.type === "password";
    [password, confirm].forEach((input) => { input.type = show ? "text" : "password"; });
    passwordToggle.setAttribute("aria-pressed", String(show));
    passwordToggle.setAttribute("aria-label", show ? "Hide passwords" : "Show passwords");
    passwordToggle.querySelector("use").setAttribute("href", show ? "#i-eye-off" : "#i-eye");
  });

  // ---------- After signing in ----------
  async function openWorkspace(supabase, userId) {
    const { data: profile, error } = await supabase.from("profiles").select("role").eq("id", userId).maybeSingle();
    if (error || !profile) throw new Error("Your profile is not ready. Run the database setup, then try again.");
    window.location.assign(profile.role === "teacher" ? "teacher.html" : "student.html");
  }

  // Supabase error messages, in plainer words.
  function friendly(error) {
    const text = error instanceof Error ? error.message : String(error || "");
    if (/invalid login credentials/i.test(text)) return "That email and password don’t match an account. Check them, or use “Forgot password?”.";
    if (/rate limit|security purposes|too many/i.test(text)) return "Too many emails were sent recently. Wait a few minutes, then try again.";
    if (/already registered|already exists/i.test(text)) return "There’s already an account with that email. Sign in instead, or reset your password.";
    if (/should be different/i.test(text)) return "Choose a password that’s different from your old one.";
    if (/expired|invalid.*(link|token)|otp/i.test(text)) return "That link is invalid or has expired. Request a new one.";
    // Errors from coming back from Google.
    if (/exchange external code/i.test(text)) return "Google sign-in couldn’t finish. The Google Client ID or Client Secret saved in Supabase doesn’t match Google Cloud (see README → Sign-in options). You can sign in with email meanwhile.";
    if (/access_denied|denied|cancel/i.test(text)) return "Google sign-in was cancelled. Try again, or sign in with email.";
    if (/provider is not enabled|unsupported provider/i.test(text)) return "Google sign-in isn’t turned on for this project yet.";
    return text || "Something went wrong. Please try again.";
  }

  async function resendConfirmation(address) {
    try {
      const supabase = await getSupabase();
      const { error } = await supabase.auth.resend({
        type: "signup", email: address, options: { emailRedirectTo: new URL("login.html", window.location.href).href }
      });
      if (error) throw error;
      showMessage(`A new confirmation link was sent to ${address}. Open it, then sign in.`, "success");
    } catch (error) {
      showMessage(friendly(error), "error");
    }
  }

  // ---------- Submit ----------
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    updateMatch();
    if (!form.reportValidity()) return;

    submit.disabled = true;
    showMessage({ login: "Signing you in…", signup: "Creating your account…", forgot: "Sending your reset link…", reset: "Saving your new password…" }[mode]);
    try {
      const supabase = await getSupabase();
      const address = email.value.trim();

      if (mode === "login") {
        const { data, error } = await supabase.auth.signInWithPassword({ email: address, password: password.value });
        if (error) {
          if (/not confirmed/i.test(error.message)) {
            showMessage("Confirm your email first: open the link we sent when you signed up.", "error", {
              label: "Send the confirmation email again", onClick: () => { void resendConfirmation(address); }
            });
            return;
          }
          throw error;
        }
        showMessage("Signed in. Opening your workspace…", "success");
        await openWorkspace(supabase, data.user.id);
        return;
      }

      if (mode === "signup") {
        const { data, error } = await supabase.auth.signUp({
          email: address,
          password: password.value,
          options: {
            data: { full_name: fullName.value.trim(), role_request: roleRequest },
            emailRedirectTo: new URL("login.html", window.location.href).href
          }
        });
        if (error) throw error;
        // With email confirmation on, Supabase answers an already-used email with an empty identity list.
        if (!data.session && data.user?.identities?.length === 0) {
          showMessage("There’s already an account with that email. Sign in instead, or reset your password.", "error", {
            label: "Reset my password", onClick: () => setMode("forgot", { focus: true })
          });
          return;
        }
        if (!data.session) {
          mode = "login";
          paint();
          password.value = "";
          confirm.value = "";
          showMessage(roleRequest === "teacher"
            ? "Teacher request submitted. Confirm your email, then sign in. A teacher must be approved before creating classes."
            : `Account created. Check ${address} for a confirmation link, then sign in here.`, "success");
          return;
        }
        showMessage("Account created. Opening your workspace…", "success");
        await openWorkspace(supabase, data.user.id);
        return;
      }

      if (mode === "forgot") {
        const { error } = await supabase.auth.resetPasswordForEmail(address, {
          redirectTo: new URL("login.html?mode=reset", window.location.href).href
        });
        if (error) throw error;
        // Same answer whether or not the account exists, so emails can't be probed.
        showMessage(`If there’s an account for ${address}, a reset link is on its way. Check your inbox and spam folder; the link works once.`, "success");
        return;
      }

      if (mode === "reset") {
        const { data, error } = await supabase.auth.updateUser({ password: password.value });
        if (error) throw error;
        showMessage("Password updated. Opening your workspace…", "success");
        await openWorkspace(supabase, data.user.id);
      }
    } catch (error) {
      showMessage(friendly(error), "error");
    } finally {
      submit.disabled = false;
    }
  });

  // ---------- Continue with Google ----------
  let providers = null;
  async function googleEnabled() {
    if (!providers) {
      try {
        const response = await fetch(`${SUPABASE_URL}/auth/v1/settings`, { headers: { apikey: SUPABASE_PUBLISHABLE_KEY } });
        providers = (await response.json()).external || {};
      } catch {
        return true; // can't tell; let Supabase answer
      }
    }
    return Boolean(providers.google);
  }

  googleButton.addEventListener("click", async () => {
    googleButton.disabled = true;
    showMessage("Opening Google…");
    try {
      if (!(await googleEnabled())) {
        showMessage("Google sign-in isn’t turned on for this project yet. The project owner can enable it in Supabase → Authentication → Sign In / Providers → Google (see README).", "error");
        return;
      }
      const supabase = await getSupabase();
      const { error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo: new URL("login.html", window.location.href).href,
          queryParams: { prompt: "select_account" } // lets people pick which Google account to use
        }
      });
      if (error) throw error;
      // The browser now goes to Google and comes back here signed in.
    } catch (error) {
      showMessage(friendly(error), "error");
    } finally {
      googleButton.disabled = false;
    }
  });

  $("#cancelReset").addEventListener("click", async () => {
    const supabase = await getSupabase();
    await supabase.auth.signOut();
    window.history.replaceState(null, "", "login.html");
    resetEmail = "";
    setMode("login");
  });

  // ---------- Arriving on the page ----------
  paint();

  // Errors from Google or an emailed link come back in the address (e.g. an expired link).
  // Supabase sometimes encodes the description twice ("code%3A 4%2F0A…"), so decode once more.
  const decode = (text) => { try { return decodeURIComponent(text.replace(/\+/g, " ")); } catch { return text; } };
  const urlError = decode(hashParams.get("error_description") || params.get("error_description") || hashParams.get("error") || params.get("error") || "");
  if (urlError) {
    showMessage(friendly(urlError), "error");
    window.history.replaceState(null, "", `login.html${params.get("mode") === "reset" ? "?mode=reset" : ""}`);
  }

  try {
    const supabase = await getSupabase();
    // Backup for reset links whose address lost "?mode=reset".
    supabase.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY" && mode !== "reset") {
        resetEmail = session?.user?.email || "";
        setMode("reset", { focus: true });
      }
    });
    const { data: { session } } = await supabase.auth.getSession();

    if (params.get("mode") === "reset") {
      // The emailed link signs the person in for long enough to choose a new password.
      if (session) {
        resetEmail = session.user.email || "";
        setMode("reset", { focus: true });
      } else {
        mode = "forgot";
        paint();
        if (!urlError) showMessage("That reset link is invalid or has expired. Enter your email to get a new one.", "error");
      }
    } else if (session) {
      // Already signed in (including coming back from Google): go to the right dashboard.
      const { data: profile } = await supabase.from("profiles").select("role").eq("id", session.user.id).maybeSingle();
      if (profile) window.location.replace(profile.role === "teacher" ? "teacher.html" : "student.html");
    }
  } catch {
    // Stay on the form if the session check fails.
  }
}
