// The backend asks the shell for two things it cannot do itself: fetch a site with the user's login,
// and open that site's sign-in page. Sessions live in one partition per site (`persist:site-<host>`),
// so a plugin's requests carry cookies the plugin never sees and never gets back.
//
// The link is a small HTTP server on loopback with a random port and a random bearer token, announced
// to the backend with `hello`. Everything the backend can ask for goes through it: `/status`,
// `/signin`, `/fetch`.
//
// Electron is required lazily and guarded: the rules below (which URL a fetch may go to, which headers
// may go out, which may come back) are the same rules the backend applies, and they are worth testing
// in plain Node. Without Electron the pure helpers still work and the server half says so.
let electron = null;
try {
  const mod = require('electron');
  // Outside the app the `electron` package resolves to a *string* (the path to the binary), so a
  // successful require is not enough — check for the pieces we actually use.
  if (mod && typeof mod === 'object' && mod.session && mod.BrowserWindow) electron = mod;
} catch {
  /* not running inside Electron: the pure helpers below still export */
}

const crypto = require('node:crypto');
const http = require('node:http');

/** What a plugin may receive as a body, in bytes. Matches BODY_MAX in backend/src/plugins/shell.ts. */
const BODY_MAX = 4 * 1024 * 1024;
/**
 * What the backend may send us as a request. A `/fetch` carries the plugin's own request body inside a
 * JSON envelope, and escaping is what makes an envelope big: the backend's route accepts up to 1 MB of
 * raw body, and a megabyte of non-ASCII becomes about six as `\uXXXX`. 8 MB leaves that worst case room
 * rather than answering 413 to a request the backend considers well inside its own limit.
 */
const REQUEST_MAX = 8 * 1024 * 1024;
const TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 5;
const MAX_RESPONSE_HEADERS = 50;
const MAX_REQUEST_HEADERS = 40;
/** What a plugin may send on one header, and what it may be told on one. The reply cap is the backend's
 * MAX_HEADER_LENGTH: a value we truncate harder than the backend would is a value the plugin never sees
 * whole even though the backend would have passed it on. */
const MAX_REQUEST_HEADER_VALUE = 4000;
const MAX_RESPONSE_HEADER_VALUE = 8 * 1024;

function requireElectron() {
  if (!electron) throw new Error('shell-link needs Electron: this half only runs inside the desktop app');
  return electron;
}

// ---------------------------------------------------------------------------
// Where a fetch may go
// ---------------------------------------------------------------------------

/**
 * Is this hostname the user's own machine or their local network?
 *
 * mirror of backend/src/plugins/hosts.ts; change both. The backend checks every URL a plugin hands it,
 * and this end checks again on every redirect hop it follows: a site fetch is a request the shell makes
 * with the user's login attached, and pointed inside the network it would reach the app's own API, a
 * router's admin page, or a cloud metadata service on 169.254.169.254.
 *
 * Takes a hostname as WHATWG `URL` gives it, which has already folded the sneaky spellings: `127.1` and
 * `0x7f000001` both arrive as `127.0.0.1`, and IPv6 arrives bracketed and compressed. What is left to
 * handle is the trailing dot (`localhost.`), the IPv6 literals, and the IPv4-mapped form, whose tail
 * `URL` serializes as two hex groups (`[::ffff:7f00:1]`).
 */
function isLocalHost(hostname) {
  let h = String(hostname ?? '')
    .trim()
    .toLowerCase();
  if (h.endsWith('.')) h = h.slice(0, -1); // the root-label spelling: `localhost.` resolves the same
  if (!h) return false;
  if (h.startsWith('[') && h.endsWith(']')) return isLocalIpv6(h.slice(1, -1));
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  return isLocalIpv4(h);
}

function isLocalIpv4(h) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a > 255 || b > 255 || Number(m[3]) > 255 || Number(m[4]) > 255) return false;
  if (a === 127) return true; // loopback
  if (a === 0) return true; // 0.0.0.0 and the rest of "this network"
  if (a === 10) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 169 && b === 254) return true; // link-local, and the cloud metadata address
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10, carrier-grade NAT
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15, benchmarking
  if (a >= 224 && a <= 239) return true; // 224/4, multicast
  if (a >= 240) return true; // 240/4, reserved, and 255.255.255.255
  return false;
}

