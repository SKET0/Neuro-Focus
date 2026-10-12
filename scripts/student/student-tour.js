// The student dashboard tour (scripts/shared/tour.js), the same kind as the teacher's
// (teacher-tour.js). It opens by itself, once per account, the first time the student reaches
// Home (a new account lands there straight after sign-up). The "Take the tour" card at the bottom
// of the sidebar replays it at any time.
import { setupDashboardTour, sidebarDrawer, settle } from "../shared/tour.js?v=3";
import { greetingName } from "../shared/avatars.js?v=1";

const app = await window.neuroFocusReady;

if (app && document.querySelector("#view-dashboard")) {
  const $ = (selector) => document.querySelector(selector);
  const status = () => window.neuroFocusClassStatus || { loaded: false, classes: [] };
  const isHome = () => !$("#view-dashboard").hidden;
  const onHome = async () => {
    sidebarDrawer(false);
    if (!isHome()) { window.neuroFocusNavigate?.("dashboard"); await settle(); }
  };
  const inSidebar = async () => { sidebarDrawer(true); await settle(); };

  const steps = () => [
    {
      intro: true,
      title: `Welcome to Neuro-Focus, ${greetingName(app.profile.display_name)}!`,
      text: "This quick tour shows where everything is in your study space. It takes about a minute, and you can replay it from the sidebar any time.",
      before: onHome,
      buttons: [
        { label: "Not now", run: (tour) => tour.end(true) },
        { label: "Start the tour", primary: true, run: (tour) => tour.next() }
      ]
    },
    {
      target: "#sidebar .nav-group",
      title: "Getting around",
      text: "Home is your daily overview. Solo focus is a private focus session, My notes keeps your class notes, and My progress shows how your focus is going over time.",
      before: inSidebar
    },
    {
      target: () => $("#sidebarClasses")?.closest(".nav-group"),
      title: "Your classes",
      text: "Every class you’ve joined, each with its own colour. A red dot means your teacher is live right now. Press + to join a class with a code from your teacher.",
      before: inSidebar
    },
    {
      target: "#nextAction",
      title: "Up next",
      text: "The one thing worth doing now: join a live session, pick up a focus session, or join your first class.",
      before: onHome
    },
    {
      target: "#view-dashboard .home-stats",
      title: "Your week",
      text: "Your focus score, how long you focused this week and your streak. Click any of them for more in My progress.",
      before: onHome
    },
    {
      target: "#today-plan",
      title: "Today",
      text: "A short plan for the day. Add your own tasks and tick them off as you go.",
      before: onHome
    },
    {
      target: "#focusPill",
      title: "Focus at a glance",
      text: "Your focus timer and tracking, visible from every page. Your camera only turns on when you start a session, and video never leaves your computer.",
      before: onHome
    },
    {
      target: ".header-actions .buddy-button",
      title: "NeuroBuddy",
      text: "Your study helper, on every page: ask questions, get explanations or make flashcards.",
      before: onHome
    },
    {
      target: () => $("#sidebar .user-card"),
      title: "Your account",
      text: "Your name, picture, theme and sign-in details are in Profile settings, here and in the menu at the top right.",
      before: inSidebar
    },
    status().classes?.length ? {
      title: "You’re all set",
      text: "When your teacher goes live, you’ll get a notice: press Join to share your focus (never your video). Good luck!",
      before: onHome,
      buttons: [{ label: "Finish", primary: true, run: (tour) => tour.end(true) }]
    } : {
      title: "Join your first class",
      text: "Ask your teacher for the join code. Once you’re in, you’ll see their posts, assignments, quizzes and live sessions.",
      before: onHome,
      buttons: [
        { label: "Later", run: (tour) => tour.end(true) },
        { label: "Join a class", primary: true, run: (tour) => { tour.end(true); window.neuroFocusClassActions?.openJoinDialog?.(); } }
      ]
    }
  ];

  setupDashboardTour({
    supabase: app.supabase, user: app.user, name: "student-dashboard", place: "study space", steps,
    isReady: () => Boolean(status().loaded),
    isHome,
    readyEvents: ["neurofocus:class-status", "neurofocus:viewchange"]
  });
}
