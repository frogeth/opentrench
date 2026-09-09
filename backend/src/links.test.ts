import { describe, it, expect } from 'vitest';
import { extractLinks } from './links.js';

const RICK_DISCORD = `**[Ethereumcat](https://dexscreener.com/ethereum/0xc56c9d4aee66e16aa4a31a710a6d2fc720a626b6) [255K/-11.3%] - ETHCAT/WETH** [⬆](https://discord.com/channels/1/2/3)
<:eth:941653284035395614> Ethereum @ Uniswap V2
💰 USD: \`0.0002551\`
[👥](https://t.me/rick?start=nh_0x7777) TH: [2.3](https://etherscan.io/address/0x13ba)
[💹](https://t.me/RickBurpBot/dsapp?startapp=0x7777_ethereum&mode=compact)
Chart: [DEX](https://dexscreener.com/ethereum/0xc56c) · [DEF](https://defined.fi/token/eth/0x7777?ref=RICK)
🧰 More: [BM](https://t.me/RickBurpBot/bmapp?startapp=x) · [Lens](https://lens.google.com/uploadbyurl?url=x) · [TG](https://t.me/Ethereumcat001) · [Web](https://ethcat.fun) · [𝕏](https://x.com/ethcat__?s=11) · [Lore](https://t.me/rick?start=lr_0x7777)
\`0x777777780838C00038ecD48F63f3C37669322Bc8\`
[PRO](https://t.me/MaestroProBot?start=0x7777-rickburpbot) · [BAN](https://t.me/BananaGun_bot?start=snp_x) · [GMG](https://gmgn.ai/eth/token/x) · [EXP](https://etherscan.io/address/0x7777) · [TW](https://twitter.com/search?q=0x7777)`;

describe('extractLinks', () => {
  it('pulls socials, website, name and symbol from a Rick discord post', () => {
    expect(extractLinks(RICK_DISCORD, [])).toEqual({
      name: 'Ethereumcat',
      symbol: 'ETHCAT',
      website: 'https://ethcat.fun',
      twitter: 'https://x.com/ethcat__?s=11',
      telegram: 'https://t.me/Ethereumcat001',
    });
  });

  it('uses entity links (telegram) with emoji labels', () => {
    const text = 'Ethereumcat [255K/-11.3%] - ETHCAT/WETH\n🧰 More: 🫧 🎨 💪 💬 🌍 🐦 [♻]';
    const links = [
      { label: '💬', url: 'https://t.me/Ethereumcat001' },
      { label: '🌍', url: 'https://ethcat.fun' },
      { label: '🐦', url: 'https://x.com/ethcat__' },
      { label: '💪', url: 'https://t.me/rick?start=x' },
      { label: '[♻]', url: 'https://t.me/RickBurpBot/dsapp?startapp=x' },
    ];
    expect(extractLinks(text, links)).toEqual({
      name: 'Ethereumcat',
      symbol: 'ETHCAT',
      website: 'https://ethcat.fun',
      twitter: 'https://x.com/ethcat__',
      telegram: 'https://t.me/Ethereumcat001',
    });
  });

  it('ignores explorer, chart, bot and search links', () => {
    const text =
      '[DEX](https://dexscreener.com/x) [EXP](https://solscan.io/token/x) [BOT](https://t.me/BloomSolana_bot?start=x) [TW](https://twitter.com/search?q=x) [PF](https://pump.fun/coin/x)';
    expect(extractLinks(text, [])).toEqual({});
  });

  it('returns {} for plain text', () => {
    expect(extractLinks('gm', [])).toEqual({});
  });

  it('keeps the first link of each kind', () => {
    const text = '[a](https://one.example) [b](https://two.example) https://x.com/first https://x.com/second';
    expect(extractLinks(text, [])).toEqual({ website: 'https://one.example', twitter: 'https://x.com/first' });
  });
});
