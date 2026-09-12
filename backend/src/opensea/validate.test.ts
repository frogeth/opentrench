import { describe, it, expect } from 'vitest';
import { validateMintTransaction } from './validate.js';

const WALLET = '0x7e6f846efd40558042633c487ea6d9d67fa84178';
const NFT = '0x9d2a003322874163cbb18f7f538a1aaea49b75d1';
const word = (hex: string) => hex.replace(/^0x/, '').padStart(64, '0');
const calldata = (selector: string, over: Partial<{ nft: string; minter: string; qty: number; stage: number }> = {}) => {
  const w = [word(over.nft ?? NFT), word('0xfee'), word(over.minter ?? '0x0'), word((over.qty ?? 1).toString(16)), word('0'), word('0'), word('0'), word('0'), word((over.stage ?? 0).toString(16))];
  return '0x' + selector + w.join('');
};
const col = { slug: 's', name: 's', address: NFT, chain: 'robinhood', networkId: 4663, drop: { kind: 'Erc721SeaDropV1', address: NFT, stages: [] } };
const ok = (data: string) => ({ actionTypes: ['MintAction'], errors: [], tx: { to: '0x00005ea00ac477b1030ce78506496e8c2de24bf5', data, value: '0', networkId: 4663, chain: 'robinhood' } });

