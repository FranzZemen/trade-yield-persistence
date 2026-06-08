/*
Created by Franz Zemen 05/12/2026
License Type: UNLICENSED

Era 4 / 4a-E3: Postgres integration tests against dev_franz. Verifies the
DynamoDB→kysely/Postgres repoint of @franzzemen/trade-yield-persistence round-trips
every field for the 6 yield tables (+ 2 child tables) under all three contexts
(open / asOf:DATE / since:EPOCH), plus the FK-cascade-delete-by-trade behavior.

The yield tables FK trades(trade_id) ON DELETE CASCADE, and the segment
transaction-portion children FK transactions(transaction_id). So a `before()` hook
seeds a minimal brokerage_accounts + trades + transactions fixture; `after()` deletes
the trade (CASCADE sweeps the yield rows) and the seed rows so the suite is
re-runnable.

Run:
  BROKENSTOCK_DB=dev_franz AWS_PROFILE=rds-user npx bs.test-only
Requires AWSSECRET; the SSH/db tunnel must be up on localhost:5432.
*/

import 'mocha';
import {expect} from 'chai';
import {randomUUID} from 'node:crypto';
import {Provenance} from '@franzzemen/admin-identity';
import {ExecutionContext} from '@franzzemen/execution-context';
import {endpointContextKey, EndpointContext, Session, systemAdministratorRoles} from '@franzzemen/endpoint-application';
import {awsContextKey, type AWSContext} from '@franzzemen/aws-app/context';
import {loadPostgresConfig} from '@franzzemen/postgres-app/config-loader';
import {createPool} from '@franzzemen/postgres-app/pool';
import {createKysely} from '@franzzemen/postgres-app/query';
import {getBrokerageAccountUUID} from '@franzzemen/endpoint-financial-identity';
import {
  getLeafChainUUID,
  getSubTradeUUID,
  getSubTradeYieldUnitUUID,
  getTradeUUID,
  getTradeYieldSegmentUUID,
  getTransactionUUID,
  LeafChainUUID,
  SubTradeUUID,
  SubTradeYieldUnit,
  TradeYieldSegment,
  TradeYieldSegmentSummary,
  AsOfTradeYieldSegmentSummary,
  SinceTradeYieldSegmentSummary,
  TransactionUUID,
  TradeUUID,
} from '@franzzemen/financial-identity';
import {AccountOwner} from '@franzzemen/endpoint-financial-identity';
import {Datestamp} from '@franzzemen/utility';
import {LoadExecutionConfigsFunctionInputs, loadNodeExecutionContext} from '@franzzemen/execution-context-node-loader';
import {LoggerApi} from '@franzzemen/logger';
import {Kysely, sql} from 'kysely';
import type {Database} from '@franzzemen/brokenstock-postgres-ddl/schema-types';
import {
  _TradeDailyMTMSeries,
  TradeYieldPersistenceTrustedApi,
  asOfContext,
  isOrphanTradeError,
  OPEN_CONTEXT,
  sinceContext,
} from '#project';

const secret = process.env['AWSSECRET'];
const suite = secret ? describe : describe.skip;

const owner: AccountOwner = `${randomUUID()}.user` as AccountOwner;

const testProvenance: Provenance = {
  startedBy:     'test:trade-yield-persistence-round-trip',
  jobId:         'test-job',
  writerLambda:  'local:round-trip-integration.test',
  writerVersion: '0.0.0-test',
  writtenAt:     Date.now(),
};

let ec: ExecutionContext;
let db: Kysely<Database>;
let api: TradeYieldPersistenceTrustedApi;

// One trade fixture per run; both test trades are seeded so the yield rows have a
// valid (CASCADE-ing) parent. account_id is the seeded brokerage_accounts PK.
const accountId = getBrokerageAccountUUID();
const tradeUuid1 = getTradeUUID();
const tradeUuid2 = getTradeUUID();
// A couple of seeded transactions the segment transaction-portion children point at.
const txnUuid1 = getTransactionUUID();
const txnUuid2 = getTransactionUUID();

function setSession(): void {
  ec.putSub<EndpointContext, Session>(endpointContextKey, 'iam.session', {
    appContext: 'endpoint-application', startEpoch: Date.now(), owner,
    token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZXN0In0.signature',
    createdBy: owner, updatedBy: owner, createdEpoch: Date.now(), updatedEpoch: Date.now(),
    authenticated: true, previouslyAuthenticated: false, invalidated: false,
    ttl: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
    start: '2026-06-08T00:00:00Z', roles: systemAdministratorRoles,
  } as Session);
}

