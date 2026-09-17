// The backend asks the shell for two things it cannot do itself: fetch a site with the user's login,
// and open that site's sign-in page. Sessions live in one partition per site, so a plugin's requests
// carry cookies the plugin never sees and never gets back.
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
  if (mod && typeof mod === 'object' && mod.session && mod.BrowserWindow && mod.net) electron = mod;
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

/** Methods a plugin may use. Anything else is a plugin trying to shape the connection, not the message. */
const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

/**
 * This request went wrong — a bad URL, a refused hop, a timeout, a site that would not answer. It is
 * not the shell going wrong, and the difference matters on the wire: the backend counts 5xx replies
 * towards deciding the shell has died, and three of them deregister a shell that is working fine.
 */
class RequestError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/** A body past REQUEST_MAX, so the reply can say 413 instead of looking like a crash. */
class TooLarge extends RequestError {
  constructor() {
    super('request body is too large', 413);
  }
}

/** Anything thrown out of a site fetch is that fetch failing, not this process failing. */
function asRequestError(e) {
  if (e instanceof RequestError) return e;
  return new RequestError(e instanceof Error ? e.message : String(e));
}

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
    throw new RequestError(`fetch speaks http and https only, not ${at.protocol}`);
  }
  if (isLocalHost(at.hostname)) throw new RequestError('fetch must not point at a local address');
}

/** The url a route was handed, as a URL, or a refusal that reads like one. */
function parseUrl(url, what) {
  try {
    return new URL(String(url));
  } catch {
    throw new RequestError(`${what} needs a url, not ${JSON.stringify(String(url)).slice(0, 120)}`);
  }
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
    throw new RequestError(`redirect to an unreadable location: ${String(location).slice(0, 200)}`);
  }
  if (next.protocol !== 'http:' && next.protocol !== 'https:') {
    throw new RequestError(`redirect speaks http and https only, not ${next.protocol}`);
  }
  if (at.protocol === 'https:' && next.protocol === 'http:') {
    throw new RequestError('insecure redirect: https must not hand off to http');
  }
  if (isLocalHost(next.hostname)) throw new RequestError('redirect must not point at a local address');
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

/**
 * One persistent session per site, named by a hash of the origin rather than the host. The origin
 * because two origins can differ only in scheme or port and must not share a login; the hash because a
 * host can hold characters a partition name cannot, and any substitution scheme that flattens them
 * (`:` → `_`) lets two different hosts land in the same partition.
 */
function partitionFor(site) {
  const origin = new URL(site).origin;
  return `persist:site-${crypto.createHash('sha256').update(origin).digest('hex').slice(0, 16)}`;
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

/** One sign-in window per partition: a second Sign in click should raise the first window, not stack another. */
const signInWindows = new Map();

/**
 * The site's own sign-in page, in the site's own partition. Navigation is deliberately not pinned to
 * the site's origin: an OAuth flow hops to an identity provider and back, and a window that refuses the
 * hop is a window the user cannot sign in with. What *is* pinned: the scheme (http(s) only), the window
 * (popups load in place instead of opening a second one), no preload, no devtools, and every permission
 * request denied — a page the user is typing a password into has no business with the camera, the
 * microphone, their location or notifications.
 */
function openSignIn(site) {
  const { BrowserWindow, session } = requireElectron();
  const at = parseUrl(site, 'sign-in');
  assertFetchable(at);
  const partition = partitionFor(at.origin);
  const already = signInWindows.get(partition);
  if (already && !already.isDestroyed()) {
    // The window is still open but the user may have wandered off down an OAuth chain, or finished and
    // left it on some other page. Asked for the site again, it goes back to the site.
    let there = '';
    try {
      there = new URL(already.webContents.getURL()).origin;
    } catch {
      /* about:blank, or nothing loaded yet */
    }
    if (there !== at.origin) void already.loadURL(at.toString());
    already.focus();
    return already;
  }
  const ses = session.fromPartition(partition);
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  const win = new BrowserWindow({
    width: 1000,
    height: 760,
    title: `Sign in — ${at.host}`,
    webPreferences: {
      partition,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      devTools: false,
    },
  });
  signInWindows.set(partition, win);
  win.on('closed', () => {
    if (signInWindows.get(partition) === win) signInWindows.delete(partition);
  });
  win.setMenuBarVisibility(false);
  // On webContents, not on the window: BrowserWindow has no setWindowOpenHandler.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isHttpUrl(url)) void win.loadURL(url); // the popup loads in place; there is only ever one window
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!isHttpUrl(url)) event.preventDefault();
  });
  void win.loadURL(at.toString());
  return win;
}

// ---------------------------------------------------------------------------
// The site fetch
// ---------------------------------------------------------------------------

/**
 * Why `net.request` and not `session.fetch`: Electron 33's `session.fetch` does not implement
 * `redirect: 'manual'`. Its net-fetch never registers a handler for the underlying request's `redirect`
 * event, so the redirect is cancelled and the promise rejects with "Redirect was cancelled" on *any*
 * 3xx — a hand-rolled hop loop built on it never runs, and every redirecting site fetch fails. `net`
 * emits the event we need and lets us decide, hop by hop, whether to go on.
 */
