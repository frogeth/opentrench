/**
 * Is this hostname the user's own machine or their local network?
 *
 * Plugins hand us URLs, and a URL pointed inside the network is a way to reach things the plugin
 * could not reach itself: the app's own API on 3210, a router's admin page, a cloud metadata service
 * on 169.254.169.254. Both the fetch allow-list (a plugin's declared `sites`) and the click-gated
 * `link` on a post refuse these.
 *
 * Takes a hostname as WHATWG `URL` gives it, which has already folded the sneaky spellings:
 * `127.1` and `0x7f000001` both arrive as `127.0.0.1`, and IPv6 arrives bracketed and compressed.
 * What is left to handle here is the trailing dot (`localhost.`), the IPv6 literals, and the
 * IPv4-mapped form, whose tail `URL` serializes as two hex groups (`[::ffff:7f00:1]`).
 *
 * This is a name check, so it is only the cheap first pass: a name that looks public can still
 * resolve to a local address. `isLocalIp` below is the same judgement applied to a resolved
 * address, which is what the fetch path pins its connections to.
 */
export function isLocalHost(hostname: string): boolean {
  let h = String(hostname ?? '')
    .trim()
    .toLowerCase();
  if (h.endsWith('.')) h = h.slice(0, -1); // the root-label spelling: `localhost.` resolves the same
  if (!h) return false;
  if (h.startsWith('[') && h.endsWith(']')) return isLocalIpv6(h.slice(1, -1));
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  return isLocalIpv4(h);
}

/**
 * Is this resolved address one we refuse to connect to? Same judgement as `isLocalHost`, but for a
 * literal address in either family and without the brackets a URL puts around IPv6. DNS is the hole
 * a name check cannot cover — a public name can answer 127.0.0.1 — so the fetch path resolves first
 * and runs every answer past this before a socket is opened.
 */
export function isLocalIp(ip: string): boolean {
  const s = String(ip ?? '')
    .trim()
    .toLowerCase();
  if (!s) return false;
  const inner = s.startsWith('[') && s.endsWith(']') ? s.slice(1, -1) : s;
  if (inner.includes(':')) return isLocalIpv6(inner);
  return isLocalIpv4(inner);
}

function isLocalIpv4(h: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
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

function isLocalIpv6(inner: string): boolean {
  const v = inner.replace(/%.*$/, ''); // a zone id rides along on link-local addresses: fe80::1%en0
  if (v === '::1' || v === '::') return true;
  if (/^(0{1,4}:){7}0{0,3}1$/.test(v)) return true; // the same loopback written out: 0:0:0:0:0:0:0:1
  if (/^(0{1,4}:){7}0{1,4}$/.test(v)) return true; // and the unspecified address written out
  if (/^ff/.test(v)) return true; // ff00::/8, multicast
  if (/^f[cd]/.test(v)) return true; // fc00::/7, unique local
  if (/^fe[89ab]/.test(v)) return true; // fe80::/10, link-local
  // An IPv4 riding inside an IPv6: the mapped form `::ffff:…` and the NAT64 well-known prefix `64:ff9b::…`.
  // Both reach the v4 address they carry, so both are judged as that address.
  const carried = /^::ffff:(.+)$/.exec(v) ?? /^64:ff9b::(.+)$/.exec(v);
  if (carried) {
    const v4 = carriedIpv4(carried[1]);
    if (v4) return isLocalIpv4(v4);
  }
  return false;
}

/** The tail of a mapped address, as either two hex groups (`7f00:1`, how URL writes it) or dotted quad. */
function carriedIpv4(tail: string): string | null {
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(tail);
  if (hex) {
    const n = (parseInt(hex[1], 16) << 16) | parseInt(hex[2], 16);
    return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
  }
  return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(tail) ? tail : null;
}
