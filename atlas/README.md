# Atlas — a daily knowledge-training quiz

Atlas is a distraction-free, single-page web app for building **broad general knowledge** in
**History, Geography, Philosophy, and Economics**. It uses evidence-based learning mechanics — active recall,
interleaving, spaced repetition, adaptive difficulty, and weak-spot targeting — with everything
running locally in your browser. No backend, no accounts, no network calls. Your progress lives in
`localStorage`.

---

## How to run it

You have two options.

### Option A — one command (recommended)

Any static file server works. From inside the `atlas/` folder:

```bash
cd atlas
python3 -m http.server 8000
```

Then open **http://localhost:8000** in your browser.

(If you prefer Node: `npx serve` or `npx http-server` from the `atlas/` folder does the same.)

### Option B — just open the file

Double-click **`atlas/index.html`**. It works offline with no server, because the question bank is
also bundled as `questions.js` for the `file://` case (browsers block `fetch()` of local JSON files,
so the app falls back to the bundled copy automatically).

Either way, the app is fully functional and self-contained.

### Option C — on your phone

The app is just static files, so any of these work on a phone:

- **Self-host with GitHub Pages (permanent, recommended):** in your repo, go to
  **Settings → Pages**, set the source to your branch, and once it publishes, open
  `https://<your-username>.github.io/<repo>/atlas/` on your phone. It's your own URL, works on
  any device, and your progress saves per-device in the browser.
- **Single portable file:** `atlas/atlas.html` is the entire app bundled into one file (HTML, CSS,
  JS, and all questions inlined). Email/AirDrop it to yourself and open it in your phone's browser —
  no server, fully offline. Regenerate it after editing questions with the snippet in
  "Keeping files in sync" below.
- **Any static host:** drop the `atlas/` folder onto Netlify, Vercel, Cloudflare Pages, etc.

Because there's no backend, progress on your phone is separate from your desktop. Use
**Export / Import** in Settings to move a backup between devices.

---

## How to use it

- **Home** → pick a session length (10 / 15 / 25) and press **Start**.
- Each question shows **the prompt first, with the options hidden**. Think of your answer, then
  **Reveal options**, pick one, and read the feedback (explanation, distractor note, connection).
- Finish the session for a score, streak update, per-topic breakdown, a review list, and a
  "what you learned today" recap.
- **Stats** shows your streak, accuracy trend, and strongest/weakest subtopics.
- **Settings** has theme, default session length, and **Export / Import / Reset** for your data.
- Once a week, if you've missed questions, a **Weekly review** banner appears on Home — a short
  session drawn only from what you got wrong in the last 7 days.

