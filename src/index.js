/**
 * Just a Chit-Chat
 * Cloudflare Worker backend + single-file frontend.
 *
 * Storage (v7-d1)
 *   Sessions live in KV (binding CCv6_DATA) for free TTL-based expiry.
 *   Everything else - topics, submissions, pupils, pupil history,
 *   teacher-admins, and settings (teacher password / rubric / groq model) -
 *   lives in D1 (binding CCv6_DB). See schema.sql for the table layout;
 *   apply it with: wrangler d1 execute chitchat-v7 --remote --file=schema.sql
 *
 *   session:<token>  (KV) -> { name, pupilClass, role, isSuperAdmin, assignedClasses, createdAt }
 *   topics            (D1) -> id, title, image_url, image_description, questions (JSON), tags (JSON), coach (JSON), created_at
 *   submissions       (D1) -> id, pupil_name, pupil_class, topic_id, topic_title, mode, rounds (JSON, 3 entries),
 *                              final_score, max_score, practice, grading_degraded, repeated_ideas_penalty, archived, flagged, created_at
 *   pupils            (D1) -> id, name, pupil_class, best_score, total_score, attempts   (UNIQUE(name,pupil_class); practice/degraded attempts never update this)
 *   pupil_history     (D1) -> id, pupil_id, timestamp, topic_id, topic_title, final_score, max_score, breakdown (JSON)
 *                              (used for the teacher's per-pupil strengths/concerns view - most recent 50 read via LIMIT, see loadPupilHistory)
 *   teacher_admins    (D1) -> username, salt, hash, classes (JSON), created_at   (a scoped teacher-admin account created by palpatine; can only see/administer pupils in `classes`. palpatine itself is NOT stored here - it's the hardcoded super-admin, see TEACHER_USERNAME)
 *   config            (D1) -> key/value: "teacher_password" (JSON {salt,hash}), "rubric" (free text), "model_groq" (Groq model id)
 *
 * Roles
 *   Every teacher-side session still has role:"teacher" (see requireTeacher), but
 *   carries two extra fields that scope what it can see/do:
 *     isSuperAdmin: true for palpatine only - full access to every class, plus the
 *       Topics/Settings/Admins tabs (see requireSuperAdmin).
 *     assignedClasses: for a scoped teacher-admin, the array of class names (as typed
 *       by palpatine when creating them) they're allowed to view/administer. null for
 *       palpatine (meaning "all classes"). Endpoints that list or mutate pupil/submission
 *       data filter by this in SQL - see classAllowed() and buildSubmissionsFilter().
 *
 * Class-name matching note: a pupil's name/class as stored on their pupils
 * row is exact-case (matches how they typed it at login, same as the old KV
 * key scheme) - so "Jovan@5ig" and "Jovan@5IG" are still different pupils.
 * Permission/filter matching (classAllowed, the ?class=/?topic= query params)
 * is case-insensitive, same as v7's KV-era JS did, just expressed as SQL
 * LOWER() comparisons now instead of .toLowerCase() in JS.
 *
 * Secrets / bindings
 *   env.GEMINI_API_KEY       Vision-capable, 1st tier tried, wrangler secret put GEMINI_API_KEY (aistudio.google.com/apikey)
 *   env.GEMINI_API_KEY_2     Optional 2nd Gemini key, tried right after the first if it fails/is rate-limited (2nd account/key)
 *   env.GROQ_API_KEY         2nd tier tried, wrangler secret put GROQ_API_KEY (console.groq.com)
 *   env.GROQ_API_KEY_2       Optional 2nd Groq key, same idea as GEMINI_API_KEY_2
 *   env.OPENROUTER_API_KEY   3rd tier tried, wrangler secret put OPENROUTER_API_KEY (openrouter.ai/keys)
 *   env.OPENROUTER_API_KEY_2 Optional 2nd OpenRouter key, same idea as GEMINI_API_KEY_2
 *   env.AI                   4th and final AI tier, Cloudflare Workers AI (free, [ai] binding in wrangler.toml)
 *
 *   Every question in a submission is marked with the same fixed chain (see
 *   aiScore): both Gemini keys, then both Groq keys, then both OpenRouter
 *   keys, then Workers AI. Any tier with no key/binding configured is simply
 *   skipped. Gemini goes first because it's the only vision-capable provider
 *   here - whenever a Gemini attempt runs, it's sent the actual topic
 *   picture (fetched + base64-encoded server-side) so the Evidence (E1) part
 *   can be checked against what's really in the picture, not just judged on
 *   plausibility. Every other provider (Groq, OpenRouter, Workers AI) is
 *   text-only and instead uses the teacher's optional imageDescription field
 *   for the Evidence part (or, failing that, is told plainly it can't see
 *   the picture and to mark E1 on plausibility only).
 *
 *   Questions are marked one at a time, not concurrently (see the
 *   /api/submit handler), specifically to avoid bursting simultaneous
 *   requests at the same provider/key - a common trigger for rate-limiting.
 *   If a question's entire chain fails on the first pass (transient
 *   rate-limits being the most likely cause), the whole chain is retried in
 *   full up to AI_MARKING_MAX_PASSES times, with a pause in between, before
 *   that question falls back to the offline rule-based scorer - this is the
 *   main safeguard that keeps AI marking landing successfully rather than
 *   silently degrading to the weaker offline scorer.
 * *   Settings and again at call time in aiScore, so this fallback tier can
 *   never end up calling a paid model.
 */

import { VULGAR_WORDS } from "./vulgarity-list.js";
import { PAGE_HTML } from "./frontend.js";
import { SEED_TOPICS } from "./seed-topics.js";

const TEACHER_USERNAME = "palpatine"; // trigger username for hidden teacher tools

// Teacher-configurable via Settings (config table, key model_groq); this is
// only the default used until a teacher picks something else. Kept in sync
// with Groq's currently-active model list - see console.groq.com/docs/models.
const DEFAULT_GROQ_MODEL = "openai/gpt-oss-120b";
// Models a teacher can pick from Settings without having to know exact model
// IDs. If Groq deprecates one of these, update this list and redeploy - a
// teacher can still type any other valid Groq model ID directly, this is
// just the convenience list shown in the dropdown.
const GROQ_MODEL_OPTIONS = [
  { id: "openai/gpt-oss-120b", label: "GPT-OSS 120B (default - high reasoning, agentic)" },
  { id: "openai/gpt-oss-20b", label: "GPT-OSS 20B (faster, lighter)" },
  { id: "qwen/qwen3.6-27b", label: "Qwen3.6 27B" },
];

// OpenRouter is the 3rd AI tier tried for every question (see aiScore) -
// after both Gemini keys and both Groq keys have failed, and before Workers
// AI. Only free models are ever allowed here (see isFreeOpenRouterModel) -
// this fallback tier exists to keep the app from hard-failing, not to run
// up a bill, so the app enforces this both when a teacher saves a model in
// Settings and again at call time in aiScore, in case the config table ever
// ends up with something else by some other route.
//
// The default, "openrouter/free", is OpenRouter's own free-model router: it
// auto-selects a free model for each request (filtering for the features
// the request needs - see openrouter.ai/openrouter/free) rather than
// pinning to one model ID, so it keeps working even as OpenRouter's
// specific free-tier model lineup changes over time. A teacher can still
// pin a specific model instead via the options below or by typing any other
// model ID that ends in ":free" (OpenRouter's own naming convention for its
// free-tier model variants - see openrouter.ai/models?max_price=0).
const DEFAULT_OPENROUTER_MODEL = "openrouter/free";
const OPENROUTER_MODEL_OPTIONS = [
  { id: "openrouter/free", label: "Free Models Router (default - auto-picks a free model)" },
  { id: "meta-llama/llama-3.3-70b-instruct:free", label: "Llama 3.3 70B (free tier)" },
  { id: "google/gemini-2.0-flash-exp:free", label: "Gemini 2.0 Flash (free tier, via OpenRouter)" },
  { id: "qwen/qwen-2.5-72b-instruct:free", label: "Qwen 2.5 72B (free tier)" },
  { id: "deepseek/deepseek-chat:free", label: "DeepSeek Chat (free tier)" },
];

// True for OpenRouter's own free-model router, or any model slug ending in
// OpenRouter's ":free" suffix convention. Anything else - a paid model, or a
// typo missing the suffix - is rejected wherever this is checked, so
// OpenRouter can never be configured (accidentally or otherwise) to call a
// paid model.
function isFreeOpenRouterModel(modelId) {
  const id = String(modelId || "").trim();
  return id === "openrouter/free" || /:free$/i.test(id);
}

const DEFAULT_RUBRIC = `The total score is 25 marks: 20 marks for TREES and 5 marks for Language Use.

TREES is marked out of 20 marks total, distributed as follows:
- T Thought: 0-2 marks
- R Reason: 0-2 marks
- E Example (evidence or example from the picture/topic to support the reasons and/or thoughts): 0-2 marks
- E Experience: 0-12 marks (the most heavily weighted part)
- S Suggestion: 0-2 marks

--- T Thought (0-2) ---
0 = no clear thought given
1 = simple or vague thought
2 = clear, relevant thought that answers the question directly

--- R Reason (0-2) ---
0 = no reason given, or vague/weak reason
1 = relevant reason but with limited explanation
2 = clear, relevant reason with some elaboration connecting clearly to thoughts

--- E Example or Evidence from picture/topic (0-2) ---
0 = no reference to the picture or topic, or mentions it only vaguely
1 = identifies a relevant detail or provides a clear example from the picture or topic
2 = uses a specific detail or example and explains how it supports the answer/thoughts/reasons

--- E Experience (0-12) ---
This is the main focus of the rubric. Do NOT reward length alone - reward
specific, believable, relevant personal details. A long but generic or
memorised-sounding answer should score LOW. Break this into 5 sub-criteria
and sum them for the Experience total:

1. Relevance to the topic/question (0-2)
   0 = missing or unrelated, 1 = weakly related, 2 = clearly relevant

2. Specificity using 5W1H details (0-6) - award up to 1 mark each for clear:
   Who was involved / What happened / When it happened / Where it happened /
   Why it happened or why the pupil acted / How it ended or was resolved

3. Authenticity / personal voice (0-2)
   0 = no personal experience, clearly copied/generic, or only a generic reference
   1 = sounds mostly personal and believable
   2 = sounds authentic and natural, with realistic details, feelings or reactions
   Look for: first-person language (I/my/we), natural small believable details,
   realistic Singapore settings (void deck, MRT, canteen, CCA), genuine feelings.

4. Clarity and sequence (0-1)
   0 = confusing, incomplete, or jumps around
   1 = clearly sequenced with a beginning, middle and ending

5. Reflection / lesson learnt (0-1)
   0 = no reflection, or only a simple feeling/lesson stated
   1 = meaningful reflection that links back to the topic

If the pupil's Experience answer lacks depth (vague on WHO/WHAT/WHEN/WHERE,
or reads as generic/memorised), say so plainly in the feedback - name what
was missing (e.g. "unclear where and when this happened, and who else was
there") - and suggest 1-2 concrete example experiences the pupil could have
shared instead, related to the topic, to model what a specific answer looks
like.

--- S Suggestion (0-2) ---
0 = no suggestion given
1 = simple or vague suggestion
2 = practical, relevant suggestion (ideally: who/what should do something + why it helps)

--- Language Use (0-5 total, separate from TREES content above) ---
Judge this ONLY from the pupil's actual grammar, word choice, and delivery -
not from how good their ideas or experience are. A pupil with a weak
experience but strong grammar should still score well here, and vice versa.

1. Grammar Accuracy (0-2)
   0 = frequent errors that make meaning hard to follow
   1 = some errors (tense, subject-verb agreement, articles) but meaning is clear
   2 = largely accurate grammar throughout

2. Vocabulary Range & Appropriateness (0-2)
   0 = very basic, repetitive vocabulary
   1 = adequate vocabulary for the topic
   2 = varied, precise, topic-appropriate vocabulary used naturally

3. Fluency & Delivery (0-1)
   0 = frequent filler words (um/uh/like) or halting, hard-to-follow delivery
   1 = mostly smooth delivery with minimal filler words`;

