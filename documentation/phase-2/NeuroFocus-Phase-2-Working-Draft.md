# Neuro-Focus: Phase 2 Working Draft

Working baseline: 10 October 2026. Intended submission: December 2026.

This is a developing report, not a declaration of project completion. Implementation descriptions below are based on repository inspection. Deployment, usability, performance and predictive validity have not been verified for this report.

## Project details

The Phase 1 report identifies project ID FYP-F25-12 and session Spring 2023–2027. Confirm these details, the team names and IDs, supervisor, exact submission date, and official Phase 2 chapter requirements before preparing the title pages. The supplied final template is the provisional structure; no separate Phase 2 rubric was supplied.

## Preliminary pages

Prepare the title page, declaration, statement of submission, dedication, acknowledgements, abstract, area of project, table of contents, list of figures and list of tables. Leave signatures and approval statements for the appropriate people. Write the final abstract after evaluation results exist.

Suggested project areas: web application development, computer vision, real-time systems and AI-assisted learning.

## Chapter 1: Introduction to the Problem

### 1.1 Introduction

Online learning systems provide access to lessons, assignments and assessments, but participation records alone offer limited information about a learner's behaviour during a study session. Neuro-Focus is a web-based classroom and study-support prototype that combines optional webcam-based estimates of on-screen engagement with classroom management and personal learning tools. It provides separate interfaces for students and teachers.

During an explicitly started focus session, the student browser processes camera input locally to extract facial landmarks. Rules based on iris position and a facial-orientation proxy generate an estimated engagement score. These measurements describe observable behaviour; they do not directly measure comprehension or cognitive attention. When tracking cannot produce a usable reading, the system records an unavailable state rather than assigning a zero score.

Students can use personal focus sessions, review their recorded progress, maintain notes and access a study assistant. Teachers can manage classes, run live sessions, review attendance and shared engagement records, publish posts, manage assignments and conduct quizzes. The project is under active development, and its effectiveness must be evaluated separately from its functional implementation.

### 1.2 Purpose

The purpose of Neuro-Focus is to provide students with practical study support and teachers with additional information about participation during explicitly joined live sessions. The platform combines classroom workflows with optional behavioural estimates while keeping webcam processing on the student's device.

### 1.3 Objectives

1. Implement separate student and teacher workflows with authenticated access.
2. Estimate observable on-screen engagement using locally processed facial landmarks.
3. Distinguish usable tracking time, unavailable measurements and break time in recorded sessions.
4. Share numerical engagement updates during a student's participation in a teacher's live session.
5. Store personal focus history and appropriately restricted class-session records.
6. Support classroom posts, assignments, quizzes and attendance.
7. Provide personal notes and AI-assisted study support.
8. Evaluate functional correctness, access restrictions, tracking behaviour and usability with documented evidence.

### 1.4 Existing Solutions

To draft after a primary-source literature and product review. Compare relevant classroom, conferencing and learning-support systems by documented capabilities. Avoid broad claims that all existing platforms lack attention-related features.

### 1.5 Proposed and Implemented Solution

The Phase 1 proposal described a Laravel application, MySQL persistence and a FastAPI service performing LSTM-based prediction. The inspected implementation instead uses HTML, CSS and JavaScript with Supabase authentication, PostgreSQL storage, realtime communication and an Edge Function for study assistance. The active camera tracker uses MediaPipe facial landmarks and rule-based scoring in the browser.

The repository includes a Python prediction-service prototype, but its prediction route calculates a simulated score from mean gaze values. It does not demonstrate trained LSTM inference, and no active browser integration with that route was found in the inspected scripts. LSTM integration should therefore remain a proposed enhancement unless a trained model, integration and evaluation are subsequently completed.

### 1.6 Gap Analysis

Prepare a referenced comparison table after reviewing existing systems. Keep the original motivation distinct from demonstrated outcomes. The report must not claim improved learning outcomes, ADHD treatment effectiveness or prediction accuracy without supporting evaluation.

## Chapter 2: Software Requirement Specification

The following are candidate requirements derived from the current codebase. Confirm them with the supervisor and link each accepted requirement to use cases and tests.

| ID | Candidate requirement | Current evidence / verification needed |
|---|---|---|
| FR-01 | Authenticate users and restrict workflows by role | Auth scripts and database rules; verify end-to-end |
| FR-02 | Create, join and manage classes | Class scripts and migrations; verify teacher/student flows |
| FR-03 | Start and join live class sessions and record attendance | Session migration and live-channel code; verify timing and failure cases |
| FR-04 | Start and stop optional local camera tracking | Tracking modules; verify permissions and camera lifecycle |
| FR-05 | Produce engagement estimates and unavailable/break states | Gaze-reading and tracking-state modules; verify supported conditions |
| FR-06 | Save focus sessions and display progress | History code and attention tables; verify persistence and calculations |
| FR-07 | Restrict teachers to permitted class-session records | Access policies; verify authorised and denied operations |
| FR-08 | Create and organise personal notes | Notes scripts and migration; verify privacy and persistence |
| FR-09 | Provide AI-assisted explanations and study activities | Assistant client and Edge Function; verify deployed configuration |
| FR-10 | Publish classroom posts and assignments and manage submissions | Migration and classroom code; verify deadlines, files and marking |
| FR-11 | Conduct classroom quizzes and retain results | Quiz migration and code; verify timing, scoring and answer access |

Non-functional requirements should include measurable criteria for response time, browser/device compatibility, access control, reliability, accessibility and data handling. Set targets before testing; do not invent results. Document network, camera, provider and deployment dependencies.

## Chapter 3: Use Case Analysis

Prepare a use-case model with Student and Teacher as primary actors. Treat external authentication, storage and AI services as supporting systems where relevant.

