-- Just a Chit-Chat - D1 schema (v7-d1)
--
-- Sessions stay in KV (binding CCv6_DATA) for free TTL-based expiry - only
-- everything else (topics, submissions, pupils, teacher-admins, config)
-- lives here, in D1 (binding CCv6_DB).
--
-- Apply with:
--   wrangler d1 execute chitchat-v7 --remote --file=schema.sql
-- (drop --remote to apply to your local dev database instead)

CREATE TABLE IF NOT EXISTS topics (
  id                 TEXT PRIMARY KEY,
  title              TEXT NOT NULL,
  image_url          TEXT DEFAULT '',
  image_description  TEXT DEFAULT '',
  questions          TEXT NOT NULL DEFAULT '[]',   -- JSON array of 3 question strings
  tags               TEXT NOT NULL DEFAULT '[]',   -- JSON array
  coach              TEXT NOT NULL DEFAULT '[]',   -- JSON array, one entry per question: {starters:[], resources:[{title,url,type}]}
  created_at         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pupils (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  name               TEXT NOT NULL,
  pupil_class        TEXT NOT NULL,
  best_score         REAL NOT NULL DEFAULT 0,
  total_score        REAL NOT NULL DEFAULT 0,
  attempts           INTEGER NOT NULL DEFAULT 0,
  UNIQUE(name, pupil_class)
);
CREATE INDEX IF NOT EXISTS idx_pupils_class ON pupils(pupil_class);

CREATE TABLE IF NOT EXISTS pupil_history (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  pupil_id           INTEGER NOT NULL REFERENCES pupils(id),
  timestamp          INTEGER NOT NULL,
  topic_id           TEXT,
  topic_title        TEXT,
  final_score        REAL,
  max_score          REAL,
  breakdown          TEXT NOT NULL DEFAULT '[]'    -- JSON array of {part, points, max}
);
CREATE INDEX IF NOT EXISTS idx_history_pupil ON pupil_history(pupil_id);
CREATE INDEX IF NOT EXISTS idx_history_pupil_ts ON pupil_history(pupil_id, timestamp);

CREATE TABLE IF NOT EXISTS submissions (
  id                       TEXT PRIMARY KEY,
  pupil_name               TEXT NOT NULL,
  pupil_class               TEXT NOT NULL,
  topic_id                  TEXT,
  topic_title                TEXT,
  mode                       TEXT,                  -- "trees" | "single"
  rounds                     TEXT NOT NULL,          -- JSON array of 3 {question,answer,score,max,breakdown,feedback,suggestion,modelAnswer,flagged,markedBy,coachUsed}
  final_score                REAL,
  max_score                  REAL,
  practice                   INTEGER NOT NULL DEFAULT 0,
  grading_degraded           INTEGER NOT NULL DEFAULT 0,
  repeated_ideas_penalty     INTEGER NOT NULL DEFAULT 0,
  archived                   INTEGER NOT NULL DEFAULT 0,
  flagged                    INTEGER NOT NULL DEFAULT 0,
  created_at                 INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_subs_class ON submissions(pupil_class);
CREATE INDEX IF NOT EXISTS idx_subs_topic ON submissions(topic_title);
CREATE INDEX IF NOT EXISTS idx_subs_archived ON submissions(archived);
CREATE INDEX IF NOT EXISTS idx_subs_created ON submissions(created_at);
CREATE INDEX IF NOT EXISTS idx_subs_class_archived ON submissions(pupil_class, archived);

CREATE TABLE IF NOT EXISTS teacher_admins (
  username        TEXT PRIMARY KEY,
  salt            TEXT NOT NULL,
  hash            TEXT NOT NULL,
  classes         TEXT NOT NULL DEFAULT '[]',   -- JSON array
  created_at      INTEGER NOT NULL
);

-- Small settings table: teacher_password (JSON {salt,hash}), rubric (free
-- text), model_groq (Groq model id). Same three keys the old KV config:*
-- entries used, just without the "config:" prefix since the table itself
-- provides the namespace.
CREATE TABLE IF NOT EXISTS config (
  key    TEXT PRIMARY KEY,
  value  TEXT
);
