# Genius terminal — implementation plan

Spec: `docs/superpowers/specs/2026-09-17-genius-terminal-design.md`. Branch `genius`, worktree `trenchfeed-genius`.

Each task: failing test first where there is logic, then the change, then `npm test -w backend` / `npm test -w frontend`, then `npm run typecheck`.

1. **Backend link builder.** `backend/src/genius.ts` with `GENIUS_NETWORK_IDS`, `geniusAssetUrl`, `buildGeniusLinks`; `backend/src/genius.test.ts` covering a Solana mint, an EVM address, an unlisted chain, a missing network.
2. **Backend wiring.** `BuyLinks.provider` union + `BuyOptions` in `hub.ts` + `applyBuy` dispatch (Solana fallback like Cove); `config.ts` type, default parse and `masked()`; `api.ts` `PUT /buy`; `services.ts` ping label. `config.test.ts` round-trips `buy.provider: 'genius'`.
3. **Frontend types and helper.** `types.ts`, `api.ts` unions; `format.ts` `GENIUS_NETWORK_IDS` + `geniusAssetUrl` with `format.genius.test.ts`.
4. **Frontend surfaces.** `BuyRow` label; `Settings` third segment + hint; `App.tsx`: provider typing, `sendToBot` for Genius (browser, no Telegram), plugin buy prompt, buy pane note, no drawer; `ColumnEditor` blurb.
5. **Docs.** README buy paragraph, CHANGELOG Unreleased.
6. **Verify.** Suites + typecheck; scratch backend on 3310 built from the worktree with `buy.provider: 'genius'`, check a card's button and right-click → Buy on Genius in the in-app browser.
