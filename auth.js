import { getSupabase } from "./supabase-client.js";

const form = document.querySelector("#authForm");
if (form) {
  const messageBox = document.querySelector("#authMessageBox");
  const message = document.querySelector("#authMessage");
  const email = document.querySelector("#emailField");
  const password = document.querySelector("#passwordField");
  const passwordToggle = document.querySelector("#passwordToggle");
  const fullName = document.querySelector("#fullNameField");
  const submit = form.querySelector("[type='submit']");
  const submitLabel = document.querySelector("#submitLabel");
  const signupFields = document.querySelectorAll(".signup-only");
  const modeTexts = document.querySelectorAll("[data-show-mode]");
  const roleButtons = document.querySelectorAll("[data-role]");
  const modeButtons = document.querySelectorAll("[data-mode]");
  const modeLinks = document.querySelectorAll("[data-mode-link]");
  const title = document.querySelector("#auth-title");
  const params = new URLSearchParams(window.location.search);
  let roleRequest = "student";
  let mode = params.get("mode") === "signup" ? "signup" : "login";

  // state: "" (info), "error" or "success"; an empty text hides the message.
  const showMessage = (text, state = "") => {
    message.textContent = text;
    messageBox.dataset.state = state === true ? "error" : state;
    messageBox.hidden = !text;
  };
  const teacherNote = "Teacher accounts start as a request. A project owner approves them before teacher tools unlock.";

  function paint() {
    roleButtons.forEach((button) => {
      button.classList.toggle("active", button.dataset.role === roleRequest);
      button.setAttribute("aria-pressed", String(button.dataset.role === roleRequest));
    });
    modeButtons.forEach((button) => {
      button.classList.toggle("active", button.dataset.mode === mode);
      button.setAttribute("aria-pressed", String(button.dataset.mode === mode));
    });
    signupFields.forEach((field) => { field.hidden = mode !== "signup"; });
    modeTexts.forEach((text) => { text.hidden = text.dataset.showMode !== mode; });
    fullName.disabled = mode !== "signup";
    password.autocomplete = mode === "signup" ? "new-password" : "current-password";
    password.placeholder = mode === "signup" ? "Create a password" : "Your password";
    submitLabel.textContent = mode === "signup" ? "Create account" : "Sign in";
    if (title) title.textContent = mode === "signup" ? "Create your account" : "Sign in";
    document.title = `${mode === "signup" ? "Create account" : "Sign in"} · Neuro-Focus`;
  }

  roleButtons.forEach((button) => button.addEventListener("click", () => {
    roleRequest = button.dataset.role;
    showMessage(roleRequest === "teacher" ? teacherNote : "");
    paint();
  }));

  const setMode = (next) => {
    mode = next;
    showMessage(mode === "signup" && roleRequest === "teacher" ? teacherNote : "");
    paint();
  };
  modeButtons.forEach((button) => button.addEventListener("click", () => setMode(button.dataset.mode)));
  modeLinks.forEach((button) => button.addEventListener("click", () => {
    setMode(button.dataset.modeLink);
    (mode === "signup" ? fullName : email).focus();
  }));

  passwordToggle?.addEventListener("click", () => {
    const show = password.type === "password";
    password.type = show ? "text" : "password";
    passwordToggle.setAttribute("aria-pressed", String(show));
    passwordToggle.setAttribute("aria-label", show ? "Hide password" : "Show password");
    passwordToggle.querySelector("use").setAttribute("href", show ? "#i-eye-off" : "#i-eye");
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;

    submit.disabled = true;
    showMessage(mode === "signup" ? "Creating your account…" : "Signing you in…");

    try {
      const supabase = await getSupabase();
      if (mode === "signup") {
        const { data, error } = await supabase.auth.signUp({
          email: email.value.trim(),
          password: password.value,
          options: {
            data: {
              full_name: fullName.value.trim(),
              role_request: roleRequest
            },
            emailRedirectTo: new URL("login.html", window.location.href).href
          }
        });
        if (error) throw error;

        if (!data.session) {
          showMessage(roleRequest === "teacher"
            ? "Teacher request submitted. Confirm your email, then sign in. A teacher must be approved before creating classes."
            : "Account created. Check your email to confirm it, then return here to sign in.", "success");
          mode = "login";
          paint();
          password.value = "";
          return;
        }
        showMessage("Account created. Opening your workspace…", "success");
      } else {
        const { data, error } = await supabase.auth.signInWithPassword({
          email: email.value.trim(),
          password: password.value
        });
        if (error) throw error;
        showMessage("Signed in. Opening your workspace…", "success");
        const { data: profile, error: profileError } = await supabase
          .from("profiles")
          .select("role")
          .eq("id", data.user.id)
          .maybeSingle();
        if (profileError || !profile) throw new Error("Your profile is not ready. Run the database setup, then try again.");
        window.location.assign(profile.role === "teacher" ? "teacher.html" : "student.html");
        return;
      }

      const { data: { user } } = await supabase.auth.getUser();
      const { data: profile, error: profileError } = await supabase
        .from("profiles")
        .select("role")
        .eq("id", user.id)
        .maybeSingle();
      if (profileError || !profile) throw new Error("Your profile is not ready. Run the database setup, then try again.");
      window.location.assign(profile.role === "teacher" ? "teacher.html" : "student.html");
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "Authentication failed. Please try again.", true);
    } finally {
      submit.disabled = false;
    }
  });

  paint();

  // Already signed in? Skip the form and go straight to the right dashboard.
  try {
    const supabase = await getSupabase();
    const { data: { session } } = await supabase.auth.getSession();
    if (session) {
      const { data: profile } = await supabase
        .from("profiles")
        .select("role")
        .eq("id", session.user.id)
        .maybeSingle();
      if (profile) window.location.replace(profile.role === "teacher" ? "teacher.html" : "student.html");
    }
  } catch {
    // Stay on the form if the session check fails.
  }
}