Write full descriptions for: authenticate user; create class; join class; start live session; join live session; run personal focus session; view progress; manage notes; request study assistance; publish assignment; submit assignment; mark submission; conduct quiz; review attendance.

Each description needs an identifier, actor, goal, preconditions, trigger, main flow, alternative/error flows and postconditions. Include denied camera permission, unavailable tracking, closed class joining, expired assignment deadlines and interrupted network access.

## Chapter 4: Design

### 4.1 Architecture baseline

The student and teacher interfaces execute in a web browser. Supabase handles authentication and PostgreSQL persistence. Realtime channels support live class updates. The student browser runs MediaPipe landmark detection and local scoring. Numerical session data is transmitted for authorised live reporting and persistence; the tracker does not require webcam frames to be uploaded. The study assistant follows a separate request path through a Supabase Edge Function to a configured AI provider.

Study-assistant attachments require separate treatment in the data-flow description: the assistant can send submitted text or images to its provider. Local processing of tracking video must not be described as a guarantee that all application data remains on-device.

### 4.2 Required design artifacts

Use the supplied template's diagram set provisionally: architecture; ERD and data dictionary; DFD levels 0 and 1; class; activity; sequence; collaboration; state transition; component; deployment. Replace the Phase 1 Laravel/MySQL/LSTM paths with the implemented paths. For JavaScript modules, label a class diagram as a conceptual domain model unless it represents actual classes.

Derive the database design from Supabase migrations, not the reference MySQL schema. Include profiles, classes, memberships, class sessions, attendance, attention sessions/samples, student notes, posts, assignments/submissions and quiz entities as appropriate. Identify legacy and internal tables separately.

Show camera permission and user start actions in activity/sequence diagrams. Show unavailable measurements and breaks in the tracking state model. Show student, teacher, storage and assistant-provider trust boundaries in data-flow and deployment diagrams.

## Chapter 5: Testing

No test results are asserted in this draft. Existing automated tracking and database access-rule tests provide a starting point, not proof of deployed-system correctness.

Maintain a test table with test ID, requirement ID, setup, inputs/actions, expected result, actual result, pass/fail, date, build/commit and evidence. Record pending tests as not run.

Priority cases: no face; multiple faces; partly visible face; eyes not visible; looking away; break transitions; missing readings; permission refusal; stopping the camera; personal versus shared history; unauthorised access; attendance independent of focus; assignment deadline boundaries; repeated quiz submissions; AI/network failures.

The final template requests black-box techniques, white-box coverage/complexity, performance, stress, system and regression testing. Select meaningful methods and explain their application. Functional test passes must not be reported as model accuracy. A predictive-validity study would require defined ground truth, a protocol, appropriate consent and a separate analysis.

## Chapter 6: Tools and Techniques

Document technologies used in the implemented runtime: HTML5, CSS3, JavaScript, MediaPipe, Supabase Auth, PostgreSQL, Supabase Realtime and Edge Functions. Identify the configured study-assistant provider from verified deployment settings before submission. Describe Git as version control and use history to support development milestones.

Describe FastAPI as an optional prototype and MySQL as a reference schema unless their runtime use changes. Explain scoring, smoothing, missing-data handling, authorisation and session persistence using code-supported descriptions.

## Chapter 7: Summary and Conclusion

Write after the December implementation baseline and evaluation are fixed. Summarise completed functionality, measured results and limitations. Separate intended educational benefits from observed findings.

## Chapter 8: User Manual

Capture screenshots from a verified build using demonstration accounts. Cover student sign-in, class joining, personal focus, live-session participation, notes, study assistance, assignments, quizzes and progress. Cover teacher class management, live monitoring, attendance, assignments and quizzes. Include camera/network troubleshooting and setup prerequisites.

Zoom and Google Meet buttons currently open saved meeting links. Describe them as meeting links unless an actual platform API integration is implemented.

## Chapter 9: Lessons Learnt and Future Enhancements

Record lessons from actual development and testing: architecture changes, local processing, missing measurements, role permissions, realtime reliability and usability. Candidate future work includes trained-model evaluation, stronger live-message identity validation, deployment hardening and broader device testing. Confirm priorities with the team.

## Appendix A: References

Build a verified reference list as literature review sections are written. Check each Phase 1 reference for relevance and bibliographic accuracy. Cite third-party frameworks and models; distinguish their capabilities from project-specific scoring.

## Appendix B: Index

Generate after the report is paginated, if required by the supervisor.

## Formatting baseline

The supplied final template specifies A4, Times New Roman 12 pt, justified body text, 1.5 line spacing, a 40 mm left margin and 20 mm other margins. It uses lower-case Roman preliminary page numbers and Arabic chapter page numbers centred at the bottom. Some preliminary pages have different spacing specifications. The stated normal limit is 20,000 words or 100 pages. Apply these rules to the submission document after confirming the Phase 2 requirements; do not copy template example dates, identities or broken contents fields.

## Evidence and development log

| Milestone | Evidence to retain |
|---|---|
| Initial documentation baseline | Phase 1 report, final template, inspected commit 864486f plus current uncommitted changes |
| Scope confirmation | Supervisor-approved Phase 2 requirements and accepted architecture changes |
| Implementation milestones | Relevant commits, feature descriptions and diagram updates |
| Functional verification | Test results, build identifier and screenshots |
| Evaluation | Protocol, observations, measurements and limitations |
| December submission baseline | Frozen feature list, final screenshots, regenerated contents and checked references |

Keep this draft aligned with the implementation. Record design changes honestly. Do not insert unsupported claims about authorship, independent development, model training, deployment, accuracy or completed testing.
