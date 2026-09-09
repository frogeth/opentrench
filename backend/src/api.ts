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
  r.get('/config', wrap(() => cfg.masked()));

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
