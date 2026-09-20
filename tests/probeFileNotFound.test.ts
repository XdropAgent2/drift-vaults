import { describe, it, expect } from '@jest/globals';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { PublicKey } from '@solana/web3.js';

const VAULT_PROGRAM_ID = new PublicKey('vAuLTsyrvSfZRuRB3XgvkPwNGgYSs9YRYymVebLKoxR');
const DRIFT_PROGRAM_ID = new PublicKey('dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH');
const PYTH_PROGRAM_ID = new PublicKey('FsJ3A3u2vn5cTVofAjvy6y5kwABJAqYWpe4975bi2epH');

describe('probe', () => {
  it('probe A: filesystem layout', () => {
    const cwd = process.cwd();
    console.log('CWD:', cwd);
    for (const p of [
      'tests/fixtures',
      'tests/fixtures/drift.so',
      'tests/fixtures/pyth.so',
      'tests/fixtures/drift_vaults.so',
      'ts/sdk/lib',
      'ts/sdk/lib/index.js',
      'target/deploy/drift_vaults.so',
    ]) {
      console.log(`  ${existsSync(p) ? 'OK  ' : 'MISS'} ${p}  -> ${resolve(p)}`);
    }
    expect(true).toBe(true);
  });

  it('probe B: import ts/sdk/lib', async () => {
    try {
      const m = await import('../ts/sdk/lib');
      console.log('IMPORT OK, keys:', Object.keys(m).length, Object.keys(m).slice(0, 8).join(','));
    } catch (e: any) {
      console.log('IMPORT FAIL:', e?.message);
      console.log('STACK:', String(e?.stack).split('\n').slice(0, 6).join('\n'));
      throw e;
    }
  });

  it('probe C: startAnchor with fixtures path', async () => {
    const { startAnchor } = await import('solana-bankrun');
    const ctx = await startAnchor(
      'tests/fixtures',
      [
        { name: 'drift_vaults', programId: VAULT_PROGRAM_ID },
        { name: 'drift', programId: DRIFT_PROGRAM_ID },
        { name: 'pyth', programId: PYTH_PROGRAM_ID },
      ],
      []
    );
    console.log('startAnchor(fixtures) OK, payer:', ctx.payer.publicKey.toBase58());
    expect(ctx).toBeTruthy();
  });

  it('probe D: startAnchor with empty path', async () => {
    const { startAnchor } = await import('solana-bankrun');
    const ctx = await startAnchor('', [{ name: 'drift', programId: DRIFT_PROGRAM_ID }], []);
    console.log('startAnchor(empty) OK, payer:', ctx.payer.publicKey.toBase58());
    expect(ctx).toBeTruthy();
  });
});