function electronRequest({ url, method, partition }) {
  const { net, session } = requireElectron();
  return net.request({
    url,
    method,
    session: session.fromPartition(partition),
    // The login is the whole point of this path: without it the shell is an expensive plain fetch.
    credentials: 'include',
    redirect: 'manual',
  });
}

function validMethod(method) {
  const verb = String(method ?? 'GET').toUpperCase();
  if (!ALLOWED_METHODS.has(verb)) throw new RequestError(`fetch does not allow the method ${verb.slice(0, 20)}`);
  return verb;
}

function validBody(body, method) {
  if (body === undefined || body === null) return undefined;
  if (typeof body !== 'string') throw new RequestError('fetch body must be text');
  if (method === 'GET' || method === 'HEAD') throw new RequestError(`a ${method} does not carry a body`);
  return body;
}

/**
 * One request, and as many redirects as it can follow without changing shape. `followRedirect()` reuses
 * the request it is called on, which means it cannot change the method or drop the body — so a hop that
 * needs either (a 303, a POST through a 301/302, a cross-origin 307/308) resolves `restart` and the
 * caller issues a fresh request for it. Either way the hop is counted.
 */
function sendOnce({ request, partition, url, method, headers, body }, budget, clock) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    // Always called *after* the promise has been settled. `abort()` makes the net layer emit 'abort',
    // whose handler rejects; tearing the request down before recording an answer we already have would
    // lose that answer to the rejection if the event ever arrives synchronously.
    const stop = (req) => {
      try {
        req.abort();
      } catch {
        /* already gone */
      }
    };
    let at = url;
    let req;
    try {
      req = request({ url, method, partition });
    } catch (e) {
      return finish(reject, asRequestError(e));
    }
    clock.abort = () => {
      finish(reject, new RequestError('fetch timed out'));
      stop(req);
    };
    try {
      for (const [name, value] of Object.entries(headers)) req.setHeader(name, value);
    } catch (e) {
      // A header the net layer will not take must fail this request, not throw out of startShellLink's
      // promise executor where nothing is listening for it.
      finish(reject, asRequestError(e));
      return stop(req);
    }

    req.on('redirect', (statusCode, _redirectMethod, redirectUrl) => {
      if (settled) return;
      let hop;
      try {
        if (budget.hops >= MAX_REDIRECTS) throw new RequestError('too many redirects');
        hop = nextHop(at, redirectUrl, statusCode, method);
      } catch (e) {
        finish(reject, asRequestError(e));
        return stop(req);
      }
      budget.hops++;
      if (hop.method !== method || hop.dropBody) {
        finish(resolve, { type: 'restart', url: hop.url, method: hop.method, dropBody: hop.dropBody });
        return stop(req);
      }
      at = hop.url;
      req.followRedirect(); // must be synchronous inside this event, or the redirect is cancelled
    });

    req.on('response', (res) => {
      const chunks = [];
      let total = 0;
      let truncated = false;
      // Both of these run as event listeners: anything they throw would come out of the emitter with
      // nobody to catch it, leaving this promise pending forever and taking the app down with it. They
      // settle the promise instead.
      const deliver = () => {
        try {
          const out = safeResponseHeaders(res.headers);
          out['content-length'] = String(total); // what we actually hand over, not what the server claimed
          finish(resolve, {
            type: 'done',
            result: {
              status: res.statusCode,
              headers: out,
              body: Buffer.concat(chunks).toString('utf8'),
              truncated,
            },
          });
        } catch (e) {
          finish(reject, asRequestError(e));
        }
      };
      res.on('data', (chunk) => {
        if (settled) return;
        try {
          if (total + chunk.length > BODY_MAX) {
            // `content-length` is a claim, not a limit: stop at the cap however much is still coming.
            chunks.push(chunk.subarray(0, BODY_MAX - total));
            total = BODY_MAX;
            truncated = true;
            deliver();
            return stop(req);
          }
          chunks.push(chunk);
          total += chunk.length;
        } catch (e) {
          finish(reject, asRequestError(e));
        }
      });
      res.on('end', deliver);
      res.on('error', (e) => finish(reject, asRequestError(e)));
    });

    const failed = (e) => finish(reject, clock.timedOut ? new RequestError('fetch timed out') : asRequestError(e));
    req.on('error', failed);
    req.on('abort', () => failed(new Error('the request was aborted')));
    try {
      if (body !== undefined) req.write(body);
      req.end();
    } catch (e) {
      finish(reject, asRequestError(e));
    }
  });
}

/**
 * The site fetch, made from the site's partition so its cookies go along. Every hop is re-checked the
 * way the backend re-checks its own: http(s) only, no downgrade to http, never a local address, and a
 * body that is never replayed at an origin the plugin did not address. One timeout covers the whole
 * chain, not each hop.
 */
