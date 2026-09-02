# Deploying "Just a Chit-Chat" from the browser only (no terminal)

This guide walks through getting the app live on Cloudflare using nothing but
your web browser — no command prompt, no terminal, no local installs. It
assumes you already have the project files (`wrangler.toml`, `README.md`,
and the `src/` folder) — the same ones this guide sits alongside.

There are two ways to do this. **Path A is recommended** — it's more
reliable for a multi-file project like this one, and Cloudflare auto-rebuilds
every time you save a change. **Path B** is a fallback if you'd rather not
touch GitHub at all.

A note before you start: Cloudflare's and GitHub's dashboards change their
button wording and layout from time to time, and this guide can't be
screenshot-verified against what you're seeing right now. If a label doesn't
match exactly, look for the closest equivalent — the underlying steps
(create a D1 database, a KV namespace, add bindings, add a secret) are
stable even when
the exact wording shifts.

---

## Path A (recommended): GitHub + Cloudflare Workers Builds

Cloudflare can watch a GitHub repository and automatically build + deploy
your Worker every time you save a change there — this is the same mechanism
that would normally run `wrangler deploy` for you, except it's Cloudflare's
own servers doing it, not your computer.

### A1. Create a GitHub account and repository

1. Go to **github.com** and sign up for a free account if you don't have one.
2. Click the **+** icon in the top-right corner → **New repository**.
3. Name it something like `just-a-chit-chat`. Public or private both work —
   private is fine since this repo will contain your `wrangler.toml` (which
   itself contains no secrets, just configuration).
4. Click **Create repository**.

### A2. Upload the project files (drag-and-drop, no git needed)

1. On your new (empty) repo's page, click **"Add file"** → **"Upload files"**.
2. Drag in:
   - `wrangler.toml`
   - `README.md`
   - the entire `src/` folder (containing `index.js`, `frontend.js`,
     `seed-topics.js`, `vulgarity-list.js`) — most browsers let you drag a
     whole folder onto GitHub's upload area and it preserves the folder
     structure automatically.
3. Scroll down and click **"Commit changes"**. This is the browser
   equivalent of a `git push` — no command line involved.
4. Confirm the file tree on your repo's main page shows `wrangler.toml`,
   `README.md`, and a `src/` folder with the 4 files inside.

### A3. Create the D1 database (this replaces `wrangler d1 create`)

1. In a new tab, log into the **Cloudflare dashboard** (dash.cloudflare.com).
2. In the left sidebar, find **Storage & Databases → D1 SQL Database**.
3. Click **Create database**.
4. Name it `chitchat-v7` (matching `database_name` in `wrangler.toml`) and create it.
5. Open the new database, find its **Console** tab (a place to run SQL
   directly in the browser), open `schema.sql` from this project on your
   computer, copy its full contents, paste them into the console, and run
   it. This creates the `topics`, `submissions`, `pupils`, `pupil_history`,
   `teacher_admins`, and `config` tables.
6. Copy the **Database ID** shown on the database's overview page — you'll
   need it in the next step.

### A3b. Create the KV namespace (this replaces `wrangler kv:namespace create`)

1. Still in the Cloudflare dashboard sidebar, find **Storage & Databases →
   KV** (naming may vary slightly, e.g. "Workers KV"). KV is only used for
   session tokens now — everything else lives in the D1 database you just
   created.
2. Click **Create a namespace** (or **Create namespace**).
3. Name it `CCv6_DATA` (matching the binding name in `wrangler.toml`) and create it.
4. Copy the **Namespace ID** it shows you — you'll need it in the next step.

### A4. Put the real D1 database ID and KV namespace ID into `wrangler.toml`

1. Back in your GitHub repo, open `wrangler.toml` and click the **pencil
   (edit)** icon.
2. Find the line:
   ```toml
   database_id = "REPLACE_WITH_YOUR_D1_DATABASE_ID"
   ```
   and replace it with the real Database ID you copied in step A3, keeping
   the quotes.
3. Find the line:
   ```toml
   { binding = "CCv6_DATA", id = "REPLACE_WITH_YOUR_KV_NAMESPACE_ID" }
   ```
3. Replace `REPLACE_WITH_YOUR_KV_NAMESPACE_ID` with the real ID you copied
   in step A3b, keeping the quotes.
4. Scroll down and **commit the change** directly to the main branch.

### A5. Connect the repo to Cloudflare

1. In the Cloudflare dashboard, go to **Workers & Pages**.
2. Click **Create** (or **Create application**).
3. Look for an option like **"Import a repository"** or **"Connect to Git"**
   and select it.
4. Authorize Cloudflare to access your GitHub account if prompted, then
   choose the `just-a-chit-chat` repository.
5. Cloudflare should detect `wrangler.toml` automatically and pre-fill the
   build/deploy settings from it (this is what picks up the `[ai]` binding,
   the D1 database binding, and the `CCv6_DATA` KV binding — you shouldn't
   need to type these in manually, but you can double check them in the
   next step).
6. Confirm/start the deployment. Cloudflare will build and deploy the
   Worker; this typically takes under a minute.

### A6. Add your Gemini (and optionally Groq) API key as secrets

