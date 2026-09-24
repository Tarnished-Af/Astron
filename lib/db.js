// Astron database: one SQLite file holds users, sessions, file records,
// stars, settings, AI usage, and the searchable text of every note.
const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

function open(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, "astron.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id          INTEGER PRIMARY KEY,
      username    TEXT UNIQUE NOT NULL,
      name        TEXT NOT NULL,
      role        TEXT NOT NULL CHECK (role IN ('admin','friend')),
      pass_hash   TEXT NOT NULL,
      must_change INTEGER NOT NULL DEFAULT 1,
      created_at  INTEGER NOT NULL,
      last_seen   INTEGER
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id         TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS files (
      id          INTEGER PRIMARY KEY,
      kind        TEXT NOT NULL CHECK (kind IN ('notes','hw','lab','raw')),
      subject     TEXT NOT NULL,
      sem         INTEGER NOT NULL,
      unit        INTEGER NOT NULL,
      title       TEXT NOT NULL,
      ext         TEXT NOT NULL,
      mime        TEXT NOT NULL,
      bytes       INTEGER NOT NULL,
      stored_as   TEXT NOT NULL,
      uploader_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      status      TEXT CHECK (status IN ('new','used','skip')),
      tag         TEXT,
      text_state  TEXT NOT NULL DEFAULT 'pending',
      pages       INTEGER,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS files_place ON files(subject, sem, unit);
    CREATE TABLE IF NOT EXISTS stars (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      PRIMARY KEY (user_id, file_id)
    );
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS ai_usage (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      day     TEXT NOT NULL,
      count   INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, day)
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(
      text,
      file_id UNINDEXED, page UNINDEXED, subject UNINDEXED, sem UNINDEXED, unit UNINDEXED,
      tokenize = 'porter unicode61'
    );
  `);
  return db;
}

function getSetting(db, key, fallback) {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? row.value : fallback;
}
function setSetting(db, key, value) {
  db.prepare("INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(key, String(value));
}

module.exports = { open, getSetting, setSetting };
