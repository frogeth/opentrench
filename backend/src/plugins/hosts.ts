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

function isLocalIpv4(h: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 127) return true; // loopback
  if (a === 0) return true; // 0.0.0.0 and the rest of "this network"
  if (a === 10) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 169 && b === 254) return true; // link-local, and the cloud metadata address
  return false;
}

function isLocalIpv6(inner: string): boolean {
  if (inner === '::1' || inner === '::') return true;
  if (/^f[cd]/.test(inner)) return true; // fc00::/7, unique local
  if (/^fe[89ab]/.test(inner)) return true; // fe80::/10, link-local
  // IPv4-mapped: `::ffff:7f00:1` as URL writes it, or `::ffff:127.0.0.1` as a plugin might
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(inner);
  if (hex) {
    const n = (parseInt(hex[1], 16) << 16) | parseInt(hex[2], 16);
    return isLocalIpv4([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.'));
  }
  const dotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(inner);
  if (dotted) return isLocalIpv4(dotted[1]);
  return false;
}
