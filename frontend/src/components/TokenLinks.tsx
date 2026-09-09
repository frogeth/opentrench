import type { TokenInfo } from '../types';
import { Icon, type IconName } from './Icon';

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
  const links: [IconName, string, string | undefined][] = [
    ['chart', 'open chart', t?.chartUrl],
    ['globe', 'website', t?.website],
    ['x', 'X / Twitter', t?.twitter],
    ['telegram', 'Telegram', t?.telegram],
    ['explorer', 'explorer', t?.explorerUrl],
  ];
  return (
    <div className="token-links">
      {canChart && (
        <button
          className={`token-link${showChart ? ' active' : ''}`}
          onClick={onToggleChart}
          title={showChart ? 'hide live chart' : 'live chart'}
        >
          <Icon name="live" />
        </button>
      )}
      {links.map(([icon, label, url]) =>
        url ? (
          <a key={icon} className={`token-link token-link-${icon}`} href={url} target="_blank" rel="noreferrer" title={label}>
            <Icon name={icon} />
          </a>
        ) : null,
      )}
    </div>
  );
}