function csvEscape(val) {
  const s = val === undefined || val === null ? "" : String(val);
  if (/[",\n]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json;charset=UTF-8", "access-control-allow-origin": "*" },
  });
}

function badRequest(msg) {
  return json({ error: msg }, 400);
}

function uid() {
  return crypto.randomUUID();
}

// ---------- NPC "Coach" content (sentence starters + teacher-set resources) ----------
// One coach entry per question (3 total per topic). Resources are manually
// set by the teacher via Teacher Tools -> Topics -> Coach fields - there is
// no AI-generated link suggestion here on purpose (an LLM can hallucinate
// plausible-looking article/video links that don't actually exist).
// ---------- Pupil tracking by name@class ----------
// Row identity on the pupils table is exact-case (name, pupil_class) - see
// the header comment. getOrCreatePupilId upserts in one round trip using
// D1's ON CONFLICT ... RETURNING.
async function getOrCreatePupilId(env, pupilClass, name) {
  const row = await env.CCv6_DB.prepare("SELECT id FROM pupils WHERE name = ? AND pupil_class = ?").bind(name, pupilClass).first();
  if (row) return row.id;
  const inserted = await env.CCv6_DB
    .prepare("INSERT INTO pupils (name, pupil_class, best_score, total_score, attempts) VALUES (?, ?, 0, 0, 0) RETURNING id")
    .bind(name, pupilClass)
    .first();
  return inserted.id;
}

const PUPIL_HISTORY_CAP = 50; // only the most recent 50 attempts are read back (LIMIT), see loadPupilHistory - older rows simply accumulate in D1 rather than being pruned

function rowToPupil(row) {
  return { name: row.name, pupilClass: row.pupil_class, bestScore: row.best_score, totalScore: row.total_score, attempts: row.attempts };
}

function rowToHistoryEntry(row) {
  return {
    timestamp: row.timestamp,
    topicId: row.topic_id,
    topicTitle: row.topic_title,
    finalScore: row.final_score,
    maxScore: row.max_score,
    breakdown: JSON.parse(row.breakdown || "[]"),
  };
}

