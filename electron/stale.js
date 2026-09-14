// A backend from another build answering on our port (an orphan that outlived an update, a stale
// `npm start`): find the process holding the port and stop it, so the app can start its own.
const { execFile } = require('node:child_process');

const run = (cmd, args) => new Promise((resolve) => execFile(cmd, args, { windowsHide: true }, (err, stdout) => resolve({ ok: !err, out: String(stdout ?? '') })));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The pid listening on `port`, or null. */
async function listenerPid(port) {
  if (process.platform === 'win32') {
    const r = await run('netstat', ['-ano', '-p', 'tcp']);
    for (const line of r.out.split(/\r?\n/)) {
      const m = /^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i.exec(line);
      if (m && Number(m[2]) === port) return Number(m[3]);
    }
    return null;
  }
  const r = await run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']);
  const pid = Number(r.out.trim().split(/\s+/)[0]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** What the pid is running, for the log. */
async function describePid(pid) {
  if (process.platform === 'win32') {
    const r = await run('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV']);
    return r.out.split(',')[0]?.replace(/"/g, '').trim() || `pid ${pid}`;
  }
  const r = await run('ps', ['-o', 'command=', '-p', String(pid)]);
  return r.out.trim() || `pid ${pid}`;
}

/**
 * Stop whatever listens on `port` and wait until the port is free (`isUp` polls it).
 * Returns { ok, pid, what } — ok false when nothing was found or it would not die.
 */
async function stopListener(port, isUp, log = () => {}) {
  const pid = await listenerPid(port);
  if (!pid || pid === process.pid) return { ok: false, pid: null, what: '' };
  const what = await describePid(pid);
  log(`stopping stale backend pid ${pid} (${what}) on port ${port}`);
  if (process.platform === 'win32') await run('taskkill', ['/PID', String(pid), '/T', '/F']);
  else {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* gone already, or not ours */
    }
  }
  for (let i = 0; i < 40; i++) {
    if (!(await isUp())) return { ok: true, pid, what };
    await sleep(250);
  }
  if (process.platform !== 'win32') {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* ignore */
    }
    for (let i = 0; i < 20; i++) {
      if (!(await isUp())) return { ok: true, pid, what };
      await sleep(250);
    }
  }
  return { ok: false, pid, what };
}

module.exports = { listenerPid, describePid, stopListener };
