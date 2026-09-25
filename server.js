// Astron server. One process serves the website and its API.
require("dotenv").config();
const express = require("express");
const cookieParser = require("cookie-parser");
const multer = require("multer");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { open, getSetting, setSetting } = require("./lib/db");
const { extract, chunk } = require("./lib/extract");
const AI = require("./lib/ai");
const { convert, MAX_PAGES } = require("./lib/convert");

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, "data"));
const FILES_DIR = path.join(DATA_DIR, "files");
const FIG_DIR = path.join(DATA_DIR, "figures");


const COOKIE_SECURE = process.env.COOKIE_SECURE === "true";

// What course this site is for: years, subjects, labs and syllabus. See docs/CATALOG.md.
const CATALOG_PATH = process.env.CATALOG || path.join(__dirname, "config", "catalog.example.json");
let CATALOG = null, catalogError = null;
function loadCatalog() {
  try {
    CATALOG = JSON.parse(fs.readFileSync(CATALOG_PATH, "utf8"));
    const n = (CATALOG.subjects || []).length;
    if (!n) throw new Error("no subjects in it");
    catalogError = null;
    return n;
  } catch (e) {
    catalogError = e.message;
    CATALOG = null;
    return 0;
  }
}
const SESSION_DAYS = 30;
fs.mkdirSync(FILES_DIR, { recursive: true });
fs.mkdirSync(FIG_DIR, { recursive: true });

const db = open(DATA_DIR);

// Settings can be changed on the site; .env is only the starting point.
const DEFAULTS = {
  site_name: process.env.SITE_NAME || "Astron",
  storage_limit_mb: process.env.STORAGE_LIMIT_MB || 5120,
  max_file_mb: process.env.MAX_FILE_MB || 25,
  ai_daily_limit: process.env.AI_DAILY_LIMIT || 40,
  ai_base_url: process.env.AI_BASE_URL || "",
  ai_model: process.env.AI_MODEL || "",
  ai_key: process.env.AI_API_KEY || "",
  ai_format: process.env.AI_FORMAT || "auto",
  ai_api_version: process.env.AI_API_VERSION || "2024-10-21",
  ocr_engine: process.env.OCR_ENGINE || "azure",
  di_endpoint: process.env.AZURE_DI_ENDPOINT || "",
  di_key: process.env.AZURE_DI_KEY || "",
  di_api_version: process.env.AZURE_DI_API_VERSION || "2024-11-30",
  allow_download: process.env.ALLOW_DOWNLOAD || "admin"   // admin | everyone
};
const cfg = k => { const v = getSetting(db, k, undefined); return v === undefined || v === null ? DEFAULTS[k] : v; };
const cfgNum = (k, min, max) => { const n = Number(cfg(k)); return isFinite(n) ? Math.min(max, Math.max(min, n)) : Number(DEFAULTS[k]); };
const SECRETS = ["ai_key", "di_key"];

const ai = AI.client(() => ({
  baseUrl: cfg("ai_base_url"), model: cfg("ai_model"), key: cfg("ai_key"),
  format: cfg("ai_format"), apiVersion: cfg("ai_api_version")
}));
const ocrOptions = () => ({
  engine: cfg("ocr_engine"),
  di: { endpoint: cfg("di_endpoint"), key: cfg("di_key"), version: cfg("di_api_version") }
});
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------- first run: create the admin ----------
if (!db.prepare("SELECT 1 FROM users WHERE role = 'admin'").get()) {
  const u = (process.env.ADMIN_USERNAME || "admin").toLowerCase();
  const p = process.env.ADMIN_PASSWORD;
  if (!p || p.length < 8) { console.error("Set ADMIN_PASSWORD (8+ characters) in .env for the first run."); process.exit(1); }
  db.prepare("INSERT INTO users(username,name,role,pass_hash,must_change,created_at) VALUES(?,?,?,?,1,?)")
    .run(u, process.env.ADMIN_NAME || "Admin", "admin", bcrypt.hashSync(p, 12), Date.now());
  log("Created admin account @" + u + ". You'll be asked to change the password on first login.");
}

const catalogCount = loadCatalog();
if (catalogError) console.error(`Could not read the catalog at ${CATALOG_PATH}: ${catalogError}`);
else log(`Catalog: ${catalogCount} subjects and labs from ${path.basename(CATALOG_PATH)}`);

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(express.json({ limit: "200kb" }));
app.use(cookieParser());
app.use((req, res, next) => {
  res.set("X-Content-Type-Options", "nosniff");
  res.set("Referrer-Policy", "same-origin");
  next();
});

// ---------- helpers ----------
const USERNAME = /^[a-z0-9._]{3,20}$/;
const SUBJECT = /^[a-z0-9]{2,12}$/;
const KINDS = ["notes", "hw", "lab", "raw", "pyq"];   // pyq = past question papers
const bad = (res, code, msg) => res.status(code).json({ error: msg });
const pub = u => u && { id: u.id, username: u.username, name: u.name, role: u.role, mustChange: !!u.must_change };
const today = () => new Date().toISOString().slice(0, 10);
const passwordProblem = p => !p || p.length < 8 ? "Passwords need at least 8 characters." : p.length > 100 ? "That password is too long." : null;

