/**
 * What a plugin's request may look like on the wire. One copy, because the route (what a plugin is
 * allowed to send) and the fetch layer (what actually goes out, hop after hop) must agree: a header
 * the route lets through and the shell then strips is a bug that only shows on someone's machine.
 */

/** RFC 9110 token characters. A name outside this set is a plugin trying to shape the request itself. */
export const HEADER_NAME_RE = /^[a-z0-9!#$%&'*+.^_`|~-]+$/i;

/**
 * Hop-by-hop headers and the ones the fetch layer owns. A plugin naming these is either confused or
 * probing: `host` and `cookie` decide who the request is for and who it is from, and the rest belong
 * to the connection rather than the message.
 */
export const REQUEST_HEADER_STRIP = new Set(['host', 'content-length', 'transfer-encoding', 'connection', 'proxy-connection', 'upgrade', 'te', 'keep-alive', 'cookie']);

/** Sent to the origin that was asked for, and to no other — and never by a plugin over the shell's login. */
export const CREDENTIAL_HEADERS = new Set(['authorization', 'proxy-authorization']);

/** The statuses that carry a `location` we would have to follow. */
export const REDIRECT_STATUS = [301, 302, 303, 307, 308];
