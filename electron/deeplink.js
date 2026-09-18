// The pure half of the opentrench:// deep link: which strings the shell forwards to the page, and how
// to spot one among a process's arguments. Kept free of Electron so it runs under plain `node --test`.

/** A link the page may see: the scheme, then 1–600 URL characters and nothing else (no spaces, no control characters). */
const LINK = /^opentrench:\/\/[A-Za-z0-9._~:/?#\[\]@!$&'()*+,;=%-]{1,600}$/;

function isLink(s) {
  return typeof s === 'string' && LINK.test(s);
}

/**
 * The first opentrench:// entry of an argv, or undefined. Windows and Linux hand a clicked link to a
 * fresh process as one argument among the executable, `.` in dev and any flags; a second instance
 * forwards that argv to the running one.
 */
function findLink(argv) {
  if (!Array.isArray(argv)) return undefined;
  return argv.find(isLink);
}

module.exports = { isLink, findLink, LINK };
