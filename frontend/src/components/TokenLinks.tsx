import type { TokenInfo } from '../types';
import { Icon, type IconName } from './Icon';
import { SiteLink, XLink } from './HoverCards';
import { Tip } from './HoverCard';

/** x.com/<handle>[/status/…] → handle; search / i / intent links have no profile. */
export function xHandle(url?: string): string | undefined {
  if (!url) return undefined;
  const m = /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/(?:#!\/)?@?([A-Za-z0-9_]{1,20})(?:[/?#]|$)/i.exec(url);
  const h = m?.[1];
  if (!h || /^(search|i|home|explore|intent|hashtag|share|login|settings)$/i.test(h)) return undefined;
  return h;
}

export function TokenLinks({
  t,
  showChart,
  onToggleChart,
  canChart = !!t?.embedUrl,
}: {
  t?: TokenInfo;
  showChart: boolean;
  onToggleChart: () => void;
  canChart?: boolean;
}) {
  const searchUrl = t ? `https://x.com/search?q=${encodeURIComponent(t.symbol ? `$${t.symbol} OR ${t.address}` : t.address)}&f=live` : undefined;
  const handle = xHandle(t?.twitter);
  const link = (icon: IconName, label: string, url: string) => (
    <a className={`token-link token-link-${icon}`} href={url} target="_blank" rel="noreferrer" title={label}>
      <Icon name={icon} />
    </a>
  );
  return (
    <div className="token-links">
      {canChart && (
        <Tip text={showChart ? 'hide live chart' : 'live chart'}>
          <button className={`token-link${showChart ? ' active' : ''}`} onClick={onToggleChart}>
            <Icon name="live" />
          </button>
        </Tip>
      )}
      {t?.chartUrl && <Tip text="open chart">{link('chart', 'open chart', t.chartUrl)}</Tip>}
      {t?.website && <SiteLink url={t.website}>{link('globe', 'website', t.website)}</SiteLink>}
      {t?.twitter && (handle ? <XLink handle={handle}>{link('x', `@${handle}`, t.twitter)}</XLink> : <Tip text="X / Twitter">{link('x', 'X / Twitter', t.twitter)}</Tip>)}
      {searchUrl && <Tip text="Search on X">{link('search', 'search on X', searchUrl)}</Tip>}
      {t?.telegram && <Tip text="Telegram">{link('telegram', 'Telegram', t.telegram)}</Tip>}
      {t?.explorerUrl && <Tip text="explorer">{link('explorer', 'explorer', t.explorerUrl)}</Tip>}
    </div>
  );
}