function newSession(res, userId) {
  const id = crypto.randomBytes(32).toString("hex");
  const now = Date.now();
  db.prepare("INSERT INTO sessions(id,user_id,created_at,expires_at) VALUES(?,?,?,?)").run(id, userId, now, now + SESSION_DAYS * 864e5);
  res.cookie("astron", id, { httpOnly: true, sameSite: "lax", secure: COOKIE_SECURE, maxAge: SESSION_DAYS * 864e5, path: "/" });
}

function auth(req, res, next) {
  const sid = req.cookies.astron;
  if (!sid) return bad(res, 401, "Please sign in.");
  const row = db.prepare("SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > ?").get(sid, Date.now());
  if (!row) { res.clearCookie("astron"); return bad(res, 401, "Your session ended. Please sign in again."); }
  req.user = row;
  if (!row.last_seen || Date.now() - row.last_seen > 60000) db.prepare("UPDATE users SET last_seen = ? WHERE id = ?").run(Date.now(), row.id);
  next();
}
// Until the temporary password is changed, only the password endpoint works.
const ready = (req, res, next) => req.user.must_change ? bad(res, 403, "Choose a new password first.") : next();
const adminOnly = (req, res, next) => req.user.role === "admin" ? next() : bad(res, 403, "Only the admin can do that.");

// Simple login throttle: 8 tries per username+IP every 15 minutes.
const tries = new Map();
function throttled(key) {
  const now = Date.now(), t = (tries.get(key) || []).filter(x => now - x < 15 * 60000);
  tries.set(key, t);
  return t.length >= 8;
}

// ---------- storage ----------
function usedBytes() { return db.prepare("SELECT COALESCE(SUM(bytes),0) AS b FROM files").get().b; }
function storage() {
  const limitMB = cfgNum("storage_limit_mb", 50, 1e6);
  const st = fs.statfsSync(FILES_DIR);
  const diskTotalMB = st.blocks * st.bsize / 1048576;
  const diskFreeMB = st.bavail * st.bsize / 1048576;
  const usedMB = usedBytes() / 1048576;
  // What the site can really use: your limit, capped by what the disk can hold.
  const allocatedMB = Math.min(limitMB, usedMB + Math.max(0, diskFreeMB - 500)); // keep 500 MB for the system
  return { limitMB, allocatedMB, usedMB, freeMB: Math.max(0, allocatedMB - usedMB), diskTotalMB, diskFreeMB, maxFileMB: cfgNum("max_file_mb", 1, 500),
    byKind: Object.fromEntries(KINDS.map(k => [k, db.prepare("SELECT COALESCE(SUM(bytes),0) AS b FROM files WHERE kind = ?").get(k).b / 1048576])) };
}

// ---------- indexing ----------
function indexText(fileId, pages, subject, sem, unit) {
  const ins = db.prepare("INSERT INTO chunks(text,file_id,page,subject,sem,unit) VALUES(?,?,?,?,?,?)");
  const pieces = chunk(pages);
  db.transaction(() => {
    db.prepare("DELETE FROM chunks WHERE file_id = ?").run(fileId);
    for (const c of pieces) ins.run(c.text, fileId, c.page, subject, sem, unit);
  })();
  return pieces.length;
}

// ---------- text extraction queue ----------
let working = false;
async function processQueue() {
  if (working) return; working = true;
  try {
    let f;
    while ((f = db.prepare("SELECT * FROM files WHERE text_state = 'pending' ORDER BY id LIMIT 1").get())) {
      db.prepare("UPDATE files SET text_state = 'working' WHERE id = ?").run(f.id);
      try {
        const { pages, ocrPages } = await extract(path.join(FILES_DIR, f.stored_as), f.mime, f.ext, { ...ocrOptions(), ai, log });
        const n = indexText(f.id, pages, f.subject, f.sem, f.unit);
        const pieces = { length: n };
        const state = n ? "ready" : "none";
        db.prepare("UPDATE files SET text_state = ?, pages = ? WHERE id = ?").run(state, pages.length || null, f.id);
        log(`Read #${f.id} "${f.title}": ${pieces.length} pieces${ocrPages ? ", " + ocrPages + " pages by OCR" : ""}`);
      } catch (e) {
        db.prepare("UPDATE files SET text_state = 'failed' WHERE id = ?").run(f.id);
        log(`Could not read #${f.id}: ${e.message}`);
      }
    }
  } finally { working = false; }
}
db.prepare("UPDATE files SET text_state = 'pending' WHERE text_state = 'working'").run();
setTimeout(processQueue, 2000);

// ================= API =================
const api = express.Router();

api.get("/site", (req, res) => res.json({ name: cfg("site_name") }));

