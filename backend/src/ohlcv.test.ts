import { describe, expect, it } from 'vitest';
import { mapOhlcv, ohlcvPath } from './geckoterminal.js';

describe('ohlcv', () => {
  it('maps GT rows to candles oldest-first and picks supported granularities', () => {
    const c = mapOhlcv({ data: { attributes: { ohlcv_list: [[20, 1, 2, 0.5, 1.5, 9], [10, 1, 1, 1, 1, 0], ['x']] } } });
    expect(c).toEqual([
      { t: 10, o: 1, h: 1, l: 1, c: 1, v: 0 },
      { t: 20, o: 1, h: 2, l: 0.5, c: 1.5, v: 9 },
    ]);
    expect(ohlcvPath('1m')).toEqual({ timeframe: 'minute', aggregate: 1 });
    expect(ohlcvPath('15m')).toEqual({ timeframe: 'minute', aggregate: 15 });
    expect(ohlcvPath('4h')).toEqual({ timeframe: 'hour', aggregate: 4 });
    expect(ohlcvPath('1d')).toEqual({ timeframe: 'day', aggregate: 1 });
    expect(ohlcvPath('junk')).toEqual({ timeframe: 'minute', aggregate: 5 });
  });
});
