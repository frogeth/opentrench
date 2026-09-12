import { EventEmitter } from 'node:events';
import { createPublicClient, http, parseEther, type TransactionSerializableEIP1559 } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { chainInfo, rpcFor, type ChainInfo } from './chains.js';
import { OpenSeaError } from './gql.js';
import { OpenSeaSession } from './session.js';
import { resolveCollection, eligibility as fetchEligibility, mintAction as fetchMintAction, type DropCollection, type Eligibility } from './drops.js';
import { UnsafeMintAction, validateMintTransaction } from './validate.js';
import type { MintJob } from '../types.js';

const GAS_LIMIT = 300_000;
const QUOTE_TTL_MS = 2 * 60_000;
const RECEIPT_TIMEOUT_MS = 3 * 60_000;
const MAX_JOBS = 100;
const MAX_QUANTITY = 99;
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const GWEI = 1_000_000_000n;

export const toWei = (unit: number): bigint => {
  const s = unit.toFixed(18).replace(/\.?0+$/, '');
  return parseEther(s === '' || s === '-' ? '0' : s);
};

/** The slice of a viem PublicClient the minter uses; tests pass fakes. */
export interface Rpc {
  getBalance(a: { address: `0x${string}` }): Promise<bigint>;
  estimateFeesPerGas(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>;
  getTransactionCount(a: { address: `0x${string}`; blockTag: 'pending' }): Promise<number>;
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
export const redact = (s: string): string => s.replace(/https?:\/\/[^\s]+/gi, '<rpc>');

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
 * Jobs live in memory only. A restart loses the log, including a `pending` job — the *transaction*
 * is not lost (it is already broadcast and will confirm or not on its own), but we stop watching
 * it, so after a restart a pending mint has to be checked on the explorer by its hash.
 */
export class Minter extends EventEmitter {
  readonly jobs: MintJob[] = [];
  private sessions = new Map<string, OpenSeaSession>();
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
  private overCeiling(info: ChainInfo, fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }): string | undefined {
    const tail = `; check ⚙ → Trading → OpenSea RPCs`;
    const capFee = BigInt(info.maxFeeGwei) * GWEI;
    const capTip = BigInt(info.maxTipGwei) * GWEI;
    if (fees.maxFeePerGas > capFee) return `the RPC quoted a gas price above the ${info.id} ceiling (${gwei(fees.maxFeePerGas)} gwei > ${info.maxFeeGwei} gwei)${tail}`;
    if (fees.maxPriorityFeePerGas > capTip) return `the RPC quoted a priority fee above the ${info.id} ceiling (${gwei(fees.maxPriorityFeePerGas)} gwei > ${info.maxTipGwei} gwei)${tail}`;
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
      const [balance, fees] = await Promise.all([client.getBalance({ address: acct.address }), client.estimateFeesPerGas()]);
      const tooDear = this.overCeiling(info, fees);
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
    try {
      const col = await this.deps.resolve(job.collection.slug, job.collection.chain);
      // Everything the user approved in the quote is pinned here. OpenSea answers the same slug, so
      // a different contract, chain or drop contract coming back means the quote is not this mint.
      if (col.address !== job.collection.address || col.chain !== job.collection.chain || col.networkId !== job.collection.networkId || col.drop?.address !== job.collection.address) {
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
      const action = await this.deps.mintAction(this.session(acct), col, job.quantity);
      const tx = validateMintTransaction(action, col, acct.address, job.stage!, job.quantity, chainId);
      if (BigInt(tx.value) !== BigInt(job.price!.totalWei)) {
        return this.fail(job, `OpenSea's transaction value (${fmt(BigInt(tx.value))}) does not match the quoted price (${fmt(BigInt(job.price!.totalWei))}); quote again`);
      }
      const [nonce, fees] = await Promise.all([client.getTransactionCount({ address: acct.address, blockTag: 'pending' }), client.estimateFeesPerGas()]);
      const tooDear = this.overCeiling(info, fees);
      if (tooDear) return this.fail(job, tooDear);
      // The user approved the quote's gas, not whatever the RPC says now. Under the ceiling there is
      // still room for a quoted 1 gwei to become 4 gwei between quote and send, so bound the drift.
      if (fees.maxFeePerGas > 2n * BigInt(job.gas!.maxFeeWei) || fees.maxPriorityFeePerGas > 2n * BigInt(job.gas!.maxPriorityWei)) {
        return this.fail(job, `gas price moved too far since the quote (${gwei(fees.maxFeePerGas)} gwei vs ${gwei(BigInt(job.gas!.maxFeeWei))} gwei quoted); quote again`);
      }
      const balance = await client.getBalance({ address: acct.address });
      const estimate = fees.maxFeePerGas * BigInt(GAS_LIMIT);
      if (balance < BigInt(tx.value) + estimate) return this.fail(job, `needs ${fmt(BigInt(tx.value) + estimate)} ${job.price!.symbol} (price + gas), wallet has ${fmt(balance)}`);
      const unsigned: TransactionSerializableEIP1559 = { type: 'eip1559', chainId, nonce, gas: BigInt(GAS_LIMIT), maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas, to: tx.to as `0x${string}`, value: BigInt(tx.value), data: tx.data as `0x${string}` };
      const signed = await acct.signTransaction(unsigned);
      hash = await client.sendRawTransaction({ serializedTransaction: signed });
      // Safe to record the signed fees over the quoted ones: both checks above passed, so they are
      // inside the chain ceiling and within 2x of what the user approved.
      this.put(job, { state: 'pending', txHash: hash, gas: { ...job.gas!, maxFeeWei: fees.maxFeePerGas.toString(), maxPriorityWei: fees.maxPriorityFeePerGas.toString() } });
      const started = this.deps.now();
      let delay = 250;
      while (this.deps.now() - started < RECEIPT_TIMEOUT_MS) {
        let receipt: Awaited<ReturnType<Rpc['getTransactionReceipt']>> | undefined;
        try {
          receipt = await client.getTransactionReceipt({ hash });
        } catch {
          /* not mined yet */
        }
        // Parsing happens outside the try on purpose: inside it, a malformed log threw, looked like
        // "not mined yet", and the job ended as 'no receipt' for a mint that had already confirmed.
        if (receipt) {
          if (receipt.status !== 'success') return this.fail(job, `the mint transaction reverted (${hash})`);
          return this.put(job, { state: 'confirmed', blockNumber: blockOf(receipt.blockNumber), tokenIds: mintedTokenIds(receipt.logs, col.address, acct.address) });
        }
        await this.deps.sleep(delay);
        delay = Math.min(2000, delay * 2);
      }
      return this.fail(job, `no receipt after three minutes; check ${hash} on the explorer`);
    } catch (e: unknown) {
      console.warn('[osmint]', job.id, redact(rawMessage(e)));
      const where = hash ? ` (the transaction may have been sent: check the explorer for ${hash})` : ' (nothing was sent)';
      return this.fail(job, safeMessage(e) ?? `the RPC or OpenSea call failed; check ⚙ → Trading → OpenSea RPCs${where}`);
    }
  }

  /** Keep the log at MAX_JOBS, but never drop a job we are still watching a transaction for. */
  private evict(): void {
    while (this.jobs.length > MAX_JOBS) {
      const i = this.jobs.findIndex((j) => j.state !== 'sending' && j.state !== 'pending');
      if (i < 0) return;
      this.jobs.splice(i, 1);
    }
  }
}