async function pushPupilHistory(env, pupilId, entry) {
  await env.CCv6_DB
    .prepare("INSERT INTO pupil_history (pupil_id, timestamp, topic_id, topic_title, final_score, max_score, breakdown) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(pupilId, entry.timestamp, entry.topicId, entry.topicTitle, entry.finalScore, entry.maxScore, JSON.stringify(entry.breakdown))
    .run();
}

// Most recent PUPIL_HISTORY_CAP attempts, oldest-first (matches the order
// the old KV rolling-array log kept them in).
async function loadPupilHistory(env, pupilId) {
  const { results } = await env.CCv6_DB
    .prepare("SELECT * FROM pupil_history WHERE pupil_id = ? ORDER BY timestamp DESC LIMIT ?")
    .bind(pupilId, PUPIL_HISTORY_CAP)
    .all();
  return results.reverse().map(rowToHistoryEntry);
}

// Averages each breakdown criterion (Thought, Reason, ..., Fluency & Delivery)
// across a submission's 3 rounds, so one attempt collapses to one compact
// history entry instead of 3 full round breakdowns.
function averageRoundBreakdown(rounds) {
  const sums = {};
  const maxes = {};
  for (const r of rounds) {
    for (const b of r.breakdown || []) {
      sums[b.part] = (sums[b.part] || 0) + b.points;
      maxes[b.part] = b.max;
    }
  }
  return Object.keys(sums).map((part) => ({
    part,
    points: Math.round((sums[part] / rounds.length) * 10) / 10,
    max: maxes[part],
  }));
}

// Rolls a pupil's history into per-criterion averages, then flags the
// weakest as "areas to grow" and strongest as "strengths" - purely
// arithmetic on already-stored scores, no AI call needed.
function computeStrengthsConcerns(history) {
  if (!history || !history.length) return { strengths: [], concerns: [], rows: [] };
  const totals = {};
  for (const h of history) {
    for (const b of h.breakdown || []) {
      if (!totals[b.part]) totals[b.part] = { sum: 0, max: b.max, n: 0 };
      totals[b.part].sum += b.points;
      totals[b.part].n += 1;
    }
  }
  const rows = Object.keys(totals).map((part) => {
    const t = totals[part];
    const avg = t.n > 0 ? t.sum / t.n : 0;
    return { part, avg: Math.round(avg * 10) / 10, max: t.max, pct: t.max > 0 ? avg / t.max : 0 };
  });
  const sorted = [...rows].sort((a, b) => a.pct - b.pct);
  const concerns = sorted.slice(0, 2).map((r) => r.part);
  const strengths = [...sorted].reverse().slice(0, 2).map((r) => r.part);
  return { strengths, concerns, rows };
}

function sanitizeCoach(raw) {
  const entries = Array.isArray(raw) ? raw : [];
  const out = [];
  for (let i = 0; i < 3; i++) {
    const e = entries[i] || {};
    const starters = Array.isArray(e.starters) ? e.starters.map((s) => String(s || "").trim()).filter(Boolean).slice(0, 6) : [];
    const resourcesRaw = Array.isArray(e.resources) ? e.resources : [];
    const resources = [];
    for (const r of resourcesRaw) {
      const url = String((r && r.url) || "").trim();
      if (!url) continue;
      if (!/^https?:\/\//i.test(url)) continue; // never store a non-http(s) "link"
      const type = r && r.type === "video" ? "video" : "article";
      const title = String((r && r.title) || url).trim().slice(0, 200);
      resources.push({ title, url, type });
      if (resources.length >= 3) break;
    }
    out.push({ starters, resources });
  }
  return out;
}

// ---------- Password comparison / hashing ----------
// Compares two strings in constant time (relative to a fixed-length buffer)
// so a failed login attempt doesn't leak how many leading characters were
// correct via response timing.
function timingSafeEqualStr(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  const len = Math.max(aBytes.length, bBytes.length, 32);
  let diff = aBytes.length ^ bBytes.length;
  for (let i = 0; i < len; i++) {
    diff |= (i < aBytes.length ? aBytes[i] : 0) ^ (i < bBytes.length ? bBytes[i] : 0);
  }
  return diff === 0;
}

async function hashPassword(password, salt) {
  const enc = new TextEncoder();
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(salt + ":" + password));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ---------- Settings (D1 config table: key/value) ----------
async function getConfig(env, key) {
  const row = await env.CCv6_DB.prepare("SELECT value FROM config WHERE key = ?").bind(key).first();
  return row ? row.value : null;
}
async function setConfig(env, key, value) {
  await env.CCv6_DB.prepare("INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(key, value).run();
}
async function deleteConfig(env, key) {
  await env.CCv6_DB.prepare("DELETE FROM config WHERE key = ?").bind(key).run();
}

// The teacher password is stored as { salt, hash } (SHA-256), never in
// plaintext. Older deployments may still have a plain string in the config
// table from before this change - if a login with that plaintext value
// succeeds, we transparently upgrade the stored value to the salted-hash
// format so the plaintext isn't left sitting there any longer than necessary.
async function verifyTeacherPassword(env, password) {
  const stored = await getConfig(env, "teacher_password");
  if (!stored) return { ok: false, unset: true };

  let record = null;
  try {
    record = JSON.parse(stored);
  } catch (e) {
    record = null;
  }

  if (record && typeof record.salt === "string" && typeof record.hash === "string") {
    const candidateHash = await hashPassword(password, record.salt);
    return { ok: timingSafeEqualStr(candidateHash, record.hash) };
  }

  // Legacy plaintext format.
  const matches = timingSafeEqualStr(password, stored);
  if (matches) {
    await setTeacherPassword(env, password); // migrate to hashed storage
  }
  return { ok: matches };
}

async function setTeacherPassword(env, newPassword) {
  const salt = uid();
  const hash = await hashPassword(newPassword, salt);
  await setConfig(env, "teacher_password", JSON.stringify({ salt, hash }));
}

// ---------- Teacher-admin accounts ----------
// Scoped admins created by palpatine, each restricted to a set of classes.
// Stored the same salted-hash way as the palpatine password.
async function getTeacherAdmin(env, username) {
  const row = await env.CCv6_DB.prepare("SELECT * FROM teacher_admins WHERE username = ?").bind(username).first();
  if (!row) return null;
  return { username: row.username, salt: row.salt, hash: row.hash, classes: JSON.parse(row.classes || "[]"), createdAt: row.created_at };
}

async function verifyTeacherAdminPassword(record, password) {
  if (!record || typeof record.salt !== "string" || typeof record.hash !== "string") return false;
  const candidateHash = await hashPassword(password, record.salt);
  return timingSafeEqualStr(candidateHash, record.hash);
}

async function listTeacherAdmins(env) {
  const { results } = await env.CCv6_DB.prepare("SELECT username, classes, created_at FROM teacher_admins ORDER BY username").all();
  return results.map((r) => ({ username: r.username, classes: JSON.parse(r.classes || "[]"), createdAt: r.created_at }));
}

// Every class a pupil has ever logged in under. Used to populate class
// filter dropdowns and is intersected with a scoped teacher-admin's
// assignedClasses where relevant.
async function getAllKnownClasses(env) {
  const { results } = await env.CCv6_DB.prepare("SELECT DISTINCT pupil_class FROM pupils ORDER BY pupil_class").all();
  return results.map((r) => r.pupil_class);
}

// True if this session is allowed to see/administer the given class -
// palpatine (isSuperAdmin) can see everything; a scoped teacher-admin only
// their own assignedClasses (case-insensitive match).
function classAllowed(session, pupilClass) {
  if (!session || session.role !== "teacher") return false;
  if (session.isSuperAdmin) return true;
  const cls = (pupilClass || "unassigned").toLowerCase();
  return (session.assignedClasses || []).some((c) => String(c).toLowerCase() === cls);
}

async function getSession(request, env) {
  const auth = request.headers.get("authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  const raw = await env.CCv6_DATA.get(`session:${token}`);
  if (!raw) return null;
  return { token, ...JSON.parse(raw) };
}

function requireTeacher(session) {
  return session && session.role === "teacher";
}

// palpatine only - Topics, Settings, and managing teacher-admin accounts are
// global and out of scope for a class-scoped teacher-admin.
function requireSuperAdmin(session) {
  return session && session.role === "teacher" && session.isSuperAdmin === true;
}

// ---------- Vulgarity filter ----------
function scanVulgarity(text) {
  if (!text) return { clean: text || "", flagged: false, hits: [] };
  const hits = [];
  let clean = text;
  for (const word of VULGAR_WORDS) {
    const re = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi");
    if (re.test(clean)) {
      hits.push(word);
      clean = clean.replace(re, (m) => "*".repeat(m.length));
    }
  }
  return { clean, flagged: hits.length > 0, hits };
}

function scanAllParts(parts) {
  const flaggedFields = [];
  const cleaned = {};
  let anyFlag = false;
  for (const [key, val] of Object.entries(parts || {})) {
    const { clean, flagged } = scanVulgarity(val);
    cleaned[key] = clean;
    if (flagged) {
      anyFlag = true;
      flaggedFields.push(key);
    }
  }
  return { cleaned, anyFlag, flaggedFields };
}

// ---------- Topics (D1) ----------
function rowToTopic(row) {
  return {
    id: row.id,
    title: row.title,
    imageUrl: row.image_url,
    imageDescription: row.image_description,
    questions: JSON.parse(row.questions || "[]"),
    tags: JSON.parse(row.tags || "[]"),
    coach: JSON.parse(row.coach || "[]"),
  };
}

async function ensureSeeded(env) {
  const row = await env.CCv6_DB.prepare("SELECT COUNT(*) as c FROM topics").first();
  if (row && row.c > 0) return;
  for (const t of SEED_TOPICS) {
    await env.CCv6_DB
      .prepare("INSERT INTO topics (id, title, image_url, image_description, questions, tags, coach, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(t.id, t.title || "Untitled topic", t.imageUrl || "", t.imageDescription || "", JSON.stringify(t.questions || []), JSON.stringify(t.tags || []), JSON.stringify(t.coach || []), Date.now())
      .run();
  }
}

// ---------- Rubric fallback (no AI key configured) ----------
const TREES_ORDER = [
  ["T", "Thought", 2],
  ["R", "Reason", 2],
  ["E1", "Evidence", 2],
  ["E2", "Experience", 12],
  ["S", "Suggestion", 2],
];
const TREES_MAX_TOTAL = TREES_ORDER.reduce((sum, [, , max]) => sum + max, 0); // 20

const EXPERIENCE_SUB = [
  ["Relevance", 2],
  ["5W1H Specificity", 6],
  ["Authenticity / Personal Voice", 2],
  ["Clarity & Sequence", 1],
  ["Reflection / Lesson Learnt", 1],
];

// ---------- Language Use (v6) - additive to TREES, not part of it ----------
// Modeled on (not copied from) the real PSLE oral exam's separate weighting
// of content vs language. Kept as its own small block so a teacher can see
// exactly which part of the mark is about WHAT was said vs HOW it was said.
const LANGUAGE_ORDER = [
  ["Grammar", "Grammar Accuracy", 2],
  ["Vocabulary", "Vocabulary Range & Appropriateness", 2],
  ["Fluency", "Fluency & Delivery", 1],
];
const LANGUAGE_MAX_TOTAL = LANGUAGE_ORDER.reduce((sum, [, , max]) => sum + max, 0); // 5
const FULL_MAX_TOTAL = TREES_MAX_TOTAL + LANGUAGE_MAX_TOTAL; // 25

// Applied once per submission (not per round) when the pupil's three answers
// reuse essentially the same idea/story across all three questions - see
// detectRepeatedIdeas(). A flat deduction rather than a per-round rubric
// line, since it's about the *set* of three answers, not any one of them.
const REPEATED_IDEAS_PENALTY = 5;

// Filler words / disfluency markers, used to inform the Fluency sub-score.
// NOTE: the transcript comes from the browser's Web Speech API, which is
// known to smooth over or drop disfluencies rather than transcribe them
// faithfully - this is a best-effort signal, not a precise measurement.
const FILLER_RE = /\b(um+|uh+|erm+|ah+|hmm+|like|you know)\b/gi;
function countFillers(text) {
  const words = (text || "").trim().split(/\s+/).filter(Boolean);
  const totalWords = words.length;
  const matches = (text || "").match(FILLER_RE) || [];
  const count = matches.length;
  const density = totalWords > 0 ? count / totalWords : 0;
  return { count, totalWords, density };
}

// crude 5W1H / authenticity heuristics used only when no AI key is configured.
// These are deliberately strict: a pupil who just writes a lot of words with
// no real content should NOT score well offline, since this scorer has no
// real language understanding and is meant to be a conservative stand-in,
// not a generous one, while a teacher fixes the AI marking setup.
const WHO_RE = /\b(i|my|me|mother|father|mum|dad|grandmother|grandfather|friend|classmate|teacher|uncle|auntie|sister|brother|we)\b/i;
const WHEN_RE = /\b(yesterday|last\s+\w+|today|during|after|before|one\s+day|morning|afternoon|evening|weekend|recess|holiday)\b/i;
const WHERE_RE = /\b(at|in|near|school|canteen|mrt|bus|void\s+deck|park|home|classroom|market|centre|center|station)\b/i;
const WHY_RE = /\b(because|so\s+that|since|as\s+a\s+result|therefore|due\s+to)\b/i;
const HOW_RE = /\b(then|after\s+that|finally|in\s+the\s+end|eventually|so\s+i|i\s+decided|i\s+helped|i\s+felt)\b/i;
// concrete action/detail words - a rough proxy for "something specific actually
// happened" rather than a vague generic sentence padded out with filler words
const WHAT_RE = /\b(\d+|played|ran|fell|helped|broke|lost|found|won|cried|laughed|shouted|forgot|dropped|caught|fixed|built|cooked|cleaned|carried|shared|apologi[sz]ed|argued|comforted)\b/i;
const REFLECT_RE = /\b(felt|learnt|learned|realised|realized|proud|happy|taught\s+me|lesson|since\s+then)\b/i;
const SEQUENCE_RE = /\b(at\s+first|then|after\s+that|in\s+the\s+end|finally|next|later\s+on|once)\b/i;

const THOUGHT_RE = /\b(i think|in my opinion|i believe|i feel that)\b/i;
const REASON_RE = /\bbecause\b/i;
const EVIDENCE_RE = /\b(in the picture|i can see|the picture shows|this shows)\b/i;
const SUGGESTION_RE = /\b(i suggest|should|could|in future|we can|in the future)\b/i;

const STOPWORDS = new Set(["this", "that", "with", "from", "about", "your", "their", "which", "there", "would", "could", "should", "picture", "topic", "image"]);

// Pulls a handful of meaningful keywords out of the topic (title + tags) so
// the offline scorer can do a rough check for on-topic content, instead of
// only ever measuring word count.
function topicKeywords(topic) {
  const raw = [topic && topic.title, ...((topic && topic.tags) || [])].filter(Boolean).join(" ");
  const words = (raw.toLowerCase().match(/[a-z]+/g) || []).filter((w) => w.length >= 4 && !STOPWORDS.has(w));
  return Array.from(new Set(words));
}

function mentionsTopic(text, keywords) {
  if (!keywords.length) return false;
  const lower = (text || "").toLowerCase();
  return keywords.some((kw) => lower.includes(kw));
}

// ---------- Repeated-ideas-across-prompts penalty ----------
// A flat deduction applied once per submission (not per round) when all
// three answers are largely the same idea/story reused across different
// questions - deliberately deterministic and word-overlap based rather than
// an AI judgement call, since it's comparing across rounds that were each
// scored independently.
function extractRoundText(answer) {
  if (!answer) return "";
  if (typeof answer.text === "string") return answer.text;
  if (answer.parts && typeof answer.parts === "object") return Object.values(answer.parts).join(" ");
  return "";
}
function significantWordSet(text) {
  const words = (text || "").toLowerCase().match(/[a-z']+/g) || [];
  return new Set(words.filter((w) => w.length >= 4 && !STOPWORDS.has(w)));
}
function jaccardSimilarity(setA, setB) {
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const w of setA) if (setB.has(w)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union > 0 ? intersection / union : 0;
}
const REPEATED_IDEAS_MIN_WORDS = 6; // each answer needs at least this many significant words to be judged
const REPEATED_IDEAS_THRESHOLD = 0.45; // Jaccard similarity - all 3 pairwise comparisons must clear this
function detectRepeatedIdeas(roundTexts) {
  if (roundTexts.length < 3) return false;
  const sets = roundTexts.map(significantWordSet);
  if (sets.some((s) => s.size < REPEATED_IDEAS_MIN_WORDS)) return false; // not enough content in one of them to judge fairly
  const pairs = [
    [sets[0], sets[1]],
    [sets[0], sets[2]],
    [sets[1], sets[2]],
  ];
  return pairs.every(([a, b]) => jaccardSimilarity(a, b) >= REPEATED_IDEAS_THRESHOLD);
}

function scoreExperienceFallback(text, keywords) {
  const words = text ? text.split(/\s+/).filter(Boolean).length : 0;
  const onTopic = mentionsTopic(text, keywords);
  const sub = {};

  // Relevance now requires BOTH enough length AND an actual mention of the
  // topic/picture - a long but completely off-topic answer no longer scores here.
  sub["Relevance"] = words >= 10 && onTopic ? 2 : (words >= 10 || onTopic) && words >= 3 ? 1 : 0;

  let whCount = 0;
  if (WHO_RE.test(text)) whCount++;
  if (WHEN_RE.test(text)) whCount++;
  if (WHERE_RE.test(text)) whCount++;
  if (WHY_RE.test(text)) whCount++;
  if (HOW_RE.test(text)) whCount++;
  if (WHAT_RE.test(text)) whCount++; // requires a concrete detail, not just length
  sub["5W1H Specificity"] = Math.min(6, whCount);

  // Authenticity now needs a real spread of WH-markers, not just "I" plus enough words.
  sub["Authenticity / Personal Voice"] = WHO_RE.test(text) && whCount >= 3 && words >= 15 ? 2 : WHO_RE.test(text) && whCount >= 2 ? 1 : 0;

  // Clarity now requires actual sequencing language - length alone no longer earns a point.
  const sequenceMatches = (text.match(new RegExp(SEQUENCE_RE, "gi")) || []).length;
  sub["Clarity & Sequence"] = sequenceMatches >= 1 ? 1 : 0;

  // Reflection now requires both the reflective language AND enough length to be a real reflection.
  sub["Reflection / Lesson Learnt"] = REFLECT_RE.test(text) && words >= 10 ? 1 : 0;

  const total = Object.values(sub).reduce((a, b) => a + b, 0);
  return { total: Math.min(12, total), sub };
}

// ---------- Language Use fallback (no AI key configured) ----------
// Crude, deterministic proxies only - never claims to be real grammar/vocab
// assessment, and says so in its own notes. Grammar uses basic punctuation/
// sentence-length signals; Vocabulary uses type-token ratio (distinct words
// / total words), a standard rough lexical-diversity measure; Fluency uses
// the filler-word density computed by countFillers().
function scoreLanguageFallback(text, fillerStats) {
  const trimmed = (text || "").trim();
  const words = trimmed ? trimmed.split(/\s+/).filter(Boolean) : [];
  const wordCount = words.length;
  const breakdown = [];

  const startsCapital = /^[A-Z]/.test(trimmed);
  const endsWithPunct = /[.!?]$/.test(trimmed);
  const sentenceCount = (trimmed.match(/[.!?]+/g) || []).length;
  const avgSentenceLen = sentenceCount > 0 ? wordCount / sentenceCount : wordCount;
  const grammarPts =
    wordCount >= 15 && startsCapital && endsWithPunct && avgSentenceLen <= 35
      ? 2
      : wordCount >= 8 && (startsCapital || endsWithPunct)
      ? 1
      : 0;
  breakdown.push({ part: "Grammar Accuracy", points: grammarPts, max: 2, note: "Estimated from punctuation and sentence-length patterns - not real grammar checking." });

  const lowerWords = words.map((w) => w.toLowerCase().replace(/[^a-z']/g, "")).filter(Boolean);
  const uniqueWords = new Set(lowerWords);
  const ttr = lowerWords.length > 0 ? uniqueWords.size / lowerWords.length : 0;
  const vocabPts = wordCount >= 15 && ttr >= 0.6 ? 2 : wordCount >= 5 && ttr >= 0.45 ? 1 : 0;
  breakdown.push({ part: "Vocabulary Range & Appropriateness", points: vocabPts, max: 2, note: "Estimated from word variety (distinct vs repeated words) - not real vocabulary assessment." });

  const fluencyPts = wordCount >= 5 && fillerStats.density < 0.05 ? 1 : 0;
  breakdown.push({
    part: "Fluency & Delivery",
    points: fluencyPts,
    max: 1,
    note: fillerStats.count > 0 ? `${fillerStats.count} filler word(s) detected (um/uh/like/etc.).` : "No filler words detected.",
  });

  const total = breakdown.reduce((sum, b) => sum + b.points, 0);
  return { total, breakdown };
}

function ruleBasedScoreTrees(parts, keywords) {
  let total = 0;
  const breakdown = [];
  for (const [key, label, max] of TREES_ORDER) {
    const text = (parts[key] || "").trim();
    const words = text ? text.split(/\s+/).filter(Boolean).length : 0;

    if (key === "E2") {
      const exp = scoreExperienceFallback(text, keywords);
      total += exp.total;
      breakdown.push({
        part: label,
        points: exp.total,
        max,
        note: words === 0 ? "This part is empty." : "Estimated with simple keyword checks (who/when/where/why/how) - not full AI marking.",
        subBreakdown: EXPERIENCE_SUB.map(([subLabel, subMax]) => ({ label: subLabel, points: exp.sub[subLabel] || 0, max: subMax })),
      });
      continue;
    }

    // Each part now needs content matching what it's actually meant to contain
    // (a thought, a reason, evidence, a suggestion) - word count alone is only
    // ever enough for partial credit, never full marks.
    let pts = 0;
    if (key === "T") {
      pts = THOUGHT_RE.test(text) && words >= 5 ? max : THOUGHT_RE.test(text) || words >= 8 ? Math.min(max, 1) : 0;
    } else if (key === "R") {
      pts = REASON_RE.test(text) && words >= 8 ? max : REASON_RE.test(text) || words >= 10 ? Math.min(max, 1) : 0;
    } else if (key === "E1") {
      const onTopic = mentionsTopic(text, keywords);
      pts = EVIDENCE_RE.test(text) && onTopic ? max : EVIDENCE_RE.test(text) || onTopic ? Math.min(max, 1) : 0;
    } else {
      pts = SUGGESTION_RE.test(text) && words >= 5 ? max : SUGGESTION_RE.test(text) ? Math.min(max, 1) : 0;
    }
    total += pts;
    breakdown.push({
      part: label,
      points: pts,
      max,
      note: words === 0 ? "This part is empty." : pts >= max ? "Clear, on-topic content." : "Estimated with simple keyword checks - not full AI marking.",
    });
  }
  return { total, breakdown };
}

function ruleBasedScoreSingle(text, keywords) {
  text = text || "";
  const words = text.trim() ? text.trim().split(/\s+/).filter(Boolean).length : 0;
  const onTopic = mentionsTopic(text, keywords);
  let total = 0;
  const breakdown = [];
  for (const [key, label, max] of TREES_ORDER) {
    if (key === "E2") {
      const exp = scoreExperienceFallback(text, keywords);
      total += exp.total;
      breakdown.push({
        part: label,
        points: exp.total,
        max,
        note: "Estimated from the combined answer using keyword checks - not full AI marking.",
        subBreakdown: EXPERIENCE_SUB.map(([subLabel, subMax]) => ({ label: subLabel, points: exp.sub[subLabel] || 0, max: subMax })),
      });
      continue;
    }
    const re = key === "T" ? THOUGHT_RE : key === "R" ? REASON_RE : key === "E1" ? EVIDENCE_RE : SUGGESTION_RE;
    let pts = 0;
    if (key === "E1") {
      // evidence in a combined answer should also actually reference the topic
      pts = re.test(text) && onTopic ? max : re.test(text) || onTopic ? Math.min(max, 1) : 0;
    } else if (re.test(text)) {
      pts = max;
    } else if (words >= 25) {
      // a long combined answer with no matching phrase at all gets minimal credit
      pts = Math.min(max, 1);
    }
    total += pts;
    breakdown.push({
      part: label,
      points: pts,
      max,
      note: "Estimated from the combined answer using keyword checks - not full AI marking.",
    });
  }
  return { total, breakdown };
}

function ruleBasedScore(mode, data, topic, fillerStats) {
  const keywords = topicKeywords(topic);
  const contentResult = mode === "single" ? ruleBasedScoreSingle(data.text, keywords) : ruleBasedScoreTrees(data.parts, keywords);
  const combinedText = mode === "single" ? data.text || "" : TREES_ORDER.map(([key]) => data.parts[key] || "").join(" ");
  const fillers = fillerStats || countFillers(combinedText);
  const lang = scoreLanguageFallback(combinedText, fillers);
  return {
    total: contentResult.total + lang.total,
    max: FULL_MAX_TOTAL,
    breakdown: [...contentResult.breakdown, ...lang.breakdown],
    feedback:
      "Automatic marking (no AI marker configured): scored with simple keyword/relevance/grammar-pattern checks, not real understanding. Ask your teacher to add an AI key for accurate marking.",
    suggestion: "Try adding a specific personal experience with who, what, when, where, why and how it ended, plus how you felt.",
    modelAnswer: "",
  };
}

// ---------- AI marking ----------
function extractJson(text) {
  const cleaned = text.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/, "");
  const parsed = JSON.parse(cleaned);
  if (!parsed || !Array.isArray(parsed.breakdown)) throw new Error("bad shape");
  return parsed;
}

function clampNumber(n, min, max) {
  const num = typeof n === "number" && isFinite(n) ? n : 0;
  return Math.min(max, Math.max(min, Math.round(num)));
}

// The AI is asked to self-report a "total", but models occasionally return a
// total that doesn't match the sum of their own breakdown, or sub-scores that
// exceed their stated max. Rather than trust the model's arithmetic, we
// re-derive every number from the breakdown it gave us, clamping each part
// to its rubric max. This also normalizes shape (missing/malformed parts,
// missing notes, etc.) so a slightly-off AI response can't crash rendering
// or silently distort a pupil's score.
function normalizeAiResult(raw, markedBy) {
  const rawBreakdown = Array.isArray(raw.breakdown) ? raw.breakdown : [];
  const normalized = [];
  let total = 0;
  for (const [key, label, max] of TREES_ORDER) {
    const part = rawBreakdown.find((b) => b && b.part === label) || {};
    if (key === "E2") {
      const rawSub = Array.isArray(part.subBreakdown) ? part.subBreakdown : [];
      const subBreakdown = EXPERIENCE_SUB.map(([subLabel, subMax]) => {
        const sub = rawSub.find((s) => s && s.label === subLabel) || {};
        return { label: subLabel, points: clampNumber(sub.points, 0, subMax), max: subMax };
      });
      const subTotal = subBreakdown.reduce((sum, s) => sum + s.points, 0);
      total += subTotal;
      normalized.push({
        part: label,
        points: subTotal,
        max,
        note: typeof part.note === "string" ? part.note.slice(0, 300) : "",
        subBreakdown,
      });
      continue;
    }
    const pts = clampNumber(part.points, 0, max);
    total += pts;
    normalized.push({
      part: label,
      points: pts,
      max,
      note: typeof part.note === "string" ? part.note.slice(0, 300) : "",
    });
  }
  for (const [, label, max] of LANGUAGE_ORDER) {
    const part = rawBreakdown.find((b) => b && b.part === label) || {};
    const pts = clampNumber(part.points, 0, max);
    total += pts;
    normalized.push({
      part: label,
      points: pts,
      max,
      note: typeof part.note === "string" ? part.note.slice(0, 300) : "",
    });
  }
  return {
    total,
    max: FULL_MAX_TOTAL,
    breakdown: normalized,
    feedback: typeof raw.feedback === "string" && raw.feedback.trim() ? raw.feedback.slice(0, 600) : "Marked - see the breakdown below for details.",
    suggestion: typeof raw.suggestion === "string" ? raw.suggestion.slice(0, 300) : "",
    modelAnswer: typeof raw.modelAnswer === "string" && raw.modelAnswer.trim() ? raw.modelAnswer.trim().slice(0, 900) : "",
    markedBy,
  };
}

function buildPrompts(topic, question, mode, data, rubricText, opts) {
  opts = opts || {};
  const imageAttached = !!opts.imageAttached;
  const imageDescription = (opts.imageDescription || "").trim();
  const fillerStats = opts.fillerStats || { count: 0, totalWords: 0, density: 0 };

  const modeInstruction =
    mode === "single"
      ? `The pupil's answer below is ONE continuous piece of spoken text - it is NOT split into labelled parts. Read it carefully and identify each TREES component (Thought, Reason, Evidence, Experience, Suggestion) wherever it appears in the text, even if the pupil blends parts together or states them out of order, then mark each part using the same rubric. If a component is genuinely absent from their answer, score that part 0.`
      : `The pupil's answer below IS already split into 5 labelled parts. Mark each part as given.`;

  // Evidence (E1) instructions vary depending on how much visual grounding
  // this specific call actually has - a text-only model has no way to
  // verify a picture claim, so it should never be scored as if it could.
  let visionInstruction;
  if (imageAttached) {
    visionInstruction = `An image of the picture stimulus is attached below the pupil's answer. Actually look at it. For the Evidence (E1) part, verify whether the pupil's claim accurately describes something really present in the picture - if it's vague, generic, or doesn't match what's actually shown, score E1 low even if it sounds fluent.`;
  } else if (imageDescription) {
    visionInstruction = `You cannot see the actual picture, but the teacher has provided this description of it: "${imageDescription}". Use this description (not guesswork) to judge the Evidence (E1) part - if the pupil's claim contradicts or ignores this description, score E1 low; if it aligns with specific details in it, score E1 well.`;
  } else {
    visionInstruction = `You cannot see the actual picture and no teacher description was provided for it. For the Evidence (E1) part, judge only on plausibility and specificity of the claim - award partial credit for a specific, plausible-sounding reference to the picture, but do not penalise for visual accuracy you have no way to verify.`;
  }

  const fillerInstruction =
    fillerStats.totalWords > 0
      ? `Filler-word check (already counted by the app, not your job to recount): the pupil's full answer contains ${fillerStats.count} filler word(s) (um/uh/erm/like/you know, etc.) out of ${fillerStats.totalWords} total words (${Math.round(fillerStats.density * 100)}% filler density). Note this is only as reliable as the speech-to-text transcript, which sometimes smooths over disfluencies - use it as one signal, not the only one, when scoring Fluency & Delivery.`
      : `The transcript was too short to meaningfully measure filler-word density - use your own judgement on Fluency & Delivery from the text alone.`;

  const system = `You are a supportive but honest Primary School English oral examiner in Singapore, marking a pupil's spoken response using the TREES framework (Thought, Reason, Evidence, Experience, Suggestion) plus a separate Language Use component.

Marking rubric (set by the teacher), out of ${FULL_MAX_TOTAL} marks total (${TREES_MAX_TOTAL} for TREES content + ${LANGUAGE_MAX_TOTAL} for Language Use):
${rubricText}

${modeInstruction}

${visionInstruction}

${fillerInstruction}

Be encouraging in tone, age-appropriate for a 9-12 year old. For the Experience part specifically, you MUST score and return the 5 sub-criteria (Relevance 0-2, 5W1H Specificity 0-6, Authenticity/Personal Voice 0-2, Clarity & Sequence 0-1, Reflection/Lesson Learnt 0-1) and their sum must equal the Experience "points" value. Do not reward length alone anywhere - reward specific, believable, relevant detail.
If the Experience answer lacks depth (vague on who/what/when/where, or reads as generic/memorised), say so plainly in the Experience part's "note" - name what was actually missing (e.g. "unclear where and when this happened, and who else was there") - and give 1-2 concrete example experiences the pupil could have shared instead, related to the topic, in the "suggestion" field.
Language Use is separate from content - judge Grammar Accuracy (0-2) and Vocabulary Range & Appropriateness (0-2) from the pupil's actual sentences (not from how interesting their ideas are), and Fluency & Delivery (0-1) mainly from the filler-word signal above and general smoothness of the transcript.
Give ONE concrete, actionable suggestion for improvement per weak part in that part's "note".
Also write "modelAnswer": a short rewritten version (roughly 60-120 words) of the pupil's OWN Experience answer (or their combined answer if in single mode) that keeps their real content/experience but fixes grammar, adds specific missing 5W1H detail, and reads more fluently - this shows the pupil what a stronger version of THEIR OWN answer could sound like, not a generic unrelated example.
Respond with ONLY valid JSON, no markdown fences, no preamble, no explanation before or after, matching exactly this shape:
{
  "breakdown": [
    { "part": "Thought", "points": 0, "max": 2, "note": "short comment, max 25 words" },
    { "part": "Reason", "points": 0, "max": 2, "note": "short comment, max 25 words" },
    { "part": "Evidence", "points": 0, "max": 2, "note": "short comment, max 25 words" },
    { "part": "Experience", "points": 0, "max": 12, "note": "short comment, max 25 words - name what was missing if depth was lacking",
      "subBreakdown": [
        { "label": "Relevance", "points": 0, "max": 2 },
        { "label": "5W1H Specificity", "points": 0, "max": 6 },
        { "label": "Authenticity / Personal Voice", "points": 0, "max": 2 },
        { "label": "Clarity & Sequence", "points": 0, "max": 1 },
        { "label": "Reflection / Lesson Learnt", "points": 0, "max": 1 }
      ]
    },
    { "part": "Suggestion", "points": 0, "max": 2, "note": "short comment, max 25 words" },
    { "part": "Grammar Accuracy", "points": 0, "max": 2, "note": "short comment, max 25 words" },
    { "part": "Vocabulary Range & Appropriateness", "points": 0, "max": 2, "note": "short comment, max 25 words" },
    { "part": "Fluency & Delivery", "points": 0, "max": 1, "note": "short comment, max 25 words" }
  ],
  "total": 0,
  "max": ${FULL_MAX_TOTAL},
  "feedback": "2-3 encouraging sentences summarising strengths and one thing to work on, max 60 words",
  "suggestion": "one concrete practical tip to improve their next experience answer - if depth was lacking, include 1-2 example experiences they could share instead, max 40 words",
  "modelAnswer": "a rewritten, stronger version of the pupil's own answer, roughly 60-120 words"
}`;

  const content =
    mode === "single"
      ? (data.text || "").trim() || "(left blank)"
      : TREES_ORDER.map(([key, label]) => `${label}: ${(data.parts[key] || "").trim() || "(left blank)"}`).join("\n");

  const user = `Topic: ${topic ? topic.title : "General"}
Examiner question: ${question || "Tell me about this topic."}

Pupil's answer (${mode === "single" ? "single combined response" : "TREES, split into parts"}):
${content}`;

  return { system, user };
}

// Fetches a topic's stimulus picture and base64-encodes it for a multimodal
// AI call. Used so the marker can actually verify Evidence (E1) claims
// against the real picture instead of guessing. Returns null on any failure
// (bad URL, non-image response, too large, network error) - callers must
// treat that as "no image available" and fall back to the teacher's text
// description (topic.imageDescription) if one was set.
async function fetchImageAsBase64(url) {
  if (!url) return null;
  try {
    const resp = await fetch(url, { headers: { accept: "image/*" } });
    if (!resp.ok) return null;
    const contentType = (resp.headers.get("content-type") || "").split(";")[0].trim();
    if (!contentType.startsWith("image/")) return null;
    const buf = await resp.arrayBuffer();
    if (buf.byteLength > 8 * 1024 * 1024) return null; // 8MB safety cap
    const bytes = new Uint8Array(buf);
    let binary = "";
    const chunkSize = 8192;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return { mimeType: contentType, base64: btoa(binary) };
  } catch (e) {
    return null;
  }
}

// ---------- Provider: Groq (2nd marker, https://console.groq.com) ----------
// ---------- Provider: Groq (https://console.groq.com) ----------
// Two API keys can be configured - env.GROQ_API_KEY and env.GROQ_API_KEY_2 -
// tried in that order, so a second account's free-tier quota is available
// if the first is exhausted or rate-limited. See aiScore for where both get
// queued as separate attempts.
async function callGroq(env, system, user, model, apiKey) {
  const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer " + apiKey,
    },
    body: JSON.stringify({
      // Model is teacher-configurable from Settings (config:model_groq in
      // the D1 config table), defaulting to DEFAULT_GROQ_MODEL if never set.
      // If Groq deprecates the default, update DEFAULT_GROQ_MODEL /
      // GROQ_MODEL_OPTIONS above (see console.groq.com/docs/deprecations).
      model: model || DEFAULT_GROQ_MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: { type: "json_object" },
      reasoning_effort: "low", // this task doesn't need heavy reasoning - keeps latency down
      temperature: 0.4,
    }),
  });
  if (!resp.ok) {
    const bodyText = await resp.text().catch(() => "");
    console.error("Groq API error", resp.status, bodyText.slice(0, 500));
    throw new Error("Groq API error " + resp.status);
  }
  const data = await resp.json();
  const text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!text) throw new Error("Groq: empty response");
  return extractJson(text);
}

// ---------- Provider: Google Gemini (https://aistudio.google.com/apikey) ----------
// Two API keys can be configured - env.GEMINI_API_KEY and
// env.GEMINI_API_KEY_2 - tried in that order, same reasoning as Groq/
// OpenRouter above: a second account's free-tier quota is available if the
// first is exhausted or rate-limited.
async function callGemini(env, system, user, image, apiKey) {
  const model = "gemini-2.5-flash"; // fast + cheap, generous free tier, multimodal
  const parts = [{ text: user }];
  if (image && image.base64) {
    parts.push({ inline_data: { mime_type: image.mimeType, data: image.base64 } });
  }
  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts }],
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0.4,
        },
      }),
    }
  );
  if (!resp.ok) {
    const bodyText = await resp.text().catch(() => "");
    console.error("Gemini API error", resp.status, bodyText.slice(0, 500));
    throw new Error("Gemini API error " + resp.status);
  }
  const data = await resp.json();
  const candidate = data.candidates && data.candidates[0];
  const respParts = candidate && candidate.content && candidate.content.parts;
  const text = respParts && respParts[0] && respParts[0].text;
  if (!text) throw new Error("Gemini: empty response");
  return extractJson(text);
}

