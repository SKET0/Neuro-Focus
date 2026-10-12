// The teacher dashboard tour (scripts/shared/tour.js). It opens by itself, once per account, the
// first time the teacher reaches Home (a new account lands there straight after sign-up). The
// "Take the tour" card at the bottom of the sidebar replays it at any time. The student dashboard
// has the same kind of tour (student-tour.js).
import { setupDashboardTour, sidebarDrawer, settle } from "../shared/tour.js?v=3";
import { greetingName } from "../shared/avatars.js?v=1";

const app = await window.neuroFocusReady;

if (app && document.querySelector("#classesView")) {
  const $ = (selector) => document.querySelector(selector);
  const actions = () => window.neuroFocusTeacherActions || {};
  const status = () => window.neuroFocusTeacherStatus || { loaded: false, classes: [] };
  const onHome = () => {
    sidebarDrawer(false);
    if ($("#classesView").hidden) actions().showClasses?.();
  };
  const inSidebar = async () => { sidebarDrawer(true); await settle(); };

  const steps = () => [
    {
      intro: true,
      title: `Welcome to Neuro-Focus, ${greetingName(app.profile.display_name)}!`,
      text: "This quick tour shows where everything is on your dashboard. It takes about a minute, and you can replay it from the sidebar any time.",
      before: onHome,
      buttons: [
        { label: "Not now", run: (tour) => tour.end(true) },
        { label: "Start the tour", primary: true, run: (tour) => tour.next() }
      ]
    },
    {
      target: "#sidebar .nav-group",
      title: "Getting around",
      text: "Home is your daily overview. Classes, All students and the Attendance report are always one click away. The badge on Home counts submissions waiting to be marked.",
      before: inSidebar
    },
    {
      target: () => $("#sidebarClasses")?.closest(".nav-group"),
      title: "Jump to any class",
      text: "Every class is listed here, each with its own colour. A green number shows who’s online right now and a red dot means a live session is running. Press + to create a new class.",
      before: inSidebar
    },
    {
      target: "#classesView .quick-actions",
      title: "Quick actions",
      text: "Go live, post an announcement, set an assignment or start a quiz. If you have more than one class, you’ll pick which one next.",
      before: onHome
    },
    {
      target: "#tClassesPanel",
      title: "Your classes, one at a time",
      text: "Pick a class at the top (or use the arrow keys) to see how it’s doing: attendance, focus, what’s waiting to mark and what’s due. Click any number to open that part of the class.",
      before: onHome
    },
    {
      target: "#tTodoPanel",
      title: "Needs your attention",
      text: "Marking, reminders for upcoming deadlines, invites and students worth checking in with, most urgent first. Each one has a button that takes you straight there.",
      before: onHome
    },
    {
      target: "#tMore",
      title: "Insights and recent activity",
      text: "Folded away so Home stays calm. Open it to see what’s going well, what might be worth changing, and the latest submissions and sessions.",
      before: onHome
    },
    {
      target: () => $("#sidebar .user-card"),
      title: "Your account",
      text: "Your name, picture, theme and sign-in details are in Profile settings, here and in the menu at the top right.",
      before: inSidebar
    },
    status().classes.length ? {
      title: "You’re all set",
      text: "Open a class to post, set assignments, run quizzes and go live. Students share only numbers computed on their own device: video never leaves their computer.",
      before: onHome,
      buttons: [{ label: "Finish", primary: true, run: (tour) => tour.end(true) }]
    } : {
      title: "Start with your first class",
      text: "Create a class to get a join code. Students join with it and appear on the class’s master list straight away.",
      before: onHome,
      buttons: [
        { label: "Later", run: (tour) => tour.end(true) },
        { label: "Create a class", primary: true, run: (tour) => { tour.end(true); actions().openNewClass?.(); } }
      ]
    }
  ];

  setupDashboardTour({
    supabase: app.supabase, user: app.user, name: "teacher-dashboard", place: "dashboard", steps,
    isReady: () => status().loaded,
    isHome: () => !$("#classesView").hidden,
    readyEvents: ["neurofocus:teacher-status", "neurofocus:viewchange"]
  });
}