async function warmUp(): Promise<void> {
  for (let attempt = 1; attempt <= 6; attempt++) {
    try { await sql`SELECT 1`.execute(db); return; }
    catch (err) { if (attempt === 6) throw err; await new Promise(r => setTimeout(r, 5000)); }
  }
}

/**
 * Seed the once-only parents that survive a trade-only cascade delete: the
 * brokerage_accounts row + the transactions the segment transaction-portion
 * children reference (transactions.trade_id is NULL, so deleting a trade leaves
 * them intact; segment→portion rows cascade off the segment, not the transaction).
 */
async function seedAccountAndTxns(): Promise<void> {
  await db.insertInto('brokerage_accounts').values({
    account_id: accountId, owner, brokerage: 'Fidelity' as never, account: '123456789', nickname: null,
    created_by: owner, updated_by: owner,
  }).execute();

  for (const [txnId, epoch] of [[txnUuid1, 1_700_000_000_000], [txnUuid2, 1_700_086_400_000]] as const) {
    await db.insertInto('transactions').values({
      transaction_id: txnId, owner, account_id: accountId,
      brokerage: 'Fidelity' as never, account: '123456789',
      transaction_date: new Date(epoch), trading_date: '2026-03-15' as never,
      paid_transaction_date: null, last_split_date: '2026-03-15' as never,
      security_key: 'XNAS:AAPL', alias_type: 'Unknown', mic: 'XNAS', symbol: 'AAPL',
      brokerage_alias: 'AAPL', underlying_symbol: 'AAPL', underlying_exchange: 'NASDAQ', country_code: 'US',
      security_type: 'Stock', action: 'buy', action_type: 'Opening',
      quantity: '100', price: '150', parsed_quantity: '100', parsed_price: '150',
      commission: '0', fees: '0', amount: '-15000', currency: 'USD', origin: 'manual', origin_name: 'test',
      origin_record_id: null, origin_transfer_event_id: null, brokerage_unique_identifier: null,
      transfer_counterparty_hint: null, trade_id: null, sub_trade_ndx: null, ordinal_position: null,
      created_by: owner, updated_by: owner,
    }).execute();
  }
}

/**
 * Seed (or re-seed) the trade rows the yield rows FK to. Called in before() and
 * again by the FK-cascade test after it deletes the trade row directly.
 */
async function seedTrades(tradeIds: TradeUUID[] = [tradeUuid1, tradeUuid2]): Promise<void> {
  for (const tradeId of tradeIds) {
    await db.insertInto('trades').values({
      trade_id: tradeId, owner, account_id: accountId,
      brokerage: 'Fidelity' as never, account: '123456789',
      symbol_partition: 'Fidelity:123456789:AAPL', symbol: 'AAPL', security_key: 'XNAS:AAPL',
      status: 'Open', opened_epoch: String(1_700_000_000_000), closed_epoch: String(Number.MAX_SAFE_INTEGER),
      open_positions: '100', created_by: owner, updated_by: owner,
    }).execute();
  }
}

async function cleanupFixture(): Promise<void> {
  // Deleting the trade CASCADEs the yield rows; clear transactions + account explicitly.
  await db.deleteFrom('trades').where('owner', '=', owner).execute();
  await db.deleteFrom('transactions').where('owner', '=', owner).execute();
  await db.deleteFrom('brokerage_accounts').where('owner', '=', owner).execute();
}

// ── make* helpers — every wire field populated, including the new forensic/lineage fields ──