// ---------- Provider: Cloudflare Workers AI (final AI-tier marker, free, built into this Worker) ----------
async function callWorkersAI(env, system, user) {
  const model = "@cf/meta/llama-3.3-70b-instruct-fp8-fast"; // confirmed active, not on Cloudflare's deprecation list as of Aug 2026
  let result;
  try {
    result = await env.AI.run(model, {
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: { type: "json_object" },
      temperature: 0.4,
    });
  } catch (e) {
    console.error("Workers AI call error", e && e.message);
    throw e;
  }
  const text = typeof result === "string" ? result : result.response;
  if (!text) throw new Error("Workers AI: empty response");
  return extractJson(text);
}

// ---------- Provider: OpenRouter (https://openrouter.ai) ----------
// Two API keys can be configured - env.OPENROUTER_API_KEY and
// env.OPENROUTER_API_KEY_2 - tried in that order, so a second account's
// free-tier quota is available if the first is exhausted or rate-limited.
// See aiScore for where both get queued as separate attempts.
async function callOpenRouter(env, system, user, model, apiKey) {
  const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer " + apiKey,
      // OpenRouter uses these two headers for attribution/leaderboard
      // purposes only - harmless if left as-is, but feel free to change
      // them to match your actual deployment URL / app name.
      "HTTP-Referer": "https://just-a-chit-chat.pages.dev",
      "X-Title": "Just a Chit-Chat",
    },
    body: JSON.stringify({
      // Model is teacher-configurable from Settings (config:model_openrouter),
      // defaulting to DEFAULT_OPENROUTER_MODEL if never set.
      model: model || DEFAULT_OPENROUTER_MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: { type: "json_object" },
      temperature: 0.4,
    }),
  });
  if (!resp.ok) {
    const bodyText = await resp.text().catch(() => "");
    console.error("OpenRouter API error", resp.status, bodyText.slice(0, 500));
    throw new Error("OpenRouter API error " + resp.status);
  }
  const data = await resp.json();
  const text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!text) throw new Error("OpenRouter: empty response");
  return extractJson(text);
}