describe('validateMintTransaction', () => {
  it('passes a public mint for the wallet', () => {
    expect(() => validateMintTransaction(ok(calldata('161ac21f')), col, WALLET, { type: 'PUBLIC_SALE', index: 0 }, 1, 4663)).not.toThrow();
    expect(() => validateMintTransaction(ok(calldata('161ac21f', { minter: WALLET })), col, WALLET, { type: 'PUBLIC_SALE', index: 0 }, 1, 4663)).not.toThrow();
  });
  it('passes a signed presale on its stage index', () => {
    expect(() => validateMintTransaction(ok(calldata('4b61cd6f', { stage: 2 })), col, WALLET, { type: 'SIGNED_PRESALE', index: 2 }, 1, 4663)).not.toThrow();
    expect(() => validateMintTransaction(ok(calldata('4b61cd6f', { stage: 1 })), col, WALLET, { type: 'SIGNED_PRESALE', index: 2 }, 1, 4663)).toThrow(/stage index/);
  });
  it('rejects everything osnm-z rejects', () => {
    const pub = { type: 'PUBLIC_SALE', index: 0 };
    expect(() => validateMintTransaction({ ...ok(calldata('161ac21f')), errors: ['InsufficientFundError'] }, col, WALLET, pub, 1, 4663)).toThrow(/can't cover/);
    expect(() => validateMintTransaction({ ...ok(calldata('161ac21f')), actionTypes: ['ApproveAction', 'MintAction'] }, col, WALLET, pub, 1, 4663)).toThrow(/action sequence/);
    expect(() => validateMintTransaction({ ...ok(calldata('161ac21f')), tx: undefined }, col, WALLET, pub, 1, 4663)).toThrow(/exactly one/);
    expect(() => validateMintTransaction({ ...ok(calldata('161ac21f')), tx: { ...ok('').tx!, to: '0x0000000000000000000000000000000000000000', data: calldata('161ac21f') } }, col, WALLET, pub, 1, 4663)).toThrow(/zero/);
    expect(() => validateMintTransaction({ ...ok(calldata('161ac21f')), tx: { ...ok(calldata('161ac21f')).tx!, networkId: 1 } }, col, WALLET, pub, 1, 4663)).toThrow(/network/);
    expect(() => validateMintTransaction(ok('0x16'), col, WALLET, pub, 1, 4663)).toThrow(/selector/);
    expect(() => validateMintTransaction(ok(calldata('4b61cd6f')), col, WALLET, pub, 1, 4663)).toThrow(/selector/);
    expect(() => validateMintTransaction(ok(calldata('161ac21f', { nft: '0x1111111111111111111111111111111111111111' })), col, WALLET, pub, 1, 4663)).toThrow(/contract/);
    expect(() => validateMintTransaction(ok(calldata('161ac21f', { minter: '0x2222222222222222222222222222222222222222' })), col, WALLET, pub, 1, 4663)).toThrow(/minter/);
    expect(() => validateMintTransaction(ok(calldata('161ac21f', { qty: 2 })), col, WALLET, pub, 1, 4663)).toThrow(/quantity/);
  });
  it('only decodes calldata for ERC-721 SeaDrop v1', () => {
    const c1155 = { ...col, drop: { ...col.drop, kind: 'Erc1155SeaDropV2' } };
    expect(() => validateMintTransaction(ok('0xdeadbeef00'), c1155, WALLET, { type: 'PUBLIC_SALE', index: 0 }, 1, 4663)).not.toThrow();
  });

  it('rejects a non-decimal value', () => {
    expect(() => validateMintTransaction({ ...ok(calldata('161ac21f')), tx: { ...ok(calldata('161ac21f')).tx!, value: '0x10' } }, col, WALLET, { type: 'PUBLIC_SALE', index: 0 }, 1, 4663)).toThrow(/value/);
  });

  it('rejects a malformed to address', () => {
    expect(() => validateMintTransaction({ ...ok(calldata('161ac21f')), tx: { ...ok(calldata('161ac21f')).tx!, to: '0xnotanaddress' } }, col, WALLET, { type: 'PUBLIC_SALE', index: 0 }, 1, 4663)).toThrow();
  });

  it('rejects calldata too short for the stage index word', () => {
    const shortData = '0x4b61cd6f' + [word(NFT), word('0xfee'), word('0x0'), word('1'), word('0')].join('');
    expect(() => validateMintTransaction(ok(shortData), col, WALLET, { type: 'SIGNED_PRESALE', index: 0 }, 1, 4663)).toThrow(/shorter/);
  });

  it('rejects an address word with high bits set', () => {
    const badNftWord = 'f'.repeat(24) + NFT.slice(2);
    const data = '0x161ac21f' + [badNftWord, word('0xfee'), word('0x0'), word('1'), word('0'), word('0'), word('0'), word('0'), word('0')].join('');
    expect(() => validateMintTransaction(ok(data), col, WALLET, { type: 'PUBLIC_SALE', index: 0 }, 1, 4663)).toThrow(/high bits/);
  });

  it('accepts uppercase hex calldata case-insensitively', () => {
    const data = calldata('161ac21f').toUpperCase().replace('0X', '0x');
    expect(() => validateMintTransaction(ok(data), col, WALLET, { type: 'PUBLIC_SALE', index: 0 }, 1, 4663)).not.toThrow();
  });

  it('uses the merkle presale selector for an unknown-to-callers stage type', () => {
    expect(() => validateMintTransaction(ok(calldata('4300a4e6', { stage: 3 })), col, WALLET, { type: 'MERKLE_PRESALE', index: 3 }, 1, 4663)).not.toThrow();
  });

  it('rejects an unknown stage type', () => {
    expect(() => validateMintTransaction(ok(calldata('161ac21f')), col, WALLET, { type: 'AIRDROP', index: 0 }, 1, 4663)).toThrow(/unknown stage/);
  });

  it('rejects calldata whose length is not a whole number of words', () => {
    const data = calldata('161ac21f') + '00';
    expect(() => validateMintTransaction(ok(data), col, WALLET, { type: 'PUBLIC_SALE', index: 0 }, 1, 4663)).toThrow();
  });

  it('returns the tx object on success', () => {
    const tx = validateMintTransaction(ok(calldata('161ac21f')), col, WALLET, { type: 'PUBLIC_SALE', index: 0 }, 1, 4663);
    expect(tx).toEqual(ok(calldata('161ac21f')).tx);
  });

  it('sanity-checks quantity and stage index', () => {
    expect(() => validateMintTransaction(ok(calldata('161ac21f')), col, WALLET, { type: 'PUBLIC_SALE', index: 0 }, 0, 4663)).toThrow();
    expect(() => validateMintTransaction(ok(calldata('161ac21f')), col, WALLET, { type: 'PUBLIC_SALE', index: 0 }, -1, 4663)).toThrow();
    expect(() => validateMintTransaction(ok(calldata('161ac21f')), col, WALLET, { type: 'PUBLIC_SALE', index: -1 }, 1, 4663)).toThrow();
  });
});
