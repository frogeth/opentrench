import { describe, expect, it } from 'vitest';
import { extractManifest } from './manifest.js';

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
});
