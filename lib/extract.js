// Pulls readable text out of uploaded notes so the AI can search them.
// Typed PDFs: text is read directly with pdftotext.
// Scanned or handwritten PDFs and photos: each page becomes an image and is
// sent to OCR: Azure Document Intelligence, your own vision model, or Tesseract.
const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { promisify } = require("util");
const run = promisify(execFile);

const MIN_CHARS_PER_PAGE = 40; // less than this means "probably a scan"
const MAX_OCR_PAGES = 60;      // guards the OCR bill on huge uploads

async function pdfPageCount(file) {
  const { stdout } = await run("pdfinfo", [file]);
  const m = stdout.match(/Pages:\s+(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

async function pdfPageText(file, page) {
  const { stdout } = await run("pdftotext", ["-f", String(page), "-l", String(page), "-layout", file, "-"], { maxBuffer: 16 * 1024 * 1024 });
  return stdout.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

async function pdfPageToJpeg(file, page, dir) {
  const base = path.join(dir, "p" + page);
  await run("pdftoppm", ["-f", String(page), "-l", String(page), "-r", "150", "-jpeg", "-jpegopt", "quality=80", "-singlefile", file, base]);
  return base + ".jpg";
}

async function shrinkImage(src, dir) {
  // Textract's direct API takes images up to 5 MB; phone photos can be bigger.
  const out = path.join(dir, "img.jpg");
  await run("convert", [src, "-auto-orient", "-resize", "2200x2200>", "-quality", "82", out]);
  return out;
}

// ---- OCR engines ----
// Azure AI Document Intelligence: reads print AND handwriting, and takes a whole
// PDF at once, so the small VM never has to render pages itself.
async function azureRead(bytes, mime, di = {}) {
  const base = String(di.endpoint || "").replace(/\/+$/, "");
  const key = di.key || "";
  const version = di.version || "2024-11-30";
  if (!base || !key) throw new Error("Document Intelligence isn't set up: add its address and key on the Settings page.");
  const url = `${base}/documentintelligence/documentModels/prebuilt-read:analyze?api-version=${version}`;
  const start = await fetch(url, {
    method: "POST",
    headers: { "Ocp-Apim-Subscription-Key": key, "Content-Type": mime || "application/octet-stream" },
    body: bytes
  });
  if (start.status === 401 || start.status === 403) throw new Error("Document Intelligence refused the key (" + start.status + "). Check AZURE_DI_KEY.");
  if (!start.ok && start.status !== 202) {
    const t = await start.text().catch(() => "");
    throw new Error("Document Intelligence error " + start.status + ": " + t.slice(0, 200));
  }
  const poll = start.headers.get("operation-location");
  if (!poll) throw new Error("Document Intelligence didn't return a result link.");
  for (let i = 0; i < 60; i++) {                     // up to ~2 minutes
    await new Promise(r => setTimeout(r, i < 5 ? 1000 : 3000));
    const res = await fetch(poll, { headers: { "Ocp-Apim-Subscription-Key": key } });
    const data = await res.json().catch(() => ({}));
    if (data.status === "succeeded") {
      const pages = (data.analyzeResult && data.analyzeResult.pages) || [];
      return pages.map(p => ({
        page: p.pageNumber,
        text: (p.lines || []).map(l => l.content).join("\n").trim()
      }));
    }
    if (data.status === "failed") throw new Error("Document Intelligence couldn't read the file: " + JSON.stringify(data.error || {}).slice(0, 200));
  }
  throw new Error("Document Intelligence took too long.");
}

async function ocrWithAI(jpegPath, ai) {
  const b64 = fs.readFileSync(jpegPath).toString("base64");
  return ai.chat([
    { role: "system", content: "You transcribe photos of study notes. Output only the text you can read, in reading order. Write equations in plain text. Do not add commentary." },
    { role: "user", content: [
      { type: "text", text: "Transcribe this page." },
      { type: "image_url", image_url: { url: "data:image/jpeg;base64," + b64 } }
    ] }
  ], { maxTokens: 2000, temperature: 0 });
}

// Free and local. Good on printed text, weak on handwriting.
async function ocrTesseract(jpegPath) {
  try {
    const { stdout } = await run("tesseract", [jpegPath, "stdout", "--psm", "6"], { maxBuffer: 8 * 1024 * 1024 });
    return stdout.trim();
  } catch (e) {
    if (/ENOENT/.test(e.message)) throw new Error("Tesseract isn't installed on this server (sudo apt-get install -y tesseract-ocr).");
    throw e;
  }
}

async function ocr(jpegPath, engine, ai) {
  if (engine === "tesseract") return ocrTesseract(jpegPath);
  if (engine === "ai") return ocrWithAI(jpegPath, ai);
  return "";
}

// Returns { pages: [{ page, text }], ocrPages }
async function extract(filePath, mime, ext, { engine = "azure", di = {}, ai = null, log = () => {} } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "astron-"));
  const pages = [];
  let ocrPages = 0;
  try {
    if (ext === "pdf") {
      const n = await pdfPageCount(filePath);
      for (let p = 1; p <= n; p++) pages.push({ page: p, text: await pdfPageText(filePath, p) });
      const thin = pages.filter(p => p.text.length < MIN_CHARS_PER_PAGE);
      if (thin.length && engine !== "off") {
        if (engine === "azure") {
          // One call for the whole document: cheaper, and no image work on the server.
          try {
            const read = await azureRead(fs.readFileSync(filePath), "application/pdf", di);
            for (const r of read) {
              const slot = pages.find(x => x.page === r.page);
              if (slot && r.text.length > slot.text.length) { slot.text = r.text; ocrPages++; }
            }
          } catch (e) { log("Document Intelligence failed: " + e.message); }
        } else {
          for (const slot of thin) {
            if (ocrPages >= MAX_OCR_PAGES) break;
            try {
              const jpg = await pdfPageToJpeg(filePath, slot.page, tmp);
              const read = await ocr(jpg, engine, ai);
              if (read && read.trim().length > slot.text.length) { slot.text = read.trim(); ocrPages++; }
            } catch (e) { log("OCR failed on page " + slot.page + ": " + e.message); }
          }
        }
      }
    } else if (/^image\//.test(mime)) {
      if (engine !== "off") {
        try {
          if (engine === "azure") {
            const read = await azureRead(fs.readFileSync(filePath), mime, di);
            pages.push({ page: 1, text: read.map(r => r.text).join("\n").trim() });
          } else {
            const jpg = await shrinkImage(filePath, tmp);
            pages.push({ page: 1, text: ((await ocr(jpg, engine, ai)) || "").trim() });
          }
          ocrPages = 1;
        } catch (e) { log("OCR failed on image: " + e.message); pages.push({ page: 1, text: "" }); }
      }
    } else if (/^(c|cpp|h|py|java|txt|md)$/.test(ext)) {
      pages.push({ page: 1, text: fs.readFileSync(filePath, "utf8").slice(0, 200000) });
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return { pages, ocrPages };
}

// Splits page text into overlapping pieces the search can rank.
function chunk(pages, size = 1400, overlap = 200) {
  const out = [];
  for (const { page, text } of pages) {
    if (!text) continue;
    for (let i = 0; i < text.length; i += size - overlap) {
      const piece = text.slice(i, i + size).trim();
      if (piece.length > 30) out.push({ page, text: piece });
      if (i + size >= text.length) break;
    }
  }
  return out;
}

module.exports = { extract, chunk };