function makeSegment(tradeUuid: TradeUUID, startEpoch: number, endEpoch: number | null, denominator: number, gain: number): TradeYieldSegment {
  return {
    uuid: getTradeYieldSegmentUUID(),
    tradeUuid,
    subTradeUuids: [getSubTradeUUID()],
    archetype: 'longEquity',
    denominator,
    startEpoch,
    endEpoch,
    startBoundaryKind: 'openingTransaction',
    endBoundaryKind: endEpoch === null ? null : 'closingTransaction',
    transactionPortions: [
      {transactionUuid: txnUuid1, quantityPortion: 0.5},
      {transactionUuid: txnUuid2, quantityPortion: 0.5},
    ],
    gain,
    markToMarketPriceAtBoundary: 152.5,
    days: 1,
    yield: denominator > 0 ? (gain / denominator) * 100 : 0,
    feesAndCommissions: 1.25,
    // Forensic / lineage / DAG fields:
    explanation: 'opened long equity; closed at boundary',
    leafChainUuids: [getLeafChainUUID(), getLeafChainUUID()],
    priorSegmentUuids: [getTradeYieldSegmentUUID()],
    closingTransactionUuids: [txnUuid2],
    openingTransactionUuids: [txnUuid1],
    familyClusterId: `cluster-${randomUUID()}`,
    boundaryQuantityDelta: {prior: 100, current: 50},
  };
}

function makeUnit(tradeUuid: TradeUUID): SubTradeYieldUnit {
  return {
    uuid: getSubTradeYieldUnitUUID(),
    tradeUuid,
    subTradeUuid: getSubTradeUUID(),
    symbol: 'AAPL',
    archetype: 'longEquity',
    denominator: 1000,
    startEpoch: 1_700_000_000_000,
    endEpoch: 1_700_086_400_000,
    gain: 50,
    markToMarketPriceAtBoundary: 151.0,
    days: 1,
    yield: 5,
    feesAndCommissions: 0.5,
    explanation: 'forensic as-if-no-spread unit',
  };
}

function makeOpenSummary(tradeUuid: TradeUUID, segments: TradeYieldSegment[], units: SubTradeYieldUnit[]): TradeYieldSegmentSummary {
  const totalGain = segments.reduce((s, x) => s + x.gain, 0);
  const pscar = segments.reduce((s, x) => s + x.denominator, 0);
  return {
    tradeUuid,
    peakSimultaneousCaR: pscar,
    startEpoch: 1_700_000_000_000,
    endEpoch: null,
    days: 1,
    totalGain,
    realizedGain: 10,
    unrealizedGain: totalGain - 10,
    passiveGain: 2,
    feesAndCommissions: 1.25,
    yield: pscar > 0 ? (totalGain / pscar) * 100 : 0,
    annualizedYieldLinear: 12.5,
    annualizedYieldCagr: 13.1,
    segments,
    subTradeYieldUnits: units,
    subTradeWins:       2,
    subTradeLosses:     1,
    subTradeBreakevens: 1,
    subTradeWinRate:    0.5,
    subTradeWinAmount:  120,
    subTradeLossAmount: 30,
    priceSource: 'realtime',
    closingDate: '2026-04-21' as Datestamp,
    explanation: 'rolling open-trade summary',
    computedAt: 1_700_100_000_000,
  };
}

function makeDailyMtm(tradeUuid: TradeUUID): _TradeDailyMTMSeries {
  return {
    owner,
    tradeUuid,
    dateEpoch: 1_700_000_000_000,
    date: '2026-04-21' as Datestamp,
    mtmAmount: 15250,
    carAtDate: 15000,
    segmentArchetypeContributions: [
      {archetype: 'longEquity', carContribution: 12000},
      {archetype: 'coveredCall', carContribution: 3000},
    ],
    priceCoverage: 0.95,
    computedAt: 1_700_100_000_000,
  };
}

// Sort segments by uuid so deep-equal is order-independent.
const byUuid = <T extends {uuid?: string}>(a: T, b: T) => (a.uuid! < b.uuid! ? -1 : 1);

