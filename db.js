import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = process.env.DATA_DIR || './data';
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(path.join(DATA_DIR, 'autodm.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS automations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  trigger_type TEXT NOT NULL,          -- comment | dm | story_reply
  match_mode TEXT NOT NULL DEFAULT 'contains', -- contains | exact | any
  keywords TEXT NOT NULL DEFAULT '[]', -- JSON array
  media_id TEXT,                        -- comment only: limit to one post (null = all posts)
  media_label TEXT,
  dm_text TEXT NOT NULL,
  button_title TEXT,
  button_url TEXT,
  public_replies TEXT NOT NULL DEFAULT '[]', -- comment only: JSON array, one picked at random
  once_per_user INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  sent_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sent (
  automation_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (automation_id, user_id)
);

CREATE TABLE IF NOT EXISTS seen_events (
  event_id TEXT PRIMARY KEY,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  run_after INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  automation_id INTEGER,
  automation_name TEXT,
  trigger_type TEXT,
  user_id TEXT,
  username TEXT,
  incoming_text TEXT,
  status TEXT NOT NULL,   -- queued | sent | failed | skipped
  detail TEXT
);

CREATE TABLE IF NOT EXISTS send_times (at INTEGER NOT NULL);
`);

// ---- settings ----
export function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}
export function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value == null ? null : String(value));
}

// ---- automations ----
function rowToAutomation(r) {
  if (!r) return null;
  return {
    ...r,
    keywords: JSON.parse(r.keywords || '[]'),
    public_replies: JSON.parse(r.public_replies || '[]'),
    once_per_user: !!r.once_per_user,
    active: !!r.active,
  };
}
export function listAutomations() {
  return db.prepare('SELECT * FROM automations ORDER BY id DESC').all().map(rowToAutomation);
}
export function getAutomation(id) {
  return rowToAutomation(db.prepare('SELECT * FROM automations WHERE id = ?').get(id));
}
function clean(a) {
  const triggers = ['comment', 'dm', 'story_reply'];
  const modes = ['contains', 'exact', 'any'];
  if (!a.name || !String(a.name).trim()) throw new Error('Give the automation a name.');
  if (!triggers.includes(a.trigger_type)) throw new Error('Pick a trigger: comment, DM or story reply.');
  if (!modes.includes(a.match_mode)) throw new Error('Pick how keywords should match.');
  const keywords = (a.keywords || []).map(k => String(k).trim().toLowerCase()).filter(Boolean);
  if (a.match_mode !== 'any' && keywords.length === 0) throw new Error('Add at least one keyword, or set matching to "any message".');
  if (!a.dm_text || !String(a.dm_text).trim()) throw new Error('Write the DM that gets sent.');
  if (a.button_url && !/^https?:\/\//i.test(a.button_url)) throw new Error('Button link must start with http:// or https://');
  return {
    name: String(a.name).trim(),
    trigger_type: a.trigger_type,
    match_mode: a.match_mode,
    keywords: JSON.stringify(keywords),
    media_id: a.trigger_type === 'comment' && a.media_id ? String(a.media_id) : null,
    media_label: a.trigger_type === 'comment' && a.media_id ? (a.media_label || null) : null,
    dm_text: String(a.dm_text).trim(),
    button_title: a.button_url ? (String(a.button_title || '').trim() || 'Open link').slice(0, 20) : null,
    button_url: a.button_url ? String(a.button_url).trim() : null,
    public_replies: JSON.stringify(a.trigger_type === 'comment' ? (a.public_replies || []).map(s => String(s).trim()).filter(Boolean) : []),
    once_per_user: a.once_per_user === false ? 0 : 1,
    active: a.active === false ? 0 : 1,
  };
}
export function createAutomation(a) {
  const c = clean(a);
  const info = db.prepare(`INSERT INTO automations
    (name, trigger_type, match_mode, keywords, media_id, media_label, dm_text, button_title, button_url, public_replies, once_per_user, active)
    VALUES (@name, @trigger_type, @match_mode, @keywords, @media_id, @media_label, @dm_text, @button_title, @button_url, @public_replies, @once_per_user, @active)`).run(c);
  return getAutomation(info.lastInsertRowid);
}
export function updateAutomation(id, a) {
  const c = clean(a);
  db.prepare(`UPDATE automations SET name=@name, trigger_type=@trigger_type, match_mode=@match_mode, keywords=@keywords,
    media_id=@media_id, media_label=@media_label, dm_text=@dm_text, button_title=@button_title, button_url=@button_url,
    public_replies=@public_replies, once_per_user=@once_per_user, active=@active WHERE id=@id`).run({ ...c, id });
  return getAutomation(id);
}
export function setAutomationActive(id, active) {
  db.prepare('UPDATE automations SET active = ? WHERE id = ?').run(active ? 1 : 0, id);
  return getAutomation(id);
}
export function deleteAutomation(id) {
  db.prepare('DELETE FROM automations WHERE id = ?').run(id);
  db.prepare('DELETE FROM sent WHERE automation_id = ?').run(id);
}
export function incrementSent(id) {
  db.prepare('UPDATE automations SET sent_count = sent_count + 1 WHERE id = ?').run(id);
}

// ---- dedupe ----
export function alreadySentTo(automationId, userId) {
  return !!db.prepare('SELECT 1 FROM sent WHERE automation_id = ? AND user_id = ?').get(automationId, userId);
}
export function markSentTo(automationId, userId) {
  db.prepare('INSERT OR IGNORE INTO sent (automation_id, user_id) VALUES (?, ?)').run(automationId, userId);
}
/** Returns true the first time an event id is seen (Meta retries webhooks). */
export function firstTimeSeen(eventId) {
  const info = db.prepare('INSERT OR IGNORE INTO seen_events (event_id) VALUES (?)').run(eventId);
  return info.changes === 1;
}

// ---- queue ----
export function enqueue(job) {
  db.prepare('INSERT INTO queue (job) VALUES (?)').run(JSON.stringify(job));
}
export function nextJob(now) {
  const r = db.prepare('SELECT * FROM queue WHERE run_after <= ? ORDER BY id LIMIT 1').get(now);
  return r ? { ...r, job: JSON.parse(r.job) } : null;
}
export function removeJob(id) { db.prepare('DELETE FROM queue WHERE id = ?').run(id); }
export function retryJob(id, attempts, runAfter) {
  db.prepare('UPDATE queue SET attempts = ?, run_after = ? WHERE id = ?').run(attempts, runAfter, id);
}
export function queueLength() { return db.prepare('SELECT COUNT(*) AS n FROM queue').get().n; }

// ---- rate tracking ----
export function recordSend(now) {
  db.prepare('INSERT INTO send_times (at) VALUES (?)').run(now);
  db.prepare('DELETE FROM send_times WHERE at < ?').run(now - 3600_000);
}
export function sendsLastHour(now) {
  return db.prepare('SELECT COUNT(*) AS n FROM send_times WHERE at >= ?').get(now - 3600_000).n;
}

// ---- activity ----
export function logActivity(e) {
  const info = db.prepare(`INSERT INTO activity (automation_id, automation_name, trigger_type, user_id, username, incoming_text, status, detail)
    VALUES (@automation_id, @automation_name, @trigger_type, @user_id, @username, @incoming_text, @status, @detail)`).run({
    automation_id: null, automation_name: null, trigger_type: null, user_id: null, username: null, incoming_text: null, detail: null, ...e,
  });
  return info.lastInsertRowid;
}
export function updateActivity(id, status, detail) {
  db.prepare('UPDATE activity SET status = ?, detail = ? WHERE id = ?').run(status, detail ?? null, id);
}
export function listActivity(limit = 100) {
  return db.prepare('SELECT * FROM activity ORDER BY id DESC LIMIT ?').all(limit);
}
export function statsToday() {
  return db.prepare(`SELECT status, COUNT(*) AS n FROM activity WHERE at >= datetime('now', '-1 day') GROUP BY status`).all();
}

// housekeeping: keep tables small
export function prune() {
  db.prepare(`DELETE FROM seen_events WHERE at < datetime('now', '-10 days')`).run();
  db.prepare(`DELETE FROM activity WHERE id NOT IN (SELECT id FROM activity ORDER BY id DESC LIMIT 5000)`).run();
}
