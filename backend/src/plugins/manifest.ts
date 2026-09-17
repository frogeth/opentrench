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
const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MAX_FILE = 512 * 1024;

/** Finds `export const manifest =`, takes the `{…}` that follows (string-aware brace matching), parses it as JSON, validates. */
export function extractManifest(source: string): PluginManifest {
  if (source.length > MAX_FILE) throw new Error('plugin file is too large (512 KB max)');
  const at = source.search(/export\s+const\s+manifest\s*=\s*\{/);
  if (at < 0) throw new Error('no manifest: the file must start with `export const manifest = { … };`');
  const start = source.indexOf('{', at);
  let depth = 0;
  let inStr: string | null = null;
  let end = -1;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (inStr) {
      if (ch === '\\') i++;
      else if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'") inStr = ch;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) throw new Error('manifest block never closes');
  let raw: any;
  try {
    raw = JSON.parse(source.slice(start, end + 1));
  } catch {
    throw new Error('manifest is not valid JSON (quoted keys, no comments, no trailing commas)');
  }
  return validateManifest(raw);
}

export function validateManifest(raw: any): PluginManifest {
  if (!raw || typeof raw !== 'object') throw new Error('manifest must be an object');
  const id = String(raw.id ?? '');
  if (!ID_RE.test(id)) throw new Error('manifest id must be 1–40 chars of a-z, 0-9 and dashes');
  const name = String(raw.name ?? '').trim().slice(0, 60);
  if (!name) throw new Error('manifest needs a name');
  const version = String(raw.version ?? '').trim().slice(0, 20);
  if (!/^\d+\.\d+\.\d+/.test(version)) throw new Error('manifest version must look like 1.2.3');
  const api = Number(raw.api);
  if (!Number.isInteger(api) || api < 1) throw new Error('manifest api must be a positive integer');
  if (api > PLUGIN_API_VERSION) throw new Error(`this plugin needs plugin api ${api}; this build serves ${PLUGIN_API_VERSION} — update opentrench`);
  const sites: string[] = Array.isArray(raw.sites) ? raw.sites.map((s: unknown) => String(s)) : [];
  for (const s of sites) {
    let u: URL;
    try {
      u = new URL(s);
    } catch {
      throw new Error(`sites: ${s} is not a URL`);
    }
    if (u.protocol !== 'https:' || u.pathname !== '/' || u.search || u.hash) throw new Error(`sites: ${s} must be an https origin like https://example.com`);
  }
  const permissions: string[] = Array.isArray(raw.permissions) ? raw.permissions.map((p: unknown) => String(p)) : [];
  for (const p of permissions) if (!PERMISSIONS.includes(p as PluginPermission)) throw new Error(`unknown permission "${p}" (allowed: ${PERMISSIONS.join(', ')})`);
  return { id, name, version, api, sites: [...new Set(sites.map((s: string) => new URL(s).origin))], permissions: [...new Set(permissions)] as PluginPermission[], ui: raw.ui === true, description: String(raw.description ?? '').slice(0, 300) };
}
