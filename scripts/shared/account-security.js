// Profile settings → Sign-in and security, shared by the student workspace and the teacher
// dashboard: change the email and the password used to sign in (Supabase Auth). Both ask for the
// current password first, checked by signing in again as the same account. A new email only takes
// effect once the person opens the confirmation link Supabase emails (login.html shows the result).
// Accounts that only sign in with Google have no password: they get an emailed link to set one,
// which opens the existing "Choose a new password" step on login.html.
import { notify } from "./class-live.js";

const app = await window.neuroFocusReady;

if (app && document.querySelector("#acctEmailForm")) {
  const { supabase } = app;
  const $ = (selector) => document.querySelector(selector);
  const MIN_PASSWORD = 8;
  const loginUrl = (query = "") => new URL(`login.html${query}`, window.location.href).href;
  let user = app.user;

  // An account with an email identity has a password; one with only Google doesn't.
  const hasPassword = () => !user.identities?.length || user.identities.some((identity) => identity.provider === "email");

  function say(selector, text, state = "") {
    const node = $(selector);
    node.textContent = text;
    node.dataset.state = state;
  }
  function invalid(input, bad) {
    if (bad) input.setAttribute("aria-invalid", "true");
    else input.removeAttribute("aria-invalid");
  }

  // Supabase error messages, in plainer words.
  function friendly(error, fallback) {
    const text = error?.message || String(error || "");
    if (/rate limit|security purposes|too many/i.test(text)) return "Too many attempts or emails just now. Wait a few minutes, then try again.";
    if (/already (been )?registered|already exists|email_exists/i.test(text)) return "That email can’t be used. It may already belong to another account.";
    if (/invalid.*email|email.*invalid|unable to validate email/i.test(text)) return "Enter a valid email address.";
    if (/should be different|same_password/i.test(text)) return "Choose a password that’s different from your current one.";
    if (/weak|pwned|leaked|easy to guess/i.test(text)) return "That password is too easy to guess. Try a longer one, like a short sentence.";
    if (/at least \d+ characters/i.test(text)) return text;
    if (/reauthenticat/i.test(text)) return "For security, sign out and sign in again, then try once more.";
    if (/network|fetch/i.test(text)) return "Couldn’t reach the server. Check your connection and try again.";
    return fallback;
  }

  // Signing in again as the same account proves the current password without changing anything.
  async function checkPassword(password) {
    const { data, error } = await supabase.auth.signInWithPassword({ email: user.email, password });
    if (error) return /invalid login credentials/i.test(error.message || "") ? "That current password isn’t right." : friendly(error, "Couldn’t check your current password. Try again.");
    if (data?.user?.id !== user.id) return "Couldn’t check your current password. Try again.";
    user = data.user;
    return "";
  }

  function render() {
    $("#acctCurrentEmail").textContent = user.email || "your Google account";
    const pending = user.new_email && user.new_email !== user.email ? user.new_email : "";
    $("#acctEmailPending").hidden = !pending;
    $("#acctEmailPending").textContent = pending
      ? `Waiting for you to confirm ${pending}. Open the link we emailed. Until then, keep signing in with ${user.email}.`
      : "";
    const withPassword = hasPassword();
    document.querySelectorAll("[data-needs-password]").forEach((node) => {
      node.hidden = !withPassword;
      node.querySelectorAll("input").forEach((input) => { input.disabled = !withPassword; });
    });
    $("#acctPasswordFields").hidden = !withPassword;
    $("#acctPasswordLink").hidden = withPassword;
  }

  async function refreshUser() {
    const { data, error } = await supabase.auth.getUser();
    if (!error && data?.user) user = data.user;
    render();
  }

  // ---------- Email ----------
  $("#acctEmailForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const emailInput = $("#acctNewEmail");
    const passwordInput = $("#acctEmailPassword");
    const address = emailInput.value.trim();
    const problem = !address ? "Enter your new email address."
      : !emailInput.checkValidity() ? "Enter a valid email address."
        : address.toLowerCase() === (user.email || "").toLowerCase() ? "That’s already your sign-in email."
          : hasPassword() && !passwordInput.value ? "Enter your current password to confirm it’s you."
            : "";
    invalid(emailInput, problem && !problem.includes("password"));
    invalid(passwordInput, problem.includes("password"));
    if (problem) {
      say("#acctEmailMessage", problem, "error");
      (problem.includes("password") ? passwordInput : emailInput).focus();
      return;
    }
    const button = form.querySelector("button[type=submit]");
    button.disabled = true;
    say("#acctEmailMessage", "Checking…");
    try {
      if (hasPassword()) {
        const wrong = await checkPassword(passwordInput.value);
        if (wrong) {
          invalid(passwordInput, true);
          say("#acctEmailMessage", wrong, "error");
          passwordInput.focus();
          return;
        }
      }
      const { data, error } = await supabase.auth.updateUser({ email: address }, { emailRedirectTo: loginUrl() });
      if (error) {
        say("#acctEmailMessage", friendly(error, "Couldn’t change your email. Try again."), "error");
        invalid(emailInput, true);
        emailInput.focus();
        return;
      }
      if (data?.user) user = data.user;
      emailInput.value = "";
      passwordInput.value = "";
      if ((user.email || "").toLowerCase() === address.toLowerCase()) {
        say("#acctEmailMessage", `Done. You now sign in with ${address}.`, "success");
      } else {
        say("#acctEmailMessage", `Almost done: open the confirmation link we sent to ${address}. If an email also arrives at ${user.email}, open that link too.`, "success");
        notify({ title: "Check your inbox", text: `Your sign-in email changes to ${address} once you confirm it.`, kind: "info", timeoutMs: 9000 });
      }
      render();
    } finally {
      button.disabled = false;
    }
  });

  // ---------- Password ----------
  const passwordInputs = ["#acctCurrentPassword", "#acctNewPassword", "#acctConfirmPassword"].map((selector) => $(selector));
  $("#acctShowPasswords").addEventListener("change", (event) => {
    passwordInputs.forEach((input) => { input.type = event.currentTarget.checked ? "text" : "password"; });
  });

  $("#acctPasswordForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!hasPassword()) return;
    const form = event.currentTarget;
    const [current, next, again] = passwordInputs;
    const problem = !current.value ? ["Enter your current password.", current]
      : next.value.length < MIN_PASSWORD ? [`Your new password needs at least ${MIN_PASSWORD} characters.`, next]
        : next.value !== again.value ? ["The new passwords don’t match.", again]
          : next.value === current.value ? ["Choose a password that’s different from your current one.", next]
            : null;
    passwordInputs.forEach((input) => invalid(input, problem?.[1] === input));
    if (problem) {
      say("#acctPasswordMessage", problem[0], "error");
      problem[1].focus();
      return;
    }
    const button = form.querySelector("button[type=submit]");
    button.disabled = true;
    say("#acctPasswordMessage", "Checking…");
    try {
      const wrong = await checkPassword(current.value);
      if (wrong) {
        invalid(current, true);
        say("#acctPasswordMessage", wrong, "error");
        current.focus();
        return;
      }
      const { error } = await supabase.auth.updateUser({ password: next.value });
      if (error) {
        say("#acctPasswordMessage", friendly(error, "Couldn’t change your password. Try again."), "error");
        invalid(next, true);
        next.focus();
        return;
      }
      passwordInputs.forEach((input) => { input.value = ""; });
      say("#acctPasswordMessage", "Password changed. Use your new password next time you sign in.", "success");
      notify({ title: "Password changed", text: "Use your new password next time you sign in.", kind: "success" });
    } finally {
      button.disabled = false;
    }
  });

  // Google-only accounts: the same emailed link as "Forgot password?" lets them set one.
  $("#acctPasswordLinkButton").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    say("#acctPasswordLinkMessage", "Sending…");
    const { error } = await supabase.auth.resetPasswordForEmail(user.email, { redirectTo: loginUrl("?mode=reset") });
    button.disabled = false;
    if (error) say("#acctPasswordLinkMessage", friendly(error, "Couldn’t send the link. Try again."), "error");
    else say("#acctPasswordLinkMessage", `We emailed a link to ${user.email}. Open it to choose a password.`, "success");
  });

  render();
  void refreshUser();
}