// ---------- AI marking: 2x Gemini -> 2x Groq -> 2x OpenRouter -> Workers AI -> offline scorer ----------
// Every question is marked with the same chain, tried in this fixed order:
// both Gemini keys, then both Groq keys, then both OpenRouter keys, then
// Workers AI (single, no key). Any tier with no key/binding configured is
// skipped. If the whole chain fails once (e.g. transient rate-limiting), it
// is retried in full up to AI_MARKING_MAX_PASSES times, with a pause between
// passes, before that question falls back to the offline rule-based scorer
// - see aiScore. Questions themselves are marked one at a time (not in
// parallel, see the /api/submit handler) specifically to avoid bursting
// several simultaneous requests at the same provider/key, which is what
// tends to trigger rate limits in the first place.
const AI_MARKING_MAX_PASSES = 2; // how many times to retry the *entire* chain for one question before giving up to the offline scorer
const AI_ATTEMPT_PAUSE_MS = 350; // brief pause between individual provider attempts within a chain
const AI_PASS_RETRY_PAUSE_MS = 3000; // longer pause before retrying the whole chain again (gives transient rate-limits time to clear)

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function aiScore(env, topic, question, mode, data) {
  const storedRubric = await getConfig(env, "rubric");
  const rubricText = (storedRubric && storedRubric.trim()) || DEFAULT_RUBRIC;
  const storedGroqModel = await getConfig(env, "model_groq");
  const groqModel = (storedGroqModel && storedGroqModel.trim()) || DEFAULT_GROQ_MODEL;
  const storedOpenRouterModel = await getConfig(env, "model_openrouter");
  // Defense in depth: even though POST /api/teacher/model-openrouter already
  // rejects non-free models, re-validate here at call time too - if the
  // config table ever ends up with a non-free value some other way (e.g.
  // edited directly in D1), silently fall back to the safe free default
  // rather than ever actually calling a paid model.
  const candidateOpenRouterModel = (storedOpenRouterModel && storedOpenRouterModel.trim()) || DEFAULT_OPENROUTER_MODEL;
  const openRouterModel = isFreeOpenRouterModel(candidateOpenRouterModel) ? candidateOpenRouterModel : DEFAULT_OPENROUTER_MODEL;

  const combinedText = mode === "single" ? data.text || "" : TREES_ORDER.map(([key]) => data.parts[key] || "").join(" ");
  const fillerStats = countFillers(combinedText);
  const imageDescription = (topic && topic.imageDescription) || "";

  // Only Gemini is vision-capable. Fetch the picture once up front whenever
  // either Gemini key is configured - every other provider (Groq, Workers
  // AI, OpenRouter) uses the text-only prompt with the teacher's
  // imageDescription instead.
  let image = null;
  if ((env.GEMINI_API_KEY || env.GEMINI_API_KEY_2) && topic && topic.imageUrl) {
    image = await fetchImageAsBase64(topic.imageUrl);
  }
  const visionPrompts = buildPrompts(topic, question, mode, data, rubricText, { imageAttached: !!image, imageDescription, fillerStats });
  const textOnlyPrompts = image ? buildPrompts(topic, question, mode, data, rubricText, { imageAttached: false, imageDescription, fillerStats }) : visionPrompts;

  const attempts = [];
  if (env.GEMINI_API_KEY) attempts.push({ name: "gemini", run: () => callGemini(env, visionPrompts.system, visionPrompts.user, image, env.GEMINI_API_KEY) });
  if (env.GEMINI_API_KEY_2) attempts.push({ name: "gemini", run: () => callGemini(env, visionPrompts.system, visionPrompts.user, image, env.GEMINI_API_KEY_2) });
  if (env.GROQ_API_KEY) attempts.push({ name: "groq", run: () => callGroq(env, textOnlyPrompts.system, textOnlyPrompts.user, groqModel, env.GROQ_API_KEY) });
  if (env.GROQ_API_KEY_2) attempts.push({ name: "groq", run: () => callGroq(env, textOnlyPrompts.system, textOnlyPrompts.user, groqModel, env.GROQ_API_KEY_2) });
  if (env.OPENROUTER_API_KEY) attempts.push({ name: "openrouter", run: () => callOpenRouter(env, textOnlyPrompts.system, textOnlyPrompts.user, openRouterModel, env.OPENROUTER_API_KEY) });
  if (env.OPENROUTER_API_KEY_2) attempts.push({ name: "openrouter", run: () => callOpenRouter(env, textOnlyPrompts.system, textOnlyPrompts.user, openRouterModel, env.OPENROUTER_API_KEY_2) });
  if (env.AI) attempts.push({ name: "workers-ai", run: () => callWorkersAI(env, textOnlyPrompts.system, textOnlyPrompts.user) });

  for (let pass = 1; pass <= AI_MARKING_MAX_PASSES; pass++) {
    for (let i = 0; i < attempts.length; i++) {
      try {
        const raw = await attempts[i].run();
        return normalizeAiResult(raw, attempts[i].name);
      } catch (e) {
        // this attempt failed or errored - pause briefly (spreads out load
        // on whichever provider/key is next) then try the next one
        if (i < attempts.length - 1) await sleep(AI_ATTEMPT_PAUSE_MS);
      }
    }
    // Every attempt in this pass failed. If this wasn't the last allowed
    // pass, wait longer (transient rate-limits are the most likely cause)
    // and run through the entire chain again from the top before giving up.
    if (pass < AI_MARKING_MAX_PASSES) await sleep(AI_PASS_RETRY_PAUSE_MS);
  }

  return { ...ruleBasedScore(mode, data, topic, fillerStats), markedBy: "fallback" };
}

