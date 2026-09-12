import { SEADROP_TARGETS } from './chains.js';
import { mintErrorSentence, type DropCollection, type MintTx } from './drops.js';

export class UnsafeMintAction extends Error {}

const SELECTOR: Record<string, string> = { PUBLIC_SALE: '161ac21f', SIGNED_PRESALE: '4b61cd6f', MERKLE_PRESALE: '4300a4e6' };

const wordAt = (data: string, i: number): bigint => {
  const hex = data.slice(2 + 8 + i * 64, 2 + 8 + (i + 1) * 64);
  if (hex.length !== 64) throw new UnsafeMintAction('calldata is shorter than expected');
  return BigInt('0x' + hex);
};
const addrAt = (data: string, i: number): string => {
  const w = wordAt(data, i);
  if (w >> 160n !== 0n) throw new UnsafeMintAction('calldata address word has high bits set');
  return '0x' + w.toString(16).padStart(40, '0');
};

/**
 * osnm-z's checks before anything is signed: one MintAction, one transaction on the expected
 * chain (by both numeric id and string identifier), and for ERC-721 SeaDrop v1 a known SeaDrop
 * target plus calldata that is the expected selector for the stage, for this collection, this
 * wallet, this quantity and this stage index.
 */
export function validateMintTransaction(
  action: { actionTypes: string[]; errors: string[]; tx?: MintTx },
  col: DropCollection,
  wallet: string,
  stage: { type: string; index: number },
  quantity: number,
  chainId: number,
): MintTx {
  if (!Number.isSafeInteger(quantity) || quantity < 1) throw new UnsafeMintAction('quantity must be a positive integer');
  if (!Number.isSafeInteger(stage.index) || stage.index < 0) throw new UnsafeMintAction('stage index must be a non-negative integer');

  const err = mintErrorSentence(action.errors);
  if (err) throw new UnsafeMintAction(err);
  if (action.actionTypes.length !== 1 || action.actionTypes[0] !== 'MintAction') {
    const types = action.actionTypes.join(', ') || 'none';
    throw new UnsafeMintAction(`unexpected action sequence (${types.slice(0, 200)})`);
  }
  const tx = action.tx;
  if (!tx) throw new UnsafeMintAction('expected exactly one transaction');
  if (!/^0x[0-9a-fA-F]{40}$/.test(tx.to) || /^0x0{40}$/.test(tx.to)) throw new UnsafeMintAction('zero or invalid transaction target');
  if (tx.networkId !== chainId) throw new UnsafeMintAction(`network mismatch (${tx.networkId} vs ${chainId})`);
  // networkId and chain are two independent claims about the same thing; both must name our chain,
  // so a payload that passes the numeric check with a mismatched string identifier is still refused.
  if (tx.chain !== col.chain) throw new UnsafeMintAction(`chain mismatch (${String(tx.chain).slice(0, 40)} vs ${col.chain})`);
  if (!/^0x[0-9a-fA-F]*$/.test(tx.data) || tx.data.length < 10) throw new UnsafeMintAction('calldata is shorter than a selector');
  if (!/^\d+$/.test(tx.value)) throw new UnsafeMintAction('invalid value');

  if (col.drop?.kind !== 'Erc721SeaDropV1') return tx;

  if (!SEADROP_TARGETS.has(tx.to.toLowerCase())) throw new UnsafeMintAction('unexpected mint target');

  const data = tx.data.toLowerCase();
  if ((data.length - 10) % 64 !== 0) throw new UnsafeMintAction('calldata is shorter than a whole number of words');

  if (!Object.hasOwn(SELECTOR, stage.type)) throw new UnsafeMintAction(`unknown stage type ${stage.type}`);
  const want = SELECTOR[stage.type];

  if (data.slice(2, 10) !== want) throw new UnsafeMintAction('mint selector mismatch');
  if (addrAt(data, 0) !== col.address.toLowerCase()) throw new UnsafeMintAction('NFT contract mismatch');
  const minter = addrAt(data, 2);
  if (minter !== '0x' + '0'.repeat(40) && minter !== wallet.toLowerCase()) throw new UnsafeMintAction('minter mismatch');
  if (wordAt(data, 3) !== BigInt(quantity)) throw new UnsafeMintAction('mint quantity mismatch');
  if (stage.type === 'PUBLIC_SALE') {
    if (stage.index !== 0) throw new UnsafeMintAction('public stage index must be 0');
  } else if (wordAt(data, 8) !== BigInt(stage.index)) {
    throw new UnsafeMintAction('mint stage index mismatch');
  }
  return tx;
}
