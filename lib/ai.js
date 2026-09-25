// Astron's AI: finds the most relevant pieces of your notes, then asks the
// model to answer, quiz, summarise or make flashcards from only those pieces.
// Works with any provider that speaks the OpenAI chat-completions format
// (DeepSeek, Groq, Mistral, OpenRouter, Together, OpenAI, Gemini's compatible
// endpoint, and most others). Set AI_BASE_URL, AI_MODEL and AI_API_KEY.

const { client } = require("./ai-client");

// ---------- search ----------
const STOP = new Set("a an the is are was were be been of in on at to for from by with and or not what which who whom whose why how when where explain define describe give write list state find tell me about do does did can could should would will this that these those it its as into than then there their them they we you your i my our unit notes please short long answer question questions".split(" "));

function ftsQuery(text) {
  const words = (text.toLowerCase().match(/[a-z0-9]+/g) || []).filter(w => w.length > 1 && !STOP.has(w));
  const uniq = [...new Set(words)].slice(0, 12);
  return uniq.length ? uniq.map(w => '"' + w + '"').join(" OR ") : null;
}

// scope: { subject, sem, unit } any of which may be empty
function search(db, question, scope, limit = 8) {
  const where = [], args = [];
  if (scope.subject) { where.push("c.subject = ?"); args.push(scope.subject); }
  if (scope.sem) { where.push("c.sem = ?"); args.push(Number(scope.sem)); }
  if (scope.unit) { where.push("c.unit = ?"); args.push(Number(scope.unit)); }
  // Only posted material feeds the AI. Friends' raw uploads count once you mark them used.
  where.push("(f.kind != 'raw' OR f.status = 'used')");
  const q = question ? ftsQuery(question) : null;
  const filter = where.length ? " AND " + where.join(" AND ") : "";
  let rows = [];
  if (q) {
    rows = db.prepare(`SELECT c.text, c.file_id, c.page, f.title, f.kind, f.subject, f.sem, f.unit, bm25(chunks) AS score
      FROM chunks c JOIN files f ON f.id = c.file_id WHERE chunks MATCH ?${filter} ORDER BY score LIMIT ?`).all(q, ...args, limit);
  }
  if (rows.length < 3 && (scope.subject || scope.unit)) {
    // Topic words missed; fall back to reading the scope in order.
    const more = db.prepare(`SELECT c.text, c.file_id, c.page, f.title, f.kind, f.subject, f.sem, f.unit
      FROM chunks c JOIN files f ON f.id = c.file_id WHERE 1=1${filter} ORDER BY f.kind = 'notes' DESC, c.file_id, CAST(c.page AS INTEGER) LIMIT ?`).all(...args, limit);
    const seen = new Set(rows.map(r => r.file_id + ":" + r.page + ":" + r.text.slice(0, 40)));
    for (const r of more) if (!seen.has(r.file_id + ":" + r.page + ":" + r.text.slice(0, 40))) rows.push(r);
    rows = rows.slice(0, limit);
  }
  return rows;
}

function excerpts(rows, budget = 14000) {
  let used = 0; const out = [];
  rows.forEach((r, i) => {
    if (used > budget) return;
    const t = r.text.slice(0, Math.max(400, budget - used));
    used += t.length;
    out.push(`[${i + 1}] ${r.title} (page ${r.page})\n${t}`);
  });
  return out.join("\n\n---\n\n");
}

const sources = rows => {
  const seen = new Map();
  rows.forEach((r, i) => { const k = r.file_id + ":" + r.page; if (!seen.has(k)) seen.set(k, { n: i + 1, fileId: r.file_id, title: r.title, page: Number(r.page), kind: r.kind }); });
  return [...seen.values()];
};

function parseJSON(text) {
  const clean = String(text).replace(/```json|```/g, "").trim();
  try { return JSON.parse(clean); } catch (_) {}
  const m = clean.match(/[\[{][\s\S]*[\]}]/);
  if (m) { try { return JSON.parse(m[0]); } catch (_) {} }
  throw new Error("The AI's reply wasn't in the expected format. Try again.");
}

const basePrompt = ctx => {
  const who = ctx && ctx.course ? `students on ${ctx.course}` : "students";
  const at = ctx && ctx.institution ? ` at ${ctx.institution}` : "";
  return `You are ${(ctx && ctx.siteName) || "a study assistant"}, helping ${who}${at}. Use ONLY the note excerpts provided. If they don't cover something, say plainly that the notes don't cover it rather than guessing. Be clear and exam-focused.`;
};

