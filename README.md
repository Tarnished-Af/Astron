# Astron

A small, private notes site for a class or a group of friends, with an AI that answers from **your own notes** — including handwritten ones.

One person (the admin) posts the notes, homework and lab work. Everyone else reads them and can send in raw material: photos of the board, scans, pages from their notebook. The admin turns those into clean typed notes, with the AI doing the typing.

It is built for one course at one college. Everything about that course lives in a single config file, so you can point it at your own degree without touching the code.

---

## What it does

**Organised the way a degree actually is.**
Year → subject or lab → semester → unit (labs count in experiments). Each unit holds Notes, Homework, Lab work and Raw uploads. Every subject also gets a Syllabus tab with credits, hours, course outcomes, unit topics and books.

**Handwritten notes become typed notes.**
Choose some photographed pages, press one button, and the AI types them up: clean headings, proper maths rendered with KaTeX, and diagrams redrawn as line art with your original photo kept one click away. You edit before saving, and notes stay marked as an AI draft until you check them.

**An AI that only knows your notes.**
Ask a question and get an answer drawn from the notes on the site, with links to the file and page it used. It also writes practice questions, summaries and flashcards, scoped to all notes, one subject or one unit. If your notes don't cover something, it says so rather than inventing an answer.

**Handwriting is searchable.**
Uploaded scans and photos are read by Azure AI Document Intelligence, so the AI can use handwritten pages too. Typed PDFs are read locally and never sent anywhere.

**Accounts you control.**
Only the admin creates accounts. Each person gets a username and a temporary password and picks their own on first sign-in. Forgotten passwords are reset by the admin. Passwords are stored hashed with bcrypt.

**Run from the site, not the server.**
An admin Manage course page edits subjects, units and the syllabus, with warnings before anything that would orphan files, and an Export button for sharing your catalog. A Settings page covers the site name, storage and AI limits, and the provider keys — saved on the server and never shown again.

**Storage you can see.**
A live bar shows what's used against a limit you set, broken down by type, year and subject. Uploads that would exceed the limit are refused before they start.

**View-only by design.**
Files open in an in-page viewer and there are no download links. (Screenshots are always possible — this stops casual sharing, not a determined person.)

---

## Running it

You need a small Linux server, an OpenAI-compatible AI endpoint, and optionally Azure Document Intelligence for handwriting.

```bash
git clone https://github.com/Tarnished-Af/Astron.git && cd astron
npm install --omit=dev
cp .env.example .env     # then edit it
node server.js
```

Open the address it prints and sign in as the admin from `.env`. Everything after that — the course, the keys, the limits — can be set from the site itself.

`docs/DEPLOY-AZURE.md` is a click-by-click guide to a real deployment on an Azure VM with a domain and HTTPS, using the scripts in `deploy/`. Those scripts work on any Ubuntu server.

### Settings

All in `.env` (see `.env.example`):

| Setting | What it does |
|---|---|
| `SITE_NAME` | Name shown in the tab, sign-in screen and AI page |
| `CATALOG` | Path to your course file (see below) |
| `AI_BASE_URL`, `AI_MODEL`, `AI_API_KEY` | Any provider: OpenAI-compatible, Anthropic, Gemini, or local |
| `OCR_ENGINE` | `azure`, `ai` (your own vision model), `tesseract` (local, free) or `off` |
| `AZURE_DI_ENDPOINT`, `AZURE_DI_KEY` | For the `azure` option; leave blank to skip |
| `STORAGE_LIMIT_MB`, `MAX_FILE_MB` | Storage limit and per-file cap |
| `AI_DAILY_LIMIT` | AI requests per person per day; the admin has no limit |

## Making it your college's site

Copy `config/catalog.example.json`, describe your own years, subjects, labs and syllabus, and point `CATALOG` at it. Nothing else changes.

`config/catalog.btu-cse.json` is a full real example: four years of a B.Tech Computer Science degree, 64 subjects and labs, 61 syllabus entries.

**[docs/CATALOG.md](docs/CATALOG.md) explains every field.**

## What's inside

| | |
|---|---|
| `server.js` | The whole API: sign-in, uploads, storage, viewing, AI |
| `lib/db.js` | SQLite schema and helpers |
| `lib/extract.js` | Reading text from PDFs and images, with OCR |
| `lib/convert.js` | Turning photographed pages into typed notes and drawings |
| `lib/ai.js` | Provider client, note search and the study tools |
| `public/index.html` | The entire front end: one file, no build step |
| `config/` | Course catalogs |
| `deploy/` | Setup, update, HTTPS and backup scripts |

Node 20+, SQLite, and `poppler-utils` plus `imagemagick` for reading PDFs. No build tooling, no framework, no tracking, nothing phones home.

## Notes on the AI

- It only ever sees notes posted on the site, plus raw uploads once they're marked used.
- Converted notes are a **draft**. Models misread handwriting, especially Greek letters and subscripts, and a redrawn diagram can be plain wrong. Check them before your friends rely on them.
- Costs are per page converted and per question asked. The daily limit per person keeps it predictable.
- Typing up photographed pages needs a model that reads images. Text-only models can still answer questions and write quizzes; the site says so plainly rather than failing oddly.

## Licence

MIT. Do what you like with it; no warranty. See [LICENSE](LICENSE).
