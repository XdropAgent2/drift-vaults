import { describe, it, expect } from '@jest/globals';
import { copyFileSync, existsSync } from 'fs';
import { PublicKey } from '@solana/web3.js';

const V = new PublicKey('vAuLTsyrvSfZRuRB3XgvkPwNGgYSs9YRYymVebLKoxR');
const D = new PublicKey('dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH');
const P = new PublicKey('FsJ3A3u2vn5cTVofAjvy6y5kwABJAqYWpe4975bi2epH');

describe('probe2', () => {
  it('E: empty path, all three programs (copied to cwd)', async () => {
    for (const n of ['drift_vaults', 'drift', 'pyth']) {
      const src = `tests/fixtures/${n}.so`;
      const dst = `./${n}.so`;
      if (existsSync(src)) { copyFileSync(src, dst); console.log(`copied ${src} -> ${dst}`); }
      else console.log(`MISSING ${src}`);
    }
    const { startAnchor } = await import('solana-bankrun');
    try {
      const ctx = await startAnchor('', [
        { name: 'drift_vaults', programId: V },
        { name: 'drift', programId: D },
        { name: 'pyth', programId: P },
      ], []);
      console.log('E OK payer:', ctx.payer.publicKey.toBase58());
      expect(ctx).toBeTruthy();
    } catch (e: any) {
      console.log('E FAIL:', e?.message);
      throw e;
    }
  });

  it('F: empty path, only drift (mirror the existing passing test)', async () => {
    const { startAnchor } = await import('solana-bankrun');
    const ctx = await startAnchor('', [{ name: 'drift', programId: D }], []);
    console.log('F OK payer:', ctx.payer.publicKey.toBase58());
    expect(ctx).toBeTruthy();
  });
});
