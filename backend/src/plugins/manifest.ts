import { isLocalHost } from './hosts.js';

/** What a plugin declares at the top of its file. The block must be plain JSON so the app can read it without running anything. */
export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  /** opentrench plugin API major version the plugin was written for */
  api: number;
  /** https origins the plugin may fetch through the user's login */
  sites: string[];
  permissions: PluginPermission[];
  /** true when the plugin draws a column */
  ui: boolean;
  description: string;
}
export type PluginPermission = 'feed:write' | 'storage' | 'actions';
export const PERMISSIONS: PluginPermission[] = ['feed:write', 'storage', 'actions'];
/** The API major this build serves. Append-only within a major; bump when anything is renamed or removed. */
export const PLUGIN_API_VERSION = 1;

export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManifestError';
  }
}

/** A plugin id: 1–40 chars of a-z, 0-9 and dashes, starting with a letter or digit. */
export const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
/**
 * Ids that name something on a plain object rather than something in the folder: the config keeps
 * its plugins in one, and `plugins.constructor = …` is a write nobody reads back. `__proto__` cannot
 * pass the pattern above anyway; it is named here so the rule reads as the whole rule, and so the
 * registry's fallback ids can be held to the same list.
 */
export const RESERVED_IDS = new Set(['__proto__', 'constructor', 'prototype']);
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/;
export const MAX_FILE = 512 * 1024;
/** Shared so the registry rejects an oversize file with the same words the parser would. */
export const MAX_FILE_MESSAGE = `plugin file is too large (${MAX_FILE / 1024} KB max)`;
const MAX_SITES = 20;

/** Matches the manifest block only when it is the very first thing in the (comment-stripped) source. */
const MANIFEST_RE_ANCHORED = /^export\s+const\s+manifest\s*=\s*\{/;
/** Same pattern, unanchored, used to detect a manifest block anywhere in the file. */
const MANIFEST_RE_ANY = /export\s+const\s+manifest\s*=\s*\{/;

/** Strips leading whitespace and `//` / `/* … *\/` comments, returning the index of the first real statement. */
function firstStatementStart(source: string): number {
  let i = 0;
  for (;;) {
    while (i < source.length && /\s/.test(source[i])) i++;
    if (source.startsWith('//', i)) {
      const nl = source.indexOf('\n', i);
      i = nl < 0 ? source.length : nl + 1;
      continue;
    }
    if (source.startsWith('/*', i)) {
      const close = source.indexOf('*/', i + 2);
      i = close < 0 ? source.length : close + 2;
      continue;
    }
    break;
  }
  return i;
}

/** Removes control (Cc) and format (Cf) characters, collapses whitespace, and trims/truncates. */
const clean = (v: unknown, max: number): string =>
  String(v ?? '')
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

/**
 * Finds `export const manifest =` as the first statement of the file, takes the `{…}` that follows
 * (string-aware brace matching), parses it as JSON, and validates it. Never executes the file.
 */
export function extractManifest(source: string): PluginManifest {
  if (source.length > MAX_FILE) throw new ManifestError(MAX_FILE_MESSAGE);

  const bodyStart = firstStatementStart(source);
  const rest = source.slice(bodyStart);
  const head = MANIFEST_RE_ANCHORED.exec(rest);
  if (!head) {
    if (MANIFEST_RE_ANY.test(source)) {
      throw new ManifestError('the manifest must be the first statement in the file');
    }
    throw new ManifestError('no manifest: the file must start with `export const manifest = { … };`');
  }

  const start = bodyStart + head[0].length - 1; // index of the opening '{'
  let depth = 0;
  let inStr = false;
  let end = -1;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (inStr) {
      if (ch === '\\') i++;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) throw new ManifestError('manifest block never closes');

  const second = MANIFEST_RE_ANY.exec(source.slice(end + 1));
  if (second) {
    const line = source.slice(0, end + 1 + second.index).split('\n').length;
    throw new ManifestError(`more than one \`export const manifest\` (second one at line ${line}); only the first is allowed`);
  }

  let raw: any;
  try {
    raw = JSON.parse(source.slice(start, end + 1));
  } catch {
    throw new ManifestError('manifest is not valid JSON (quoted keys, no comments, no trailing commas)');
  }
  return validateManifest(raw);
}

export function validateManifest(raw: any): PluginManifest {
  if (!raw || typeof raw !== 'object') throw new ManifestError('manifest must be an object');
  const id = String(raw.id ?? '');
  if (!PLUGIN_ID_RE.test(id)) throw new ManifestError('manifest id must be 1–40 chars of a-z, 0-9 and dashes');
  if (RESERVED_IDS.has(id)) throw new ManifestError(`manifest id "${id}" is reserved`);
  const name = clean(raw.name, 60);
  if (!name) throw new ManifestError('manifest needs a name');
  const version = String(raw.version ?? '').trim();
  if (version.length > 40 || !VERSION_RE.test(version)) throw new ManifestError('manifest version must look like 1.2.3');
  const api = Number(raw.api);
  if (!Number.isInteger(api) || api < 1) throw new ManifestError('manifest api must be a positive integer');
  if (api > PLUGIN_API_VERSION) {
    throw new ManifestError(`this plugin needs plugin api ${api}; this build serves ${PLUGIN_API_VERSION} — update opentrench`);
  }

  const rawSites: string[] = Array.isArray(raw.sites) ? raw.sites.map((s: unknown) => String(s)) : [];
  if (rawSites.length > MAX_SITES) throw new ManifestError(`sites: at most ${MAX_SITES}`);
  const origins: string[] = [];
  for (const s of rawSites) {
    let u: URL;
    try {
      u = new URL(s);
    } catch {
      throw new ManifestError(`sites: ${s} is not a URL`);
    }
    if (u.protocol !== 'https:' || u.pathname !== '/' || u.search || u.hash) {
      throw new ManifestError(`sites: ${s} must be an https origin like https://example.com`);
    }
    // a site on the machine or the LAN would let the plugin fetch the app's own API, a router page or a
    // metadata service through the shell's session, which is the one thing the allow-list exists to stop
    if (isLocalHost(u.hostname)) throw new ManifestError(`sites: ${s} is a local address`);
    origins.push(u.origin);
  }

  const permissions: string[] = Array.isArray(raw.permissions) ? raw.permissions.map((p: unknown) => String(p)) : [];
  for (const p of permissions) {
    if (!PERMISSIONS.includes(p as PluginPermission)) {
      throw new ManifestError(`unknown permission "${p}" (allowed: ${PERMISSIONS.join(', ')})`);
    }
  }

  return {
    id,
    name,
    version,
    api,
    sites: [...new Set(origins)],
    permissions: [...new Set(permissions)] as PluginPermission[],
    ui: raw.ui === true,
    description: clean(raw.description, 300),
  };
}
