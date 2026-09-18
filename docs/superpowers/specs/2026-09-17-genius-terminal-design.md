# Genius terminal as a buy provider — design

Date: 2026-09-17. Status: built under stated assumptions (the request came in an unattended session); review welcome.

## Goal

Let people who trade on Genius Terminal (tradegenius.com, docs at docs.tradegenius.com) buy from opentrench the way Cove and BasedBot users do: the buy button on every card and in the drill-down, right-click → Buy on Genius, and the Telegram ping line all open the token in Genius.

## What Genius is, and what that rules out

- **A web terminal only.** No Telegram bot, no deep links, no public API or SDK in the docs. Spot on Solana, Ethereum, Base, BNB, Arbitrum, Avalanche, Optimism, Polygon, Sonic, HyperEVM and Robinhood Chain; perps on Hyperliquid.
- **Refuses framing.** `X-Frame-Options: SAMEORIGIN` on every page, and a Cloudflare bot check in front. So no chart embed and no in-app pane; the Electron shell already opens any non-app URL in the default browser, where the user's Genius login lives.
- **Token page:** `https://tradegenius.com/asset/<address>?network=<id>`, read from Genius's own route builder (`getAssetHref` in its bundle). The network id is the EVM chain id, with Solana as `1399811149` (`0x536f6c4d`, "SolM"). Ids from the same bundle:

  | Dexscreener network (opentrench's `TokenInfo.network`) | Genius id |
  | --- | --- |
  | solana | 1399811149 |
  | ethereum | 1 |
  | base | 8453 |
  | bsc | 56 |
  | arbitrum | 42161 |
  | avalanche | 43114 |
  | optimism | 10 |
  | polygon | 137 |
  | sonic | 146 |
  | hyperevm | 999 |
  | robinhood | 4663 |

  Hyperliquid (998) is the perps venue, not a token chain, so it is left out.
- **Referrals** are signup-time links (`tradegenius.com/ref/<code>`), not something attached to an asset URL, and opentrench has no Genius code. No referral rides on these links. (Cove and BasedBot links keep theirs.)

## Decisions

1. **Genius is a third buy provider** (`buy.provider: 'genius'`), beside Cove and BasedBot, chosen in ⚙ → Trading → Buy buttons. One choice drives every buy surface, as today.
2. **Links open in the browser.** `BuyRow` already falls back to `window.open` for anything that is not a bot deep link; in the desktop app that lands in the default browser. Nothing new is needed for routing.
3. **No amounts.** Like BasedBot: one button per token, labelled `Genius`, opening the asset page. `BuyLinks.amounts` is empty.
4. **Chain required, same as Cove.** A token whose network is not in the table (or not yet known) gets no Genius links, so the buy row is simply absent, as it is for Cove on an unlisted chain. Solana tokens count as `solana` when the network is not yet enriched (the same fallback Cove uses).
5. **Right-click → Buy on Genius** needs no Telegram. It looks the address up in the tokens the app knows: if that token has Genius links, they open; if the app knows the address but not its chain, the menu says so instead of guessing; a Solana-looking address with no record is opened as Solana.
6. **The buy pane column** (type `cove`) is bound to a Telegram bot. With Genius picked it shows a short note (Genius runs in your browser; pick Cove or BasedBot for an in-app pane) instead of a bot conversation, and no drawer opens on buy.
7. **Not a plugin.** Cove and BasedBot are core; Genius sits beside them.

## Changes

Backend
- `backend/src/genius.ts`: `GENIUS_NETWORK_IDS` table, `geniusAssetUrl(network, address)`, `buildGeniusLinks(network, address): BuyLinks | undefined`. Tests beside it.
- `types.ts` `BuyLinks.provider` gains `'genius'`; `config.ts` accepts and persists it; `api.ts` `PUT /buy` accepts it; `hub.ts` `applyBuy` dispatches to it; `services.ts` ping line labels it `Genius`.

Frontend
- `types.ts` / `api.ts`: the provider union gains `'genius'`.
- `format.ts`: the same id table and `geniusAssetUrl`, for the right-click path (mirrors the backend, as the chart slugs do).
- `BuyRow.tsx`: label `Genius`.
- `Settings.tsx`: a third segment button and its hint.
- `App.tsx`: `buyProvider` typed as the union; `sendToBot` / the plugin buy prompt route Genius to the browser; the buy pane shows the note when Genius is picked; the drawer is skipped.
- `ColumnEditor.tsx` blurb mentions Genius.

Docs
- README buy-buttons paragraph, CHANGELOG Unreleased.

## Error handling

- A chain Genius does not trade: no links, no button (backend), and the right-click item explains (frontend).
- Nothing network-bound happens at link time; an unreachable Genius is the browser's problem.

## Testing

- Backend unit tests: URL for a Solana mint and an EVM address, `undefined` for an unlisted chain and for a missing network, `buy.provider` round-trip through config.
- Frontend unit test for `geniusAssetUrl`.
- Manual: scratch backend on 3310 with `buy.provider: 'genius'`, check the card button and the right-click item in the in-app browser.