1. Once the Worker exists, open it in the Cloudflare dashboard and go to
   **Settings → Variables and Bindings** (wording may vary — look for
   "Environment Variables" or "Secrets" if you don't see this exact label).
2. Add a new variable:
   - Name: `GEMINI_API_KEY`
   - Value: your key from [Google AI Studio](https://aistudio.google.com/apikey)
   - Type: **Secret / Encrypted** (not plain text) — this matches what
     `wrangler secret put GEMINI_API_KEY` would have done locally. Gemini is
     the primary marker since it's the only one that can see the topic
     picture.
3. Optional, but recommended for a stronger fallback chain: add a second
   variable the same way:
   - Name: `GROQ_API_KEY`
   - Value: your key from [console.groq.com](https://console.groq.com)
   - Type: **Secret / Encrypted**
4. Save. The values won't be visible again after saving — that's expected
   and is the whole point of a secret.
5. While you're in this panel, confirm there's a binding for **Workers AI**
   named `AI`, a **D1 database** binding named `CCv6_DB` pointing at
   `chitchat-v7`, and a **KV Namespace** binding named `CCv6_DATA` pointing
   at the namespace you created — add them here manually if `wrangler.toml`
   auto-detection didn't pick them up.

### A7. Set the teacher password (this replaces the `wrangler d1 execute --command=...` command)

1. Go back to **Storage & Databases → D1 SQL Database**, open the
   `chitchat-v7` database, and open its **Console** tab.
2. Run:
   ```sql
   INSERT INTO config (key, value) VALUES ('teacher_password', 'yourSecretPassword')
   ON CONFLICT(key) DO UPDATE SET value = excluded.value;
   ```
   replacing `yourSecretPassword` with whatever password you want teachers
   to use to unlock the `palpatine` login.

### A8. Get your live URL

1. In the Cloudflare dashboard, open your Worker and look at the
   **Deployments** tab (or the Worker's overview page).
2. You'll see a URL ending in `.workers.dev` — that's the whole app, live.
3. Any future change: edit files on GitHub (or re-upload changed files) and
   commit — Cloudflare rebuilds and redeploys automatically within a
   minute or two.

---

## Path B (alternative): paste code directly into Cloudflare's editor

Skip GitHub entirely and type/paste the project straight into Cloudflare's
own in-browser code editor. This editor (sometimes called "Quick Edit") now
supports multiple files with `import`/`export` between them, which is what
this project needs.

1. In the Cloudflare dashboard, go to **Workers & Pages → Create → Create
   Worker**. Give it a name (e.g. `just-a-chit-chat`) and create it.
2. Open **"Edit code"** on the new Worker.
3. In the file panel on the left of the editor, create 4 files matching this
   project's `src/` folder:
   - `index.js`
   - `frontend.js`
   - `seed-topics.js`
   - `vulgarity-list.js`
4. Open each one and paste in the matching file's contents from this
   package. Make sure `index.js` is set as the entry point/main module if
   the editor asks (it's the file with the `export default { fetch... }`
   at the bottom).
5. In the editor's bindings/settings panel, add the same things as Path A
   step A6:
   - A **D1 database** binding named `CCv6_DB` pointing at `chitchat-v7`
     (create the database and run `schema.sql` in its Console tab first —
     same as Path A step A3, if you haven't already)
   - A **KV Namespace** binding named `CCv6_DATA` (create the namespace here
     if you haven't already — same as Path A step A3b)
   - A **Workers AI** binding named `AI`
   - A **Secret** named `GEMINI_API_KEY` with your Gemini key
   - Optionally, a **Secret** named `GROQ_API_KEY` with your Groq key
6. Set the teacher password the same way as Path A step A7 (Storage &
   Databases → D1 SQL Database → `chitchat-v7` → Console → run the
   `INSERT INTO config ...` statement from step A7 with your password).
7. Click **Save and Deploy** in the editor.

**Trade-off vs. Path A:** this works, but you're hand-copying 4 files with
no version history and no auto-redeploy on future edits — every change
means reopening the editor and re-pasting. Path A is the better choice if
you expect to tweak the code again later (e.g. adding topics to
`seed-topics.js`, adjusting the rubric, changing the model name).

---

## After deploying (either path)

Whichever path you used, from here the app behaves exactly as described in
`README.md`:

- Pupils go to your `.workers.dev` URL, enter a name, and start a practice
  session.
- Typing **palpatine** as the name prompts for the teacher password you set
  in step A7/B6, unlocking Teacher Tools (Leaderboard, Submissions, Topics,
  Pupils, Settings). Pupils can also log in as `Name@Class` (e.g.
  `Ashraf@5IG`) so their teacher can track progress by class in the new
  Pupils tab.
- Marking uses Gemini first (it's the only provider that can see the topic
  picture), then Groq, then Workers AI automatically if those are missing or
  a call fails — no extra setup needed for the Workers AI fallback since the
  `AI` binding covers it. Groq and Workers AI can't see the picture, so they
  rely on each topic's optional "Picture Description" field instead (Teacher
  Tools → Topics).
- Every marked question shows a green "AI connected" or red "AI unavailable"
  badge so pupils and teachers can see when a question fell all the way
  through to the offline scorer.

## If something doesn't work

- **Blank page or error at the `.workers.dev` URL** — open the Worker's
  **Logs** or **Deployments** tab in the Cloudflare dashboard to see the
  actual error message.
- **"Not authorised" or D1/KV-related errors** — double-check the `CCv6_DB`
  and `CCv6_DATA` binding names match exactly (case-sensitive) in both
  `wrangler.toml` (or the editor's binding panel) and the actual D1
  database / KV namespace. Also confirm `schema.sql` was actually run
  against the D1 database (step A3) — a missing table shows up as a
  "Server error" mentioning the table name.
- **Marking always uses the fallback / feedback looks generic** — check
  that `GEMINI_API_KEY` (or `GROQ_API_KEY`) was saved as a **Secret**, not a
  plain text variable, and that there's no typo in the name.
- **UI labels don't match this guide** — Cloudflare and GitHub occasionally
  redesign their dashboards. Tell me what you're actually seeing (a
  screenshot description, menu names visible to you) and I'll help you find
  the right spot from there.