suite('trade-yield-persistence round-trip integration (PG / dev_franz)', function () {
  this.timeout(30_000);

  before(async () => {
    if (!process.env['BROKENSTOCK_DB']) process.env['BROKENSTOCK_DB'] = 'dev_franz';
    await loadNodeExecutionContext({
      secret: secret!,
      jsonEncryptPath: './config.json.encrypt',
      jsonFilePath: './config.json',
      executionName: 'trade-yield-persistence-round-trip-test',
    } as LoadExecutionConfigsFunctionInputs);
    ec = new ExecutionContext();
    await LoggerApi.load(ec);
    setSession();
    // DDB-era config.json has no aws.rds section; inject dev_franz (mirrors the
    // other Era-3/4 package integration tests).
    const aws = ec.get<AWSContext>(awsContextKey) ?? ({} as AWSContext);
    (aws as any).region = (aws as any).region ?? 'us-west-2';
    (aws as any).rds = (aws as any).rds ?? {};
    (aws as any).rds['dev_franz'] = (aws as any).rds['dev_franz'] ?? {
      clusterEndpoint: 'brokenstock-nonprod-aurora.cluster-ct25p21tys1f.us-west-2.rds.amazonaws.com',
      port: 5432, database: 'dev_franz', iamUser: 'brokenstock_app',
    };
    ec.put<AWSContext>(awsContextKey, aws);

    db = createKysely<Database>(createPool(ec, loadPostgresConfig(ec, 'rds-user')));
    await warmUp();
    await cleanupFixture();
    await seedAccountAndTxns();
    await seedTrades();
    api = new TradeYieldPersistenceTrustedApi(ec, db);
  });

  afterEach(async () => {
    await api.deleteByTrade(tradeUuid1);
    await api.deleteByTrade(tradeUuid2);
  });

  after(async () => {
    try { if (db) await cleanupFixture(); } finally { if (db) await db.destroy(); }
  });

  it('open: round-trips the summary + every segment field + units (deep-equal)', async () => {
    const segments = [
      makeSegment(tradeUuid1, 1_700_000_000_000, 1_700_086_400_000, 1000, 50),
      makeSegment(tradeUuid1, 1_700_086_400_000, null, 2000, 100),
    ];
    const units = [makeUnit(tradeUuid1)];
    const summary = makeOpenSummary(tradeUuid1, segments, units);
    await api.putOpenTradeSummary(summary, testProvenance);

    const read = await api.getOpenTradeSummary(tradeUuid1);
    expect(read, 'summary should exist').to.exist;

    // Deep-equal the segments (the forensic/lineage fields + transactionPortions must survive).
    expect([...read!.segments].sort(byUuid)).to.deep.equal([...segments].sort(byUuid));
    expect([...read!.subTradeYieldUnits].sort(byUuid)).to.deep.equal([...units].sort(byUuid));

    // Deep-equal the summary scalars (compare with segments/units swapped to the
    // sorted, hydrated arrays so the deep-equal is order-independent).
    const expected = {...summary, segments: [...read!.segments], subTradeYieldUnits: [...read!.subTradeYieldUnits]};
    expect(read).to.deep.equal(expected);
  });

  it('open: a second put replaces prior fact rows (no accumulation)', async () => {
    const v1 = [makeSegment(tradeUuid1, 1_700_000_000_000, null, 500, 25)];
    await api.putOpenTradeSummary(makeOpenSummary(tradeUuid1, v1, []), testProvenance);
    const v2 = [
      makeSegment(tradeUuid1, 1_700_000_000_000, 1_700_086_400_000, 800, 40),
      makeSegment(tradeUuid1, 1_700_086_400_000, null, 1200, 60),
    ];
    await api.putOpenTradeSummary(makeOpenSummary(tradeUuid1, v2, []), testProvenance);

    const read = await api.getOpenTradeSummary(tradeUuid1);
    expect(read!.segments.length).to.equal(2);
    expect(read!.segments.map(s => s.uuid).sort()).to.deep.equal(v2.map(s => s.uuid).sort());
  });

  it('asOf: round-trips a summary + segments independently of open context', async () => {
    const openSegments = [makeSegment(tradeUuid1, 1_700_000_000_000, null, 1000, 50)];
    await api.putOpenTradeSummary(makeOpenSummary(tradeUuid1, openSegments, []), testProvenance);

    const asOfDate = '2026-04-21' as Datestamp;
    const asOfSegments = [makeSegment(tradeUuid1, 1_700_000_000_000, null, 500, 25)];
    const asOfUnits = [makeUnit(tradeUuid1)];
    const asOfSummary: AsOfTradeYieldSegmentSummary = {
      ...makeOpenSummary(tradeUuid1, asOfSegments, asOfUnits),
      asOfDate,
      asOfEpoch: new Date(`${asOfDate}T20:00:00Z`).getTime(),
      priceCoverage: 0.97,
      error: 'partial-price-coverage',
    };
    await api.putAsOfTradeSummary(asOfSummary, testProvenance);

    const readAsOf = await api.getAsOfTradeSummary(tradeUuid1, asOfDate);
    expect(readAsOf, 'as-of summary should exist').to.exist;
    expect([...readAsOf!.segments].sort(byUuid)).to.deep.equal([...asOfSegments].sort(byUuid));
    expect([...readAsOf!.subTradeYieldUnits].sort(byUuid)).to.deep.equal([...asOfUnits].sort(byUuid));
    const expected = {...asOfSummary, segments: [...readAsOf!.segments], subTradeYieldUnits: [...readAsOf!.subTradeYieldUnits]};
    expect(readAsOf).to.deep.equal(expected);

    // Open context is untouched.
    const readOpen = await api.getOpenTradeSummary(tradeUuid1);
    expect(readOpen!.peakSimultaneousCaR).to.equal(1000);
    expect(readOpen!.segments[0]!.uuid).to.equal(openSegments[0]!.uuid);
  });

  it('asOf: getAsOfTradeSummaryRowsForOwnerAndDate returns the trade rollup for a date', async () => {
    const asOfDate = '2026-05-01' as Datestamp;
    const asOfBase = {
      ...makeOpenSummary(tradeUuid1, [makeSegment(tradeUuid1, 1_700_000_000_000, null, 500, 25)], []),
      asOfDate, asOfEpoch: new Date(`${asOfDate}T20:00:00Z`).getTime(), priceCoverage: 1.0,
    };
    await api.putAsOfTradeSummary(asOfBase, testProvenance);
    await api.putAsOfTradeSummary({
      ...makeOpenSummary(tradeUuid2, [makeSegment(tradeUuid2, 1_700_000_000_000, null, 700, 35)], []),
      asOfDate, asOfEpoch: new Date(`${asOfDate}T20:00:00Z`).getTime(), priceCoverage: 1.0,
    }, testProvenance);

    const rows = await api.getAsOfTradeSummaryRowsForOwnerAndDate(asOfDate);
    const ours = rows.filter(r => r.tradeUuid === tradeUuid1 || r.tradeUuid === tradeUuid2);
    expect(ours.length).to.equal(2);
    expect(ours.every(r => r.asOfDate === asOfDate)).to.be.true;
  });

  it('since: round-trips with anchor-epoch keying (gainSince + W/L tally + segments)', async () => {
    const anchor = 1_700_000_000_000;
    const sinceSegments = [makeSegment(tradeUuid1, anchor, null, 800, 40)];
    const sinceUnits = [makeUnit(tradeUuid1)];
    const sinceSummary: SinceTradeYieldSegmentSummary = {
      ...makeOpenSummary(tradeUuid1, sinceSegments, sinceUnits),
      sinceAnchorEpoch: anchor,
      gainSince: 40,
    };
    await api.putSinceTradeSummary(sinceSummary, testProvenance);

    const read = await api.getSinceTradeSummary(tradeUuid1, anchor);
    expect(read, 'since summary should exist').to.exist;
    expect(read!.gainSince).to.equal(40);
    expect([...read!.segments].sort(byUuid)).to.deep.equal([...sinceSegments].sort(byUuid));
    expect([...read!.subTradeYieldUnits].sort(byUuid)).to.deep.equal([...sinceUnits].sort(byUuid));
    const expected = {...sinceSummary, segments: [...read!.segments], subTradeYieldUnits: [...read!.subTradeYieldUnits]};
    expect(read).to.deep.equal(expected);
  });

  it('daily-mtm: round-trips the series + archetype contributions', async () => {
    const row = makeDailyMtm(tradeUuid1);
    await api.putDailyMTMRows([row], testProvenance);

    const read = await api.queryDailyMTMSeriesForTrade(tradeUuid1);
    expect(read.length).to.equal(1);
    // Sort contributions for order-independent compare.
    const sortContribs = (r: _TradeDailyMTMSeries) =>
      ({...r, segmentArchetypeContributions: [...r.segmentArchetypeContributions].sort((a, b) => (a.archetype < b.archetype ? -1 : 1))});
    expect(sortContribs(read[0]!)).to.deep.equal(sortContribs(row));
  });

  it('FK cascade: deleting the trade row directly sweeps every yield row + child', async () => {
    // Each context gets its own freshly-minted segment — segment_id is the PK
    // (context-independent), so the same segment object cannot live in two contexts.
    const openSeg = makeSegment(tradeUuid1, 1_700_000_000_000, null, 1000, 50);
    await api.putOpenTradeSummary(makeOpenSummary(tradeUuid1, [openSeg], [makeUnit(tradeUuid1)]), testProvenance);
    await api.putAsOfTradeSummary({
      ...makeOpenSummary(tradeUuid1, [makeSegment(tradeUuid1, 1_700_000_000_000, null, 1000, 50)], []),
      asOfDate: '2026-04-21' as Datestamp, asOfEpoch: 1_700_086_400_000, priceCoverage: 1.0,
    }, testProvenance);
    await api.putSinceTradeSummary({
      ...makeOpenSummary(tradeUuid1, [makeSegment(tradeUuid1, 1_700_000_000_000, null, 1000, 50)], []),
      sinceAnchorEpoch: 1_700_000_000_000, gainSince: 50,
    }, testProvenance);
    await api.putDailyMTMRows([makeDailyMtm(tradeUuid1)], testProvenance);

    // Pre-delete: portions + contributions children exist.
    const portionsBefore = await db.selectFrom('trade_yield_segment_transaction_portions')
      .select(db.fn.countAll<string>().as('c'))
      .where('segment_id', '=', openSeg.uuid!)
      .executeTakeFirstOrThrow();
    expect(Number(portionsBefore.c)).to.be.greaterThan(0);

    // Delete the trade row DIRECTLY via kysely — the FK ON DELETE CASCADE must sweep
    // every yield artifact (segments → portions, units, the 3 summaries, mtm → contributions).
    const res = await db.deleteFrom('trades').where('trade_id', '=', tradeUuid1).executeTakeFirst();
    expect(Number(res.numDeletedRows ?? 0n)).to.equal(1);

    expect(await api.getOpenTradeSummary(tradeUuid1)).to.be.undefined;
    expect(await api.getAsOfTradeSummary(tradeUuid1, '2026-04-21' as Datestamp)).to.be.undefined;
    expect(await api.getSinceTradeSummary(tradeUuid1, 1_700_000_000_000)).to.be.undefined;
    expect((await api.getSegmentRowsForTradeAndContext(tradeUuid1, OPEN_CONTEXT)).length).to.equal(0);
    expect((await api.getSubTradeYieldUnitRowsForTradeAndContext(tradeUuid1, OPEN_CONTEXT)).length).to.equal(0);
    expect((await api.queryDailyMTMSeriesForTrade(tradeUuid1)).length).to.equal(0);

    // Child rows are gone (cascade reached the leaves).
    const portionsAfter = await db.selectFrom('trade_yield_segment_transaction_portions')
      .select(db.fn.countAll<string>().as('c'))
      .where('segment_id', '=', openSeg.uuid!)
      .executeTakeFirstOrThrow();
    expect(Number(portionsAfter.c)).to.equal(0);
    const contribsAfter = await db.selectFrom('trade_daily_mtm_archetype_contributions')
      .select(db.fn.countAll<string>().as('c'))
      .where('trade_id', '=', tradeUuid1)
      .executeTakeFirstOrThrow();
    expect(Number(contribsAfter.c)).to.equal(0);

    // Re-seed only the deleted trade (tradeUuid2 was untouched). The account +
    // transaction parents survived the trade-only cascade delete.
    await seedTrades([tradeUuid1]);
  });

  it('deleteByTrade sweeps every context + reports asOfDatesTouched', async () => {
    // Fresh segment per context (segment_id is the context-independent PK).
    await api.putOpenTradeSummary(makeOpenSummary(tradeUuid1, [makeSegment(tradeUuid1, 1_700_000_000_000, null, 1000, 50)], [makeUnit(tradeUuid1)]), testProvenance);
    await api.putAsOfTradeSummary({
      ...makeOpenSummary(tradeUuid1, [makeSegment(tradeUuid1, 1_700_000_000_000, null, 1000, 50)], []),
      asOfDate: '2026-04-21' as Datestamp, asOfEpoch: 1_700_086_400_000, priceCoverage: 1.0,
    }, testProvenance);
    await api.putSinceTradeSummary({
      ...makeOpenSummary(tradeUuid1, [makeSegment(tradeUuid1, 1_700_000_000_000, null, 1000, 50)], []),
      sinceAnchorEpoch: 1_700_000_000_000, gainSince: 50,
    }, testProvenance);

    const {deleted, asOfDatesTouched} = await api.deleteByTrade(tradeUuid1);
    expect(deleted).to.be.greaterThan(0);
    expect(asOfDatesTouched).to.deep.equal(['2026-04-21']);
    expect(await api.getOpenTradeSummary(tradeUuid1)).to.be.undefined;
    expect(await api.getAsOfTradeSummary(tradeUuid1, '2026-04-21' as Datestamp)).to.be.undefined;
    expect(await api.getSinceTradeSummary(tradeUuid1, 1_700_000_000_000)).to.be.undefined;
  });

  it('contexts isolate: deleteFactRowsByTradeAndContext(open) does not touch asOf', async () => {
    await api.putOpenTradeSummary(makeOpenSummary(tradeUuid1, [makeSegment(tradeUuid1, 1_700_000_000_000, null, 1000, 50)], []), testProvenance);
    const asOfDate = '2026-04-21' as Datestamp;
    await api.putAsOfTradeSummary({
      ...makeOpenSummary(tradeUuid1, [makeSegment(tradeUuid1, 1_700_000_000_000, null, 1000, 50)], []),
      asOfDate, asOfEpoch: 1_700_086_400_000, priceCoverage: 1.0,
    }, testProvenance);

    await api.deleteFactRowsByTradeAndContext(tradeUuid1, OPEN_CONTEXT);
    expect((await api.getSegmentRowsForTradeAndContext(tradeUuid1, OPEN_CONTEXT)).length).to.equal(0);
    expect((await api.getSegmentRowsForTradeAndContext(tradeUuid1, asOfContext(asOfDate))).length).to.equal(1);
  });

  it('multi-trade owner scan: getAllOpenTradeSummaryRows returns scalars for both trades', async () => {
    await api.putOpenTradeSummary(makeOpenSummary(tradeUuid1, [makeSegment(tradeUuid1, 1_700_000_000_000, null, 1000, 50)], []), testProvenance);
    await api.putOpenTradeSummary(makeOpenSummary(tradeUuid2, [makeSegment(tradeUuid2, 1_700_000_000_000, null, 2000, 100)], []), testProvenance);

    const rows = await api.getAllOpenTradeSummaryRows();
    const ours = rows.filter(r => r.tradeUuid === tradeUuid1 || r.tradeUuid === tradeUuid2);
    expect(ours.length).to.equal(2);
  });

  it('orphan guard: putOpenTradeSummary throws a detectable OrphanTradeError when existsCheck is false', async () => {
    const summary = makeOpenSummary(tradeUuid1, [makeSegment(tradeUuid1, 1_700_000_000_000, null, 500, 25)], []);
    let thrown: unknown;
    try {
      await api.putOpenTradeSummary(summary, testProvenance, {existsCheck: async () => false});
    } catch (err) { thrown = err; }
    expect(thrown, 'putOpenTradeSummary should throw').to.exist;
    expect(isOrphanTradeError(thrown), 'thrown error must be detectable as OrphanTradeError').to.be.true;
  });

  it('orphan guard: putAsOfTradeSummary throws a detectable OrphanTradeError when existsCheck is false', async () => {
    const asOfDate = '2026-04-21' as Datestamp;
    const asOfSummary: AsOfTradeYieldSegmentSummary = {
      ...makeOpenSummary(tradeUuid1, [makeSegment(tradeUuid1, 1_700_000_000_000, null, 500, 25)], []),
      asOfDate, asOfEpoch: new Date(`${asOfDate}T20:00:00Z`).getTime(), priceCoverage: 1.0,
    };
    let thrown: unknown;
    try {
      await api.putAsOfTradeSummary(asOfSummary, testProvenance, {existsCheck: async () => false});
    } catch (err) { thrown = err; }
    expect(thrown, 'putAsOfTradeSummary should throw').to.exist;
    expect(isOrphanTradeError(thrown), 'thrown error must be detectable as OrphanTradeError').to.be.true;
  });

  it('sinceContext epoch padding: lexicographic order matches numeric order', () => {
    expect(sinceContext(1).localeCompare(sinceContext(2))).to.be.lessThan(0);
    expect(sinceContext(999).localeCompare(sinceContext(1000))).to.be.lessThan(0);
    expect(sinceContext(1_700_000_000_000).localeCompare(sinceContext(1_800_000_000_000))).to.be.lessThan(0);
  });
});