You can also press **← Back** at any point to revisit earlier questions in the session (read-only —
your recorded answer and stats don't change), then jump forward again.

### Keyboard shortcuts
- **Space** — reveal the options
- **1–4** — select an answer
- **Enter** or **→** — continue to the next question
- **←** — go back to the previous question

---

## The learning mechanics

| Mechanic | What Atlas does |
|---|---|
| **Active recall** | Options are hidden until you press *Reveal* — you attempt the answer from memory first. |
| **Interleaving** | Never two questions from the same topic back to back; History / Geography / Philosophy / Economics are shuffled throughout. |
| **Spaced repetition** | SM-2-style intervals. Wrong → 1 day; correct after a wrong → 3 days; then 7, 16, 35. A correct-on-first-sight question jumps to ~14 days. Missed questions never re-appear in the same session. |
| **Adaptive difficulty** | Rolling accuracy over your last 10 answers: above ~80% weights the session harder, below ~50% weights it easier, otherwise mixed. |
| **Weak-spot weighting** | Per-subtopic accuracy is tracked; subtopics below your average accuracy get oversampled. |
| **Weekly review** | A separate ~10-question session drawn only from questions missed in the last 7 days, prompted once a week. |

---

## File structure

```
atlas/
├── index.html      # App shell (nav, theme, mounts the views)
├── styles.css      # All styling; dark mode default, light mode toggle
├── app.js          # All logic: state, scheduling, session flow, stats, import/export
├── questions.json  # The question bank — human-readable, edit this to add questions
├── questions.js    # Auto-generated mirror of questions.json (for the file:// fallback)
├── atlas.html      # Auto-generated: the whole app bundled into one portable file
└── README.md       # This file
```

**You edit `questions.json`.** `questions.js` is just `window.ATLAS_QUESTIONS = <contents of
questions.json>` so the app can run by double-clicking. If you run via a local server (Option A),
`questions.json` is loaded directly and `questions.js` is ignored — so for quick edits, use the
server and you don't need to touch `questions.js` at all. To keep the double-click path in sync
after editing, see "Keeping the two files in sync" below.

---

## The question bank (~375 starter questions)

The bank ships with ~375 questions across History (101), Geography (100), Philosophy (100), and
Economics (75), tagged by subtopic and difficulty, with "connect the dots" questions for
chronological ordering, causal links, and influence chains. The Economics branch leans into that
style deliberately — most questions ask what a concept (division of labor, comparative advantage,
inflation, externalities…) *leads to*, with the explanation laying out the chain of reasoning.

### Schema for each question

`questions.json` is a single JSON array of objects. Each object looks like this:

```json
{
  "id": "h001",
  "topic": "History",
  "subtopic": "Ancient Egypt",
  "difficulty": "medium",
  "question": "What was the primary purpose of the Great Pyramid of Giza?",
  "choices": ["A royal palace", "A tomb for a pharaoh", "A grain storehouse", "An observatory"],
  "answerIndex": 1,
  "explanation": "The Great Pyramid was built around 2560 BCE as a monumental tomb for Khufu.",
  "context": "Built c. 2560 BCE at Giza for the pharaoh Khufu; it was the tallest human-made structure on Earth for nearly 4,000 years.",
  "distractorNotes": "It aligns to cardinal directions, but 'observatory' is a modern myth.",
  "connection": "Part of the same Old Kingdom pyramid-building tradition centered on Memphis.",
  "connect": true,
  "related": ["h002", "h003"]
}
```

### Field reference

| Field | Required | Notes |
|---|---|---|
| `id` | ✅ | Unique string. Convention: `h###` History, `g###` Geography, `p###` Philosophy, `e###` Economics. |
| `topic` | ✅ | Exactly one of `"History"`, `"Geography"`, `"Philosophy"`, `"Economics"`. To add a new top-level topic, also add it to the `TOPICS` array in `app.js`. |
| `subtopic` | ✅ | Free-form, e.g. `"Ancient Rome"`, `"Physical Geography"`, `"Ethics"`. Used for weak-spot tracking, so reuse existing spellings to group questions. |
| `difficulty` | ✅ | One of `"easy"`, `"medium"`, `"hard"`. |
| `question` | ✅ | The prompt shown during active recall. |
| `choices` | ✅ | Array of **exactly 4** distinct strings. |
| `answerIndex` | ✅ | Integer `0–3` — the index of the correct choice. |
| `explanation` | ✅ | 1–2 punchy sentences on *why* the answer is right. |
| `context` | optional | 1–3 sentences of grounding facts shown as "Context" in feedback — dates and place for events, who a person is and their lifespan, what a term means. All starter questions include one. |
| `distractorNotes` | ✅ | Short note on why the most tempting wrong answer is wrong. |
| `connection` | optional | One sentence linking the fact to another idea/era/person. Shown as "Connection" in feedback. |
| `connect` | optional | `true` marks a "connect the dots" question (adds a chip and boosts it in the recap). Use for ordering / causal / influence questions. |
| `related` | optional | Array of other question `id`s this one connects to. |

### Adding your own questions

1. Open `questions.json`.
2. Copy an existing object, paste it as a new entry in the array, and edit the fields.
3. Give it a **unique `id`** and make sure `choices` has **exactly 4** options with the right
   `answerIndex`.
4. Save. If you're running via a local server, just refresh the page — done.

**Accuracy matters more than volume.** Prefer well-established, verifiable facts. If you're unsure
of a detail, pick a different question.

### Keeping the two files in sync (only needed for the double-click path)

If you edit `questions.json` and want the **double-click / `file://`** path to reflect it, regenerate
`questions.js`. Any of these works from inside `atlas/`:

```bash
# Node
node -e "const q=require('fs').readFileSync('questions.json','utf8'); require('fs').writeFileSync('questions.js','window.ATLAS_QUESTIONS = '+q+';')"
```

```bash
# or plain shell
printf 'window.ATLAS_QUESTIONS = ' > questions.js && cat questions.json >> questions.js && printf ';' >> questions.js
```

If you always run via the local server (Option A), you can ignore `questions.js` entirely.

To also refresh the single-file `atlas.html` after editing questions, run from inside `atlas/`:

```bash
node -e "const f=require('fs'),c=f.readFileSync('styles.css','utf8'),a=f.readFileSync('app.js','utf8'),q=f.readFileSync('questions.json','utf8'),h=f.readFileSync('index.html','utf8');const body=h.replace(/[\s\S]*<body>/,'').replace(/<\/body>[\s\S]*/,'').replace(/<script src=\"app.js\"><\/script>/,'');f.writeFileSync('atlas.html','<!doctype html>\n<html lang=\"en\" data-theme=\"dark\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1,viewport-fit=cover\"><title>Atlas</title><style>'+c+'</style></head><body>'+body+'<script>window.ATLAS_QUESTIONS='+q+';</script><script>'+a+'</script></body></html>');"
```

---

## Your data

- Everything is stored under the `atlas.state.v1` key in your browser's `localStorage`.
- **Export progress** downloads a JSON backup. **Import progress** restores one. **Reset** clears
  everything (with a confirmation).
- Clearing your browser data for this site will also wipe progress — export first if you care.
