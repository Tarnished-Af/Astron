// Turns photographed or scanned pages into clean, typed notes.
// Each page is sent to the AI as an image, together with whatever text
// Document Intelligence already read from it. The model sees the real layout,
// so superscripts, fractions and diagrams survive, and it writes the maths
// as LaTeX which the site renders properly.
const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { promisify } = require("util");
const run = promisify(execFile);

const MAX_PAGES = 25;          // guards time and cost per conversion
const PAGES_PER_CALL = 2;      // fewer pages per call keeps accuracy high

async function pageImages(filePath, ext, dir, detail) {
  const dpi = detail === "low" ? 110 : 160;
  if (ext === "pdf") {
    await run("pdftoppm", ["-r", String(dpi), "-jpeg", "-jpegopt", "quality=80", filePath, path.join(dir, "pg")]);
    return fs.readdirSync(dir).filter(f => f.startsWith("pg")).sort()
      .map((f, i) => ({ page: i + 1, file: path.join(dir, f) }));
  }
  const out = path.join(dir, "pg-1.jpg");
  await run("convert", [filePath, "-auto-orient", "-resize", detail === "low" ? "1400x1400>" : "2000x2000>", "-quality", "82", out]);
  return [{ page: 1, file: out }];
}

const SYSTEM = `You turn photographs of a student's handwritten notes into clean, typed notes.

Rules:
- Copy what is on the page. Do not invent steps, examples or explanations that are not there.
- Fix only obvious slips: a dropped bracket, an unreadable letter, spacing. If something is genuinely unreadable, write [unclear] rather than guessing.
- Write ALL mathematics as LaTeX, using DOLLAR delimiters only: inline as $...$ and displayed equations as $$...$$ on their own lines. Never use \\( \\) or \\[ \\]. Use \\frac, \\partial, ^, _, \\sqrt, \\int, \\lim properly. Never write maths as plain text like "d2u/dxdy".
- Use Markdown for structure: ## for topic headings, **bold** for definitions and key terms, numbered lists for steps in a derivation, tables where the page has a table.
- Keep the page's own order. Label worked examples as **Question** and **Solution** when the page does.
- Greek letters are often misread in handwriting. A loopy "S" before an equals sign in optics is almost always delta ($\\delta$), not S. Watch for $\\theta$ read as O or 0, $\\mu$ as u, $\\alpha$ as a, $\\lambda$ as h, $\\phi$ as p, $\\omega$ as w, $\\rho$ as p, $\\epsilon$ as E. Use the subject to decide: deviation, phase, density and wavelength are Greek.
- If the page has a diagram, figure or graph, output a line of exactly this form, on its own:
  [[DIAGRAM page=N top=T bottom=B caption=Short caption]]
  Put this line at the point where the figure appears in the page's own order, not at the end. N is the page number; T and B are where the drawing starts and ends down the page, as percentages from the top (0 at the very top, 100 at the bottom). Measure the drawing ITSELF. B is the bottom of the lowest drawn line or its label, NOT where the handwritten working below it begins: if there is writing under the figure, B must be above that writing. When unsure, choose the smaller B. The real drawing from the page is then placed there.
- Output only the notes. No preamble, no commentary about the image quality.`;

