import { BN, Program, AnchorProvider } from '@coral-xyz/anchor';
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { BankrunContextWrapper } from './common/bankrunConnection';
import {
	VaultClient,
	getVaultAddressSync,
	getVaultDepositorAddressSync,
	encodeName,
	DriftVaults,
	VAULT_PROGRAM_ID,
	IDL,
	WithdrawUnit,
} from '../ts/sdk/lib';
import {
	BulkAccountLoader,
	DRIFT_PROGRAM_ID,
	DriftClient,
	OracleSource,
	PEG_PRECISION,
	PublicKey,
	QUOTE_PRECISION,
	TestClient,
	ZERO,
} from '@drift-labs/sdk';
import { TestBulkAccountLoader } from './common/testBulkAccountLoader';
import {
	bootstrapSignerClientAndUserBankrun,
	initializeQuoteSpotMarket,
	initializeSolSpotMarket,
	mockUSDCMintBankrun,
} from './common/testHelpers';
import { Keypair } from '@solana/web3.js';
import { mockOracleNoProgram } from './common/bankrunOracle';
import pythIDL from './fixtures/pyth.json';

const mantissaSqrtScale = new BN(100_000);
const ammInitialQuoteAssetReserve = new BN(5 * 10 ** 13).mul(mantissaSqrtScale);
const ammInitialBaseAssetReserve = new BN(5 * 10 ** 13).mul(mantissaSqrtScale);
const PYTH_PROGRAM_ID_STR = 'FsJ3A3u2vn5cTVofAjvy6y5kwABJAqYWpe4975bi2epH';
const PYTH_PROGRAM_ID = new PublicKey(PYTH_PROGRAM_ID_STR);

/**
 * REPRO — transfer_vault_depositor_shares reverts with InvalidVaultSharesDetected
 * whenever the vault accrues ANY profit share.
 *
 * Root cause (verified by reading source):
 *   transfer_vault_depositor_shares.rs:78-80 builds its pre/post invariant from
 *     vault_depositor.get_vault_shares() + to_vault_depositor.get_vault_shares()
 *   but vault_depositor.transfer_shares() (traits.rs:256-275) internally calls
 *     self.apply_profit_share() and to.apply_profit_share(), which REDUCE the
 *     depositors' vault_shares and increase the manager's implicit shares
 *     (manager_shares = total_shares - user_shares, total_shares unchanged).
 *   => sum of the two depositor accounts drops => validate! fails.
 *
 * Control: redeem_tokens.rs:32-38 and 88-98 include
 *   vault.get_manager_shares(&mut vp) in the SAME invariant, and there it passes.
 */
