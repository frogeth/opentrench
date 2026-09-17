import type { NextFunction, Request, Response } from 'express';

/**
 * Turn whatever reaches it into `{ error }`: Express's own handler renders an HTML page with the stack
 * (and this machine's paths) in it. A 5xx says only 'server error' — an fs or network failure's message
 * names absolute paths and hosts the caller has no business with, so that detail stays in the log.
 *
 * A response that has already started streaming is past saying anything: it goes back to Express, which
 * destroys the socket. Swallowing it here would leave the client holding a body that never ends.
 */
export function jsonErrors(tag: string) {
  return (err: any, _req: Request, res: Response, next: NextFunction): void => {
    const status = Number(err?.status ?? err?.statusCode) || 500;
    const message =
      err?.type === 'entity.too.large'
        ? 'request body is too large'
        : err instanceof SyntaxError || err?.type === 'entity.parse.failed'
          ? 'request body is not valid json'
          : status >= 500
            ? 'server error'
            : (err?.message ?? 'server error');
    if (status >= 500) console.error(tag, err?.message ?? err);
    if (res.headersSent) return next(err);
    res.status(status).json({ error: message });
  };
}