const DRAW_SYSTEM = `You redraw a student's hand-drawn diagram as clean SVG.

Output exactly two things and nothing else:
1. One line: BOUNDS top=T bottom=B
   where T and B are how far down the page the drawing itself starts and ends, as percentages of the page height. Measure the drawn figure only, from its highest line to its lowest line or label. Stop above any handwritten working below it.
2. The SVG, starting with <svg and ending with </svg>.

Rules:
- <svg viewBox="0 0 640 400" xmlns="http://www.w3.org/2000/svg"> with no width or height attributes. Keep everything inside 20..620 across and 20..380 down.
- Lines and shapes: stroke="#1b3a8f" stroke-width="2" fill="none".
- Dashed construction lines: stroke-dasharray="5 4" stroke-width="1".
- Text: <text font-family="inherit" font-size="15" fill="#1b3a8f">.

Labels, which is where these drawings usually go wrong:
- Put every label right beside the thing it names, within about 25 units of it. A point's letter goes just outside the shape at that point; a ray's name goes near that ray, part way along it.
- NEVER gather labels together in a row, a column, a legend or a caption. There is no legend. If you cannot place a label sensibly beside its feature, leave that label out.
- Use exactly the letters and words written on the page (for example the same point letters). Do not rename points or invent new ones.
- No two pieces of text may overlap each other or sit on top of a line.

Angles and arrows:
- Mark an angle with a small arc at its vertex, drawn as a path with fill="none", radius about 18, and put the angle's letter just outside the arc.
- An arrowhead is a thin filled triangle about 12 long and 7 wide, pointing along the line's direction, with its tip exactly at the line's end point. Never a square, diamond or blob. Use <polygon> only: no <marker>, no CSS, no <style>, no <script>, no <image>, no external links.

Content:
- Copy the geometry and the labels that are on the page, keeping the proportions roughly right. Add nothing that is not drawn there.
- Straight lines unless the drawing is curved. Simple and readable beats detailed.`;

async function drawFigure(ai, page, caption, log) {
  const b64 = fs.readFileSync(page.file).toString("base64");
  const out = await ai.chat([
    { role: "system", content: DRAW_SYSTEM },
    { role: "user", content: [
      { type: "text", text: `Redraw the diagram on this page${caption ? " (" + caption + ")" : ""} as SVG. Ignore the handwritten text below the drawing.` },
      { type: "image_url", image_url: { url: "data:image/jpeg;base64," + b64, detail: "high" } }
    ] }
  ], { maxTokens: 2500, temperature: 0.1 });
  const m = String(out).match(/<svg[\s\S]*<\/svg>/i);
  if (!m) throw new Error("no SVG returned");
  const svg = cleanSVG(m[0]);
  if (!/<(line|polygon|polyline|path|circle|rect|ellipse)\b/i.test(svg)) throw new Error("SVG had nothing drawn in it");
  const bm = String(out).match(/BOUNDS\s+top=(\d+(?:\.\d+)?)\s+bottom=(\d+(?:\.\d+)?)/i);
  const bounds = bm && Number(bm[2]) > Number(bm[1]) ? { top: Number(bm[1]), bottom: Number(bm[2]) } : null;
  return { svg, bounds };
}

// AI-written SVG is untrusted markup: strip anything that could run or load.
function cleanSVG(svg) {
  return String(svg)
    .replace(/<\s*(script|foreignObject|iframe|object|embed|animate|set|handler)[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
    .replace(/<\s*(script|foreignObject|iframe|object|embed|use|image)\b[^>]*\/?>/gi, "")
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(href|xlink:href|src)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/javascript:/gi, "")
    .slice(0, 60000);
}

// Cuts the band of the original page where the AI says a diagram sits, so the
// student's own drawing appears in the notes rather than a redrawn guess.
async function cropFigures(markdown, pages, figuresDir) {
  const re = /\[\[DIAGRAM\s+page=(\d+)\s+top=(\d+(?:\.\d+)?)\s+bottom=(\d+(?:\.\d+)?)(?:\s+caption=([^\]]*))?\]\]/g;
  const jobs = [...markdown.matchAll(re)];
  for (const m of jobs) {
    const [whole, pageNo, topS, botS, capRaw] = m;
    const page = pages.find(p => p.page === Number(pageNo)) || pages[0];
    let top = Math.max(0, Math.min(95, Number(topS) - 2));   // a little air above
    let bottom = Math.min(100, Math.max(top + 8, Number(botS))); // no padding below: that is where the writing starts
    const caption = (capRaw || "Diagram from the original page").trim();
    try {
      const { stdout } = await run("identify", ["-format", "%w %h", page.file]);
      const [w, h] = stdout.trim().split(/\s+/).map(Number);
      const y = Math.round(h * top / 100), hh = Math.max(40, Math.round(h * (bottom - top) / 100));
      const name = require("crypto").randomBytes(12).toString("hex") + ".jpg";
      await run("convert", [page.file, "-crop", `${w}x${hh}+0+${y}`, "+repage", "-quality", "82", path.join(figuresDir, name)]);
      markdown = markdown.replace(whole, `![${caption}](/api/fig/${name})\n\n*${caption}*`);
    } catch (e) {
      markdown = markdown.replace(whole, `*${caption}. See the original page in this unit's Raw tab.*`);
    }
  }
  return markdown;
}