async function fetchWithSite(url, init, request = electronRequest) {
  const start = parseUrl(url, 'fetch');
  assertFetchable(start);
  const partition = partitionFor(start.origin);
  let method = validMethod(init?.method);
  let body = validBody(init?.body, method);
  // `origin` and `referer` go unconditionally, not just across origins: a request the shell makes has no
  // origin of its own to name, and `followRedirect` cannot recompute headers part-way down a chain.
  let headers = requestHeadersFor(init?.headers, { crossOrigin: true });
  let current = start.toString();
  const budget = { hops: 0 };
  const clock = { timedOut: false, abort: null };
  const timer = setTimeout(() => {
    clock.timedOut = true;
    clock.abort?.();
  }, TIMEOUT_MS);
  try {
    for (;;) {
      const out = await sendOnce({ request, partition, url: current, method, headers, body }, budget, clock);
      if (out.type === 'done') return out.result;
      current = out.url;
      method = out.method;
      if (out.dropBody) {
        body = undefined;
        headers = withoutHeader(headers, 'content-type'); // a bodyless request does not describe a body
      }
    }
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// The link itself
// ---------------------------------------------------------------------------

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
        reject(new RequestError('body is not json'));
      }
    });
    req.on('error', (e) => reject(asRequestError(e)));
    // A caller that goes away mid-body never emits 'end'; without this the handler waits on a promise
    // that will not settle and the request object is held for as long as the process lives.
    req.on('close', () => reject(new RequestError('the request closed before its body arrived')));
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
function startShellLink({ log = console.log, impl, backendUrl } = {}) {
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
        // A request going wrong is not the shell going wrong, and the backend reads 5xx as the latter:
        // three in a row and it deregisters a healthy shell. Everything it could have caused — a bad
        // url, a refused hop, a timeout, a site that would not answer — says 4xx.
        const status = e instanceof RequestError ? e.status : 500;
        if (status >= 500) log('[shell-link]', why(e));
        reply(status, { error: why(e) }); // the message, never the stack: this crosses a process boundary
      }
    });
    let listening = false;
    // Before it listens, a server error is the reason startShellLink failed. After, it is one socket
    // going wrong, and throwing an unhandled 'error' out of an EventEmitter would take the app with it.
    server.on('error', (e) => (listening ? log('[shell-link] server error:', why(e)) : reject(e)));
    server.listen(0, '127.0.0.1', () => {
      listening = true;
      const { port } = server.address();
      log('[shell-link] listening on 127.0.0.1:' + port);
      const shut = () => {
        server.close();
        server.closeAllConnections(); // the backend keeps its sockets alive; close() alone would wait for them
      };
      const link = {
        port,
        token,
        /** Set by close(). A hello already part-way through its retries checks it and gives up. */
        hungUp: false,
        // Say goodbye before going: without it the backend keeps offering sign-in and site fetches
        // until three of them have failed. Best effort and on a short leash — we are quitting.
        close: () => {
          link.hungUp = true;
          return backendUrl ? goodbye(backendUrl, token, log).finally(shut) : Promise.resolve(shut());
        },
      };
      resolve(link);
    });
  });
}

/**
 * Tell the backend where the callback is. Retried while the backend comes up, and re-sent periodically
 * by main.js: the backend can restart under the app (the dev setup does exactly that) and a restarted
 * backend has forgotten the link. It is idempotent on that side — a hello from the shell already
 * registered leaves things as they are.
 */
let lastHelloFailed = false;

async function hello(backendUrl, link, log = console.log) {
  for (let i = 0; i < 10; i++) {
    // A shell that has said goodbye must not announce itself again: the retry loop can still be
    // part-way through its ten seconds when the app quits, and the link it would hand over is closed.
    if (link.hungUp) return false;
    try {
      const r = await fetch(`${backendUrl}/api/shell/hello`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port: link.port, token: link.token }),
      });
      if (r.ok) {
        // This runs every minute, so it says something only when the answer changes.
        if (lastHelloFailed) log('[shell-link] the backend is answering hello again');
        lastHelloFailed = false;
        return true;
      }
    } catch {
      /* the backend is not up yet */
    }
    if (i < 9) await new Promise((r) => setTimeout(r, 1000)); // no waiting after the last try
  }
  if (!lastHelloFailed) log('[shell-link] backend never answered hello; plugin site fetches and sign-in are unavailable');
  lastHelloFailed = true;
  return false;
}

/** Hang up: the backend stops offering sign-in and stops sending us fetches straight away. */
async function goodbye(backendUrl, token, log = console.log) {
  try {
    await fetch(`${backendUrl}/api/shell/goodbye`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
      signal: AbortSignal.timeout(1000),
    });
  } catch (e) {
    log('[shell-link] goodbye did not reach the backend:', why(e));
  }
}

module.exports = {
  startShellLink,
  hello,
  goodbye,
  fetchWithSite,
  partitionFor,
  isLocalHost,
  safeResponseHeaders,
  requestHeadersFor,
  nextHop,
};
