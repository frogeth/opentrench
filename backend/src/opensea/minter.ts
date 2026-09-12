import { EventEmitter } from 'node:events';
import { createPublicClient, http, keccak256, parseEther, type TransactionSerializableEIP1559 } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { chainInfo, rpcFor, type ChainInfo } from './chains.js';
import { OpenSeaError } from './gql.js';
import { OpenSeaSession } from './session.js';
import { resolveCollection, eligibility as fetchEligibility, mintAction as fetchMintAction, type DropCollection, type Eligibility } from './drops.js';
import { UnsafeMintAction, validateMintTransaction } from './validate.js';
import type { MintJob } from '../types.js';

const GAS_LIMIT = 300_000;
/** The most gas a mint may be signed for, however high the simulation came back. */
const GAS_CAP = 600_000n;
/**
 * The drift bound is "twice the quoted fee", which is meaningless when the quote was ~0: on an L2 a
 * quoted tip of 1 wei would refuse a send at 2 wei. Below this floor, fee movement is noise.
 */
const DRIFT_FLOOR = 100_000_000n; // 0.1 gwei
const QUOTE_TTL_MS = 2 * 60_000;
/** How long the receipt is polled fast (250 ms → 2 s) while send() is still awaited. */
const RECEIPT_TIMEOUT_MS = 3 * 60_000;
/** After that, the same transaction is polled on this interval in the background. */
const SLOW_POLL_MS = 15_000;
/** A pending transaction is watched this long before we stop looking at all. */
const WATCH_MAX_MS = 6 * 60 * 60_000;
const MAX_JOBS = 100;
/**
 * `evict()` refuses to drop a quote the user may still send (a `ready` job inside its TTL), so the
 * log can grow past MAX_JOBS when someone quotes a hundred times in two minutes. This is the bound
 * that holds anyway, so the log cannot grow without limit.
 */
const HARD_MAX_JOBS = 2 * MAX_JOBS;
const MAX_QUANTITY = 99;
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const GWEI = 1_000_000_000n;

export const toWei = (unit: number): bigint => {
  const s = unit.toFixed(18).replace(/\.?0+$/, '');
  return parseEther(s === '' || s === '-' ? '0' : s);
};

