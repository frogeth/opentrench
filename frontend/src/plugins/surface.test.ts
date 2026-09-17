import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BRIDGE_SRC } from './bridge';

// jsdom supplies its own URL global, which fs will not take — resolve to a plain path first
const routeSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'route.ts'), 'utf8');

/** every `call('x.y'` the bridge makes */
const bridgeMethods = new Set([...BRIDGE_SRC.matchAll(/call\('([a-zA-Z.]+)'/g)].map((m) => m[1]));
/** every `case 'x.y':` the router answers */
const routerMethods = new Set([...routeSrc.matchAll(/case '([a-zA-Z.]+)':/g)].map((m) => m[1]));
/** router cases that are deliberately not on the `ot` surface (none today — list them here if that changes) */
const ROUTER_ONLY: string[] = [];

/**
 * The two halves are written apart and shipped together: a method on one side and not the other is a
 * plugin call that throws, or a router case nothing can ever reach. Compare the surfaces, not the code.
 */
describe('the ot surface', () => {
  it('has the same methods on the bridge and in the router', () => {
    expect([...bridgeMethods].sort()).toEqual([...routerMethods].filter((m) => !ROUTER_ONLY.includes(m)).sort());
  });

  it('covers every group the plugins are promised', () => {
    for (const m of ['feed.messages', 'feed.tokens', 'feed.token', 'feed.post', 'feed.patch', 'fetch', 'sites.status', 'sites.signIn', 'storage.get', 'storage.set', 'storage.remove', 'settings.schema', 'settings.get', 'ui.setTitle', 'ui.setSubtitle', 'ui.badge', 'actions.openToken', 'actions.jump', 'actions.buy', 'actions.research', 'actions.copy', 'actions.notify', 'log'])
      expect(bridgeMethods).toContain(m);
  });

  it('stays a literal String.raw template: no backtick, no interpolation', () => {
    expect(BRIDGE_SRC).not.toContain('`');
    expect(BRIDGE_SRC).not.toContain('$' + '{');
  });
});
