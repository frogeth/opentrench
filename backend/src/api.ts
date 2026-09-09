import { Router, json, type Request, type Response } from 'express';
import type { ConfigStore } from './config.js';
import type { MessageHub } from './hub.js';
import type { Services } from './services.js';

export function createApi(cfg: ConfigStore, hub: MessageHub, svc: Services): Router {
  const r = Router();
  r.use(json({ limit: '64kb' }));

  const wrap =
    (fn: (req: Request, res: Response) => Promise<unknown> | unknown) => async (req: Request, res: Response) => {
      try {
        const out = await fn(req, res);
        if (!res.headersSent) res.json(out ?? { ok: true });
      } catch (e: any) {
        console.error('[api]', req.method, req.path, e?.message ?? e);
        res.status(500).json({ error: e?.message ?? String(e) });
      }
    };

  r.get('/status', wrap(() => hub.getStatus()));
  r.put(
    '/cove',
    wrap((req) => {
      const amounts = (Array.isArray(req.body?.amounts) ? req.body.amounts : [])
        .map(Number)
        .filter((n: number) => Number.isFinite(n) && n > 0 && n <= 9999)
        .slice(0, 5);
      cfg.update((c) => {
        c.cove.amounts = amounts.length ? amounts : [25, 50, 100];
      });
      hub.recomputeBuyLinks();
    }),
  );
  r.get('/config', wrap(() => cfg.masked()));
  r.get('/watched', wrap(() => svc.watchedChats()));
  r.put(
    '/blacklist',
    wrap((req) => {
      const raw: unknown[] = Array.isArray(req.body?.names) ? req.body.names : [];
      const names: string[] = raw.map((n) => String(n).trim()).filter(Boolean).slice(0, 500);
      cfg.update((c) => {
        c.blacklist = [...new Set(names)];
      });
      hub.rebuild();
    }),
  );
  r.post(
    '/blacklist/add',
    wrap((req) => {
      const name = String(req.body?.name ?? '').trim();
      if (!name) throw new Error('name required');
      cfg.update((c) => {
        if (!c.blacklist.some((b) => b.toLowerCase() === name.toLowerCase())) c.blacklist.push(name);
      });
      hub.rebuild();
    }),
  );

  r.put(
    '/discord/token',
    wrap((req) => {
      const token = String(req.body?.token ?? '').trim();
      if (!token) throw new Error('token required');
      cfg.update((c) => {
        c.discord.token = token;
      });
      svc.startDiscord();
    }),
  );
  r.get('/discord/channels', wrap(() => svc.listDiscordChannels()));
  r.put(
    '/discord/watch',
    wrap((req) => {
      const ids = (req.body?.ids ?? []).map(String);
      cfg.update((c) => {
        c.discord.watch = ids;
      });
    }),
  );

  r.put(
    '/telegram/credentials',
    wrap(async (req) => {
      const apiId = Number(req.body?.apiId);
      const apiHash = String(req.body?.apiHash ?? '').trim();
      if (!apiId || !apiHash) throw new Error('apiId and apiHash required');
      cfg.update((c) => {
        c.telegram.apiId = apiId;
        c.telegram.apiHash = apiHash;
        c.telegram.session = undefined;
      });
      await svc.startTelegram();
    }),
  );
  r.post(
    '/telegram/login/start',
    wrap(async (req) => {
      if (!svc.telegram) throw new Error('set Telegram credentials first');
      const phone = String(req.body?.phone ?? '').trim();
      if (!phone) throw new Error('phone required');
      return { step: await svc.telegram.loginStart(phone) };
    }),
  );
  r.post(
    '/telegram/login/code',
    wrap(async (req) => {
      if (!svc.telegram) throw new Error('not started');
      return { step: await svc.telegram.loginCode(String(req.body?.code ?? '').trim()) };
    }),
  );
  r.post(
    '/telegram/login/password',
    wrap(async (req) => {
      if (!svc.telegram) throw new Error('not started');
      return { step: await svc.telegram.loginPassword(String(req.body?.password ?? '')) };
    }),
  );
  r.post(
    '/telegram/logout',
    wrap(async () => {
      await svc.telegram?.logout();
    }),
  );
  r.get('/telegram/dialogs', wrap(() => svc.listTelegramDialogs()));
  r.get('/telegram/avatar/:id', async (req, res) => {
    const id = String(req.params.id ?? '');
    if (!/^-?\d+$/.test(id) || !svc.telegram) return res.status(404).end();
    const buf = await svc.telegram.getAvatar(id);
    if (!buf) return res.status(404).end();
    res.setHeader('content-type', 'image/jpeg');
    res.setHeader('cache-control', 'private, max-age=3600');
    res.send(buf);
  });
  r.put(
    '/telegram/watch',
    wrap((req) => {
      const ids = (req.body?.ids ?? []).map(String);
      cfg.update((c) => {
        c.telegram.watch = ids;
      });
    }),
  );

  return r;
}