async function run(db, ai, req, site = {}) {
  const BASE = basePrompt(site);
  const mode = req.mode;
  const scope = { subject: req.subject || "", sem: req.sem || "", unit: req.unit || "" };
  const topic = (req.question || req.topic || "").slice(0, 1000);
  const rows = search(db, topic || (req.syllabusTopics || ""), scope, mode === "ask" ? 8 : 12);
  if (!rows.length) {
    return { empty: true, message: "There are no readable notes here yet, so there's nothing for the AI to work from. Upload notes for this unit first." };
  }
  const ctx = excerpts(rows);
  const where = req.label ? `Scope: ${req.label}.` : "";

  if (mode === "ask") {
    const answer = await ai.chat([
      { role: "system", content: BASE + " Cite excerpts inline like [1] or [2]. Use short paragraphs, and bullet points for steps or lists. Write maths in plain text." },
      { role: "user", content: `${where}\n\nNote excerpts:\n\n${ctx}\n\nQuestion: ${topic}` }
    ], { maxTokens: 1200 });
    return { answer, sources: sources(rows) };
  }

  if (mode === "quiz") {
    const n = Math.min(Math.max(parseInt(req.count, 10) || 8, 3), 20);
    const types = req.types || "a mix of multiple-choice, short-answer and long-answer";
    const raw = await ai.chat([
      { role: "system", content: BASE + ' Reply with JSON only, shaped as {"questions":[{"type":"mcq"|"short"|"long","q":"...","options":["...","...","...","..."],"answer":"...","explain":"...","source":1}]}. "options" only for mcq, where "answer" must equal one of the options exactly. "source" is the excerpt number.' },
      { role: "user", content: `${where}\n\nNote excerpts:\n\n${ctx}\n\nWrite ${n} exam-style questions (${types})${topic ? " focused on: " + topic : ""}. Keep them answerable from the excerpts.` }
    ], { maxTokens: 2600, json: true, temperature: 0.5 });
    const data = parseJSON(raw);
    return { questions: (data.questions || data).slice(0, n), sources: sources(rows) };
  }

  if (mode === "summary") {
    const summary = await ai.chat([
      { role: "system", content: BASE + " Write a revision summary: a one-line overview, then sections with headings using '## ', key definitions, formulas and points likely to be asked in exams. Cite excerpts like [1]." },
      { role: "user", content: `${where}\n\nNote excerpts:\n\n${ctx}\n\nSummarise this${topic ? ", focusing on " + topic : ""}.` }
    ], { maxTokens: 1800 });
    return { answer: summary, sources: sources(rows) };
  }

  if (mode === "paper") {
    const marks = Math.min(Math.max(parseInt(req.marks, 10) || 70, 20), 200);
    const hours = Math.min(Math.max(parseFloat(req.hours) || 3, 1), 4);
    const paper = await ai.chat([
      { role: "system", content: BASE + ` Write a practice examination paper in Markdown, laid out the way a real paper is:

- A heading with the subject, the marks and the time allowed.
- **Part A**: short questions worth 2 marks each, covering the breadth of the material.
- **Part B**: medium questions worth 5 to 7 marks, with a choice where sensible ("attempt any four of six").
- **Part C**: long questions worth 10 to 15 marks, one or two of them, usually with internal choice.
- Number every question, put its marks in brackets at the end of the line, and make the marks add up to the total.
- Questions must be answerable from the notes provided. Do not ask about topics the notes don't cover.
- Write mathematics in LaTeX with $...$ and $$...$$.
- Do NOT include the answers.` },
      { role: "user", content: `${where}\n\nNote excerpts:\n\n${ctx}\n\nWrite a practice paper worth ${marks} marks for ${hours} hours${topic ? ", focusing on " + topic : ""}.` }
    ], { maxTokens: 2600, temperature: 0.5 });
    return { answer: paper, sources: sources(rows), marks, hours };
  }

  if (mode === "flashcards") {
    const n = Math.min(Math.max(parseInt(req.count, 10) || 12, 4), 30);
    const raw = await ai.chat([
      { role: "system", content: BASE + ' Reply with JSON only, shaped as {"cards":[{"front":"...","back":"..."}]}. Fronts are short prompts; backs are concise answers.' },
      { role: "user", content: `${where}\n\nNote excerpts:\n\n${ctx}\n\nMake ${n} flashcards${topic ? " about " + topic : ""}.` }
    ], { maxTokens: 1800, json: true, temperature: 0.4 });
    const data = parseJSON(raw);
    return { cards: (data.cards || data).slice(0, n), sources: sources(rows) };
  }
  throw new Error("Unknown AI mode.");
}

module.exports = { client, run, search };