async function convert(ai, files, { detail = "high", summary = false, label = "", figuresDir = null, draw = true, ocr = null, log = () => {} } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "astron-conv-"));
  try {
    // Collect every page across every selected file, in order.
    const pages = [];
    for (const f of files) {
      const dir = fs.mkdtempSync(path.join(tmp, "f-"));
      const imgs = await pageImages(f.path, f.ext, dir, detail);
      for (const im of imgs) {
        if (pages.length >= MAX_PAGES) break;
        pages.push({ ...im, title: f.title, ocr: (f.textByPage && f.textByPage[im.page]) || "" });
      }
    }
    if (!pages.length) throw new Error("Nothing readable in those files.");

    const parts = [];
    for (let i = 0; i < pages.length; i += PAGES_PER_CALL) {
      const batch = pages.slice(i, i + PAGES_PER_CALL);
      const content = [{
        type: "text",
        text: `${label ? "These pages are from: " + label + ".\n" : ""}Type up ${batch.length === 1 ? "this page" : "these " + batch.length + " pages"} as clean notes.` +
          (i > 0 ? " Continue from the previous pages; do not repeat a heading already written." : "")
      }];
      for (const p of batch) {
        content.push({ type: "text", text: `--- Page ${p.page}${p.ocr ? ", text read by OCR (may be garbled, the image is authoritative):\n" + p.ocr.slice(0, 3000) : ""}` });
        content.push({ type: "image_url", image_url: { url: "data:image/jpeg;base64," + fs.readFileSync(p.file).toString("base64"), detail } });
      }
      log(`Converting pages ${batch[0].page}-${batch[batch.length - 1].page}…`);
      parts.push(await ai.chat([{ role: "system", content: SYSTEM }, { role: "user", content }], { maxTokens: 3000, temperature: 0.1 }));
    }

    let markdown = parts.join("\n\n").replace(/```(markdown|latex)\n?/g, "").trim();
    markdown = markdown.replace(/```svg\s*([\s\S]*?)```/gi, (m, svg) => "```svg\n" + cleanSVG(svg).trim() + "\n```");
    // A separate, single-purpose call per figure: far more reliable than asking
    // for the drawing as part of the typing-up job.
    if (draw) {
      const marks = [...markdown.matchAll(/\[\[DIAGRAM\s+page=(\d+)[^\]]*?(?:caption=([^\]]*))?\]\]/g)];
      for (const m of marks.slice(0, 4)) {
        const page = pages.find(p => p.page === Number(m[1])) || pages[0];
        try {
          log("Drawing the figure on page " + page.page + "…");
          const { svg, bounds } = await drawFigure(ai, page, (m[2] || "").trim(), log);
          // The drawing pass looked closely at the figure, so trust its bounds over
          // the rougher estimate made while typing up the text.
          const marker = bounds
            ? m[0].replace(/top=\d+(?:\.\d+)?/, "top=" + bounds.top).replace(/bottom=\d+(?:\.\d+)?/, "bottom=" + bounds.bottom)
            : m[0];
          markdown = markdown.replace(m[0], "```svg\n" + svg + "\n```\n\n" + marker);
        } catch (e) { log("Couldn't redraw that figure: " + e.message); }
      }
    }
    if (figuresDir) markdown = await cropFigures(markdown, pages, figuresDir);

    if (summary) {
      const head = await ai.chat([
        { role: "system", content: "You write short revision summaries of study notes. Use Markdown, keep maths in LaTeX with $...$, and stay under 120 words." },
        { role: "user", content: "Write a short summary of the key points to remember, for the top of these notes:\n\n" + markdown.slice(0, 12000) }
      ], { maxTokens: 500, temperature: 0.2 });
      markdown = "## In short\n\n" + head.trim() + "\n\n---\n\n" + markdown;
    }
    return { markdown, pageCount: pages.length };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = { convert, cleanSVG, MAX_PAGES };
