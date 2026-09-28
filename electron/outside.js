// Which links stay in the app window and which leave it, and how. Kept free of Electron so it runs under
// plain `node --test`. Links come from strangers: a coin's website is whatever its creator wrote
// on-chain, and chat messages come from anyone in a chat.

/**
 * Our own page, by origin. A prefix test is not enough: `http://127.0.0.1:3210@evil.example/` starts
 * with our address but goes to evil.example, and a coin's website link can be exactly that.
 */
function isAppUrl(url, base) {
  try {
    return new URL(url).origin === new URL(base).origin;
  } catch {
    return false;
  }
}

/**
 * What to do with a link that is not our page: web links go to the browser and `tg:` to Telegram
 * ('open'), an opentrench:// invite comes back to us ('link'), and anything else is refused. Handing
 * any scheme to the OS lets a link start programs (a `file:` path on a remote share, `ms-msdt:`,
 * `search-ms:` on Windows).
 */
function outsideAction(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return { action: 'refuse', scheme: 'not a URL' };
  }
  if (u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'tg:') return { action: 'open', href: u.href };
  if (u.protocol === 'opentrench:') return { action: 'link' };
  return { action: 'refuse', scheme: u.protocol };
}

module.exports = { isAppUrl, outsideAction };
