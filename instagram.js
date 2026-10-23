import { getSetting, setSetting } from './db.js';

const VERSION = process.env.GRAPH_VERSION || 'v25.0';
const BASE = `https://graph.instagram.com/${VERSION}`;
export const DRY_RUN = process.env.DRY_RUN === '1';

export function token() {
  // a new IG_ACCESS_TOKEN pasted into the hosting variables always wins over the last auto-renewed one
  const env = process.env.IG_ACCESS_TOKEN || null;
  if (env && getSetting('env_token') !== env) {
    setSetting('env_token', env);
    setSetting('access_token', null);
  }
  return getSetting('access_token') || env;
}

export class IGError extends Error {
  constructor(message, { code, status, retryable } = {}) {
    super(message);
    this.code = code; this.status = status; this.retryable = retryable;
  }
}

async function call(method, pathOrUrl, { query = {}, body, outbound = false } = {}) {
  const t = token();
  if (!t) throw new IGError('No access token yet. Add IG_ACCESS_TOKEN in your hosting variables.', { retryable: false });
  const url = new URL(pathOrUrl.startsWith('http') ? pathOrUrl : BASE + pathOrUrl);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  url.searchParams.set('access_token', t);

  // test mode only blocks what people would see: DMs and public replies. Everything else is real.
  if (DRY_RUN && outbound) {
    console.log('[DRY_RUN] would send:', url.pathname, body ? JSON.stringify(body) : '');
    return { dry_run: true, id: 'dry_' + Date.now() };
  }

  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const e = data.error || {};
    // 4/17/32/613 = rate limits, 1/2 = temporary; 5xx = Meta side
    const retryable = res.status >= 500 || [1, 2, 4, 17, 32, 613].includes(e.code);
    throw new IGError(e.message || `Instagram returned ${res.status}`, { code: e.code, status: res.status, retryable });
  }
  return data;
}

/** Who is this token for. user_id is the ID that appears in webhooks. */
export async function getMe() {
  return call('GET', '/me', { query: { fields: 'user_id,username,name,profile_picture_url' } });
}

export async function subscribeWebhooks() {
  return call('POST', '/me/subscribed_apps', { query: { subscribed_fields: 'comments,messages' } });
}

export async function getRecentMedia(limit = 30) {
  return call('GET', '/me/media', {
    query: { fields: 'id,caption,media_type,media_product_type,thumbnail_url,media_url,permalink,timestamp', limit: String(limit) },
  });
}

export async function getUsername(igsid) {
  try {
    const d = await call('GET', `/${igsid}`, { query: { fields: 'username' } });
    return d.username || null;
  } catch { return null; }
}

function messagePayload(text, buttonTitle, buttonUrl) {
  if (!buttonUrl) return { text };
  return {
    attachment: {
      type: 'template',
      payload: {
        template_type: 'generic',
        elements: [{
          title: text.slice(0, 80),
          subtitle: text.length > 80 ? text.slice(80, 160) : undefined,
          buttons: [{ type: 'web_url', url: buttonUrl, title: buttonTitle || 'Open link' }],
        }],
      },
    },
  };
}

/**
 * Send a DM. recipient is { id } for a DM/story reply, or { comment_id } for a private reply.
 * Tries a button card first; if Instagram rejects it, falls back to plain text with the link.
 */
export async function sendMessage(recipient, text, buttonTitle, buttonUrl) {
  const igId = getSetting('ig_user_id') || 'me';
  if (buttonUrl) {
    try {
      return await call('POST', `/${igId}/messages`, { outbound: true, body: { recipient, message: messagePayload(text, buttonTitle, buttonUrl) } });
    } catch (e) {
      if (e.retryable) throw e;
      console.warn('Button message rejected, sending plain text instead:', e.message);
      return call('POST', `/${igId}/messages`, { outbound: true, body: { recipient, message: { text: `${text}\n\n${buttonUrl}` } } });
    }
  }
  return call('POST', `/${igId}/messages`, { outbound: true, body: { recipient, message: { text } } });
}

export async function replyToComment(commentId, message) {
  return call('POST', `/${commentId}/replies`, { outbound: true, query: { message } });
}

/** Long-lived tokens last 60 days; refreshing gives a fresh 60 days. Token must be 24h+ old. */
export async function refreshToken() {
  const d = await call('GET', 'https://graph.instagram.com/refresh_access_token', { query: { grant_type: 'ig_refresh_token' } });
  if (d.access_token) {
    setSetting('access_token', d.access_token);
    setSetting('token_refreshed_at', Date.now());
    if (d.expires_in) setSetting('token_expires_at', Date.now() + d.expires_in * 1000);
  }
  return d;
}
