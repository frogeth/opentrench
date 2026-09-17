import { Router, json, type Request, type Response } from 'express';
import type { ConfigStore } from '../config.js';
import { jsonErrors } from '../http.js';
import { CHAINS } from './chains.js';
import type { Endpoints } from './endpoints.js';
import type { LivePricer } from './live.js';

/**
 * Settings → Feed → Market data: the Alchemy key, custom RPCs (the one table every on-chain read and
 * the minter use), and what each chain is using.
 * Mutations need the app's own header (the same rule as the plugin routes): a page in a browser
 * cannot point the pricer at an RPC of its choosing.
 */
const REQUESTED_WITH = 'opentrench';
const ALCHEMY_KEY_RE = /^[A-Za-z0-9_-]{8,200}$/;
const RPC_URL_RE = /^https:\/\//i;
const LOCAL_URL_RE = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i;

export function createMarketApi(cfg: ConfigStore, endpoints: Endpoints, pricer: LivePricer): Router {
  const r = Router();
  r.use(json({ limit: '8kb' }));
  const status = () => {
    const sources = endpoints.sources();
    const live = pricer.status();
    return {
      alchemy: endpoints.alchemy(),
      rpc: cfg.get().rpc,
      quotes: pricer.quotes(),
      visible: pricer.visible().size,
      chains: Object.values(CHAINS).map((ch) => ({
        network: ch.network,
        name: ch.name,
        native: ch.native,
        alchemy: !!ch.alchemy,
        v4: !!ch.v4 || ch.kind === 'solana',
        defaultRpc: ch.rpc,
        source: sources[ch.network],
        ...(live[ch.network] ?? {}),
      })),
    };
  };
  const guard = (req: Request, res: Response): boolean => {
    if (req.get('x-requested-with') !== REQUESTED_WITH) {
      res.status(403).json({ error: 'this request must come from the opentrench app' });
      return false;
    }
    return true;
  };
  r.get('/market', (_req, res) => res.json(status()));
  r.put('/market/alchemy', async (req, res, next) => {
    try {
      if (!guard(req, res)) return;
      const key = String(req.body?.key ?? '').trim();
      if (key && !ALCHEMY_KEY_RE.test(key)) {
        res.status(400).json({ error: 'that does not look like an Alchemy API key' });
        return;
      }
      const probe = await endpoints.probeAlchemy(key || undefined);
      if (key && probe.chains.length === 0) {
        // keep whatever was saved before: a key that answers nowhere is not worth storing
        await endpoints.probeAlchemy(cfg.get().marketData.alchemyKey);
        res.status(400).json({ error: probe.error ?? 'the key answered for no chain' });
        return;
      }
      cfg.update((c) => {
        c.marketData.alchemyKey = key || undefined;
      });
      res.json(status());
    } catch (e) {
      next(e);
    }
  });
  // a screen reports the tokens it is showing; the pricer reads exactly those pools
  r.put('/market/visible', (req, res) => {
    if (!guard(req, res)) return;
    const client = String(req.body?.client ?? '').slice(0, 64);
    const addresses = (Array.isArray(req.body?.addresses) ? req.body.addresses : []).filter((a: unknown) => typeof a === 'string' && a.length <= 64).slice(0, 500) as string[];
    if (!client) {
      res.status(400).json({ error: 'client id missing' });
      return;
    }
    pricer.setVisible(client, addresses);
    res.json({ ok: true });
  });
  r.put('/market/rpc', (req, res, next) => {
    try {
      if (!guard(req, res)) return;
      const chain = String(req.body?.chain ?? '');
      const url = String(req.body?.url ?? '').trim().slice(0, 500);
      if (!/^[a-z0-9_]{1,30}$/.test(chain) || !Object.hasOwn(CHAINS, chain)) {
        res.status(400).json({ error: 'unknown chain' });
        return;
      }
      if (url && !RPC_URL_RE.test(url) && !LOCAL_URL_RE.test(url)) {
        res.status(400).json({ error: 'RPC must be https:// (or a local http endpoint)' });
        return;
      }
      if (url) {
        let hostname = '';
        try {
          hostname = new URL(url).hostname;
        } catch {
          /* handled below */
        }
        if (!hostname) {
          res.status(400).json({ error: 'RPC URL is invalid' });
          return;
        }
      }
      cfg.update((c) => {
        if (url) c.rpc[chain] = url;
        else delete c.rpc[chain];
      });
      res.json(status());
    } catch (e) {
      next(e);
    }
  });
  r.use(jsonErrors('[market]'));
  return r;
}
