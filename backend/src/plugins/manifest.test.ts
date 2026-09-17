import { describe, expect, it } from 'vitest';
import { extractManifest, validateManifest, MAX_FILE } from './manifest.js';

const GOOD = `export const manifest = {
  "id": "hello-feed",
  "name": "Hello feed",
  "version": "1.0.0",
  "api": 1,
  "sites": ["https://example.com"],
  "permissions": ["feed:write", "storage"],
  "ui": false,
  "description": "Posts example items."
};
export default function main(ot) { ot.log('hi'); }
`;

const BASE_MANIFEST = {
  id: 'hello-feed',
  name: 'Hello feed',
  version: '1.0.0',
  api: 1,
  sites: [] as string[],
  permissions: [] as string[],
  ui: false,
  description: '',
};

describe('extractManifest', () => {
  it('reads the JSON block after "export const manifest =" without running the file', () => {
    const m = extractManifest(GOOD);
    expect(m).toEqual({ id: 'hello-feed', name: 'Hello feed', version: '1.0.0', api: 1, sites: ['https://example.com'], permissions: ['feed:write', 'storage'], ui: false, description: 'Posts example items.' });
  });
  it('tolerates braces inside strings and stops at the matching one', () => {
    const src = GOOD.replace('"Posts example items."', '"Posts {items} like };"');
    expect(extractManifest(src).description).toBe('Posts {items} like };');
  });
  it('rejects a missing block, bad JSON, a bad id, unknown permissions, non-https sites and a future api', () => {
    expect(() => extractManifest('export default function main() {}')).toThrow('no manifest');
    expect(() => extractManifest('export const manifest = { id: "x" };')).toThrow('manifest is not valid JSON');
    expect(() => extractManifest(GOOD.replace('"hello-feed"', '"Hello Feed"'))).toThrow('id');
    expect(() => extractManifest(GOOD.replace('"storage"', '"root"'))).toThrow('permission');
    expect(() => extractManifest(GOOD.replace('https://example.com', 'http://example.com'))).toThrow('sites');
    expect(() => extractManifest(GOOD.replace('"api": 1', '"api": 2'))).toThrow('api 2');
  });
  it('defaults sites, permissions, ui and description', () => {
    const m = extractManifest('export const manifest = {"id":"a","name":"A","version":"0.1.0","api":1};');
    expect(m).toEqual({ id: 'a', name: 'A', version: '0.1.0', api: 1, sites: [], permissions: [], ui: false, description: '' });
  });
  it('rejects an oversize file', () => {
    expect(() => extractManifest('x'.repeat(MAX_FILE + 1))).toThrow('too large');
  });
  it('rejects a manifest block that never closes', () => {
    expect(() => extractManifest('export const manifest = { "id": "a"')).toThrow('never closes');
  });
  it('rejects a second manifest block', () => {
    expect(() => extractManifest(GOOD + '\nexport const manifest = {};')).toThrow('more than one');
  });
  it('allows the manifest to be preceded by a comment', () => {
    expect(() => extractManifest(`// a hello-world plugin\n${GOOD}`)).not.toThrow();
    expect(() => extractManifest(`/* a hello-world plugin */\n${GOOD}`)).not.toThrow();
  });
  it('rejects a manifest preceded by another statement', () => {
    expect(() => extractManifest(`const x = 1;\n${GOOD}`)).toThrow('first statement');
  });
  it('replaces a control character in the name with a space', () => {
    // \\u0000 here is a literal JSON escape sequence in the source text, so JSON.parse turns it
    // into a real NUL character in the parsed name — exactly what a hostile manifest would send.
    const src = GOOD.replace('"Hello feed"', '"Hello\\u0000feed"');
    expect(extractManifest(src).name).toBe('Hello feed');
  });
});

describe('validateManifest', () => {
  it('rejects a non-object', () => {
    expect(() => validateManifest(null)).toThrow('object');
    expect(() => validateManifest('nope')).toThrow('object');
  });
  it('rejects a missing name', () => {
    expect(() => validateManifest({ ...BASE_MANIFEST, name: '   ' })).toThrow('name');
  });
  it('rejects a bad version', () => {
    expect(() => validateManifest({ ...BASE_MANIFEST, version: '1.2' })).toThrow('version');
  });
  it('rejects a non-integer api', () => {
    expect(() => validateManifest({ ...BASE_MANIFEST, api: 1.5 })).toThrow('api');
  });
  it('rejects a future api', () => {
    expect(() => validateManifest({ ...BASE_MANIFEST, api: 99 })).toThrow('api 99');
  });
  it('rejects a site that is not a URL', () => {
    expect(() => validateManifest({ ...BASE_MANIFEST, sites: ['not-a-url'] })).toThrow('sites');
  });
  it('rejects an http site', () => {
    expect(() => validateManifest({ ...BASE_MANIFEST, sites: ['http://example.com'] })).toThrow('sites');
  });
  it('rejects a site with a path', () => {
    expect(() => validateManifest({ ...BASE_MANIFEST, sites: ['https://example.com/path'] })).toThrow('sites');
  });
  it('rejects an unknown permission', () => {
    expect(() => validateManifest({ ...BASE_MANIFEST, permissions: ['root'] })).toThrow('permission');
  });
  it('dedupes sites and permissions', () => {
    const m = validateManifest({ ...BASE_MANIFEST, sites: ['https://example.com', 'https://example.com'], permissions: ['storage', 'storage'] });
    expect(m.sites).toEqual(['https://example.com']);
    expect(m.permissions).toEqual(['storage']);
  });
});