// ---------- Submissions: scope + filter + sort (D1) ----------
// Shared by GET /api/teacher/submissions and the CSV export, so both honour
// the same class/topic/archived scoping and the same sort order - expressed
// as real SQL now instead of a full KV scan + in-memory filter/sort. A
// scoped teacher-admin's WHERE clause is built from their assignedClasses,
// so out-of-scope rows are never even read out of D1.
function rowToSubmission(row) {
  return {
    id: row.id,
    pupilName: row.pupil_name,
    pupilClass: row.pupil_class,
    topicId: row.topic_id,
    topicTitle: row.topic_title,
    mode: row.mode,
    rounds: JSON.parse(row.rounds || "[]"),
    finalScore: row.final_score,
    maxScore: row.max_score,
    flagged: !!row.flagged,
    practice: !!row.practice,
    gradingDegraded: !!row.grading_degraded,
    repeatedIdeasPenalty: !!row.repeated_ideas_penalty,
    archived: !!row.archived,
    createdAt: row.created_at,
  };
}

function buildSubmissionsFilter(session, url) {
  const classParam = (url.searchParams.get("class") || "").trim();
  const topicParam = (url.searchParams.get("topic") || "").trim();
  const archivedParam = (url.searchParams.get("archived") || "active").trim().toLowerCase(); // active|archived|all
  const sortParam = (url.searchParams.get("sort") || "newest").trim().toLowerCase();

  const where = [];
  const params = [];

  if (!session.isSuperAdmin) {
    const classes = (session.assignedClasses || []).map((c) => String(c).toLowerCase());
    if (!classes.length) {
      where.push("1 = 0"); // no assigned classes -> sees nothing, rather than accidentally matching everything
    } else {
      where.push(`LOWER(pupil_class) IN (${classes.map(() => "?").join(",")})`);
      params.push(...classes);
    }
  }
  if (classParam) {
    where.push("LOWER(pupil_class) = LOWER(?)");
    params.push(classParam);
  }
  if (topicParam) {
    where.push("LOWER(topic_title) = LOWER(?)");
    params.push(topicParam);
  }
  if (archivedParam === "archived") where.push("archived = 1");
  else if (archivedParam !== "all") where.push("archived = 0"); // default "active"

  const sortMap = {
    newest: "created_at DESC",
    oldest: "created_at ASC",
    class: "pupil_class ASC, pupil_name ASC, created_at DESC",
    topic: "topic_title ASC, created_at DESC",
    score_desc: "final_score DESC, created_at DESC",
    score_asc: "final_score ASC, created_at DESC",
  };
  const orderBy = sortMap[sortParam] || sortMap.newest;
  const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
  return { whereSql, params, orderBy };
}

async function countFilteredSubmissions(env, session, url) {
  const { whereSql, params } = buildSubmissionsFilter(session, url);
  const row = await env.CCv6_DB.prepare(`SELECT COUNT(*) as c FROM submissions ${whereSql}`).bind(...params).first();
  return row ? row.c : 0;
}

// opts.limit/opts.offset are optional - omit for the full filtered set (used
// by CSV export), provide for one page (used by the Submissions tab).
async function queryFilteredSubmissions(env, session, url, opts) {
  const { whereSql, params, orderBy } = buildSubmissionsFilter(session, url);
  let sql = `SELECT * FROM submissions ${whereSql} ORDER BY ${orderBy}`;
  const bindParams = params.slice();
  if (opts && Number.isFinite(opts.limit)) {
    sql += " LIMIT ? OFFSET ?";
    bindParams.push(opts.limit, opts.offset || 0);
  }
  const { results } = await env.CCv6_DB.prepare(sql).bind(...bindParams).all();
  return results.map(rowToSubmission);
}