function isLocalIpv6(inner) {
  const v = inner.replace(/%.*$/, ''); // a zone id rides along on link-local addresses: fe80::1%en0
  if (v === '::1' || v === '::') return true;
  if (/^(0{1,4}:){7}0{0,3}1$/.test(v)) return true; // the same loopback written out
  if (/^(0{1,4}:){7}0{1,4}$/.test(v)) return true; // and the unspecified address written out
  if (/^ff/.test(v)) return true; // ff00::/8, multicast
  if (/^f[cd]/.test(v)) return true; // fc00::/7, unique local
  if (/^fe[89ab]/.test(v)) return true; // fe80::/10, link-local
  // An IPv4 riding inside an IPv6: the mapped form `::ffff:…` and the NAT64 prefix `64:ff9b::…`.
  // Both reach the v4 address they carry, so both are judged as that address.
  const carried = /^::ffff:(.+)$/.exec(v) ?? /^64:ff9b::(.+)$/.exec(v);
  if (carried) {
    const v4 = carriedIpv4(carried[1]);
    if (v4) return isLocalIpv4(v4);
  }
  return false;
}

/** The tail of a mapped address, as either two hex groups (`7f00:1`, how URL writes it) or dotted quad. */
function carriedIpv4(tail) {
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(tail);
  if (hex) {
    const n = ((parseInt(hex[1], 16) << 16) | parseInt(hex[2], 16)) >>> 0;
    return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
  }
  return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(tail) ? tail : null;
}

/** The gate every URL passes, the one the backend asked for and every hop after it. */
function assertFetchable(at) {
  if (at.protocol !== 'http:' && at.protocol !== 'https:') {
    throw new Error(`fetch speaks http and https only, not ${at.protocol}`);
  }
  if (isLocalHost(at.hostname)) throw new Error('fetch must not point at a local address');
}

/**
 * Where a redirect takes us, and what the request becomes when it gets there. Throws rather than
 * following anything the backend would have refused itself, naming the rule that was broken.
 *
 * mirror of the redirect handling in backend/src/plugins/shell.ts; change both.
 */
function nextHop(current, location, status, method) {
  const at = new URL(current);
  let next;
  try {
    next = new URL(location, current);
  } catch {
    throw new Error(`redirect to an unreadable location: ${String(location).slice(0, 200)}`);
  }
  if (next.protocol !== 'http:' && next.protocol !== 'https:') {
    throw new Error(`redirect speaks http and https only, not ${next.protocol}`);
  }
  if (at.protocol === 'https:' && next.protocol === 'http:') {
    throw new Error('insecure redirect: https must not hand off to http');
  }
  if (isLocalHost(next.hostname)) throw new Error('redirect must not point at a local address');
  const verb = String(method ?? 'GET').toUpperCase();
  // 303, and 301/302 on POST, become GET; the body goes, and its content-type goes with it
  if (status === 303 || ((status === 301 || status === 302) && verb === 'POST')) {
    return { url: next.toString(), method: 'GET', dropBody: true };
  }
  // 307/308 keep the method, which across origins would replay the body at a host the plugin never
  // addressed. The method stays, the body goes.
  if ((status === 307 || status === 308) && next.origin !== at.origin) {
    return { url: next.toString(), method: verb, dropBody: true };
  }
  return { url: next.toString(), method: verb, dropBody: false };
}

// ---------------------------------------------------------------------------
// What may go out, and what may come back
// ---------------------------------------------------------------------------

/**
 * What a plugin is allowed to learn from a response. Same allow-list as `safeResponseHeaders` in
 * backend/src/plugins/shell.ts; change both. An allow-list rather than a deny-list: a header we have
 * not thought about is more likely to carry something the plugin has no business with (a session, an
 * internal hostname, a debug trace) than something it needs.
 */
const RESPONSE_HEADER_ALLOW = new Set([
  'content-type',
  'content-length',
  'etag',
  'last-modified',
  'link',
  'retry-after',
  'location',
  'cache-control',
  'date',
]);

function isAllowedResponseHeader(key) {
  // set-cookie is named even though the allow-list already excludes it: this is the line that must never move.
  if (key === 'set-cookie' || key === 'set-cookie2') return false;
  return RESPONSE_HEADER_ALLOW.has(key) || key.startsWith('x-ratelimit-');
}

function clean(value) {
  return String(value)
    .replace(/[\r\n]+/g, ' ')
    .slice(0, MAX_RESPONSE_HEADER_VALUE);
}