// The course this site covers. Everyone signed in reads the same catalog.
api.get("/catalog", auth, (req, res) => {
  if (!CATALOG) return bad(res, 500, "The catalog file couldn't be read: " + catalogError);
  res.json(CATALOG);
});

api.post("/login", (req, res) => {
  const username = String(req.body.username || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  const key = username + "|" + req.ip;
  if (throttled(key)) return bad(res, 429, "Too many tries. Wait 15 minutes, or ask the admin to reset your password.");
  const u = db.prepare("SELECT * FROM users WHERE username = ?").get(username);
  if (!u || !bcrypt.compareSync(password, u.pass_hash)) {
    tries.get(key).push(Date.now());
    return bad(res, 401, "That username and password don't match.");
  }
  tries.delete(key);
  newSession(res, u.id);
  db.prepare("UPDATE users SET last_seen = ? WHERE id = ?").run(Date.now(), u.id);
  res.json({ user: pub(u) });
});

api.post("/logout", (req, res) => {
  if (req.cookies.astron) db.prepare("DELETE FROM sessions WHERE id = ?").run(req.cookies.astron);
  res.clearCookie("astron"); res.json({ ok: true });
});

api.get("/me", auth, (req, res) => res.json({ user: pub(req.user), allowDownload: cfg("allow_download"), ai: { ready: ai.ready, dailyLimit: cfgNum("ai_daily_limit", 0, 1000),
  usedToday: (db.prepare("SELECT count FROM ai_usage WHERE user_id = ? AND day = ?").get(req.user.id, today()) || { count: 0 }).count } }));

api.post("/me/password", auth, (req, res) => {
  const { current, next } = req.body || {};
  if (!bcrypt.compareSync(String(current || ""), req.user.pass_hash)) return bad(res, 400, "Your current password isn't right.");
  const p = passwordProblem(next); if (p) return bad(res, 400, p);
  if (current === next) return bad(res, 400, "Pick a password different from the current one.");
  db.prepare("UPDATE users SET pass_hash = ?, must_change = 0 WHERE id = ?").run(bcrypt.hashSync(next, 12), req.user.id);
  // Sign out other devices, keep this one.
  db.prepare("DELETE FROM sessions WHERE user_id = ? AND id != ?").run(req.user.id, req.cookies.astron);
  res.json({ ok: true });
});

// ---- people (admin) ----
api.get("/users", auth, ready, adminOnly, (req, res) => {
  res.json({ users: db.prepare(`SELECT u.id,u.username,u.name,u.role,u.must_change AS mustChange,u.last_seen AS lastSeen,u.created_at AS createdAt,
    (SELECT COUNT(*) FROM files f WHERE f.uploader_id = u.id AND f.kind = 'raw') AS rawSent FROM users u ORDER BY u.role, u.name`).all() });
});
api.post("/users", auth, ready, adminOnly, (req, res) => {
  const name = String(req.body.name || "").trim().slice(0, 40);
  const username = String(req.body.username || "").trim().toLowerCase();
  const temp = String(req.body.tempPassword || "");
  if (!name) return bad(res, 400, "Add their name.");
  if (!USERNAME.test(username)) return bad(res, 400, "Usernames are 3 to 20 characters: lowercase letters, numbers, dots or underscores.");
  const p = passwordProblem(temp); if (p) return bad(res, 400, p);
  if (db.prepare("SELECT 1 FROM users WHERE username = ?").get(username)) return bad(res, 400, "@" + username + " is already taken.");
  db.prepare("INSERT INTO users(username,name,role,pass_hash,must_change,created_at) VALUES(?,?,?,?,1,?)").run(username, name, "friend", bcrypt.hashSync(temp, 12), Date.now());
  res.json({ ok: true });
});
api.post("/users/:id/reset", auth, ready, adminOnly, (req, res) => {
  const u = db.prepare("SELECT * FROM users WHERE id = ?").get(req.params.id);
  if (!u) return bad(res, 404, "No such person.");
  const p = passwordProblem(req.body.tempPassword); if (p) return bad(res, 400, p);
  db.prepare("UPDATE users SET pass_hash = ?, must_change = 1 WHERE id = ?").run(bcrypt.hashSync(req.body.tempPassword, 12), u.id);
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(u.id);
  res.json({ ok: true });
});
api.patch("/users/:id/role", auth, ready, adminOnly, (req, res) => {
  const u = db.prepare("SELECT * FROM users WHERE id = ?").get(req.params.id);
  if (!u) return bad(res, 404, "No such person.");
  const role = req.body.role === "admin" ? "admin" : "friend";
  if (role === "friend") {
    const admins = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get().n;
    if (u.role === "admin" && admins <= 1) return bad(res, 400, "Someone has to stay admin. Make another person an admin first.");
  }
  db.prepare("UPDATE users SET role = ? WHERE id = ?").run(role, u.id);
  log(`@${req.user.username} made @${u.username} ${role === "admin" ? "an admin" : "a friend"}`);
  res.json({ ok: true, role });
});

api.delete("/users/:id", auth, ready, adminOnly, (req, res) => {
  const u = db.prepare("SELECT * FROM users WHERE id = ?").get(req.params.id);
  if (!u) return bad(res, 404, "No such person.");
  if (u.id === req.user.id) return bad(res, 400, "You can't remove your own account.");
  const admins = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get().n;
  if (u.role === "admin" && admins <= 1) return bad(res, 400, "That's the only admin left.");
  db.prepare("DELETE FROM users WHERE id = ?").run(u.id);
  res.json({ ok: true });
});

// ---- files ----
api.get("/files", auth, ready, (req, res) => {
  const rows = db.prepare(`SELECT f.id,f.kind,f.subject,f.sem,f.unit,f.title,f.ext,f.mime,f.bytes,f.status,f.tag,f.text_state AS textState,f.pages,
      f.created_at AS createdAt, COALESCE(u.name,'someone') AS who, u.id = ? AS mine,
      EXISTS(SELECT 1 FROM stars s WHERE s.file_id = f.id AND s.user_id = ?) AS starred,
      EXISTS(SELECT 1 FROM hw_done h WHERE h.file_id = f.id AND h.user_id = ?) AS done
    FROM files f LEFT JOIN users u ON u.id = f.uploader_id ORDER BY f.created_at DESC`).all(req.user.id, req.user.id, req.user.id);
  res.json({ files: rows });
});

const upload = multer({
  storage: multer.diskStorage({
    destination: FILES_DIR,
    filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString("hex"))
  }),
  limits: { fileSize: cfgNum("max_file_mb", 1, 500) * 1048576, files: 20 }
});