describe('reproInvariant', () => {
	let vaultProgram: Program<DriftVaults>;
	const initialSolPerpPrice = 100;
	let adminDriftClient: TestClient;
	let bulkAccountLoader: TestBulkAccountLoader;
	let bankrunContextWrapper: BankrunContextWrapper;
	let usdcMint: PublicKey;
	let solPerpOracle: PublicKey;
	const vaultName = 'repro invariant vault';
	const commonVaultKey = getVaultAddressSync(VAULT_PROGRAM_ID, encodeName(vaultName));
	const usdcAmount = new BN(1_000_000_000).mul(new BN(QUOTE_PRECISION.toNumber()));

	const managerSigner = Keypair.generate();
	let managerClient: VaultClient;
	let managerDriftClient: DriftClient;
	let managerUSDCAccount: PublicKey;

	const user1Signer = Keypair.generate();
	let user1Client: VaultClient;
	let user1DriftClient: DriftClient;
	let user1VaultDepositor: PublicKey;
	let user1UserUSDCAccount: PublicKey;

	const user2Signer = Keypair.generate();
	let user2Client: VaultClient;
	let user2DriftClient: DriftClient;
	let user2VaultDepositor: PublicKey;
	let user2UserUSDCAccount: PublicKey;

	function driftClientConfig(bulkAccountLoader: TestBulkAccountLoader, oracle: PublicKey) {
		// activeSubAccountId + subAccountIds must be explicit. Without them
		// DriftClient falls back to enumerating user accounts via
		// connection.getProgramAccounts, which BankrunProvider's connection proxy
		// does not implement, and the test dies in beforeAll with
		// "TypeError: this._provider.connection.getProgramAccounts is not a function".
		// The upstream tests (transferVaultDepositorShares, sharesExamples) all set
		// these two; mirroring them is what keeps this a bankrun-compatible config.
		return {
			activeSubAccountId: 0,
			subAccountIds: [] as number[],
			perpMarketIndexes: [0],
			spotMarketIndexes: [0, 1],
			oracleInfos: [{ publicKey: oracle, source: OracleSource.PYTH }],
			accountSubscription: {
				type: 'polling' as const,
				accountLoader: bulkAccountLoader as BulkAccountLoader,
			},
		};
	}

	/** Move an EXISTING pyth price feed to a new price (tests otherwise only create new feeds). */
	async function setOraclePrice(price: number) {
		const provider = new AnchorProvider(
			bankrunContextWrapper.connection.toConnection(),
			bankrunContextWrapper.provider.wallet,
			{ commitment: 'processed' }
		);
		const prog = new Program(pythIDL as any, new PublicKey(PYTH_PROGRAM_ID), provider);
		const ix = await prog.methods
			.setPrice(new BN(Math.round(price * 10 ** 7)))
			.accounts({ price: solPerpOracle })
			.instruction();
		const tx = new (await import('@solana/web3.js')).Transaction().add(ix);
		tx.feePayer = bankrunContextWrapper.context.payer.publicKey;
		tx.recentBlockhash = bankrunContextWrapper.context.lastBlockhash;
		tx.sign(bankrunContextWrapper.context.payer);
		await bankrunContextWrapper.connection.sendTransaction(tx);
		await bulkAccountLoader.load();
	}

	beforeAll(async () => {
		// solana-bankrun's startAnchor loads <dir>/<name>.so for each entry. The
		// drift + pyth programs ship as fixtures in tests/fixtures; our freshly
		// built vault program lives in target/deploy. The CI step copies
		// drift_vaults.so next to the fixtures so one dir serves all three.
		// solana-bankrun 0.3.x treats startAnchor's first argument as an Anchor
		// project directory (it reads Anchor.toml for [[test.genesis]]), not as a
		// directory of .so files. Passing 'tests/fixtures' therefore fails with
		// "File not found: No such file or directory (os error 2)" because that
		// directory has no Anchor.toml. Passing '' keeps the legacy behaviour:
		// each entry's `<name>.so` is resolved relative to the process cwd, which
		// is why the three programs are copied to the repo root just below.
		const { copyFileSync, existsSync } = await import('fs');
		for (const name of ['drift_vaults', 'drift', 'pyth']) {
			const src = `tests/fixtures/${name}.so`;
			if (existsSync(src)) copyFileSync(src, `./${name}.so`);
		}

		const { startAnchor } = await import('solana-bankrun');
		const context = await startAnchor(
			'',
			[
				{ name: 'drift_vaults', programId: VAULT_PROGRAM_ID },
				{ name: 'drift', programId: new PublicKey(DRIFT_PROGRAM_ID) },
				{ name: 'pyth', programId: PYTH_PROGRAM_ID },
			],
			[]
		);
		bankrunContextWrapper = new BankrunContextWrapper(context);
		vaultProgram = new Program<DriftVaults>(IDL, VAULT_PROGRAM_ID, bankrunContextWrapper.provider);
		bulkAccountLoader = new TestBulkAccountLoader(bankrunContextWrapper.connection.toConnection(), 'processed', 1);

		usdcMint = await mockUSDCMintBankrun(bankrunContextWrapper);
		solPerpOracle = await mockOracleNoProgram(bankrunContextWrapper, initialSolPerpPrice);

		adminDriftClient = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet: bankrunContextWrapper.provider.wallet,
			programID: new PublicKey(DRIFT_PROGRAM_ID),
			opts: { commitment: 'confirmed' },
			activeSubAccountId: 0,
			perpMarketIndexes: [0],
			spotMarketIndexes: [0, 1],
			subAccountIds: [],
			oracleInfos: [{ publicKey: solPerpOracle, source: OracleSource.PYTH }],
			accountSubscription: { type: 'polling', accountLoader: bulkAccountLoader as BulkAccountLoader },
		});
		await adminDriftClient.initialize(usdcMint, true);
		await adminDriftClient.subscribe();
		await initializeQuoteSpotMarket(adminDriftClient, usdcMint);
		await initializeSolSpotMarket(adminDriftClient, solPerpOracle);
		await adminDriftClient.initializePerpMarket(
			0,
			solPerpOracle,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			new BN(0), // 1 HOUR
			new BN(initialSolPerpPrice).mul(PEG_PRECISION)
		);
		await bulkAccountLoader.load();

		const mb = await bootstrapSignerClientAndUserBankrun({
			bankrunContext: bankrunContextWrapper,
			signer: managerSigner,
			usdcMint, usdcAmount, vaultClientCliMode: true,
			programId: VAULT_PROGRAM_ID,
			driftClientConfig: driftClientConfig(bulkAccountLoader, solPerpOracle),
		});
		managerClient = mb.vaultClient; managerDriftClient = mb.driftClient; managerUSDCAccount = mb.userUSDCAccount.publicKey;

		const b1 = await bootstrapSignerClientAndUserBankrun({
			bankrunContext: bankrunContextWrapper,
			signer: user1Signer,
			usdcMint, usdcAmount, vaultClientCliMode: true,
			programId: VAULT_PROGRAM_ID,
			driftClientConfig: driftClientConfig(bulkAccountLoader, solPerpOracle),
		});
		user1Client = b1.vaultClient; user1DriftClient = b1.driftClient; user1UserUSDCAccount = b1.userUSDCAccount.publicKey;
		user1VaultDepositor = getVaultDepositorAddressSync(VAULT_PROGRAM_ID, commonVaultKey, user1Signer.publicKey);

		const b2 = await bootstrapSignerClientAndUserBankrun({
			bankrunContext: bankrunContextWrapper,
			signer: user2Signer,
			usdcMint, usdcAmount, vaultClientCliMode: true,
			programId: VAULT_PROGRAM_ID,
			driftClientConfig: driftClientConfig(bulkAccountLoader, solPerpOracle),
		});
		user2Client = b2.vaultClient; user2DriftClient = b2.driftClient; user2UserUSDCAccount = b2.userUSDCAccount.publicKey;
		user2VaultDepositor = getVaultDepositorAddressSync(VAULT_PROGRAM_ID, commonVaultKey, user2Signer.publicKey);

		// NON-ZERO fees are the whole point. Upstream tests all use ZERO here.
		await managerClient.initializeVault(
			{
				name: encodeName(vaultName),
				spotMarketIndex: 0,
				redeemPeriod: ZERO,
				maxTokens: ZERO,
				managementFee: new BN(1_000_000), // 1% (PERCENTAGE_PRECISION=1e6)
				profitShare: 100_000,             // 10%
				hurdleRate: 0,
				permissioned: false,
				minDepositAmount: ZERO,
			},
			{ noLut: true }
		);

		await user1Client.initializeVaultDepositor(commonVaultKey, user1Signer.publicKey, user1Signer.publicKey, { noLut: true });
		await user2Client.initializeVaultDepositor(commonVaultKey, user2Signer.publicKey, user2Signer.publicKey, { noLut: true });

		await user1Client.deposit(user1VaultDepositor, usdcAmount.divn(10), undefined, { noLut: true }, user1UserUSDCAccount);
		await user2Client.deposit(user2VaultDepositor, usdcAmount.divn(20), undefined, { noLut: true }, user2UserUSDCAccount);
		await managerClient.deposit(
			getVaultDepositorAddressSync(VAULT_PROGRAM_ID, commonVaultKey, managerSigner.publicKey),
			usdcAmount.divn(20), undefined, { noLut: true }, managerUSDCAccount
		);
	}, 300000);

	afterAll(async () => {
		for (const c of [adminDriftClient, managerClient, managerDriftClient, user1Client, user1DriftClient, user2Client, user2DriftClient]) {
			try { await c?.unsubscribe(); } catch { /* noop */ }
		}
	});

	it('REPRO: transferVaultDepositorShares reverts InvalidVaultSharesDetected while vault is in profit', async () => {
		// create profit: the vault's drift user goes long, then the oracle price rises.
		// managerDriftClient is the account that trades for the vault's drift_user.
		try {
			const marketIndex = 0;
			await managerDriftClient.fetchAccounts();
			await managerDriftClient.placePerpOrder({
				orderType: { market: {} } as any,
				marketIndex,
				direction: { long: {} } as any,
				baseAssetAmount: managerDriftClient.convertToPerpPrecision(1),
				positionType: undefined,
			} as any);
			console.log('opened long perp position on vault drift_user');
		} catch (e: any) {
			console.log('placePerpOrder failed (non-fatal):', String(e?.message).slice(0, 200));
		}

		await setOraclePrice(initialSolPerpPrice * 1.5);

		const equityAfter = await managerClient.calculateVaultEquity({ address: commonVaultKey }).catch(() => null);
		console.log('vault equity after oracle move:', equityAfter ? equityAfter.toString() : 'n/a');

		const vaultBefore = await vaultProgram.account.vault.fetch(commonVaultKey);
		const vd1Before = await vaultProgram.account.vaultDepositor.fetch(user1VaultDepositor);
		const vd2Before = await vaultProgram.account.vaultDepositor.fetch(user2VaultDepositor);

		const legacyInvariant = vd1Before.vaultShares.add(vd2Before.vaultShares);
		const managerShares = vaultBefore.totalShares.sub(vaultBefore.userShares);

		console.log('==== PRE-STATE (the two numbers the invariant compares) ====');
		console.log('vault.userShares        =', vaultBefore.userShares.toString());
		console.log('vault.totalShares       =', vaultBefore.totalShares.toString());
		console.log('manager_shares (impl.)  =', managerShares.toString());
		console.log('vd1.vaultShares (user1) =', vd1Before.vaultShares.toString());
		console.log('vd2.vaultShares (user2) =', vd2Before.vaultShares.toString());
		console.log('legacyInvariant(vd1+vd2)=', legacyInvariant.toString(), '  <-- this is what transfer/tokenize compare');
		console.log('correctInvariant(+mgr)  =', legacyInvariant.add(managerShares).toString(), '  <-- this is what redeem_tokens compares');

		let errName = 'NO_ERROR';
		let errCode: any = null;
		let errMsg = '';
		let succeeded = false;
		try {
			await user1Client.transferVaultDepositorShares(
				user1VaultDepositor, user2VaultDepositor,
				vd1Before.vaultShares.divn(4),
				WithdrawUnit.SHARES, { noLut: true }
			);
			succeeded = true;
		} catch (e: any) {
			errName = e?.error?.errorCode?.code || e?.name || 'UNKNOWN';
			errCode = e?.error?.errorCode?.number ?? null;
			errMsg = (e?.error?.errorMessage || e?.message || '').toString();
		}
		console.log('==== RESULT ====');
		console.log('succeeded =', succeeded);
		console.log('errName   =', errName);
		console.log('errCode   =', errCode);
		console.log('message   =', errMsg);

		expect(succeeded).toBe(false);
		expect(errName).toBe('InvalidVaultSharesDetected');
	}, 300000);

	it('CONTROL: identical call succeeds when the vault has zero fees', async () => {
		const cleanName = 'repro invariant vault clean';
		const cleanKey = getVaultAddressSync(VAULT_PROGRAM_ID, encodeName(cleanName));
		await managerClient.initializeVault(
			{
				name: encodeName(cleanName), spotMarketIndex: 0, redeemPeriod: ZERO, maxTokens: ZERO,
				managementFee: ZERO, profitShare: 0, hurdleRate: 0, permissioned: false, minDepositAmount: ZERO,
			},
			{ noLut: true }
		);
		const c1 = getVaultDepositorAddressSync(VAULT_PROGRAM_ID, cleanKey, user1Signer.publicKey);
		const c2 = getVaultDepositorAddressSync(VAULT_PROGRAM_ID, cleanKey, user2Signer.publicKey);
		await user1Client.initializeVaultDepositor(cleanKey, user1Signer.publicKey, user1Signer.publicKey, { noLut: true });
		await user2Client.initializeVaultDepositor(cleanKey, user2Signer.publicKey, user2Signer.publicKey, { noLut: true });
		await user1Client.deposit(c1, usdcAmount.divn(20), undefined, { noLut: true }, user1UserUSDCAccount);
		await user2Client.deposit(c2, usdcAmount.divn(20), undefined, { noLut: true }, user2UserUSDCAccount);

		const vd1 = await vaultProgram.account.vaultDepositor.fetch(c1);
		let ok = false;
		let errName = '';
		try {
			await user1Client.transferVaultDepositorShares(c1, c2, vd1.vaultShares.divn(4), WithdrawUnit.SHARES, { noLut: true });
			ok = true;
		} catch (e: any) {
			errName = e?.error?.errorCode?.code || e?.name || 'UNKNOWN';
		}
		console.log('CONTROL: ok =', ok, 'errName =', errName);
		expect(ok).toBe(true);
	}, 300000);
});