/**
 * The gate response headers pass through before they go back to the backend. The backend applies the
 * same allow-list to whatever we send, but the shell is where the site's `set-cookie` actually exists,
 * and it should not leave this process in the first place.
 *
 * Headers are duck-typed, never `instanceof`: the object may be Electron's, Node's, or a plain bag.
 */
function safeResponseHeaders(input) {
  const entries =
    input && typeof input === 'object' && typeof input.entries === 'function'
      ? input.entries()
      : input && typeof input === 'object'
        ? Object.entries(input)
        : [];
  const out = {};
  for (const [rawKey, rawValue] of entries) {
    if (Object.keys(out).length >= MAX_RESPONSE_HEADERS) break;
    if (rawValue === null || rawValue === undefined) continue;
    const key = String(rawKey ?? '')
      .trim()
      .toLowerCase();
    if (!key || !isAllowedResponseHeader(key)) continue;
    out[key] = clean(rawValue);
  }
  return out;
}

/** RFC 9110 token characters. A name outside this set is a plugin trying to shape the request itself. */
const HEADER_NAME_RE = /^[a-z0-9!#$%&'*+.^_`|~-]+$/i;
/** Hop-by-hop headers and the ones this layer owns. Mirrors REQUEST_HEADER_STRIP in backend/src/plugins/http.ts. */
const REQUEST_HEADER_STRIP = new Set([
  'host',
  'cookie',
  'content-length',
  'transfer-encoding',
  'connection',
  'upgrade',
  'te',
  'keep-alive',
  'proxy-connection',
]);
/** Never on a site fetch: the shell attaches the site's login, and a plugin's own credentials never ride along. */
const CREDENTIAL_HEADERS = new Set(['authorization', 'proxy-authorization']);
/** Headers that name the origin the request came from; a hop that left that origin sheds them. */
const ORIGIN_HEADERS = new Set(['origin', 'referer']);

/**
 * What we are willing to put on the wire on a plugin's behalf. `cookie` is stripped because the
 * session partition is what supplies cookies here, and `authorization` because this request already
 * carries the user's login: a plugin adding its own key on top would be handing a third-party
 * credential to a site it merely declared. `crossOrigin` is true once a redirect has left the origin
 * the plugin asked for.
 */
function requestHeadersFor(headers, { crossOrigin = false } = {}) {
  const out = {};
  for (const [rawKey, rawValue] of Object.entries(headers ?? {})) {
    if (Object.keys(out).length >= MAX_REQUEST_HEADERS) break;
    if (rawValue === null || rawValue === undefined) continue;
    const key = String(rawKey ?? '')
      .trim()
      .toLowerCase();
    if (!key || !HEADER_NAME_RE.test(key)) continue;
    if (REQUEST_HEADER_STRIP.has(key) || CREDENTIAL_HEADERS.has(key)) continue;
    if (crossOrigin && ORIGIN_HEADERS.has(key)) continue;
    const value = String(rawValue);
    if (/[\r\n\0]/.test(value)) continue; // a value that carries a line break is a second header
    out[key] = value.slice(0, MAX_REQUEST_HEADER_VALUE);
  }
  return out;
}

function withoutHeader(headers, name) {
  if (!headers) return headers;
  return Object.fromEntries(Object.entries(headers).filter(([k]) => String(k).trim().toLowerCase() !== name));
}

// ---------------------------------------------------------------------------
// The three things the backend asks for
// ---------------------------------------------------------------------------

/** One persistent session per site host, so a plugin's fetches carry a login it never sees. */
function partitionFor(site) {
  return `persist:site-${new URL(site).host.replace(/[^a-z0-9.-]/gi, '_')}`;
}

/** Which of `sites` have cookies in their partition right now. */
async function signedIn(sites) {
  const { session } = requireElectron();
  const out = [];
  for (const site of sites) {
    try {
      const cookies = await session.fromPartition(partitionFor(site)).cookies.get({ url: site });
      if (cookies.length > 0) out.push(site);
    } catch {
      /* no partition yet, or a site we cannot parse: not signed in */
    }
  }
  return out;
}

/** A URL we are willing to put in the sign-in window. Unparseable counts as no. */
function isHttpUrl(url) {
  try {
    const at = new URL(url);
    return at.protocol === 'http:' || at.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * The site's own sign-in page, in the site's own partition. Navigation is deliberately not pinned to
 * the site's origin: an OAuth flow hops to an identity provider and back, and a window that refuses
 * the hop is a window the user cannot sign in with. What is pinned is the scheme (http(s) only) and
 * the window (popups load in place instead of opening a second one), and no preload is injected —
 * nothing of the app's runs in a page the user is typing a password into.
 */
function openSignIn(site) {
  const { BrowserWindow } = requireElectron();
  const at = new URL(site);
  assertFetchable(at);
  const win = new BrowserWindow({
    width: 1000,
    height: 760,
    title: `Sign in — ${at.host}`,
    webPreferences: {
      partition: partitionFor(site),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.setWindowOpenHandler(({ url }) => {
    if (isHttpUrl(url)) void win.loadURL(url); // the popup loads in place; there is only ever one window
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!isHttpUrl(url)) event.preventDefault();
  });
  void win.loadURL(site);
  return win;
}

/**
 * Read a body with a byte budget, cancelling the stream the moment we pass it: `content-length` is a
 * claim, not a limit, and a server that answers with a hundred megabytes should cost us four.
 */
async function readCapped(res, limit = BODY_MAX) {
  if (!res.body) {
    const text = await res.text();
    const bytes = new TextEncoder().encode(text);
    if (bytes.length <= limit) return { body: text, truncated: false, bytes: bytes.length };
    return { body: new TextDecoder().decode(bytes.subarray(0, limit)), truncated: true, bytes: limit };
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.length) continue;
      if (total + value.length > limit) {
        chunks.push(value.subarray(0, limit - total));
        total = limit;
        truncated = true;
        break;
      }
      chunks.push(value);
      total += value.length;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const joined = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    joined.set(chunk, at);
    at += chunk.length;
  }
  return { body: new TextDecoder().decode(joined), truncated, bytes: total };
}

/**
 * The site fetch, made from the site's partition so its cookies go along. Redirects are followed by
 * hand (`redirect: 'manual'`) so every hop is re-checked the way the backend re-checks its own: http(s)
 * only, no downgrade to http, never a local address, and a body that is never replayed at an origin
 * the plugin did not address. One timeout covers the whole chain, not each hop.
 */
async function fetchWithSite(url, init) {
  const { session } = requireElectron();
  const start = new URL(url);
  assertFetchable(start);
  const ses = session.fromPartition(partitionFor(start.origin));
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  let current = start.toString();
  let method = String(init?.method ?? 'GET').toUpperCase();
  let headers = init?.headers ?? {};
  let body = init?.body;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const at = new URL(current);
    const res = await ses.fetch(current, {
      method,
      headers: requestHeadersFor(headers, { crossOrigin: at.origin !== start.origin }),
      body,
      redirect: 'manual',
      signal,
    });
    const location = res.headers.get('location');
    if ([301, 302, 303, 307, 308].includes(res.status) && location) {
      if (hop === MAX_REDIRECTS) throw new Error('too many redirects');
      const next = nextHop(current, location, res.status, method);
      if (next.dropBody) {
        body = undefined;
        headers = withoutHeader(headers, 'content-type'); // a bodyless request does not describe a body
      }
      current = next.url;
      method = next.method;
      continue;
    }
    const { body: text, truncated, bytes } = await readCapped(res);
    const out = safeResponseHeaders(res.headers);
    out['content-length'] = String(bytes); // what we actually hand over, not what the server claimed
    return { status: res.status, headers: out, body: text, truncated };
  }
  throw new Error('too many redirects'); // unreachable: the loop returns or throws first
}

// ---------------------------------------------------------------------------
// The link itself
// ---------------------------------------------------------------------------

/** A body past REQUEST_MAX, so the reply can say 413 instead of looking like a crash. */
class TooLarge extends Error {
  constructor() {
    super('request body is too large');
    this.status = 413;
  }
}

/**
 * Past the cap we stop *keeping* the body, but keep reading it. Two failures are being avoided here.
 * Destroying the socket reaches the backend as a transport failure, and three of those in a row make
 * it deregister a shell that is in fact healthy. Answering 413 while the upload is still in flight is
 * the same failure wearing a different hat: undici reports the socket closing under a request it has
 * not finished sending as `fetch failed`, and never looks at the reply. So the body is drained to its
 * end and the 413 goes out after it, where the client will read it.
 *
 * The drain is not unbounded: a peer still sending after DRAIN_MAX is not our backend having an off
 * day, and gets the socket torn down after all.
 */
const DRAIN_MAX = REQUEST_MAX * 4;

function readJson(req) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let size = 0;
    let over = false;
    req.on('data', (d) => {
      size += d.length;
      if (over) {
        if (size > DRAIN_MAX) req.destroy(); // no longer a request, just noise
        return;
      }
      if (size > REQUEST_MAX) {
        over = true;
        parts.length = 0; // let go of what we have: we are not going to parse it
        return;
      }
      parts.push(d);
    });
    req.on('end', () => {
      if (over) return reject(new TooLarge());
      const text = Buffer.concat(parts).toString('utf8');
      try {
        resolve(text ? JSON.parse(text) : {});
      } catch {
        reject(new Error('body is not json'));
      }
    });
    req.on('error', reject);
  });
}

