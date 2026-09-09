import { useState } from 'react';

/** Launchpad logos, loaded from each site's own icon; letters if that fails. */
const LOGOS: Record<string, { src: string; label: string; short: string }> = {
  pumpfun: { src: 'https://pump.fun/icon.png', label: 'pump.fun', short: 'PF' },
  letsbonk: { src: 'https://letsbonk.fun/favicon.ico', label: 'letsbonk', short: 'BK' },
  bankr: { src: 'https://bankr.bot/favicon.svg', label: 'Bankr', short: 'B' },
  stonks: { src: 'https://www.thestonks.exchange/icon.png', label: 'Stonks', short: 'S' },
  pons: { src: 'https://www.ponsfamily.com/apple-icon.png', label: 'Pons', short: 'P' },
  o1: { src: 'https://o1.exchange/favicon.ico', label: 'o1', short: 'o1' },
  virtuals: { src: 'https://app.virtuals.io/favicon.ico', label: 'Virtuals', short: 'V' },
  flap: { src: 'https://flap.sh/favicon.ico', label: 'Flap', short: 'F' },
  clanker: { src: '', label: 'Clanker', short: 'CL' },
};

export function LaunchpadBadge({ launchpad, url, size = 18 }: { launchpad?: string; url?: string; size?: number }) {
  const [broken, setBroken] = useState(false);
  if (!launchpad) return null;
  const meta = LOGOS[launchpad] ?? { src: '', label: launchpad, short: launchpad.slice(0, 2).toUpperCase() };
  const body =
    meta.src && !broken ? (
      <img src={meta.src} alt={meta.label} width={size} height={size} loading="lazy" onError={() => setBroken(true)} />
    ) : (
      <span>{meta.short}</span>
    );
  const cls = `lp lp-${launchpad}`;
  return url ? (
    <a className={cls} href={url} target="_blank" rel="noreferrer" title={`launched on ${meta.label}`} style={{ width: size + 6, height: size + 6 }}>
      {body}
    </a>
  ) : (
    <span className={cls} title={`launched on ${meta.label}`} style={{ width: size + 6, height: size + 6 }}>
      {body}
    </span>
  );
}
