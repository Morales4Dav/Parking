// Cliente HTTP con soporte de autenticación Digest y Basic, necesario para
// hablar con la mayoría de cámaras/controladoras (Hikvision ISAPI, Dahua CGI...).
import { createHash, randomBytes } from 'node:crypto';

const md5 = (s) => createHash('md5').update(s).digest('hex');

function parseChallenge(header) {
  const out = {};
  const re = /(\w+)=(?:"([^"]*)"|([^,\s]+))/g;
  let m;
  while ((m = re.exec(header))) out[m[1].toLowerCase()] = m[2] ?? m[3];
  return out;
}

export function buildDigestHeader({ username, password, method, uri, challenge, nc = 1, cnonce }) {
  const c = challenge;
  const ha1 = md5(`${username}:${c.realm}:${password}`);
  const ha2 = md5(`${method}:${uri}`);
  const qop = c.qop ? c.qop.split(',').map((s) => s.trim()).find((q) => q === 'auth') : undefined;
  const ncHex = nc.toString(16).padStart(8, '0');
  cnonce ??= randomBytes(8).toString('hex');
  const response = qop
    ? md5(`${ha1}:${c.nonce}:${ncHex}:${cnonce}:${qop}:${ha2}`)
    : md5(`${ha1}:${c.nonce}:${ha2}`);
  const parts = [
    `username="${username}"`, `realm="${c.realm}"`, `nonce="${c.nonce}"`,
    `uri="${uri}"`, `response="${response}"`
  ];
  if (c.opaque) parts.push(`opaque="${c.opaque}"`);
  if (c.algorithm) parts.push(`algorithm=${c.algorithm}`);
  if (qop) parts.push(`qop=${qop}`, `nc=${ncHex}`, `cnonce="${cnonce}"`);
  return `Digest ${parts.join(', ')}`;
}

/**
 * Petición HTTP con reintento automático en Digest si el equipo lo pide.
 * @returns {Promise<{status:number, ok:boolean, text:string}>}
 */
export async function request(url, { method = 'GET', body, headers = {}, username, password, timeoutMs = 5000 } = {}) {
  const doFetch = (extra = {}) => fetch(url, {
    method, body, headers: { ...headers, ...extra }, signal: AbortSignal.timeout(timeoutMs)
  });

  let res = await doFetch();
  if (res.status === 401 && username) {
    const wa = res.headers.get('www-authenticate') || '';
    await res.arrayBuffer().catch(() => {});
    let auth;
    if (/^digest/i.test(wa)) {
      const u = new URL(url);
      auth = buildDigestHeader({ username, password, method, uri: u.pathname + u.search, challenge: parseChallenge(wa) });
    } else {
      auth = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
    }
    res = await doFetch({ Authorization: auth });
  }
  const text = await res.text();
  return { status: res.status, ok: res.ok, text };
}