api.post("/files", auth, ready, (req, res) => {
  // Accepts one file or twenty. Each is checked on its own, so one bad file
  // doesn't stop the rest, and the storage limit is applied across the batch.
  upload.any()(req, res, err => {
    const files = req.files || [];
    const dropAll = () => files.forEach(f => fs.rmSync(f.path, { force: true }));
    if (err) {
      dropAll();
      return bad(res, 400, err.code === "LIMIT_FILE_SIZE"
        ? `One of those files is over the ${cfgNum("max_file_mb", 1, 500)} MB limit. Compress it first.`
        : "Upload failed: " + err.message);
    }
    if (!files.length) return bad(res, 400, "No files received.");
    const b = req.body;
    const kind = req.user.role === "admin" ? b.kind : "raw"; // friends can only send raw
    const subject = String(b.subject || ""), sem = parseInt(b.sem, 10), unit = parseInt(b.unit, 10);
    if (!KINDS.includes(kind) || !SUBJECT.test(subject) || !(sem >= 1 && sem <= 20) || !(unit >= 0 && unit <= 99)) {
      dropAll(); return bad(res, 400, "Pick a subject, semester, unit and type.");
    }
    const okExt = req.user.role === "admin" ? /^(pdf|jpe?g|png|webp|heic|c|cpp|h|py|java|txt|md|zip)$/ : /^(pdf|jpe?g|png|webp|heic)$/;
    const saved = [], failed = [];
    let freeMB = storage().freeMB;

    for (const f of files) {
      const ext = (path.extname(f.originalname).slice(1) || "file").toLowerCase().slice(0, 8);
      const sizeMB = f.size / 1048576;
      const fail = why => { fs.rmSync(f.path, { force: true }); failed.push({ name: f.originalname, error: why }); };
      if (!okExt.test(ext)) { fail(req.user.role === "admin" ? "that file type isn't supported" : "friends can send PDFs and photos"); continue; }
      if (sizeMB > freeMB) { fail(`not enough space left (${freeMB.toFixed(1)} MB free)`); continue; }
      const title = String(f.originalname).replace(/\.[^.]+$/, "").trim().slice(0, 120) || "Untitled";
      const info = db.prepare(`INSERT INTO files(kind,subject,sem,unit,title,ext,mime,bytes,stored_as,uploader_id,status,tag,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(kind, subject, sem, unit, title, ext, f.mimetype || "application/octet-stream",
        f.size, f.filename, req.user.id, kind === "raw" ? "new" : null, null, Date.now());
      saved.push({ id: info.lastInsertRowid, name: f.originalname });
      freeMB -= sizeMB;
    }
    if (saved.length) setImmediate(processQueue);
    res.json({ saved, failed, count: saved.length });
  });
});

// Diagrams cut from the original pages.
api.get("/fig/:name", auth, ready, (req, res) => {
  if (!/^[0-9a-f]{24}\.jpg$/.test(req.params.name)) return bad(res, 400, "No such image.");
  const f = path.join(FIG_DIR, req.params.name);
  if (!fs.existsSync(f)) return bad(res, 404, "That diagram is gone.");
  res.set({ "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=86400" });
  res.sendFile(f);
});

// Diagrams from conversions that were never saved get cleared out after a week.
setInterval(() => {
  try {
    const used = new Set();
    for (const r of db.prepare("SELECT stored_as FROM files WHERE ext = 'md'").all()) {
      const md = fs.readFileSync(path.join(FILES_DIR, r.stored_as), "utf8");
      for (const m of md.matchAll(/\/api\/fig\/([0-9a-f]{24}\.jpg)/g)) used.add(m[1]);
    }
    for (const name of fs.readdirSync(FIG_DIR)) {
      const p = path.join(FIG_DIR, name);
      if (!used.has(name) && Date.now() - fs.statSync(p).mtimeMs > 7 * 864e5) fs.rmSync(p, { force: true });
    }
  } catch (e) { log("Figure tidy-up skipped:", e.message); }
}, 24 * 3600 * 1000).unref();

// View only: served inline, never as a download, and not cached.
api.get("/files/:id/view", auth, ready, (req, res) => {
  const f = db.prepare("SELECT * FROM files WHERE id = ?").get(req.params.id);
  if (!f) return bad(res, 404, "File not found.");
  res.set({ "Content-Type": f.mime, "Content-Disposition": "inline", "Cache-Control": "private, no-store", "X-Frame-Options": "SAMEORIGIN" });
  res.sendFile(path.join(FILES_DIR, f.stored_as));
});

api.get("/files/:id/text", auth, ready, (req, res) => {
  const f = db.prepare("SELECT * FROM files WHERE id = ?").get(req.params.id);
  if (!f) return bad(res, 404, "File not found.");
  if (!/^(c|cpp|h|py|java|txt|md)$/.test(f.ext)) return bad(res, 400, "Not a text file.");
  res.type("text/plain").send(fs.readFileSync(path.join(FILES_DIR, f.stored_as), "utf8").slice(0, 300000));
});

// Each person ticks off their own homework.
api.post("/files/:id/done", auth, ready, (req, res) => {
  const f = db.prepare("SELECT * FROM files WHERE id = ?").get(req.params.id);
  if (!f) return bad(res, 404, "File not found.");
  if (f.kind !== "hw" && f.kind !== "lab") return bad(res, 400, "Only homework and lab work can be ticked off.");
  if (req.body.done) db.prepare("INSERT OR IGNORE INTO hw_done(user_id,file_id,done_at) VALUES(?,?,?)").run(req.user.id, f.id, Date.now());
  else db.prepare("DELETE FROM hw_done WHERE user_id = ? AND file_id = ?").run(req.user.id, f.id);
  res.json({ ok: true });
});

api.post("/files/:id/star", auth, ready, (req, res) => {
  const on = !!req.body.on;
  if (on) db.prepare("INSERT OR IGNORE INTO stars(user_id,file_id) VALUES(?,?)").run(req.user.id, req.params.id);
  else db.prepare("DELETE FROM stars WHERE user_id = ? AND file_id = ?").run(req.user.id, req.params.id);
  res.json({ ok: true });
});

api.patch("/files/:id", auth, ready, adminOnly, (req, res) => {
  const f = db.prepare("SELECT * FROM files WHERE id = ?").get(req.params.id);
  if (!f) return bad(res, 404, "File not found.");
  const b = req.body || {};
  if (b.status !== undefined && ["new", "used", "skip"].includes(b.status)) db.prepare("UPDATE files SET status = ? WHERE id = ?").run(b.status, f.id);
  if (b.tag !== undefined) db.prepare("UPDATE files SET tag = ? WHERE id = ?").run(b.tag ? String(b.tag).slice(0, 20) : null, f.id);
  if (b.title) db.prepare("UPDATE files SET title = ? WHERE id = ?").run(String(b.title).slice(0, 120), f.id);
  res.json({ ok: true });
});

api.delete("/files/:id", auth, ready, adminOnly, (req, res) => {
  const f = db.prepare("SELECT * FROM files WHERE id = ?").get(req.params.id);
  if (!f) return bad(res, 404, "File not found.");
  db.transaction(() => { db.prepare("DELETE FROM chunks WHERE file_id = ?").run(f.id); db.prepare("DELETE FROM files WHERE id = ?").run(f.id); })();
  fs.rmSync(path.join(FILES_DIR, f.stored_as), { force: true });
  res.json({ ok: true });
});

// ---------- the course catalog ----------
// How many files sit under each subject and unit, so the admin can see what a
// deletion would take with it.
api.get("/catalog/usage", auth, ready, adminOnly, (req, res) => {
  const rows = db.prepare("SELECT subject, sem, unit, COUNT(*) AS n FROM files GROUP BY subject, sem, unit").all();
  const out = {};
  for (const r of rows) {
    out[r.subject] = out[r.subject] || { files: 0, units: {} };
    out[r.subject].files += r.n;
    out[r.subject].units[r.sem + ":" + r.unit] = r.n;
  }
  res.json({ usage: out });
});

api.put("/catalog", auth, ready, adminOnly, (req, res) => {
  const c = req.body && req.body.catalog;
  if (!c || !Array.isArray(c.subjects) || !Array.isArray(c.years)) return bad(res, 400, "That doesn't look like a catalog.");
  for (const k of ["course", "institution", "syllabusNote"]) if (c[k] !== undefined) c[k] = String(c[k]).slice(0, 120);
  if (!c.subjects.length) return bad(res, 400, "A catalog needs at least one subject.");
  for (const y of c.years) {
    if (!(Number(y.y) >= 1 && Number(y.y) <= 20)) return bad(res, 400, "Years are numbered 1 to 20.");
    if (!Array.isArray(y.sems) || !y.sems.length) return bad(res, 400, `"${y.label || ("Year " + y.y)}" needs at least one semester.`);
    if (y.sems.some(n => !(Number(n) >= 1 && Number(n) <= 20))) return bad(res, 400, "Semesters are numbered 1 to 20.");
  }
  const ys = c.years.map(y => Number(y.y));
  if (new Set(ys).size !== ys.length) return bad(res, 400, "Two years share the same number.");
  // Categories: Subjects and Labs by default, but a course can define its own.
  if (c.groups !== undefined) {
    if (!Array.isArray(c.groups) || !c.groups.length) return bad(res, 400, "Categories must be a list, with at least one in it.");
    const gids = new Set();
    for (const g of c.groups) {
      if (!/^[a-z0-9]{2,16}$/.test(String(g.id || ""))) return bad(res, 400, `A category needs an id of 2 to 16 lowercase letters or numbers.`);
      if (gids.has(g.id)) return bad(res, 400, `Two categories share the id "${g.id}".`);
      gids.add(g.id);
      if (!String(g.label || "").trim()) return bad(res, 400, "Every category needs a name.");
      if (g.type && !["theory", "lab"].includes(g.type)) return bad(res, 400, `"${g.label}" must behave like a subject or a lab.`);
    }
  }
  const ids = new Set();
  for (const s of c.subjects) {
    if (!/^[a-z0-9]{2,12}$/.test(String(s.id || ""))) return bad(res, 400, `"${s.name || s.id}" needs an id of 2 to 12 lowercase letters or numbers.`);
    if (ids.has(s.id)) return bad(res, 400, `Two subjects share the id "${s.id}".`);
    ids.add(s.id);
    if (!String(s.name || "").trim()) return bad(res, 400, "Every subject needs a name.");
    if (!Array.isArray(s.sems) || !s.sems.length) return bad(res, 400, `"${s.name}" needs at least one semester.`);
    if (!["theory", "lab"].includes(s.type)) return bad(res, 400, `"${s.name}" must behave like a subject or a lab.`);
    if (s.group !== undefined && c.groups && !c.groups.some(g => g.id === s.group)) return bad(res, 400, `"${s.name}" is in a category that doesn't exist.`);
    s.hidden = !!s.hidden;
  }
  // Files under subjects that no longer exist would be unreachable, so they go.
  const gone = db.prepare("SELECT DISTINCT subject FROM files").all().map(r => r.subject).filter(x => !ids.has(x));
  let removedFiles = 0;
  if (gone.length && req.body.deleteOrphans) {
    for (const subj of gone) {
      for (const f of db.prepare("SELECT * FROM files WHERE subject = ?").all(subj)) {
        fs.rmSync(path.join(FILES_DIR, f.stored_as), { force: true });
        db.prepare("DELETE FROM chunks WHERE file_id = ?").run(f.id);
        db.prepare("DELETE FROM files WHERE id = ?").run(f.id);
        removedFiles++;
      }
    }
  }
  try {
    fs.writeFileSync(CATALOG_PATH + ".tmp", JSON.stringify(c, null, 1), "utf8");
    fs.renameSync(CATALOG_PATH + ".tmp", CATALOG_PATH);
  } catch (e) {
    return bad(res, 500, "Couldn't write the catalog file: " + e.message);
  }
  loadCatalog();
  log(`Catalog saved by @${req.user.username}: ${c.subjects.length} subjects` + (removedFiles ? `, ${removedFiles} orphaned files removed` : ""));
  res.json({ ok: true, subjects: c.subjects.length, removedFiles, orphanSubjects: req.body.deleteOrphans ? [] : gone });
});

// ---------- handwritten pages -> typed notes ----------
api.post("/convert", auth, ready, adminOnly, async (req, res) => {
  if (!ai.ready) return bad(res, 503, "The AI isn't set up on the server yet.");
  const ids = (req.body.fileIds || []).slice(0, 12).map(Number).filter(Boolean);
  if (!ids.length) return bad(res, 400, "Pick at least one uploaded page.");
  const rows = ids.map(id => db.prepare("SELECT * FROM files WHERE id = ?").get(id)).filter(Boolean);
  if (!rows.length) return bad(res, 404, "Those files are gone.");
  const first = rows[0];
  if (rows.some(r => r.subject !== first.subject || r.sem !== first.sem || r.unit !== first.unit))
    return bad(res, 400, "Pick pages from one unit at a time.");
  const files = rows.map(r => {
    const textByPage = {};
    for (const c of db.prepare("SELECT page, text FROM chunks WHERE file_id = ? ORDER BY rowid").all(r.id))
      textByPage[c.page] = (textByPage[c.page] || "") + c.text + "\n";
    return { path: path.join(FILES_DIR, r.stored_as), ext: r.ext, title: r.title, textByPage };
  });
  try {
    const out = await convert(ai, files, {
      ocr: ocrOptions(),
      detail: req.body.detail === "low" ? "low" : "high",
      summary: !!req.body.summary,
      draw: req.body.draw !== false,
      label: String(req.body.label || "").slice(0, 120),
      figuresDir: FIG_DIR,
      log
    });
    res.json({ ...out, sourceIds: rows.map(r => r.id), subject: first.subject, sem: first.sem, unit: first.unit });
  } catch (e) {
    log("Convert failed:", e.message);
    bad(res, 502, e.message);
  }
});

api.post("/notes", auth, ready, adminOnly, (req, res) => {
  const b = req.body || {};
  const subject = String(b.subject || ""), sem = parseInt(b.sem, 10), unit = parseInt(b.unit, 10);
  const markdown = String(b.markdown || "").replace(/```svg\s*([\s\S]*?)```/gi, (m, svg) => "```svg\n" + require("./lib/convert").cleanSVG(svg).trim() + "\n```");
  if (!SUBJECT.test(subject) || !(sem >= 1 && sem <= 20) || !(unit >= 0 && unit <= 99)) return bad(res, 400, "Where do these notes belong?");
  if (markdown.trim().length < 20) return bad(res, 400, "There's nothing to save.");
  const st = storage();
  const bytes = Buffer.byteLength(markdown, "utf8");
  if (bytes / 1048576 > st.freeMB) return bad(res, 400, "Not enough storage space left.");
  const title = String(b.title || "Typed notes").trim().slice(0, 120);
  const stored = crypto.randomBytes(16).toString("hex") + ".md";
  fs.writeFileSync(path.join(FILES_DIR, stored), markdown, "utf8");
  const info = db.prepare("INSERT INTO files(kind,subject,sem,unit,title,ext,mime,bytes,stored_as,uploader_id,status,tag,text_state,pages,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,NULL,?,'ready',NULL,?)")
    .run(b.kind === "pyq" ? "pyq" : "notes", subject, sem, unit, title, "md", "text/markdown", bytes, stored, req.user.id, b.draft === false ? null : "ai draft", Date.now());
  indexText(info.lastInsertRowid, [{ page: 1, text: markdown }], subject, sem, unit);
  for (const id of (b.sourceIds || []).slice(0, 12).map(Number).filter(Boolean))
    db.prepare("UPDATE files SET status = 'used' WHERE id = ? AND kind = 'raw'").run(id);
  res.json({ id: info.lastInsertRowid });
});

api.put("/notes/:id", auth, ready, adminOnly, (req, res) => {
  const f = db.prepare("SELECT * FROM files WHERE id = ? AND ext = 'md'").get(req.params.id);
  if (!f) return bad(res, 404, "Those notes are gone.");
  const b = req.body || {};
  if (typeof b.markdown === "string") {
    if (b.markdown.trim().length < 20) return bad(res, 400, "There's nothing to save.");
    b.markdown = b.markdown.replace(/```svg\s*([\s\S]*?)```/gi, (m, svg) => "```svg\n" + require("./lib/convert").cleanSVG(svg).trim() + "\n```");
    fs.writeFileSync(path.join(FILES_DIR, f.stored_as), b.markdown, "utf8");
    db.prepare("UPDATE files SET bytes = ? WHERE id = ?").run(Buffer.byteLength(b.markdown, "utf8"), f.id);
    indexText(f.id, [{ page: 1, text: b.markdown }], f.subject, f.sem, f.unit);
  }
  if (b.title) db.prepare("UPDATE files SET title = ? WHERE id = ?").run(String(b.title).slice(0, 120), f.id);
  if (b.approve) db.prepare("UPDATE files SET tag = NULL WHERE id = ?").run(f.id);
  res.json({ ok: true });
});

// ---- storage + settings ----
api.get("/storage", auth, ready, (req, res) => res.json(storage()));
// What the admin can see and change. Keys are never sent back to the browser.
api.get("/settings", auth, ready, adminOnly, (req, res) => {
  const out = {};
  for (const k of Object.keys(DEFAULTS)) out[k] = SECRETS.includes(k) ? undefined : String(cfg(k));
  for (const k of SECRETS) out[k + "_set"] = !!String(cfg(k)).trim();
  out.ai_flavour = ai.flavour;
  out.ai_ready = ai.ready;
  out.catalog_path = CATALOG_PATH;
  out.catalog_writable = (() => { try { fs.accessSync(CATALOG_PATH, fs.constants.W_OK); return true; } catch (_) { return false; } })();
  res.json(out);
});

api.put("/settings/all", auth, ready, adminOnly, (req, res) => {
  const b = req.body || {};
  const problems = [];
  const text = (k, max, check) => {
    if (b[k] === undefined) return;
    const v = String(b[k]).slice(0, max).trim();
    if (check && !check(v)) { problems.push(k); return; }
    setSetting(db, k, v);
  };
  const num = (k, min, max) => {
    if (b[k] === undefined || b[k] === "") return;
    const n = Number(b[k]);
    if (!isFinite(n) || n < min || n > max) { problems.push(k); return; }
    setSetting(db, k, Math.round(n));
  };
  text("site_name", 40, v => v.length > 0);
  num("storage_limit_mb", 50, 1e6);
  num("max_file_mb", 1, 500);
  num("ai_daily_limit", 0, 1000);
  text("ai_base_url", 300);
  text("ai_model", 120);
  text("ai_format", 20, v => ["auto", "openai", "azure", "anthropic", "gemini"].includes(v));
  text("ai_api_version", 40);
  text("ocr_engine", 20, v => ["azure", "ai", "tesseract", "off"].includes(v));
  text("allow_download", 20, v => ["admin", "everyone"].includes(v));
  text("di_endpoint", 300);
  text("di_api_version", 40);
  // Secrets are only written when something was actually typed in.
  for (const k of SECRETS) if (typeof b[k] === "string" && b[k].trim()) setSetting(db, k, b[k].trim());
  if (b.clear_ai_key) setSetting(db, "ai_key", "");
  if (b.clear_di_key) setSetting(db, "di_key", "");
  if (problems.length) return bad(res, 400, "These couldn't be saved: " + problems.join(", "));
  res.json({ ok: true, ai_ready: ai.ready, ai_flavour: ai.flavour });
});

// A quick round trip to the provider, so the admin knows the keys work.
api.post("/settings/test-ai", auth, ready, adminOnly, async (req, res) => {
  try {
    const reply = await ai.chat([{ role: "user", content: "Reply with the single word: ready" }], { maxTokens: 20, temperature: 0 });
    res.json({ ok: true, flavour: ai.flavour, model: ai.model, reply: String(reply).trim().slice(0, 80) });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

api.put("/settings", auth, ready, adminOnly, (req, res) => {
  const b = req.body || {};
  if (b.storageLimitMB !== undefined) {
    const v = Number(b.storageLimitMB);
    if (!(v >= 50 && v <= 1e6)) return bad(res, 400, "Storage limit must be at least 50 MB.");
    setSetting(db, "storage_limit_mb", Math.round(v));
  }
  if (b.aiDailyLimit !== undefined) {
    const v = Number(b.aiDailyLimit);
    if (!(v >= 0 && v <= 1000)) return bad(res, 400, "AI limit must be between 0 and 1000.");
    setSetting(db, "ai_daily_limit", Math.round(v));
  }
  res.json({ ok: true, storage: storage() });
});

// ---- AI ----
api.post("/ai", auth, ready, async (req, res) => {
  if (!ai.ready) return bad(res, 503, "The AI isn't set up on the server yet.");
  const limit = cfgNum("ai_daily_limit", 0, 1000);
  const day = today();
  const used = (db.prepare("SELECT count FROM ai_usage WHERE user_id = ? AND day = ?").get(req.user.id, day) || { count: 0 }).count;
  if (req.user.role !== "admin" && used >= limit) return bad(res, 429, `You've used today's ${limit} AI requests. They reset at midnight UTC.`);
  const b = req.body || {};
  if (!["ask", "quiz", "summary", "flashcards", "paper"].includes(b.mode)) return bad(res, 400, "Unknown AI action.");
  if (b.mode === "ask" && !String(b.question || "").trim()) return bad(res, 400, "Type a question.");
  try {
    const out = await AI.run(db, ai, b, {
      siteName: cfg("site_name"),
      course: (CATALOG && CATALOG.course) || "",
      institution: (CATALOG && CATALOG.institution) || ""
    });
    if (!out.empty) db.prepare("INSERT INTO ai_usage(user_id,day,count) VALUES(?,?,1) ON CONFLICT(user_id,day) DO UPDATE SET count = count + 1").run(req.user.id, day);
    res.json({ ...out, usedToday: used + (out.empty ? 0 : 1), dailyLimit: limit });
  } catch (e) {
    log("AI error:", e.message);
    bad(res, 502, e.message);
  }
});

app.use("/api", api);
app.use("/api", (req, res) => bad(res, 404, "Not found."));
app.use(express.static(path.join(__dirname, "public"), { index: "index.html", maxAge: "1h" }));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => log(`${cfg("site_name")} running on port ${PORT}. Data in ${DATA_DIR}. OCR: ${cfg("ocr_engine")}. AI: ${ai.ready ? ai.model + " (" + ai.flavour + ")" : "not set up"}.`));
