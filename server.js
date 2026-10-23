import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as store from './db.js';
import * as ig from './instagram.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || '';
const APP_SECRET = process.env.IG_APP_SECRET || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const MAX_PER_HOUR = Number(process.env.MAX_PER_HOUR || 180);

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));

// ───────────────────────── keyword matching ─────────────────────────

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''); // strip punctuation/emoji at the ends
}
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function textMatches(a, text) {
  if (a.match_mode === 'any') return true;
  const t = normalize(text);
  if (!t) return false;
  if (a.match_mode === 'exact') return a.keywords.some(k => t === normalize(k));
  return a.keywords.some(k => {
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(normalize(k))}($|[^\\p{L}\\p{N}])`, 'u');
    return re.test(t);
  });
}

/** Most specific automation wins: a specific post beats "all posts", keywords beat "any message". */
function findAutomation(triggerType, text, mediaId) {
  const candidates = store.listAutomations()
    .filter(a => a.active && a.trigger_type === triggerType)
    .filter(a => !a.media_id || a.media_id === mediaId)
    .filter(a => textMatches(a, text));
  candidates.sort((x, y) =>
    (y.media_id ? 1 : 0) - (x.media_id ? 1 : 0) ||
    (x.match_mode === 'any' ? 1 : 0) - (y.match_mode === 'any' ? 1 : 0) ||
    x.id - y.id);
  return candidates[0] || null;
}

// ───────────────────────── webhook ─────────────────────────

app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && VERIFY_TOKEN && req.query['hub.verify_token'] === VERIFY_TOKEN) {
    console.log('Webhook verified by Meta');
    return res.status(200).send(req.query['hub.challenge']);
  }
  res.sendStatus(403);
});

function validSignature(req) {
  if (!APP_SECRET) return ig.DRY_RUN; // only allow unsigned events while testing
  const header = req.get('x-hub-signature-256') || '';
  const expected = 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(req.rawBody || '').digest('hex');
  const a = Buffer.from(header), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

app.post('/webhook', (req, res) => {
  if (!validSignature(req)) {
    console.warn('Rejected webhook with bad or missing signature. Check IG_APP_SECRET.');
    return res.sendStatus(401);
  }
  res.sendStatus(200); // answer Meta fast, work afterwards
  store.setSetting('last_webhook_at', Date.now());
  try { handleEvent(req.body); } catch (e) { console.error('Webhook handling error:', e); }
});

function handleEvent(body) {
  if (!body || !Array.isArray(body.entry)) return;
  const myId = store.getSetting('ig_user_id');

  for (const entry of body.entry) {
    for (const change of entry.changes || []) {
      if (change.field === 'comments' || change.field === 'live_comments') handleComment(change.value, myId);
    }
    for (const m of entry.messaging || []) handleMessage(m, myId);
  }
}

function handleComment(v, myId) {
  if (!v || !v.id || !v.from) return;
  if (v.from.id === myId) return;                 // never answer our own replies
  if (!store.firstTimeSeen('c:' + v.id)) return;  // Meta can deliver the same event twice

  const a = findAutomation('comment', v.text, v.media?.id);
  if (!a) return;
  const base = {
    automation_id: a.id, automation_name: a.name, trigger_type: 'comment',
    user_id: v.from.id, username: v.from.username || null, incoming_text: v.text || '',
  };
  if (a.once_per_user && store.alreadySentTo(a.id, v.from.id)) {
    store.logActivity({ ...base, status: 'skipped', detail: 'Already sent to this person' });
    return;
  }
  store.markSentTo(a.id, v.from.id);
  const activityId = store.logActivity({ ...base, status: 'queued' });
  store.enqueue({ kind: 'dm', recipient: { comment_id: v.id }, automation_id: a.id, user_id: v.from.id, activity_id: activityId });
  if (a.public_replies.length) {
    const text = a.public_replies[Math.floor(Math.random() * a.public_replies.length)];
    store.enqueue({ kind: 'public_reply', comment_id: v.id, text });
  }
}

function handleMessage(m, myId) {
  const msg = m.message;
  if (!msg || msg.is_echo || msg.is_deleted) return;
  const senderId = m.sender?.id;
  if (!senderId || senderId === myId) return;
  if (!store.firstTimeSeen('m:' + msg.mid)) return;

  const isStoryReply = !!msg.reply_to?.story;
  // story replies try story-reply automations first, then fall back to DM automations
  let a = null, trigger = 'dm';
  if (isStoryReply) { a = findAutomation('story_reply', msg.text); trigger = 'story_reply'; }
  if (!a) { a = findAutomation('dm', msg.text); trigger = 'dm'; }
  if (!a) return;

  const base = {
    automation_id: a.id, automation_name: a.name, trigger_type: trigger,
    user_id: senderId, incoming_text: msg.text || (isStoryReply ? '(story reply)' : '(attachment)'),
  };
  if (a.once_per_user && store.alreadySentTo(a.id, senderId)) {
    store.logActivity({ ...base, status: 'skipped', detail: 'Already sent to this person' });
    return;
  }
  store.markSentTo(a.id, senderId);
  const activityId = store.logActivity({ ...base, status: 'queued' });
  store.enqueue({ kind: 'dm', recipient: { id: senderId }, automation_id: a.id, user_id: senderId, activity_id: activityId, lookup_username: true });
}

// ───────────────────────── send queue ─────────────────────────
// Sends one message at a time, spaced out, and never more than MAX_PER_HOUR DMs in any rolling hour.
// Jobs live in the database, so a restart doesn't lose anything.

let working = false;
async function worker() {
  if (working) return;
  working = true;
  try {
    const now = Date.now();
    const item = store.nextJob(now);
    if (!item) return;
    const { job } = item;
    if (job.kind === 'dm' && store.sendsLastHour(now) >= MAX_PER_HOUR) return; // wait for the hour to roll

    try {
      if (job.kind === 'dm') {
        const a = store.getAutomation(job.automation_id);
        if (!a) { store.removeJob(item.id); store.updateActivity(job.activity_id, 'failed', 'Automation was deleted'); return; }
        await ig.sendMessage(job.recipient, a.dm_text, a.button_title, a.button_url);
        store.recordSend(Date.now());
        store.incrementSent(a.id);
        store.updateActivity(job.activity_id, 'sent', ig.DRY_RUN ? 'Test mode: not actually sent' : null);
        if (job.lookup_username) {
          const u = await ig.getUsername(job.user_id);
          if (u) store.db.prepare('UPDATE activity SET username = ? WHERE id = ?').run(u, job.activity_id);
        }
      } else if (job.kind === 'public_reply') {
        await ig.replyToComment(job.comment_id, job.text);
      }
      store.removeJob(item.id);
    } catch (e) {
      const attempts = item.attempts + 1;
      if (e.retryable && attempts < 5) {
        store.retryJob(item.id, attempts, Date.now() + Math.min(60, 2 ** attempts) * 60_000);
        console.warn(`Send failed (attempt ${attempts}), retrying later:`, e.message);
      } else {
        store.removeJob(item.id);
        if (job.kind === 'dm') {
          store.updateActivity(job.activity_id, 'failed', e.message);
          // let them trigger it again later since they never got it
          store.db.prepare('DELETE FROM sent WHERE automation_id = ? AND user_id = ?').run(job.automation_id, job.user_id);
        }
        console.error('Send failed permanently:', e.message);
      }
    }
  } finally {
    working = false;
  }
}
setInterval(worker, 1500);

// ───────────────────────── token upkeep ─────────────────────────

async function maybeRefreshToken() {
  if (!ig.token()) return;
  const last = Number(store.getSetting('token_refreshed_at') || 0);
  if (Date.now() - last < 7 * 86400_000) return;
  try {
    await ig.refreshToken();
    console.log('Access token refreshed');
  } catch (e) {
    console.warn('Token refresh failed (will retry in 6h):', e.message);
  }
}
setInterval(maybeRefreshToken, 6 * 3600_000);
setInterval(store.prune, 24 * 3600_000);
setTimeout(maybeRefreshToken, 10_000);

// ───────────────────────── public pages ─────────────────────────

const ACCOUNT_LABEL = () => { const u = store.getSetting('ig_username'); return u ? `the Instagram account @${u}` : 'our own Instagram account'; };
app.get(['/health', '/healthz'], (_req, res) => res.json({ ok: true }));
app.get('/privacy', (_req, res) => res.type('html').send(`<!doctype html><meta name=viewport content="width=device-width,initial-scale=1">
<title>Privacy policy</title><body style="font:16px/1.6 system-ui;max-width:640px;margin:40px auto;padding:0 20px">
<h1>Privacy policy</h1><p>This app is used only to send automatic replies from ${ACCOUNT_LABEL()} to people who comment on its posts or message it.
It runs on its owner's own server and is not operated by any third party.
It stores the Instagram user ID and username of people who interact, plus the text that triggered a reply, to avoid sending duplicates.
This data is never sold or shared. To have your data deleted, send us a DM on Instagram asking for removal.</p></body>`));

// ───────────────────────── dashboard (password protected) ─────────────────────────

function requireAdmin(req, res, next) {
  if (!ADMIN_PASSWORD) return res.status(503).send('Set ADMIN_PASSWORD in your hosting variables to open the dashboard.');
  const [scheme, encoded] = (req.get('authorization') || '').split(' ');
  if (scheme === 'Basic' && encoded) {
    const pass = Buffer.from(encoded, 'base64').toString().split(':').slice(1).join(':');
    const a = Buffer.from(pass), b = Buffer.from(ADMIN_PASSWORD);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="DropDM dashboard"').status(401).send('Password required');
}

app.use('/api', requireAdmin);
const wrap = fn => (req, res) => Promise.resolve().then(() => fn(req, res)).catch(e => res.status(400).json({ error: e.message }));

app.get('/api/status', wrap((req, res) => {
  const now = Date.now();
  res.json({
    connected: !!store.getSetting('ig_user_id'),
    username: store.getSetting('ig_username'),
    has_token: !!ig.token(),
    dry_run: ig.DRY_RUN,
    signature_check: !!APP_SECRET,
    verify_token_set: !!VERIFY_TOKEN,
    verify_token: VERIFY_TOKEN || null, // only shown behind the dashboard password
    token_refreshed_at: Number(store.getSetting('token_refreshed_at') || 0) || null,
    token_expires_at: Number(store.getSetting('token_expires_at') || 0) || null,
    last_webhook_at: Number(store.getSetting('last_webhook_at') || 0) || null,
    queue: store.queueLength(),
    sent_last_hour: store.sendsLastHour(now),
    max_per_hour: MAX_PER_HOUR,
    today: Object.fromEntries(store.statsToday().map(r => [r.status, r.n])),
    webhook_url: `${/^(localhost|127\.)/.test(req.get('host')) ? 'http' : 'https'}://${req.get('host')}/webhook`,
  });
}));