// ---------- Router ----------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "content-type,authorization",
          "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
        },
      });
    }

    await ensureSeeded(env);

    if (pathname === "/" || pathname === "/index.html") {
      return new Response(PAGE_HTML, { headers: { "content-type": "text/html;charset=UTF-8" } });
    }

    if (!pathname.startsWith("/api/")) {
      return new Response("Not found", { status: 404 });
    }

    try {
      // ---------- AUTH ----------
      if (pathname === "/api/login" && request.method === "POST") {
        const body = await request.json();
        let raw = (body.name || "").trim();
        if (!raw) return badRequest("Please enter a name.");
        if (raw.length > 60) raw = raw.slice(0, 60);

        // Optional "Name@Class" syntax, e.g. "Jovan@5IG" -> name "Jovan",
        // class "5IG". This is how pupils are tracked and grouped for the
        // teacher's per-pupil history/progress view - see /api/teacher/pupils.
        let name = raw;
        let pupilClass = "";
        const atIdx = raw.indexOf("@");
        if (atIdx > 0 && atIdx < raw.length - 1) {
          name = raw.slice(0, atIdx).trim();
          pupilClass = raw.slice(atIdx + 1).trim();
        }
        if (name.length > 40) name = name.slice(0, 40);
        if (pupilClass.length > 20) pupilClass = pupilClass.slice(0, 20);
        name = scanVulgarity(name).clean;
        pupilClass = scanVulgarity(pupilClass).clean;
        // Keep class names to a safe, predictable charset rather than
        // letting arbitrary punctuation in.
        pupilClass = pupilClass.replace(/[^a-zA-Z0-9 _-]/g, "").trim();

        if (!name) return badRequest("Please enter a name.");
        const lname = name.toLowerCase();
        if (lname === TEACHER_USERNAME || (await getTeacherAdmin(env, lname))) {
          // Teacher / teacher-admin path requires a password on a second step;
          // issue a "pending" marker only, echoing back which username to use
          // in that second step (so a scoped teacher-admin's own username
          // round-trips through the login form correctly).
          return json({ requiresTeacherPassword: true, username: lname });
        }

        const pupilClassKey = pupilClass || "unassigned";
        const token = uid();
        await env.CCv6_DATA.put(
          `session:${token}`,
          JSON.stringify({ name, pupilClass: pupilClassKey, role: "pupil", createdAt: Date.now() }),
          { expirationTtl: 60 * 60 * 6 }
        );
        return json({ token, name, pupilClass: pupilClassKey, role: "pupil" });
      }

      if (pathname === "/api/teacher/login" && request.method === "POST") {
        const body = await request.json();
        const username = (body.username || "").trim().toLowerCase();
        const password = body.password || "";

        let name, isSuperAdmin, assignedClasses;
        if (username === TEACHER_USERNAME) {
          const verdict = await verifyTeacherPassword(env, password);
          if (verdict.unset) {
            return json(
              { error: "No teacher password has been set up yet. Ask an admin to run: wrangler d1 execute chitchat-v7 --remote --command=\"INSERT INTO config (key,value) VALUES ('teacher_password','yourPassword')\" (or use the Cloudflare dashboard's D1 console)" },
              500
            );
          }
          if (!verdict.ok) return json({ error: "Incorrect password." }, 403);
          name = "Teacher";
          isSuperAdmin = true;
          assignedClasses = null;
        } else {
          const record = await getTeacherAdmin(env, username);
          if (!record) return json({ error: "Not authorised." }, 403);
          const ok = await verifyTeacherAdminPassword(record, password);
          if (!ok) return json({ error: "Incorrect password." }, 403);
          name = record.username;
          isSuperAdmin = false;
          assignedClasses = record.classes || [];
        }

        const token = uid();
        await env.CCv6_DATA.put(
          `session:${token}`,
          JSON.stringify({ name, role: "teacher", isSuperAdmin, assignedClasses, createdAt: Date.now() }),
          { expirationTtl: 60 * 60 * 6 }
        );
        return json({ token, name, role: "teacher", isSuperAdmin, assignedClasses });
      }

      // ---------- TOPICS ----------
      if (pathname === "/api/topics" && request.method === "GET") {
        const { results } = await env.CCv6_DB.prepare("SELECT * FROM topics ORDER BY created_at ASC, rowid ASC").all();
        return json({ topics: results.map(rowToTopic) });
      }

      // ---------- SUBMIT ----------
      if (pathname === "/api/submit" && request.method === "POST") {
        const session = await getSession(request, env);
        if (!session || session.role !== "pupil") return json({ error: "Please log in first." }, 401);

        const body = await request.json();
        const { topicId, answers } = body;
        // Which questions the pupil opened the NPC Coach for, before
        // submitting (see /api/topics coach content). This is recorded for
        // the teacher but deliberately never told to the pupil - see
        // requireTeacher-gated endpoints for where it's surfaced.
        const coachUsedIn = Array.isArray(body.coachUsed) ? body.coachUsed : [];
        const mode = body.mode === "single" ? "single" : "trees";
        const practice = !!body.practice;
        if (!topicId || !Array.isArray(answers) || answers.length !== 3) {
          return badRequest("Expected a topic and exactly 3 answers.");
        }

        const topicRow = await env.CCv6_DB.prepare("SELECT * FROM topics WHERE id = ?").bind(topicId).first();
        const topic = topicRow ? rowToTopic(topicRow) : null;
        const questions = (topic && topic.questions) || [];

        // Prepare all 3 rounds' cleaned input first (vulgarity scanning is
        // synchronous), then fire all 3 AI marking calls together instead of
        // one-at-a-time - this is the slow part of a submission (each call
        // can take a couple of seconds), so awaiting them in parallel cuts
        // total marking latency roughly 3x.
        const roundInputs = [];
        let anyFlagTotal = false;
        for (let i = 0; i < 3; i++) {
          const question = questions[i] || "Tell me about this topic.";
          const rawAnswer = answers[i] || {};
          let cleanedData, anyFlag, answerForRecord;

          if (mode === "single") {
            const scanResult = scanVulgarity(rawAnswer.text || "");
            cleanedData = { text: scanResult.clean };
            anyFlag = scanResult.flagged;
            answerForRecord = { text: scanResult.clean };
          } else {
            const scanResult = scanAllParts(rawAnswer.parts || {});
            cleanedData = { parts: scanResult.cleaned };
            anyFlag = scanResult.anyFlag;
            answerForRecord = { parts: scanResult.cleaned };
          }
          if (anyFlag) anyFlagTotal = true;
          roundInputs.push({ question, cleanedData, anyFlag, answerForRecord });
        }

        // Mark each question one at a time (not Promise.all) - marking all 3
        // questions concurrently means up to 3x the simultaneous requests
        // hitting the same provider/key, which is exactly what tends to
        // trigger rate limits. A short pause between questions spaces the
        // load out further still. See aiScore for the per-question retry
        // logic that adds further resilience against transient rate-limits.
        const results = [];
        for (let i = 0; i < roundInputs.length; i++) {
          results.push(await aiScore(env, topic, roundInputs[i].question, mode, roundInputs[i].cleanedData));
          if (i < roundInputs.length - 1) await sleep(AI_ATTEMPT_PAUSE_MS);
        }

        let scoreSum = 0;
        let anyFallback = false;
        const rounds = roundInputs.map((ri, i) => {
          const result = results[i];
          scoreSum += result.total;
          if (result.markedBy === "fallback") anyFallback = true;
          return {
            question: ri.question,
            mode,
            answer: ri.answerForRecord,
            score: result.total,
            max: result.max,
            breakdown: result.breakdown,
            feedback: result.feedback,
            suggestion: result.suggestion,
            modelAnswer: result.modelAnswer || "",
            flagged: ri.anyFlag,
            markedBy: result.markedBy,
            // teacher-only - stripped out of the response sent back to the
            // pupil below, and never mentioned in the pupil-facing UI
            coachUsed: !!coachUsedIn[i],
          };
        });

        const finalScoreRaw = Math.round((scoreSum / 3) * 10) / 10; // average, 1 decimal place
        const repeatedIdeas = detectRepeatedIdeas(rounds.map((r) => extractRoundText(r.answer)));
        const finalScore = repeatedIdeas ? Math.max(0, Math.round((finalScoreRaw - REPEATED_IDEAS_PENALTY) * 10) / 10) : finalScoreRaw;

        const id = uid();
        const pupilClass = session.pupilClass || "unassigned";
        const record = {
          id,
          pupilName: session.name,
          pupilClass,
          topicId,
          topicTitle: topic ? topic.title : "Unknown",
          mode,
          rounds,
          finalScore,
          maxScore: FULL_MAX_TOTAL,
          flagged: anyFlagTotal,
          practice,
          // true when at least one of the 3 questions fell all the way back
          // to the offline keyword scorer (all AI providers unavailable) -
          // this is much less rigorous than real AI marking, so a
          // non-practice attempt in this state is kept out of the
          // leaderboard rather than silently rewarding a marking outage.
          gradingDegraded: anyFallback,
          repeatedIdeasPenalty: repeatedIdeas,
          archived: false, // v7 bulk archive - Teacher Tools > Submissions
          createdAt: Date.now(),
        };
        await env.CCv6_DB
          .prepare(
            `INSERT INTO submissions (id, pupil_name, pupil_class, topic_id, topic_title, mode, rounds, final_score, max_score, practice, grading_degraded, repeated_ideas_penalty, archived, flagged, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
          )
          .bind(
            id,
            record.pupilName,
            record.pupilClass,
            record.topicId,
            record.topicTitle,
            record.mode,
            JSON.stringify(record.rounds),
            record.finalScore,
            record.maxScore,
            record.practice ? 1 : 0,
            record.gradingDegraded ? 1 : 0,
            record.repeatedIdeasPenalty ? 1 : 0,
            record.flagged ? 1 : 0,
            record.createdAt
          )
          .run();

        const countsForLeaderboard = !practice && !anyFallback;
        if (countsForLeaderboard) {
          // update pupil aggregate (leaderboard) - practice attempts, and
          // attempts marked entirely offline, never count
          const pupilRow = await env.CCv6_DB
            .prepare(
              `INSERT INTO pupils (name, pupil_class, best_score, total_score, attempts)
               VALUES (?, ?, ?, ?, 1)
               ON CONFLICT(name, pupil_class) DO UPDATE SET
                 attempts = attempts + 1,
                 total_score = total_score + ?,
                 best_score = MAX(best_score, ?)
               RETURNING id`
            )
            .bind(session.name, pupilClass, finalScore, finalScore, finalScore, finalScore)
            .first();

          // Progress history - used to compute trend and per-criterion
          // strengths/concerns in Teacher Tools -> Pupils (most recent
          // PUPIL_HISTORY_CAP attempts, see loadPupilHistory). Practice/
          // degraded attempts are excluded for the same reason they don't
          // count toward the leaderboard: they're not a reliable signal of
          // the pupil's actual ability.
          await pushPupilHistory(env, pupilRow.id, {
            timestamp: Date.now(),
            topicId,
            topicTitle: topic ? topic.title : "Unknown",
            finalScore,
            maxScore: FULL_MAX_TOTAL,
            breakdown: averageRoundBreakdown(rounds),
          });
        }

        let warning = null;
        if (anyFlagTotal && anyFallback) {
          warning = "Some words were filtered out, and AI marking wasn't available for at least one question so this attempt won't count on the leaderboard.";
        } else if (anyFlagTotal) {
          warning = "Some words were filtered out. Please keep your answers respectful.";
        } else if (anyFallback) {
          warning = "AI marking wasn't available for at least one question, so this attempt was scored with a simple offline check and won't count on the leaderboard.";
        }
        if (repeatedIdeas) {
          const penaltyNote = `A ${REPEATED_IDEAS_PENALTY}-point penalty was applied because your three answers reused largely the same idea/story - try to use a different example or experience for each question next time.`;
          warning = warning ? `${warning} ${penaltyNote}` : penaltyNote;
        }

        // `record` (with coachUsed per round) is what's stored in KV and
        // shown to the teacher. The pupil only ever sees `pupilRecord`,
        // which has coachUsed stripped out - pupils are not told that
        // opening the NPC Coach is tracked.
        const pupilRecord = {
          ...record,
          rounds: record.rounds.map((r) => {
            const { coachUsed, ...rest } = r;
            return rest;
          }),
        };
        return json({ record: pupilRecord, warning });
      }

      // ---------- LEADERBOARD ----------
      if (pathname === "/api/leaderboard" && request.method === "GET") {
        // Pupil names + scores are only for people who are actually in the
        // class session - this must not be reachable by anyone who just has
        // the .workers.dev URL.
        const session = await getSession(request, env);
        if (!session) return json({ error: "Please log in first." }, 401);

        // A scoped teacher-admin only ever sees pupils in their own assigned
        // classes here, regardless of ?class=. Everyone else (pupils, and
        // palpatine) can optionally narrow with ?class= (used by the Teacher
        // Tools > Leaderboard class filter).
        const where = [];
        const params = [];
        if (session.role === "teacher" && !session.isSuperAdmin) {
          const classes = (session.assignedClasses || []).map((c) => String(c).toLowerCase());
          if (!classes.length) return json({ leaderboard: [] });
          where.push(`LOWER(pupil_class) IN (${classes.map(() => "?").join(",")})`);
          params.push(...classes);
        } else {
          const classParam = (url.searchParams.get("class") || "").trim();
          if (classParam) {
            where.push("LOWER(pupil_class) = LOWER(?)");
            params.push(classParam);
          }
        }
        const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
        const { results } = await env.CCv6_DB
          .prepare(`SELECT * FROM pupils ${whereSql} ORDER BY best_score DESC, total_score DESC LIMIT 50`)
          .bind(...params)
          .all();
        return json({ leaderboard: results.map(rowToPupil) });
      }

      // =========== TEACHER-ONLY ROUTES BELOW ===========
      const session = await getSession(request, env);

      if (pathname === "/api/teacher/submissions" && request.method === "GET") {
        if (!requireTeacher(session)) return json({ error: "Not authorised." }, 403);
        const limitParam = parseInt(url.searchParams.get("limit"), 10);
        const offsetParam = parseInt(url.searchParams.get("offset"), 10);
        const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 200) : 50;
        const offset = Number.isFinite(offsetParam) && offsetParam >= 0 ? offsetParam : 0;

        const total = await countFilteredSubmissions(env, session, url);
        const page = await queryFilteredSubmissions(env, session, url, { limit, offset });
        return json({ submissions: page, total, offset, limit, hasMore: offset + limit < total });
      }

      if (pathname === "/api/teacher/submissions/export" && request.method === "GET") {
        if (!requireTeacher(session)) return json({ error: "Not authorised." }, 403);
        // Exports whatever's currently in scope/filtered (class/topic/archived
        // query params, same as the Submissions tab) so a teacher-admin's CSV
        // only ever contains their own classes, and "Export CSV" while a
        // filter is active exports just that filtered view.
        const filteredSubs = await queryFilteredSubmissions(env, session, url);
        const rows = [];
        rows.push(
          [
            "id",
            "pupilName",
            "pupilClass",
            "topicTitle",
            "mode",
            "practice",
            "finalScore",
            "maxScore",
            "flagged",
            "gradingDegraded",
            "repeatedIdeasPenalty",
            "archived",
            "createdAt",
            "Q1_question",
            "Q1_answer",
            "Q1_score",
            "Q1_coachUsed",
            "Q2_question",
            "Q2_answer",
            "Q2_score",
            "Q2_coachUsed",
            "Q3_question",
            "Q3_answer",
            "Q3_score",
            "Q3_coachUsed",
          ]
            .map(csvEscape)
            .join(",")
        );
        for (const s of filteredSubs) {
          const rounds = s.rounds || [];
          const roundCols = [];
          for (let i = 0; i < 3; i++) {
            const r = rounds[i];
            if (!r) {
              roundCols.push("", "", "", "");
              continue;
            }
            const answerText =
              r.mode === "single"
                ? (r.answer && r.answer.text) || ""
                : ["T", "R", "E1", "E2", "S"]
                    .map((k) => (r.answer && r.answer.parts && r.answer.parts[k]) || "")
                    .join(" | ");
            roundCols.push(r.question || "", answerText, r.score, r.coachUsed ? "yes" : "no");
          }
          rows.push(
            [
              s.id,
              s.pupilName,
              s.pupilClass || "unassigned",
              s.topicTitle,
              s.mode,
              s.practice ? "yes" : "no",
              s.finalScore,
              s.maxScore,
              s.flagged ? "yes" : "no",
              s.gradingDegraded ? "yes" : "no",
              s.repeatedIdeasPenalty ? "yes" : "no",
              s.archived ? "yes" : "no",
              new Date(s.createdAt).toISOString(),
              ...roundCols,
            ]
              .map(csvEscape)
              .join(",")
          );
        }
        const csv = rows.join("\r\n");
        return new Response(csv, {
          status: 200,
          headers: {
            "content-type": "text/csv;charset=UTF-8",
            "content-disposition": 'attachment; filename="just-a-chit-chat-submissions.csv"',
            "access-control-allow-origin": "*",
          },
        });
      }

      if (pathname === "/api/teacher/rubric" && request.method === "GET") {
        if (!requireSuperAdmin(session)) return json({ error: "Not authorised." }, 403);
        const stored = await getConfig(env, "rubric");
        return json({ rubric: stored || DEFAULT_RUBRIC, isDefault: !stored });
      }

      if (pathname === "/api/teacher/rubric" && request.method === "POST") {
        if (!requireSuperAdmin(session)) return json({ error: "Not authorised." }, 403);
        const body = await request.json();
        const rubric = (body.rubric || "").trim();
        if (!rubric) {
          await deleteConfig(env, "rubric"); // reset to default
          return json({ ok: true, rubric: DEFAULT_RUBRIC, isDefault: true });
        }
        await setConfig(env, "rubric", rubric);
        return json({ ok: true, rubric, isDefault: false });
      }

      if (pathname === "/api/teacher/model-groq" && request.method === "GET") {
        if (!requireSuperAdmin(session)) return json({ error: "Not authorised." }, 403);
        const stored = await getConfig(env, "model_groq");
        return json({ model: stored || DEFAULT_GROQ_MODEL, isDefault: !stored, options: GROQ_MODEL_OPTIONS });
      }

      if (pathname === "/api/teacher/model-groq" && request.method === "POST") {
        if (!requireSuperAdmin(session)) return json({ error: "Not authorised." }, 403);
        const body = await request.json();
        const model = (body.model || "").trim();
        if (!model) {
          await deleteConfig(env, "model_groq"); // reset to default
          return json({ ok: true, model: DEFAULT_GROQ_MODEL, isDefault: true });
        }
        await setConfig(env, "model_groq", model);
        return json({ ok: true, model, isDefault: false });
      }

      if (pathname === "/api/teacher/model-openrouter" && request.method === "GET") {
        if (!requireSuperAdmin(session)) return json({ error: "Not authorised." }, 403);
        const stored = await getConfig(env, "model_openrouter");
        return json({ model: stored || DEFAULT_OPENROUTER_MODEL, isDefault: !stored, options: OPENROUTER_MODEL_OPTIONS });
      }

      if (pathname === "/api/teacher/model-openrouter" && request.method === "POST") {
        if (!requireSuperAdmin(session)) return json({ error: "Not authorised." }, 403);
        const body = await request.json();
        const model = (body.model || "").trim();
        if (!model) {
          await deleteConfig(env, "model_openrouter"); // reset to default
          return json({ ok: true, model: DEFAULT_OPENROUTER_MODEL, isDefault: true });
        }
        // OpenRouter is a shared fallback tier for every question - only
        // free models (":free" suffix, or the "openrouter/free" auto-router)
        // are ever allowed here, so this can't silently start running up a
        // bill. See isFreeOpenRouterModel.
        if (!isFreeOpenRouterModel(model)) {
          return badRequest('Only free OpenRouter models are allowed here - the model ID must end in ":free" (e.g. meta-llama/llama-3.3-70b-instruct:free), or be "openrouter/free" (OpenRouter\'s free-model auto-router). See openrouter.ai/models?max_price=0 for the current free-tier list.');
        }
        await setConfig(env, "model_openrouter", model);
        return json({ ok: true, model, isDefault: false });
      }

      if (pathname === "/api/teacher/submissions/archive" && request.method === "POST") {
        if (!requireTeacher(session)) return json({ error: "Not authorised." }, 403);
        const body = await request.json();
        const ids = Array.isArray(body.ids) ? body.ids.slice(0, 500) : [];
        const archived = !!body.archived;
        let updated = 0;
        for (const id of ids) {
          const row = await env.CCv6_DB.prepare("SELECT pupil_class FROM submissions WHERE id = ?").bind(id).first();
          if (!row) continue;
          if (!classAllowed(session, row.pupil_class)) continue; // silently skip out-of-scope ids rather than 403ing a whole bulk request
          await env.CCv6_DB.prepare("UPDATE submissions SET archived = ? WHERE id = ?").bind(archived ? 1 : 0, id).run();
          updated++;
        }
        return json({ ok: true, updated, archived });
      }

      if (pathname.startsWith("/api/teacher/submissions/") && request.method === "DELETE") {
        if (!requireTeacher(session)) return json({ error: "Not authorised." }, 403);
        const id = pathname.split("/").pop();
        const row = await env.CCv6_DB.prepare("SELECT pupil_class FROM submissions WHERE id = ?").bind(id).first();
        if (row && !classAllowed(session, row.pupil_class)) return json({ error: "Not authorised for this pupil's class." }, 403);
        await env.CCv6_DB.prepare("DELETE FROM submissions WHERE id = ?").bind(id).run();
        return json({ ok: true });
      }

      if (pathname.startsWith("/api/teacher/submissions/") && request.method === "PUT") {
        if (!requireTeacher(session)) return json({ error: "Not authorised." }, 403);
        const id = pathname.split("/").pop();
        const existingRow = await env.CCv6_DB.prepare("SELECT * FROM submissions WHERE id = ?").bind(id).first();
        if (!existingRow) return json({ error: "Not found." }, 404);
        if (!classAllowed(session, existingRow.pupil_class)) return json({ error: "Not authorised for this pupil's class." }, 403);
        const body = await request.json();
        const existing = rowToSubmission(existingRow);
        const updated = { ...existing, ...body, id };
        await env.CCv6_DB
          .prepare(
            `UPDATE submissions SET pupil_name=?, pupil_class=?, topic_id=?, topic_title=?, mode=?, rounds=?, final_score=?, max_score=?, practice=?, grading_degraded=?, repeated_ideas_penalty=?, archived=?, flagged=? WHERE id=?`
          )
          .bind(
            updated.pupilName,
            updated.pupilClass,
            updated.topicId,
            updated.topicTitle,
            updated.mode,
            JSON.stringify(updated.rounds),
            updated.finalScore,
            updated.maxScore,
            updated.practice ? 1 : 0,
            updated.gradingDegraded ? 1 : 0,
            updated.repeatedIdeasPenalty ? 1 : 0,
            updated.archived ? 1 : 0,
            updated.flagged ? 1 : 0,
            id
          )
          .run();
        return json({ record: updated });
      }

      if (pathname === "/api/teacher/leaderboard/reset" && request.method === "POST") {
        if (!requireTeacher(session)) return json({ error: "Not authorised." }, 403);
        const body = await request.json().catch(() => ({}));
        if (body.name) {
          const cls = body.pupilClass || "unassigned";
          if (!classAllowed(session, cls)) return json({ error: "Not authorised for this pupil's class." }, 403);
          const pupilRow = await env.CCv6_DB.prepare("SELECT id FROM pupils WHERE name = ? AND pupil_class = ?").bind(body.name, cls).first();
          if (pupilRow) {
            await env.CCv6_DB.prepare("DELETE FROM pupil_history WHERE pupil_id = ?").bind(pupilRow.id).run();
            await env.CCv6_DB.prepare("DELETE FROM pupils WHERE id = ?").bind(pupilRow.id).run();
          }
        } else {
          // "Reset all" only resets pupils within this session's scope - a
          // scoped teacher-admin can never wipe another class's leaderboard.
          let where = "";
          const params = [];
          if (!session.isSuperAdmin) {
            const classes = (session.assignedClasses || []).map((c) => String(c).toLowerCase());
            if (!classes.length) return json({ ok: true });
            where = `WHERE LOWER(pupil_class) IN (${classes.map(() => "?").join(",")})`;
            params.push(...classes);
          }
          const { results: pupilRows } = await env.CCv6_DB.prepare(`SELECT id FROM pupils ${where}`).bind(...params).all();
          for (const p of pupilRows) {
            await env.CCv6_DB.prepare("DELETE FROM pupil_history WHERE pupil_id = ?").bind(p.id).run();
          }
          await env.CCv6_DB.prepare(`DELETE FROM pupils ${where}`).bind(...params).run();
        }
        return json({ ok: true });
      }

      // ---------- PUPIL TRACKING ----------
      if (pathname === "/api/teacher/pupils" && request.method === "GET") {
        if (!requireTeacher(session)) return json({ error: "Not authorised." }, 403);
        const where = [];
        const params = [];
        if (!session.isSuperAdmin) {
          const classes = (session.assignedClasses || []).map((c) => String(c).toLowerCase());
          if (!classes.length) return json({ pupils: [] });
          where.push(`LOWER(pupil_class) IN (${classes.map(() => "?").join(",")})`);
          params.push(...classes);
        }
        const classParam = (url.searchParams.get("class") || "").trim();
        if (classParam) {
          where.push("LOWER(pupil_class) = LOWER(?)");
          params.push(classParam);
        }
        const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
        const { results } = await env.CCv6_DB.prepare(`SELECT * FROM pupils ${whereSql} ORDER BY pupil_class, name`).bind(...params).all();
        return json({ pupils: results.map(rowToPupil) });
      }

      // Distinct class names this session may see - powers the Class filter
      // dropdowns on Leaderboard/Submissions/Pupils.
      if (pathname === "/api/teacher/classes" && request.method === "GET") {
        if (!requireTeacher(session)) return json({ error: "Not authorised." }, 403);
        if (session.isSuperAdmin) {
          return json({ classes: await getAllKnownClasses(env) });
        }
        return json({ classes: (session.assignedClasses || []).slice().sort((a, b) => a.localeCompare(b)) });
      }

      if (pathname === "/api/teacher/pupil" && request.method === "GET") {
        if (!requireTeacher(session)) return json({ error: "Not authorised." }, 403);
        const name = (url.searchParams.get("name") || "").trim();
        const pupilClass = (url.searchParams.get("class") || "unassigned").trim();
        if (!name) return badRequest("Missing pupil name.");
        if (!classAllowed(session, pupilClass)) return json({ error: "Not authorised for this pupil's class." }, 403);
        const pupilRow = await env.CCv6_DB.prepare("SELECT * FROM pupils WHERE name = ? AND pupil_class = ?").bind(name, pupilClass).first();
        const pupil = pupilRow ? rowToPupil(pupilRow) : { name, pupilClass, bestScore: 0, totalScore: 0, attempts: 0 };
        const history = pupilRow ? await loadPupilHistory(env, pupilRow.id) : [];
        const { strengths, concerns, rows } = computeStrengthsConcerns(history);
        return json({ pupil, history, strengths, concerns, rows });
      }

      if (pathname === "/api/teacher/topics" && request.method === "POST") {
        if (!requireSuperAdmin(session)) return json({ error: "Not authorised." }, 403);
        const body = await request.json();
        const id = body.id || uid();
        const topic = {
          id,
          title: (body.title || "Untitled topic").trim(),
          imageUrl: (body.imageUrl || "").trim(),
          imageDescription: (body.imageDescription || "").trim().slice(0, 600),
          questions: Array.isArray(body.questions) ? body.questions.filter(Boolean) : [],
          tags: Array.isArray(body.tags) ? body.tags : [],
          coach: sanitizeCoach(body.coach),
        };
        const existing = await env.CCv6_DB.prepare("SELECT created_at FROM topics WHERE id = ?").bind(id).first();
        await env.CCv6_DB
          .prepare(
            `INSERT INTO topics (id, title, image_url, image_description, questions, tags, coach, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               title = excluded.title, image_url = excluded.image_url, image_description = excluded.image_description,
               questions = excluded.questions, tags = excluded.tags, coach = excluded.coach`
          )
          .bind(id, topic.title, topic.imageUrl, topic.imageDescription, JSON.stringify(topic.questions), JSON.stringify(topic.tags), JSON.stringify(topic.coach), existing ? existing.created_at : Date.now())
          .run();
        return json({ topic });
      }

      if (pathname.startsWith("/api/teacher/topics/") && request.method === "DELETE") {
        if (!requireSuperAdmin(session)) return json({ error: "Not authorised." }, 403);
        const id = pathname.split("/").pop();
        await env.CCv6_DB.prepare("DELETE FROM topics WHERE id = ?").bind(id).run();
        return json({ ok: true });
      }

      if (pathname === "/api/teacher/password" && request.method === "POST") {
        if (!requireSuperAdmin(session)) return json({ error: "Not authorised." }, 403);
        const body = await request.json();
        const newPassword = (body.newPassword || "").trim();
        if (newPassword.length < 6) return badRequest("Password should be at least 6 characters.");
        await setTeacherPassword(env, newPassword);
        return json({ ok: true });
      }

      // ---------- TEACHER-ADMIN ACCOUNTS (palpatine only) ----------
      if (pathname === "/api/admin/teachers" && request.method === "GET") {
        if (!requireSuperAdmin(session)) return json({ error: "Not authorised." }, 403);
        return json({ teachers: await listTeacherAdmins(env) });
      }

      if (pathname === "/api/admin/teachers" && request.method === "POST") {
        if (!requireSuperAdmin(session)) return json({ error: "Not authorised." }, 403);
        const body = await request.json();
        const username = (body.username || "").trim().toLowerCase();
        const password = body.password || "";
        const classes = Array.isArray(body.classes) ? body.classes.map((c) => String(c || "").trim()).filter(Boolean).slice(0, 30) : [];
        if (!/^[a-z0-9_-]{3,30}$/.test(username)) return badRequest("Username should be 3-30 characters: letters, numbers, - or _ only.");
        if (username === TEACHER_USERNAME) return badRequest("That username is reserved.");
        if (password.length < 6) return badRequest("Password should be at least 6 characters.");
        if (!classes.length) return badRequest("Assign at least one class.");
        if (await getTeacherAdmin(env, username)) return badRequest("That username is already taken.");
        const salt = uid();
        const hash = await hashPassword(password, salt);
        const createdAt = Date.now();
        await env.CCv6_DB
          .prepare("INSERT INTO teacher_admins (username, salt, hash, classes, created_at) VALUES (?, ?, ?, ?, ?)")
          .bind(username, salt, hash, JSON.stringify(classes), createdAt)
          .run();
        return json({ teacher: { username, classes, createdAt } });
      }

      if (pathname.startsWith("/api/admin/teachers/") && request.method === "PUT") {
        if (!requireSuperAdmin(session)) return json({ error: "Not authorised." }, 403);
        const username = decodeURIComponent(pathname.split("/").pop()).trim().toLowerCase();
        const record = await getTeacherAdmin(env, username);
        if (!record) return json({ error: "Not found." }, 404);
        const body = await request.json();
        let classes = record.classes;
        if (Array.isArray(body.classes)) {
          classes = body.classes.map((c) => String(c || "").trim()).filter(Boolean).slice(0, 30);
          if (!classes.length) return badRequest("Assign at least one class.");
        }
        let salt = record.salt;
        let hash = record.hash;
        if (typeof body.newPassword === "string" && body.newPassword) {
          if (body.newPassword.length < 6) return badRequest("Password should be at least 6 characters.");
          salt = uid();
          hash = await hashPassword(body.newPassword, salt);
        }
        await env.CCv6_DB.prepare("UPDATE teacher_admins SET classes = ?, salt = ?, hash = ? WHERE username = ?").bind(JSON.stringify(classes), salt, hash, username).run();
        return json({ teacher: { username: record.username, classes, createdAt: record.createdAt } });
      }

      if (pathname.startsWith("/api/admin/teachers/") && request.method === "DELETE") {
        if (!requireSuperAdmin(session)) return json({ error: "Not authorised." }, 403);
        const username = decodeURIComponent(pathname.split("/").pop()).trim().toLowerCase();
        await env.CCv6_DB.prepare("DELETE FROM teacher_admins WHERE username = ?").bind(username).run();
        return json({ ok: true });
      }

      return json({ error: "Not found." }, 404);
    } catch (err) {
      return json({ error: "Server error: " + (err && err.message ? err.message : String(err)) }, 500);
    }
  },
};