/** The slice of a viem PublicClient the minter uses; tests pass fakes. */
export interface Rpc {
  getChainId(): Promise<number>;
  getBalance(a: { address: `0x${string}` }): Promise<bigint>;
  estimateFeesPerGas(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>;
  getTransactionCount(a: { address: `0x${string}`; blockTag: 'pending' | 'latest' }): Promise<number>;
  estimateGas(a: { account: `0x${string}`; to: `0x${string}`; data: `0x${string}`; value: bigint }): Promise<bigint>;
  sendRawTransaction(a: { serializedTransaction: `0x${string}` }): Promise<`0x${string}`>;
  getTransactionReceipt(a: { hash: `0x${string}` }): Promise<{ status: string; blockNumber: bigint; logs: { address: string; topics: readonly string[] }[] }>;
}
export interface MinterDeps {
  resolve: (locator: string, chain?: string) => Promise<DropCollection>;
  eligibility: (session: OpenSeaSession, col: DropCollection) => Promise<Eligibility>;
  mintAction: (session: OpenSeaSession, col: DropCollection, quantity: number) => ReturnType<typeof fetchMintAction>;
  rpc: (url: string) => Rpc;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}
const LIVE: MinterDeps = {
  resolve: (l, c) => resolveCollection(l, c),
  eligibility: fetchEligibility,
  mintAction: fetchMintAction,
  rpc: (url) => createPublicClient({ transport: http(url) }) as unknown as Rpc,
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/** Up to 6 significant decimal digits, never collapsing a small nonzero value to "0". */
const fmt = (wei: bigint): string => new Intl.NumberFormat('en-US', { maximumSignificantDigits: 6, maximumFractionDigits: 18 }).format(Number(wei) / 1e18);
const gwei = (wei: bigint): string => new Intl.NumberFormat('en-US', { maximumSignificantDigits: 6, maximumFractionDigits: 9 }).format(Number(wei) / 1e9);

/**
 * An RPC URL can carry an API key in its path or query, and viem puts the URL it called into
 * transport error messages. Those messages are logged, so strip every URL before logging one.
 */
export const redact = (s: string): string =>
  s
    .replace(/(?:https?|wss?):\/\/[^\s]+/gi, '<rpc>')
    // Best effort for a URL quoted without its scheme ("rpc.example.com/v2/KEY timed out"): a
    // host-looking token followed by a path. Anything with a key in it has a path, so this is the
    // half worth catching.
    .replace(/[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(?::\d+)?\/\S*/gi, '<rpc>');

/**
 * Only our own error types carry text that is safe to show: OpenSea's own sentences and the
 * validator's refusals. Anything else (a viem transport error, a TypeError, a DNS failure) can
 * quote the RPC URL, so its message never reaches the UI.
 */
const safeMessage = (e: unknown): string | undefined => (e instanceof OpenSeaError || e instanceof UnsafeMintAction ? e.message : undefined);
const rawMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Minted token ids out of a receipt, best effort. A confirmed mint must never be downgraded or
 * retried because a log was shaped unexpectedly, so every failure here degrades to "no ids".
 */
const mintedTokenIds = (logs: { address: string; topics: readonly string[] }[], nft: string, wallet: string): string[] => {
  const ids: string[] = [];
  try {
    const contract = nft.toLowerCase();
    const to = wallet.toLowerCase();
    for (const l of logs ?? []) {
      try {
        if (typeof l?.address !== 'string' || l.address.toLowerCase() !== contract) continue;
        const t = l.topics;
        if (!t || t.length !== 4 || !t.every((x) => typeof x === 'string')) continue;
        if (t[0].toLowerCase() !== TRANSFER_TOPIC) continue;
        if (!/^0x0{64}$/.test(t[1])) continue; // minted, not transferred
        if ('0x' + t[2].slice(-40).toLowerCase() !== to) continue;
        ids.push(BigInt(t[3]).toString());
      } catch {
        /* one malformed log does not cost us the others */
      }
    }
  } catch {
    return [];
  }
  return ids;
};

/** `MintJob.blockNumber` is a `number`; an absurd or non-bigint block height becomes 0, never NaN. */
const blockOf = (b: unknown): number => (typeof b === 'bigint' && b >= 0n && b < 2n ** 53n ? Number(b) : 0);

/**
 * Quote → send → receipt for one SeaDrop mint with the configured wallet. Every state change is
 * emitted as 'job'. Errors never throw out of quote()/send(): the job ends 'failed' with a sentence.
 *
 * A broadcast transaction is only ever resolved by the chain: either its receipt arrives, or the
 * nonce is seen spent by something else. No wall-clock deadline turns a `pending` mint into a
 * `failed` one, because `failed` releases the one-mint-per-wallet guard, and a second mint signed
 * while the first is still in the mempool would either replace it or mint twice.
 *
 * Jobs live in memory, and the hub persists the ones with a transaction hash; `restore()` takes
 * them back after a restart and resumes the watch.
 */
export class Minter extends EventEmitter {
  readonly jobs: MintJob[] = [];
  private sessions = new Map<string, OpenSeaSession>();
  /** RPC URL → the chain id it answered with, checked once per URL */
  private verifiedRpc = new Map<string, number>();
  /** job id → the receipt watch still running for it */
  private watches = new Map<string, Promise<MintJob>>();
  constructor(
    private walletKey: () => string | undefined,
    private rpcOverrides: () => Record<string, string>,
    private deps: MinterDeps = LIVE,
  ) {
    super();
  }

  /** the wallet's address, for the UI (undefined without a key) */
  address(): string | undefined {
    const k = this.walletKey();
    return k ? privateKeyToAccount(k as `0x${string}`).address : undefined;
  }
  private account(): PrivateKeyAccount | undefined {
    const k = this.walletKey();
    return k ? privateKeyToAccount(k as `0x${string}`) : undefined;
  }
  private session(acct: PrivateKeyAccount): OpenSeaSession {
    let s = this.sessions.get(acct.address);
    if (!s) this.sessions.set(acct.address, (s = new OpenSeaSession(acct)));
    return s;
  }
  private put(job: MintJob, patch: Partial<MintJob>): MintJob {
    Object.assign(job, patch, { updatedAt: this.deps.now() });
    // Deep copy, not `{ ...job }`: job.collection/stage/price/gas are nested objects, and a
    // shallow copy would still share those references, so a listener mutating e.g.
    // emittedJob.price.unitWei would silently corrupt the stored job.
    this.emit('job', structuredClone(job));
    return job;
  }
  private fail(job: MintJob, error: string): MintJob {
    console.warn(`[osmint] ${job.id} failed: ${error}`);
    return this.put(job, { state: 'failed', error });
  }

  /**
   * A fee the RPC quoted that is outside what this chain could plausibly need is treated as the RPC
   * lying or being broken, not as a fee to pay. Returns the sentence to fail with, or undefined.
   */
  private overCeiling(info: ChainInfo, fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }, gas: bigint): string | undefined {
    const tail = `; check ⚙ → Trading → OpenSea RPCs`;
    const capFee = BigInt(info.maxFeeGwei) * GWEI;
    const capTip = BigInt(info.maxTipGwei) * GWEI;
    if (fees.maxFeePerGas > capFee) return `the RPC quoted a gas price above the ${info.id} ceiling (${gwei(fees.maxFeePerGas)} gwei > ${info.maxFeeGwei} gwei)${tail}`;
    if (fees.maxPriorityFeePerGas > capTip) return `the RPC quoted a priority fee above the ${info.id} ceiling (${gwei(fees.maxPriorityFeePerGas)} gwei > ${info.maxTipGwei} gwei)${tail}`;
    // A tip above the max fee is not a fee we could pay, it is a malformed answer; viem would also
    // reject it at signing time, with a message that quotes the RPC URL.
    if (fees.maxPriorityFeePerGas > fees.maxFeePerGas) return `the RPC returned a priority fee above the max fee (${gwei(fees.maxPriorityFeePerGas)} gwei > ${gwei(fees.maxFeePerGas)} gwei)${tail}`;
    // The gwei ceilings leave room for congestion, so the money bound is the absolute worst case of
    // this one transaction: max fee × gas limit.
    const cost = fees.maxFeePerGas * gas;
    if (cost > info.maxGasCostWei) return `the gas for this mint would exceed the ${info.id} ceiling (${fmt(cost)} > ${fmt(info.maxGasCostWei)} ${info.symbol})${tail}`;
    return undefined;
  }

  /**
   * An RPC that answers for a different chain than the one we are minting on would have us read the
   * wrong balance, the wrong nonce, and — worse — no receipt for a transaction that did confirm,
   * which is indistinguishable from an unmined mint. `eth_chainId` is static, so it is asked once
   * per URL and only cached when it agreed. Returns the sentence to fail with, or undefined.
   */
  private async verifyChain(client: Rpc, url: string, info: ChainInfo): Promise<string | undefined> {
    if (this.verifiedRpc.get(url) === info.chainId) return undefined;
    const got = await client.getChainId();
    if (got !== info.chainId) return `the RPC for ${info.id} answers for chain id ${got}, expected ${info.chainId}; check ⚙ → Trading → OpenSea RPCs`;
    this.verifiedRpc.set(url, info.chainId);
    return undefined;
  }

  async quote(req: { locator: string; chain?: string; quantity: number }): Promise<MintJob> {
    const asked = Number(req.quantity);
    // Clamped rather than trusted: quantity reaches the calldata and the price, and `Infinity`/`NaN`
    // would otherwise travel as far as BigInt() before anything noticed.
    const quantity = Number.isFinite(asked) ? Math.min(MAX_QUANTITY, Math.max(1, Math.floor(asked))) : 0;
    const t0 = this.deps.now();
    const job: MintJob = { id: `m${t0.toString(36)}${Math.random().toString(36).slice(2, 6)}`, ts: t0, updatedAt: t0, state: 'quoting', collection: { slug: '', name: req.locator, address: '', chain: req.chain ?? '', networkId: 0, dropKind: '' }, quantity, wallet: '' };
    this.jobs.push(job);
    this.evict();
    try {
      if (!quantity) return this.fail(job, `quantity must be a whole number from 1 to ${MAX_QUANTITY}`);
      const acct = this.account();
      if (!acct) return this.fail(job, 'Add a wallet in ⚙ → Trading first.');
      job.wallet = acct.address;
      const col = await this.deps.resolve(req.locator, req.chain);
      job.collection = { slug: col.slug, name: col.name, image: col.image, address: col.address, chain: col.chain, networkId: col.networkId, dropKind: col.drop?.kind ?? '' };
      if (!col.drop) return this.fail(job, `${col.name} is not an OpenSea drop, so there is nothing to mint here.`);
      if (col.drop.kind !== 'Erc721SeaDropV1') return this.fail(job, `${col.drop.kind} drops are not supported yet (ERC-721 SeaDrop only).`);
      const rpc = rpcFor(col.chain, this.rpcOverrides());
      if (!rpc) return this.fail(job, `No RPC for ${col.chain}. Add one in ⚙ → Trading → OpenSea RPCs.`);
      const info = chainInfo(col.chain);
      if (!info) return this.fail(job, `minting on ${col.chain} is not supported yet`);
      // We sign for info.chainId, so OpenSea's own number for the same chain has to agree with our
      // table; if it does not, one of the two is wrong about where this mint is going.
      if (info.chainId !== col.networkId) return this.fail(job, `chain id mismatch: OpenSea says ${col.networkId} for ${col.chain}, we have ${info.chainId}`);
      const elig = await this.deps.eligibility(this.session(acct), col);
      if (elig.kind !== col.drop.kind) return this.fail(job, 'OpenSea returned eligibility for a different drop type; try again');
      const now = t0;
      const openStages = col.drop.stages.filter((s) => Date.parse(s.startTime ?? '') <= now && (!s.endTime || now < Date.parse(s.endTime)));
      const paired = openStages.map((s) => ({ s, e: elig.stages.find((x) => x.type === s.type && x.index === s.index) }));
      const open = paired.find((p) => p.e?.eligible) ?? paired[0];
      if (!open) {
        const next = col.drop.stages.map((s) => Date.parse(s.startTime ?? '')).filter((t) => t > now).sort((a, b) => a - b)[0];
        return this.fail(job, next ? `no open stage; the next one starts ${new Date(next).toLocaleString()}` : 'no open stage, the drop has ended');
      }
      if (!open.e?.eligible) return this.fail(job, `the open ${open.s.type.toLowerCase().replace(/_/g, ' ')} stage is not open to this wallet (no open stage you're eligible for)`);
      if (open.e.eligibleMinter !== undefined && open.e.eligibleMinter.toLowerCase() !== acct.address.toLowerCase()) return this.fail(job, 'the eligible minter is another wallet');
      const max = open.e.eligibleMax ?? open.e.maxPerWallet ?? open.s.maxPerWallet;
      const left = max === undefined ? Infinity : Math.max(0, max - elig.minted);
      job.stage = { type: open.s.type, index: open.s.index, startTime: open.s.startTime, endTime: open.s.endTime, maxPerWallet: max, alreadyMinted: elig.minted };
      if (quantity > left) return this.fail(job, `this wallet can mint ${left} more (${elig.minted} of ${max} used), not ${quantity}`);
      let unitWei: bigint;
      try {
        unitWei = toWei(open.e.priceUnit ?? 0);
      } catch {
        return this.fail(job, 'OpenSea returned an unusable price');
      }
      const totalWei = unitWei * BigInt(quantity);
      job.price = { unitWei: unitWei.toString(), totalWei: totalWei.toString(), symbol: open.e.priceSymbol ?? info.symbol, usd: open.e.priceUsd !== undefined ? open.e.priceUsd * quantity : undefined };
      const client = this.deps.rpc(rpc);
      const wrongChain = await this.verifyChain(client, rpc, info);
      if (wrongChain) return this.fail(job, wrongChain);
      const [balance, fees] = await Promise.all([client.getBalance({ address: acct.address }), client.estimateFeesPerGas()]);
      const tooDear = this.overCeiling(info, fees, BigInt(GAS_LIMIT));
      if (tooDear) return this.fail(job, tooDear);
      const estimate = fees.maxFeePerGas * BigInt(GAS_LIMIT);
      job.gas = { limit: GAS_LIMIT, maxFeeWei: fees.maxFeePerGas.toString(), maxPriorityWei: fees.maxPriorityFeePerGas.toString(), estimateWei: estimate.toString() };
      job.balanceWei = balance.toString();
      if (balance < totalWei + estimate) return this.fail(job, `needs ${fmt(totalWei + estimate)} ${job.price.symbol} (price + gas), wallet has ${fmt(balance)}`);
      return this.put(job, { state: 'ready' });
    } catch (e: unknown) {
      console.warn('[osmint]', job.id, redact(rawMessage(e)));
      return this.fail(job, safeMessage(e) ?? 'the RPC or OpenSea call failed; check ⚙ → Trading → OpenSea RPCs');
    }
  }

  async send(jobId: string): Promise<MintJob> {
    const job = this.jobs.find((j) => j.id === jobId);
    if (!job) throw new Error('no such quote');
    if (job.state !== 'ready') throw new Error(`quote is ${job.state}`);
    if (this.deps.now() - job.ts > QUOTE_TTL_MS) return this.fail(job, 'the quote is older than two minutes; quote again');
    const acct = this.account();
    if (!acct || acct.address !== job.wallet) return this.fail(job, 'the wallet changed since the quote');
    // One at a time per wallet: two mints in flight share a nonce race, and the second would either
    // replace the first or sit unmined behind it.
    if (this.jobs.some((j) => j !== job && j.wallet.toLowerCase() === job.wallet.toLowerCase() && (j.state === 'sending' || j.state === 'pending'))) {
      return this.fail(job, 'another mint from this wallet is still pending; wait for it to confirm');
    }
    // Marked 'sending' synchronously (still before any await, so everything above and this line
    // run in one tick) so two rapid send() calls on the same job cannot both pass the state check.
    this.put(job, { state: 'sending' });
    let hash: `0x${string}` | undefined;
    let broadcastAttempted = false;
    try {
      const col = await this.deps.resolve(job.collection.slug, job.collection.chain);
      // Everything the user approved in the quote is pinned here. OpenSea answers the same slug, so
      // a different contract, chain, drop contract or drop *kind* coming back means the quote is not
      // this mint. The kind is part of the pin because it selects how the calldata is read: a second
      // lookup that answers with another kind would otherwise change what validation even means.
      if (
        col.address !== job.collection.address ||
        col.chain !== job.collection.chain ||
        col.networkId !== job.collection.networkId ||
        col.drop?.address !== job.collection.address ||
        col.drop?.kind !== job.collection.dropKind ||
        job.collection.dropKind !== 'Erc721SeaDropV1'
      ) {
        return this.fail(job, 'the collection changed since the quote');
      }
      const info = chainInfo(col.chain);
      if (!info) return this.fail(job, `minting on ${col.chain} is not supported yet`);
      const chainId = info.chainId;
      const rpc = rpcFor(col.chain, this.rpcOverrides());
      if (!rpc) return this.fail(job, `No RPC for ${col.chain}.`);
      const now = this.deps.now();
      const stage = job.stage;
      if (stage && (Date.parse(stage.startTime ?? '') > now || (stage.endTime && now >= Date.parse(stage.endTime)))) return this.fail(job, 'the stage closed');
      const client = this.deps.rpc(rpc);
      const wrongChain = await this.verifyChain(client, rpc, info);
      if (wrongChain) return this.fail(job, wrongChain);
      const action = await this.deps.mintAction(this.session(acct), col, job.quantity);
      const tx = validateMintTransaction(action, col, acct.address, job.stage!, job.quantity, chainId);
      if (BigInt(tx.value) !== BigInt(job.price!.totalWei)) {
        return this.fail(job, `OpenSea's transaction value (${fmt(BigInt(tx.value))}) does not match the quoted price (${fmt(BigInt(job.price!.totalWei))}); quote again`);
      }
      const [nonce, fees] = await Promise.all([client.getTransactionCount({ address: acct.address, blockTag: 'pending' }), client.estimateFeesPerGas()]);
      // Simulate before signing. A mint that reverts (sold out, stage closed, a stale allowlist
      // proof) costs the whole gas limit if it is broadcast, and OpenSea hands us calldata without
      // promising it still applies; a successful simulation also gives us a real gas number instead
      // of the flat limit. 25% headroom for state that moves between here and inclusion.
      let gas = BigInt(GAS_LIMIT);
      try {
        const est = await client.estimateGas({ account: acct.address, to: tx.to as `0x${string}`, data: tx.data as `0x${string}`, value: BigInt(tx.value) });
        gas = (est * 125n) / 100n;
        if (gas < est) gas = est;
        if (gas > GAS_CAP) gas = GAS_CAP;
      } catch (e: unknown) {
        console.warn('[osmint]', job.id, redact(rawMessage(e)));
        const why = safeMessage(e)?.slice(0, 120);
        return this.fail(job, `OpenSea's transaction reverts in simulation${why ? ` (${why})` : ''}; nothing was sent`);
      }
      const tooDear = this.overCeiling(info, fees, gas);
      if (tooDear) return this.fail(job, tooDear);
      // The user approved the quote's gas, not whatever the RPC says now. Under the ceiling there is
      // still room for a quoted 1 gwei to become 4 gwei between quote and send, so bound the drift —
      // at twice the quote, or the noise floor when the quote was at or near zero.
      const bound = (quoted: bigint): bigint => (2n * quoted > DRIFT_FLOOR ? 2n * quoted : DRIFT_FLOOR);
      const quotedTip = BigInt(job.gas!.maxPriorityWei);
      const quotedMax = BigInt(job.gas!.maxFeeWei);
      if (fees.maxPriorityFeePerGas > bound(quotedTip)) {
        return this.fail(job, `gas moved too far since the quote: the priority fee is ${gwei(fees.maxPriorityFeePerGas)} gwei, ${gwei(quotedTip)} gwei quoted; quote again`);
      }
      if (fees.maxFeePerGas > bound(quotedMax)) {
        return this.fail(job, `gas moved too far since the quote: the max fee is ${gwei(fees.maxFeePerGas)} gwei, ${gwei(quotedMax)} gwei quoted; quote again`);
      }
      const balance = await client.getBalance({ address: acct.address });
      const estimate = fees.maxFeePerGas * gas;
      if (balance < BigInt(tx.value) + estimate) return this.fail(job, `needs ${fmt(BigInt(tx.value) + estimate)} ${job.price!.symbol} (price + gas), wallet has ${fmt(balance)}`);
      const unsigned: TransactionSerializableEIP1559 = { type: 'eip1559', chainId, nonce, gas, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas, to: tx.to as `0x${string}`, value: BigInt(tx.value), data: tx.data as `0x${string}` };
      const signed = await acct.signTransaction(unsigned);
      // The hash of a signed EIP-1559 transaction is the keccak of the envelope, so we know it before
      // the RPC does. Computing it here means a lost or failed broadcast response never leaves us
      // without the one string the user needs to check whether their money moved.
      hash = keccak256(signed);
      let broadcastUnknown = false;
      broadcastAttempted = true;
      try {
        const relayed = await client.sendRawTransaction({ serializedTransaction: signed });
        if (relayed && relayed.toLowerCase() !== hash.toLowerCase()) {
          console.warn(`[osmint] ${job.id} the RPC answered with a different hash than the signed transaction's; watching ${hash}`);
        }
      } catch (e: unknown) {
        // "The request failed" is not "the transaction was not sent": the node may have accepted and
        // propagated it and lost only the reply. Treat it as in flight — the job stays pending (so
        // the per-wallet guard still blocks a second mint) and the receipt loop decides.
        console.warn('[osmint]', job.id, redact(rawMessage(e)));
        broadcastUnknown = true;
      }
      // Safe to record the signed fees and gas over the quoted ones: the checks above passed, so they
      // are inside the chain ceilings and within the drift bound of what the user approved.
      this.put(job, {
        state: 'pending',
        txHash: hash,
        nonce,
        watchUntil: this.deps.now() + WATCH_MAX_MS,
        gas: { limit: Number(gas), maxFeeWei: fees.maxFeePerGas.toString(), maxPriorityWei: fees.maxPriorityFeePerGas.toString(), estimateWei: estimate.toString() },
        error: broadcastUnknown ? `the broadcast result is unknown: the transaction may have been sent; check ${hash} on the explorer before minting again` : undefined,
      });
      return await this.watch(job, client, col.address, acct.address);
    } catch (e: unknown) {
      console.warn('[osmint]', job.id, redact(rawMessage(e)));
      const where = broadcastAttempted ? ` (the transaction may have been sent: check the explorer for ${hash})` : ' (nothing was sent)';
      return this.fail(job, safeMessage(e) ?? `the RPC or OpenSea call failed; check ⚙ → Trading → OpenSea RPCs${where}`);
    }
  }

  /**
   * Re-adopt the jobs a previous run left behind (`hub.restoredMintJobs`). A `pending` job is a
   * transaction the chain has not answered for yet: resuming its watch is what makes it resolve at
   * all, and keeping it in `jobs` is what keeps the per-wallet guard engaged, so a restart cannot be
   * used (or stumbled into) as a way to sign a second mint while the first is still in the mempool.
   *
   * The returned promise settles when the resumed watches have had their fast phase; nothing needs
   * to await it (the slow phase continues in the background either way).
   */
  async restore(jobs: MintJob[] | undefined): Promise<void> {
    const resumed: Promise<unknown>[] = [];
    for (const j of jobs ?? []) {
      if (!j || typeof j.id !== 'string' || !j.id || this.jobs.some((x) => x.id === j.id)) continue;
      this.jobs.push(j);
      if (j.state === 'pending' && j.txHash && typeof j.nonce === 'number') resumed.push(this.resume(j));
    }
    this.evict();
    await Promise.all(resumed);
  }

  /** The watch still running for a job, if any — production fires and forgets, tests await it. */
  watching(jobId: string): Promise<MintJob> | undefined {
    return this.watches.get(jobId);
  }

  /** Pick the watch back up for a restored pending job. Never throws; leaves the job pending. */
  private async resume(job: MintJob): Promise<void> {
    try {
      const url = rpcFor(job.collection.chain, this.rpcOverrides());
      if (!url) {
        this.put(job, { error: 'no RPC to watch this mint' });
        return;
      }
      const client = this.deps.rpc(url);
      const info = chainInfo(job.collection.chain);
      if (info) {
        // A wrong-chain RPC would report "no receipt" forever; say so instead of watching nothing.
        const wrongChain = await this.verifyChain(client, url, info).catch(() => undefined);
        if (wrongChain) {
          this.put(job, { error: wrongChain });
          return;
        }
      }
      await this.watch(job, client, job.collection.address, job.wallet);
    } catch (e: unknown) {
      console.warn('[osmint]', job.id, redact(rawMessage(e)));
    }
  }

  /**
   * Watch a broadcast transaction to its end. Polls fast (250 ms → 2 s) for RECEIPT_TIMEOUT_MS,
   * which is what `send()` awaits; if the receipt has not arrived by then the job *stays pending* —
   * three minutes of silence is a slow block, not a failed mint — and the slow watch continues in
   * the background. Resolves with the job as it stands when the fast phase ends.
   */
  private async watch(job: MintJob, client: Rpc, nft: string, wallet: string): Promise<MintJob> {
    const hash = job.txHash as `0x${string}`;
    const fastUntil = this.deps.now() + RECEIPT_TIMEOUT_MS;
    let delay = 250;
    while (this.deps.now() < fastUntil) {
      const settled = await this.pollReceipt(job, client, hash, nft, wallet);
      if (settled) return settled;
      await this.deps.sleep(delay);
      delay = Math.min(2000, delay * 2);
    }
    // Said once, so the UI can show "still watching" without a new line every fifteen seconds.
    this.put(job, { error: `no receipt yet after 3 minutes; still watching ${hash}` });
    const slow = this.slowWatch(job, client, hash, nft, wallet).finally(() => {
      if (this.watches.get(job.id) === slow) this.watches.delete(job.id);
    });
    this.watches.set(job.id, slow);
    return job;
  }

  /**
   * One receipt poll. Returns the settled job (confirmed or reverted), or undefined while the
   * transaction is not mined yet.
   */
  private async pollReceipt(job: MintJob, client: Rpc, hash: `0x${string}`, nft: string, wallet: string): Promise<MintJob | undefined> {
    let receipt: Awaited<ReturnType<Rpc['getTransactionReceipt']>> | undefined;
    try {
      receipt = await client.getTransactionReceipt({ hash });
    } catch {
      /* not mined yet */
    }
    // Parsing happens outside the try on purpose: inside it, a malformed log threw, looked like
    // "not mined yet", and the job ended as 'no receipt' for a mint that had already confirmed.
    if (!receipt) return undefined;
    if (receipt.status !== 'success') return this.fail(job, `the mint transaction reverted (${hash})`);
    // A receipt settles a lost broadcast response, so the note about it goes away with it.
    return this.put(job, { state: 'confirmed', blockNumber: blockOf(receipt.blockNumber), tokenIds: mintedTokenIds(receipt.logs, nft, wallet), error: undefined });
  }

  /**
   * The patient half of the watch: every SLOW_POLL_MS until `watchUntil`. Two ways out other than a
   * receipt: the nonce is seen spent on chain while our hash still has none (some other transaction
   * took it, so this one can never mint), or the six hours run out.
   */
  private async slowWatch(job: MintJob, client: Rpc, hash: `0x${string}`, nft: string, wallet: string): Promise<MintJob> {
    const until = job.watchUntil ?? this.deps.now() + WATCH_MAX_MS;
    let nonceSpent = 0;
    while (this.deps.now() < until) {
      try {
        await this.deps.sleep(SLOW_POLL_MS);
        const settled = await this.pollReceipt(job, client, hash, nft, wallet);
        if (settled) return settled;
        if (typeof job.nonce === 'number') {
          let count: number | undefined;
          try {
            count = await client.getTransactionCount({ address: wallet as `0x${string}`, blockTag: 'latest' });
          } catch {
            /* the nonce check is a bonus; silence here just means we keep waiting */
          }
          if (count !== undefined && count > job.nonce) nonceSpent++;
          // The nonce is spent and our hash has no receipt: another transaction (a replacement, a
          // wallet used elsewhere) used it, so ours can never be mined. Two further polls before
          // believing it — the receipt can lag the nonce, and the two answers can come from
          // different nodes behind one URL.
          if (nonceSpent >= 3) return this.fail(job, `the transaction was replaced or dropped (nonce ${job.nonce} was used by another transaction); nothing minted`);
        }
      } catch (e: unknown) {
        console.warn('[osmint]', job.id, redact(rawMessage(e)));
      }
    }
    return this.fail(job, `stopped watching ${hash} after 6 hours; check the explorer`);
  }

  /**
   * Keep the log small. A job whose transaction is in flight is never dropped, and neither is a
   * quote the user could still send (a `ready` job inside its TTL) — so finished jobs go first,
   * then stale quotes, and only past HARD_MAX_JOBS does a live quote become expendable.
   */
  private evict(): void {
    const expendable = (j: MintJob): boolean => j.state !== 'sending' && j.state !== 'pending';
    const finished = (j: MintJob): boolean => j.state === 'failed' || j.state === 'confirmed';
    while (this.jobs.length > MAX_JOBS) {
      const stale = this.deps.now() - QUOTE_TTL_MS;
      let i = this.jobs.findIndex(finished);
      if (i < 0) i = this.jobs.findIndex((j) => expendable(j) && j.ts <= stale);
      if (i < 0 && this.jobs.length > HARD_MAX_JOBS) i = this.jobs.findIndex(expendable);
      if (i < 0) return;
      this.jobs.splice(i, 1);
    }
  }
}