function why(e) {
  return e instanceof Error ? e.message : String(e);
}

/** Constant-time on the part an attacker can vary; the length is not a secret worth hiding. */
function tokenMatches(header, token) {
  const given = Buffer.from(String(header ?? ''), 'utf8');
  const want = Buffer.from(`Bearer ${token}`, 'utf8');
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}

/** What the three routes actually do. Split out so the server can be tested without Electron. */
function electronImpl() {
  requireElectron(); // fail at startShellLink rather than on the first request the backend makes
  return { signedIn, openSignIn, fetchWithSite };
}

/**
 * Start the callback server on a random loopback port. The token is the whole of the authentication:
 * a process on this machine that has neither the port nor the token cannot ask us for anything. (A
 * process that can read the backend's config is already past everything this could defend, which is
 * why there is nothing more here.)
 */
function startShellLink({ log = console.log, impl } = {}) {
  return new Promise((resolve, reject) => {
    let routes;
    try {
      routes = impl ?? electronImpl();
    } catch (e) {
      reject(e);
      return;
    }
    const token = crypto.randomBytes(24).toString('hex');
    const server = http.createServer(async (req, res) => {
      const reply = (status, obj) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      try {
        if (!tokenMatches(req.headers.authorization, token)) return reply(401, { error: 'token' });
        if (req.method !== 'POST') return reply(405, { error: 'method' });
        const route = (req.url ?? '').split('?')[0];
        const body = await readJson(req);
        if (route === '/status') {
          const sites = Array.isArray(body.sites) ? body.sites.map(String) : [];
          return reply(200, { signedIn: await routes.signedIn(sites) });
        }
        if (route === '/signin') {
          routes.openSignIn(String(body.site));
          return reply(200, { ok: true });
        }
        if (route === '/fetch') {
          return reply(200, await routes.fetchWithSite(String(body.url), body.init ?? {}));
        }
        reply(404, { error: 'route' });
      } catch (e) {
        if (e instanceof TooLarge) return reply(413, { error: why(e) });
        log('[shell-link]', why(e));
        reply(500, { error: why(e) }); // the message, never the stack: this crosses a process boundary
      }
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      log('[shell-link] listening on 127.0.0.1:' + port);
      resolve({
        port,
        token,
        close: () => {
          server.close();
          server.closeAllConnections(); // the backend keeps its sockets alive; close() alone would wait for them
        },
      });
    });
  });
}

/**
 * Tell the backend where the callback is. Retried while the backend comes up, and re-sent periodically
 * by main.js: the backend can restart under the app (the dev setup does exactly that) and a restarted
 * backend has forgotten the link. It is idempotent on that side — a hello from the shell already
 * registered leaves things as they are.
 */
async function hello(backendUrl, link, log = console.log) {
  for (let i = 0; i < 10; i++) {
    try {
      const r = await fetch(`${backendUrl}/api/shell/hello`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port: link.port, token: link.token }),
      });
      if (r.ok) return true;
    } catch {
      /* the backend is not up yet */
    }
    if (i < 9) await new Promise((r) => setTimeout(r, 1000)); // no waiting after the last try
  }
  log('[shell-link] backend never answered hello; plugin site fetches and sign-in are unavailable');
  return false;
}

module.exports = {
  startShellLink,
  hello,
  partitionFor,
  isLocalHost,
  safeResponseHeaders,
  requestHeadersFor,
  nextHop,
};
