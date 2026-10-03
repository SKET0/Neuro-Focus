-- Neuro-Focus reference schema for MySQL 8.0.16+.
-- Use these definitions as the basis for Laravel migrations.
-- Raw webcam video is intentionally not stored in this schema.

CREATE TABLE users (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    name VARCHAR(120) NOT NULL,
    email VARCHAR(255) NOT NULL,
    email_verified_at TIMESTAMP NULL,
    password VARCHAR(255) NOT NULL,
    role ENUM('student', 'teacher', 'admin') NOT NULL DEFAULT 'student',
    remember_token VARCHAR(100) NULL,
    created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_users_email (email),
    KEY idx_users_role (role)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE courses (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    teacher_id BIGINT UNSIGNED NOT NULL,
    name VARCHAR(120) NOT NULL,
    description TEXT NULL,
    join_code VARCHAR(24) NOT NULL,
    join_password_hash VARCHAR(255) NULL,
    status ENUM('draft', 'active', 'archived') NOT NULL DEFAULT 'active',
    created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_courses_join_code (join_code),
    KEY idx_courses_teacher (teacher_id),
    CONSTRAINT fk_courses_teacher
        FOREIGN KEY (teacher_id) REFERENCES users (id)
        ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE course_members (
    course_id BIGINT UNSIGNED NOT NULL,
    student_id BIGINT UNSIGNED NOT NULL,
    joined_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    status ENUM('active', 'removed') NOT NULL DEFAULT 'active',
    PRIMARY KEY (course_id, student_id),
    KEY idx_course_members_student (student_id),
    CONSTRAINT fk_course_members_course
        FOREIGN KEY (course_id) REFERENCES courses (id)
        ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT fk_course_members_student
        FOREIGN KEY (student_id) REFERENCES users (id)
        ON UPDATE CASCADE ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE assignments (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    course_id BIGINT UNSIGNED NOT NULL,
    teacher_id BIGINT UNSIGNED NOT NULL,
    title VARCHAR(180) NOT NULL,
    instructions TEXT NULL,
    attachment_path VARCHAR(500) NULL,
    due_at DATETIME NULL,
    status ENUM('draft', 'published', 'closed') NOT NULL DEFAULT 'draft',
    created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_assignments_course_status (course_id, status),
    KEY idx_assignments_teacher (teacher_id),
    CONSTRAINT fk_assignments_course
        FOREIGN KEY (course_id) REFERENCES courses (id)
        ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT fk_assignments_teacher
        FOREIGN KEY (teacher_id) REFERENCES users (id)
        ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE assignment_submissions (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    assignment_id BIGINT UNSIGNED NOT NULL,
    student_id BIGINT UNSIGNED NOT NULL,
    response_text MEDIUMTEXT NULL,
    attachment_path VARCHAR(500) NULL,
    submitted_at DATETIME NULL,
    score DECIMAL(7,2) NULL,
    feedback TEXT NULL,
    graded_by BIGINT UNSIGNED NULL,
    graded_at DATETIME NULL,
    created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_assignment_submission (assignment_id, student_id),
    KEY idx_assignment_submissions_student (student_id),
    KEY idx_assignment_submissions_grader (graded_by),
    CONSTRAINT fk_assignment_submissions_assignment
        FOREIGN KEY (assignment_id) REFERENCES assignments (id)
        ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT fk_assignment_submissions_student
        FOREIGN KEY (student_id) REFERENCES users (id)
        ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT fk_assignment_submissions_grader
        FOREIGN KEY (graded_by) REFERENCES users (id)
        ON UPDATE CASCADE ON DELETE SET NULL,
    CONSTRAINT chk_assignment_submission_score
        CHECK (score IS NULL OR score >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE quizzes (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    course_id BIGINT UNSIGNED NOT NULL,
    teacher_id BIGINT UNSIGNED NOT NULL,
    title VARCHAR(180) NOT NULL,
    instructions TEXT NULL,
    opens_at DATETIME NULL,
    closes_at DATETIME NULL,
    time_limit_minutes SMALLINT UNSIGNED NULL,
    status ENUM('draft', 'published', 'closed') NOT NULL DEFAULT 'draft',
    created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_quizzes_course_status (course_id, status),
    KEY idx_quizzes_teacher (teacher_id),
    CONSTRAINT fk_quizzes_course
        FOREIGN KEY (course_id) REFERENCES courses (id)
        ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT fk_quizzes_teacher
        FOREIGN KEY (teacher_id) REFERENCES users (id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT chk_quiz_time_limit
        CHECK (time_limit_minutes IS NULL OR time_limit_minutes > 0),
    CONSTRAINT chk_quiz_window
        CHECK (opens_at IS NULL OR closes_at IS NULL OR closes_at > opens_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE quiz_questions (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    quiz_id BIGINT UNSIGNED NOT NULL,
    question_text TEXT NOT NULL,
    question_type ENUM('multiple_choice', 'true_false', 'short_answer') NOT NULL DEFAULT 'multiple_choice',
    points DECIMAL(7,2) NOT NULL DEFAULT 1.00,
    position SMALLINT UNSIGNED NOT NULL,
    created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_quiz_question_position (quiz_id, position),
    KEY idx_quiz_questions_quiz (quiz_id),
    CONSTRAINT fk_quiz_questions_quiz
        FOREIGN KEY (quiz_id) REFERENCES quizzes (id)
        ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT chk_quiz_question_points CHECK (points >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE quiz_options (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    question_id BIGINT UNSIGNED NOT NULL,
    option_text TEXT NOT NULL,
    is_correct BOOLEAN NOT NULL DEFAULT FALSE,
    position SMALLINT UNSIGNED NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_quiz_option_position (question_id, position),
    UNIQUE KEY uq_quiz_option_question_id (question_id, id),
    CONSTRAINT fk_quiz_options_question
        FOREIGN KEY (question_id) REFERENCES quiz_questions (id)
        ON UPDATE CASCADE ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE quiz_attempts (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    quiz_id BIGINT UNSIGNED NOT NULL,
    student_id BIGINT UNSIGNED NOT NULL,
    attempt_number SMALLINT UNSIGNED NOT NULL DEFAULT 1,
    started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    submitted_at DATETIME NULL,
    score DECIMAL(7,2) NULL,
    status ENUM('in_progress', 'submitted', 'graded', 'abandoned') NOT NULL DEFAULT 'in_progress',
    created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_quiz_student_attempt (quiz_id, student_id, attempt_number),
    KEY idx_quiz_attempts_student (student_id, started_at),
    CONSTRAINT fk_quiz_attempts_quiz
        FOREIGN KEY (quiz_id) REFERENCES quizzes (id)
        ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT fk_quiz_attempts_student
        FOREIGN KEY (student_id) REFERENCES users (id)
        ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT chk_quiz_attempt_score
        CHECK (score IS NULL OR score >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE quiz_answers (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    attempt_id BIGINT UNSIGNED NOT NULL,
    question_id BIGINT UNSIGNED NOT NULL,
    selected_option_id BIGINT UNSIGNED NULL,
    answer_text TEXT NULL,
    awarded_points DECIMAL(7,2) NULL,
    answered_at DATETIME NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_quiz_answer_question (attempt_id, question_id),
    KEY idx_quiz_answers_question (question_id),
    KEY idx_quiz_answers_option (question_id, selected_option_id),
    CONSTRAINT fk_quiz_answers_attempt
        FOREIGN KEY (attempt_id) REFERENCES quiz_attempts (id)
        ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT fk_quiz_answers_question
        FOREIGN KEY (question_id) REFERENCES quiz_questions (id)
        ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT fk_quiz_answers_option
        FOREIGN KEY (question_id, selected_option_id)
        REFERENCES quiz_options (question_id, id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT chk_quiz_answer_points
        CHECK (awarded_points IS NULL OR awarded_points >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE monitoring_sessions (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    course_id BIGINT UNSIGNED NOT NULL,
    teacher_id BIGINT UNSIGNED NOT NULL,
    assignment_id BIGINT UNSIGNED NULL,
    quiz_id BIGINT UNSIGNED NULL,
    session_name VARCHAR(180) NOT NULL,
    started_at DATETIME NULL,
    ended_at DATETIME NULL,
    status ENUM('scheduled', 'active', 'ended', 'cancelled') NOT NULL DEFAULT 'scheduled',
    created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_monitoring_sessions_course_status (course_id, status),
    KEY idx_monitoring_sessions_teacher (teacher_id),
    CONSTRAINT fk_monitoring_sessions_course
        FOREIGN KEY (course_id) REFERENCES courses (id)
        ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT fk_monitoring_sessions_teacher
        FOREIGN KEY (teacher_id) REFERENCES users (id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT fk_monitoring_sessions_assignment
        FOREIGN KEY (assignment_id) REFERENCES assignments (id)
        ON UPDATE CASCADE ON DELETE SET NULL,
    CONSTRAINT fk_monitoring_sessions_quiz
        FOREIGN KEY (quiz_id) REFERENCES quizzes (id)
        ON UPDATE CASCADE ON DELETE SET NULL,
    CONSTRAINT chk_monitoring_session_activity
        CHECK (assignment_id IS NULL OR quiz_id IS NULL),
    CONSTRAINT chk_monitoring_session_time
        CHECK (started_at IS NULL OR ended_at IS NULL OR ended_at >= started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE session_participants (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    session_id BIGINT UNSIGNED NOT NULL,
    student_id BIGINT UNSIGNED NOT NULL,
    consent_status ENUM('pending', 'granted', 'declined', 'withdrawn') NOT NULL DEFAULT 'pending',
    consented_at DATETIME NULL,
    joined_at DATETIME NULL,
    left_at DATETIME NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_session_participant (session_id, student_id),
    UNIQUE KEY uq_session_participant_pair (session_id, id),
    KEY idx_session_participants_student (student_id, joined_at),
    CONSTRAINT fk_session_participants_session
        FOREIGN KEY (session_id) REFERENCES monitoring_sessions (id)
        ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT fk_session_participants_student
        FOREIGN KEY (student_id) REFERENCES users (id)
        ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT chk_session_participant_time
        CHECK (joined_at IS NULL OR left_at IS NULL OR left_at >= joined_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE attention_scores (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    session_id BIGINT UNSIGNED NOT NULL,
    participant_id BIGINT UNSIGNED NOT NULL,
    score DECIMAL(5,2) NULL,
    predicted_state ENUM('focused', 'distracted', 'uncertain', 'unavailable') NOT NULL,
    confidence DECIMAL(5,4) NULL,
    model_version VARCHAR(80) NULL,
    recorded_at DATETIME(3) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_attention_score_session_participant (session_id, participant_id, recorded_at),
    KEY idx_attention_scores_dashboard (session_id, recorded_at),
    KEY idx_attention_scores_participant_time (participant_id, recorded_at),
    CONSTRAINT fk_attention_scores_participant
        FOREIGN KEY (session_id, participant_id)
        REFERENCES session_participants (session_id, id)
        ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT chk_attention_score_range
        CHECK (score IS NULL OR (score >= 0 AND score <= 100)),
    CONSTRAINT chk_attention_confidence_range
        CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
    CONSTRAINT chk_attention_score_availability
        CHECK ((predicted_state = 'unavailable' AND score IS NULL) OR
               (predicted_state <> 'unavailable' AND score IS NOT NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE adaptive_alerts (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    session_id BIGINT UNSIGNED NOT NULL,
    participant_id BIGINT UNSIGNED NOT NULL,
    attention_score_id BIGINT UNSIGNED NULL,
    recipient ENUM('student', 'teacher') NOT NULL DEFAULT 'student',
    alert_code VARCHAR(60) NOT NULL,
    message VARCHAR(500) NOT NULL,
    sent_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    acknowledged_at DATETIME NULL,
    status ENUM('sent', 'acknowledged', 'dismissed') NOT NULL DEFAULT 'sent',
    PRIMARY KEY (id),
    KEY idx_adaptive_alerts_session_time (session_id, sent_at),
    KEY idx_adaptive_alerts_participant_time (participant_id, sent_at),
    CONSTRAINT fk_adaptive_alerts_participant
        FOREIGN KEY (session_id, participant_id)
        REFERENCES session_participants (session_id, id)
        ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT fk_adaptive_alerts_score
        FOREIGN KEY (attention_score_id) REFERENCES attention_scores (id)
        ON UPDATE CASCADE ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
