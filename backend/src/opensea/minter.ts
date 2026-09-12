import { EventEmitter } from 'node:events';
import { createPublicClient, http, parseEther, type TransactionSerializableEIP1559 } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { chainInfo, rpcFor } from './chains.js';
import { OpenSeaSession } from './session.js';
import { resolveCollection, eligibility as fetchEligibility, mintAction as fetchMintAction, type DropCollection, type Eligibility } from './drops.js';
import { validateMintTransaction } from './validate.js';
import type { MintJob } from '../types.js';

const GAS_LIMIT = 300_000;
const QUOTE_TTL_MS = 2 * 60_000;
const RECEIPT_TIMEOUT_MS = 3 * 60_000;
const MAX_JOBS = 100;
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

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

/**
 * Quote → send → receipt for one SeaDrop mint with the configured wallet. Every state change is
 * emitted as 'job'. Errors never throw out of quote()/send(): the job ends 'failed' with a sentence.
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

  async quote(req: { locator: string; chain?: string; quantity: number }): Promise<MintJob> {
    const quantity = Math.max(1, Math.floor(Number(req.quantity) || 1));
    const t0 = this.deps.now();
    const job: MintJob = { id: `m${t0.toString(36)}${Math.random().toString(36).slice(2, 6)}`, ts: t0, updatedAt: t0, state: 'quoting', collection: { slug: '', name: req.locator, address: '', chain: req.chain ?? '', networkId: 0, dropKind: '' }, quantity, wallet: '' };
    this.jobs.push(job);
    if (this.jobs.length > MAX_JOBS) this.jobs.shift();
    try {
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
      const elig = await this.deps.eligibility(this.session(acct), col);
      const now = t0;
      const openStages = col.drop.stages.filter((s) => Date.parse(s.startTime ?? '') <= now && (!s.endTime || now < Date.parse(s.endTime)));
      const paired = openStages.map((s) => ({ s, e: elig.stages.find((x) => x.type === s.type && x.index === s.index) }));
      const open = paired.find((p) => p.e?.eligible) ?? paired[0];
      if (!open) {
        const next = col.drop.stages.map((s) => Date.parse(s.startTime ?? '')).filter((t) => t > now).sort((a, b) => a - b)[0];
        return this.fail(job, next ? `no open stage; the next one starts ${new Date(next).toLocaleString()}` : 'no open stage, the drop has ended');
      }
      if (!open.e?.eligible) return this.fail(job, `the open ${open.s.type.toLowerCase().replace(/_/g, ' ')} stage is not open to this wallet (no open stage you're eligible for)`);
      const max = open.e.eligibleMax ?? open.e.maxPerWallet ?? open.s.maxPerWallet;
      const left = max === undefined ? Infinity : Math.max(0, max - elig.minted);
      job.stage = { type: open.s.type, index: open.s.index, startTime: open.s.startTime, endTime: open.s.endTime, maxPerWallet: max, alreadyMinted: elig.minted };
      if (quantity > left) return this.fail(job, `this wallet can mint ${left} more (${elig.minted} of ${max} used), not ${quantity}`);
      const unitWei = toWei(open.e.priceUnit ?? 0);
      const totalWei = unitWei * BigInt(quantity);
      job.price = { unitWei: unitWei.toString(), totalWei: totalWei.toString(), symbol: open.e.priceSymbol ?? info?.symbol ?? 'ETH', usd: open.e.priceUsd !== undefined ? open.e.priceUsd * quantity : undefined };
      const client = this.deps.rpc(rpc);
      const [balance, fees] = await Promise.all([client.getBalance({ address: acct.address }), client.estimateFeesPerGas()]);
      const estimate = fees.maxFeePerGas * BigInt(GAS_LIMIT);
      job.gas = { limit: GAS_LIMIT, maxFeeWei: fees.maxFeePerGas.toString(), maxPriorityWei: fees.maxPriorityFeePerGas.toString(), estimateWei: estimate.toString() };
      job.balanceWei = balance.toString();
      if (balance < totalWei + estimate) return this.fail(job, `needs ${fmt(totalWei + estimate)} ${job.price.symbol} (price + gas), wallet has ${fmt(balance)}`);
      return this.put(job, { state: 'ready' });
    } catch (e: any) {
      return this.fail(job, e?.message ?? String(e));
    }
  }

  async send(jobId: string): Promise<MintJob> {
    const job = this.jobs.find((j) => j.id === jobId);
    if (!job) throw new Error('no such quote');
    if (job.state !== 'ready') throw new Error(`quote is ${job.state}`);
    if (this.deps.now() - job.ts > QUOTE_TTL_MS) return this.fail(job, 'the quote is older than two minutes; quote again');
    const acct = this.account();
    if (!acct || acct.address !== job.wallet) return this.fail(job, 'the wallet changed since the quote');
    // Marked 'sending' synchronously (still before any await, so everything above and this line
    // run in one tick) so two rapid send() calls on the same job cannot both pass the state check.
    this.put(job, { state: 'sending' });
    try {
      const col = await this.deps.resolve(job.collection.slug, job.collection.chain);
      const chainId = chainInfo(col.chain)?.chainId ?? col.networkId;
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
      const balance = await client.getBalance({ address: acct.address });
      const estimate = fees.maxFeePerGas * BigInt(GAS_LIMIT);
      if (balance < BigInt(tx.value) + estimate) return this.fail(job, `needs ${fmt(BigInt(tx.value) + estimate)} ${job.price!.symbol} (price + gas), wallet has ${fmt(balance)}`);
      const unsigned: TransactionSerializableEIP1559 = { type: 'eip1559', chainId, nonce, gas: BigInt(GAS_LIMIT), maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas, to: tx.to as `0x${string}`, value: BigInt(tx.value), data: tx.data as `0x${string}` };
      const signed = await acct.signTransaction(unsigned as any);
      const hash = await client.sendRawTransaction({ serializedTransaction: signed });
      this.put(job, { state: 'pending', txHash: hash, gas: { ...job.gas!, maxFeeWei: fees.maxFeePerGas.toString(), maxPriorityWei: fees.maxPriorityFeePerGas.toString() } });
      const started = this.deps.now();
      let delay = 250;
      while (this.deps.now() - started < RECEIPT_TIMEOUT_MS) {
        try {
          const r = await client.getTransactionReceipt({ hash });
          if (r) {
            if (r.status !== 'success') return this.fail(job, `the mint transaction reverted (${hash})`);
            const ids = r.logs.filter((l) => l.address.toLowerCase() === col.address && l.topics[0] === TRANSFER_TOPIC && l.topics.length === 4 && '0x' + l.topics[2].slice(-40) === acct.address.toLowerCase() && /^0x0{64}$/.test(l.topics[1])).map((l) => BigInt(l.topics[3]).toString());
            return this.put(job, { state: 'confirmed', blockNumber: Number(r.blockNumber), tokenIds: ids });
          }
        } catch {
          /* not mined yet */
        }
        await this.deps.sleep(delay);
        delay = Math.min(2000, delay * 2);
      }
      return this.fail(job, `no receipt after three minutes; check ${hash} on the explorer`);
    } catch (e: any) {
      return this.fail(job, e?.message ?? String(e));
    }
  }
}
