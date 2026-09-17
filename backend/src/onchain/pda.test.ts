import { describe, expect, it } from 'vitest';
import { decodeBase58, findProgramAddress, isOnCurve, utf8 } from './pda.js';
import { PROGRAMS } from './solana.js';

describe('program-derived addresses', () => {
  it('a real public key is on the curve; a PDA is not', () => {
    expect(isOnCurve(decodeBase58('So11111111111111111111111111111111111111112'))).toBe(true);
    expect(isOnCurve(decodeBase58('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'))).toBe(true);
    expect(isOnCurve(decodeBase58('5pbbzxp8gqAPXGpAev28intZa5NDTMs7QrYHVcxGTXpY'))).toBe(false);
  });
  it('derives the pump.fun bonding curve of a mint (live vector from the feed)', () => {
    expect(findProgramAddress([utf8('bonding-curve'), '2Dmta7fhheLqCBszyqcB1szf7nxx2eEsHM4dmEhFpump'], PROGRAMS.pumpfun).address).toBe('5pbbzxp8gqAPXGpAev28intZa5NDTMs7QrYHVcxGTXpY');
    expect(findProgramAddress([utf8('bonding-curve'), '7qgPfjFXcV7Hdpxf5qUDVr4N2YGYfDCwtLhRipXkpump'], PROGRAMS.pumpfun).address).toBe('46svP2DdCq1ZE3aCsXnDZhnGi4tAFtuDhR6Gs4BJQRbd');
  });
  it('derives the Metaplex metadata account (USDC)', () => {
    const METAPLEX = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';
    expect(findProgramAddress([utf8('metadata'), METAPLEX, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'], METAPLEX).address).toBe('5x38Kp4hvdomTCnCrAny4UtMUt5rQBdB6px2K1Ui45Wq');
  });
});