app.post('/api/connect', wrap(async (_req, res) => {
  const me = await ig.getMe();
  store.setSetting('ig_user_id', me.user_id);
  store.setSetting('ig_username', me.username);
  await ig.subscribeWebhooks();
  if (!store.getSetting('token_refreshed_at')) store.setSetting('token_refreshed_at', Date.now());
  res.json({ ok: true, username: me.username });
}));

app.post('/api/refresh-token', wrap(async (_req, res) => {
  await ig.refreshToken();
  res.json({ ok: true });
}));

app.get('/api/media', wrap(async (_req, res) => {
  const d = await ig.getRecentMedia(30);
  res.json(d.data || []);
}));

app.get('/api/automations', wrap((_req, res) => res.json(store.listAutomations())));
app.post('/api/automations', wrap((req, res) => res.json(store.createAutomation(req.body))));
app.put('/api/automations/:id', wrap((req, res) => res.json(store.updateAutomation(Number(req.params.id), req.body))));
app.patch('/api/automations/:id/active', wrap((req, res) => res.json(store.setAutomationActive(Number(req.params.id), !!req.body.active))));
app.delete('/api/automations/:id', wrap((req, res) => { store.deleteAutomation(Number(req.params.id)); res.json({ ok: true }); }));

app.get('/api/activity', wrap((req, res) => res.json(store.listActivity(Math.min(500, Number(req.query.limit) || 100)))));

/** "Which automation would fire?" without sending anything. */
app.post('/api/test', wrap((req, res) => {
  const { trigger_type, text, media_id } = req.body;
  let a = findAutomation(trigger_type, text, media_id || undefined);
  if (!a && trigger_type === 'story_reply') a = findAutomation('dm', text);
  res.json({ match: a ? { id: a.id, name: a.name, dm_text: a.dm_text } : null });
}));

app.use('/', requireAdmin, express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`DropDM running on port ${PORT}${ig.DRY_RUN ? ' (DRY_RUN: nothing is really sent)' : ''}`);
  if (!APP_SECRET) console.warn('IG_APP_SECRET is not set: webhooks will be rejected (except in DRY_RUN).');
  if (!VERIFY_TOKEN) console.warn('VERIFY_TOKEN is not set: Meta cannot verify your webhook.');
});
