/*
Created by Franz Zemen 05/12/2026
License Type: UNLICENSED

Integration tests against the real `test`-tableset DynamoDB tables. Verifies put/query/
hydrate round-trips for the five trade-yield-persistence tables under all three contexts
(open / asOf:DATE / since:EPOCH), plus cascade-delete-by-trade and per-context fact-row
replacement.

Requires AWSSECRET env var; suite is skipped otherwise.
*/

import 'mocha';
import {expect} from 'chai';
import {Provenance} from '@franzzemen/admin-identity';
import {ExecutionContext} from '@franzzemen/execution-context';
import {endpointContextKey} from '@franzzemen/endpoint-application';
import {
  getSubTradeUUID,
  getSubTradeYieldUnitUUID,
  getTradeUUID,
  getTradeYieldSegmentUUID,
  getTransactionUUID,
  SubTradeYieldUnit,
  TradeYieldSegment,
  TradeYieldSegmentSummary,
  AsOfTradeYieldSegmentSummary,
  SinceTradeYieldSegmentSummary,
  TradeUUID,
} from '@franzzemen/financial-identity';
import {AccountOwner} from '@franzzemen/endpoint-financial-identity';
import {Datestamp} from '@franzzemen/utility';
import {LoadExecutionConfigsFunctionInputs, loadNodeExecutionContext} from '@franzzemen/execution-context-node-loader';
import {LoggerApi} from '@franzzemen/logger';
import {awsContextKey} from '@franzzemen/aws-app/context';
import {
  TradeYieldPersistenceTrustedApi,
  asOfContext,
  OPEN_CONTEXT,
  sinceContext,
} from '#project';

const secret = process.env['AWSSECRET'];
const suite = secret ? describe : describe.skip;

const owner: AccountOwner = 'e3ce6f67-1670-4ace-b28d-1bacef21dccf.user' as AccountOwner;

const testProvenance: Provenance = {
  startedBy:     'test:trade-yield-persistence-round-trip',
  jobId:         'test-job',
  writerLambda:  'local:round-trip-integration.test',
  writerVersion: '0.0.0-test',
  writtenAt:     Date.now(),
};

function makeSegment(tradeUuid: TradeUUID, startEpoch: number, endEpoch: number | null, denominator: number, gain: number): TradeYieldSegment {
  return {
    uuid: getTradeYieldSegmentUUID(),
    tradeUuid,
    subTradeUuids: [],
    archetype: 'longEquity',
    denominator,
    startEpoch,
    endEpoch,
    startBoundaryKind: 'openingTransaction',
    endBoundaryKind: endEpoch === null ? null : 'closingTransaction',
    transactionPortions: [{transactionUuid: getTransactionUUID(), quantityPortion: 1}],
    gain,
    days: 1,
    yield: denominator > 0 ? (gain / denominator) * 100 : 0,
    feesAndCommissions: 0,
  };
}

function makeUnit(tradeUuid: TradeUUID): SubTradeYieldUnit {
  return {
    uuid: getSubTradeYieldUnitUUID(),
    tradeUuid,
    subTradeUuid: getSubTradeUUID(),
    symbol: 'TEST',
    archetype: 'longEquity',
    denominator: 1000,
    startEpoch: 1_700_000_000_000,
    endEpoch: 1_700_086_400_000,
    gain: 50,
    days: 1,
    yield: 5,
    feesAndCommissions: 0,
  } as SubTradeYieldUnit;
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
    realizedGain: 0,
    unrealizedGain: totalGain,
    passiveGain: 0,
    feesAndCommissions: 0,
    yield: pscar > 0 ? (totalGain / pscar) * 100 : 0,
    annualizedYieldLinear: 0,
    annualizedYieldCagr: 0,
    segments,
    subTradeYieldUnits: units,
    subTradeWins:       0,
    subTradeLosses:     0,
    subTradeBreakevens: 0,
    subTradeWinRate:    null,
    subTradeWinAmount:  0,
    subTradeLossAmount: 0,
    computedAt: Date.now(),
  };
}

suite('trade-yield-persistence round-trip integration', function () {
  this.timeout(20_000);
  let ec: ExecutionContext;
  let api: TradeYieldPersistenceTrustedApi;
  const tradeUuid1 = getTradeUUID();
  const tradeUuid2 = getTradeUUID();

  before(async () => {
    const inputs: LoadExecutionConfigsFunctionInputs = {
      secret: secret!,
      jsonEncryptPath: './config.json.encrypt',
      jsonFilePath: './config.json',
      executionName: 'trade-yield-persistence-round-trip-test',
    };
    await loadNodeExecutionContext(inputs);
    ec = new ExecutionContext();
    await LoggerApi.load(ec);
    ec.putSub(awsContextKey, 'dynamo.currentTableSet', 'test');
    ec.putSub(endpointContextKey, 'iam.session', {
      appContext: 'endpoint-application',
      startEpoch: Date.now(),
      start: new Date().toISOString(),
      token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhcHBDb250ZXh0IjoidGVzdC1lbmRwb2ludCIsImRhdGUiOjE3MjE1NjI5NzMzMzIsImlhdCI6MTcyMTU2Mjk3MywiZXhwIjoxNzIxNTY2NTczLCJpc3MiOiJ0ZXN0LWlzc3VlciIsInN1YiI6InRlc3QtdXNlcm5hbWUifQ.rTOAkdOeTa03JSxo79nzheuAXiPvrahqgt5u8vs-bFo',
      owner,
      authenticated: true,
      previouslyAuthenticated: false,
      invalidated: false,
      ttl: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
      roles: [],
    });
    api = new TradeYieldPersistenceTrustedApi(ec);
    await api.deleteByTrade(tradeUuid1);
    await api.deleteByTrade(tradeUuid2);
  });

  afterEach(async () => {
    await api.deleteByTrade(tradeUuid1);
    await api.deleteByTrade(tradeUuid2);
  });

  it('open: puts summary + fact rows; getOpenTradeSummary hydrates segments + units', async () => {
    const segments = [
      makeSegment(tradeUuid1, 1_700_000_000_000, 1_700_086_400_000, 1000, 50),
      makeSegment(tradeUuid1, 1_700_086_400_000, null, 2000, 100),
    ];
    const units = [makeUnit(tradeUuid1)];
    const summary = makeOpenSummary(tradeUuid1, segments, units);
    await api.putOpenTradeSummary(summary, testProvenance);

    const read = await api.getOpenTradeSummary(tradeUuid1);
    expect(read, 'summary should exist').to.exist;
    expect(read!.peakSimultaneousCaR).to.equal(3000);
    expect(read!.totalGain).to.equal(150);
    expect(read!.segments.length).to.equal(2);
    expect(read!.subTradeYieldUnits.length).to.equal(1);
    expect(read!.segments.map(s => s.uuid).sort()).to.deep.equal(segments.map(s => s.uuid).sort());
  });

  it('open: second putOpenTradeSummary replaces prior fact rows (no accumulation)', async () => {
    const v1Segments = [makeSegment(tradeUuid1, 1_700_000_000_000, null, 500, 25)];
    await api.putOpenTradeSummary(makeOpenSummary(tradeUuid1, v1Segments, []), testProvenance);

    const v2Segments = [
      makeSegment(tradeUuid1, 1_700_000_000_000, 1_700_086_400_000, 800, 40),
      makeSegment(tradeUuid1, 1_700_086_400_000, null, 1200, 60),
    ];
    await api.putOpenTradeSummary(makeOpenSummary(tradeUuid1, v2Segments, []), testProvenance);

    const read = await api.getOpenTradeSummary(tradeUuid1);
    expect(read!.segments.length).to.equal(2);
    expect(read!.segments.map(s => s.uuid).sort()).to.deep.equal(v2Segments.map(s => s.uuid).sort());
  });

  it('asOf: puts and reads back independently of open context', async () => {
    const openSegments = [makeSegment(tradeUuid1, 1_700_000_000_000, null, 1000, 50)];
    await api.putOpenTradeSummary(makeOpenSummary(tradeUuid1, openSegments, []), testProvenance);

    const asOfDate = '2026-04-21' as Datestamp;
    const asOfSegments = [makeSegment(tradeUuid1, 1_700_000_000_000, null, 500, 25)];
    const asOfSummary: AsOfTradeYieldSegmentSummary = {
      ...makeOpenSummary(tradeUuid1, asOfSegments, []),
      asOfDate,
      asOfEpoch: new Date(`${asOfDate}T20:00:00Z`).getTime(),
      priceCoverage: 1.0,
    };
    await api.putAsOfTradeSummary(asOfSummary, testProvenance);

    const readAsOf = await api.getAsOfTradeSummary(tradeUuid1, asOfDate);
    expect(readAsOf!.peakSimultaneousCaR).to.equal(500);
    expect(readAsOf!.segments.length).to.equal(1);
    expect(readAsOf!.segments[0]!.uuid).to.equal(asOfSegments[0]!.uuid);

    const readOpen = await api.getOpenTradeSummary(tradeUuid1);
    expect(readOpen!.peakSimultaneousCaR).to.equal(1000);
    expect(readOpen!.segments[0]!.uuid).to.equal(openSegments[0]!.uuid);
  });

  it('since: puts and reads back with anchor-epoch keying', async () => {
    const anchor = 1_700_000_000_000;
    const sinceSegments = [makeSegment(tradeUuid1, anchor, null, 800, 40)];
    const sinceSummary: SinceTradeYieldSegmentSummary = {
      ...makeOpenSummary(tradeUuid1, sinceSegments, []),
      sinceAnchorEpoch: anchor,
      gainSince: 40,
    };
    await api.putSinceTradeSummary(sinceSummary, testProvenance);

    const read = await api.getSinceTradeSummary(tradeUuid1, anchor);
    expect(read!.gainSince).to.equal(40);
    expect(read!.segments[0]!.uuid).to.equal(sinceSegments[0]!.uuid);
  });

  it('deleteByTrade sweeps every context and every table', async () => {
    const segs = [makeSegment(tradeUuid1, 1_700_000_000_000, null, 1000, 50)];
    await api.putOpenTradeSummary(makeOpenSummary(tradeUuid1, segs, [makeUnit(tradeUuid1)]), testProvenance);
    await api.putAsOfTradeSummary({
      ...makeOpenSummary(tradeUuid1, segs, []),
      asOfDate: '2026-04-21' as Datestamp,
      asOfEpoch: 1_700_086_400_000,
      priceCoverage: 1.0,
    }, testProvenance);
    await api.putSinceTradeSummary({
      ...makeOpenSummary(tradeUuid1, segs, []),
      sinceAnchorEpoch: 1_700_000_000_000,
      gainSince: 50,
    }, testProvenance);

    const {deleted, asOfDatesTouched} = await api.deleteByTrade(tradeUuid1);
    expect(deleted).to.be.greaterThan(0);
    expect(asOfDatesTouched, 'asOfDatesTouched should report the date the deleted trade contributed to').to.deep.equal(['2026-04-21']);

    expect(await api.getOpenTradeSummary(tradeUuid1)).to.be.undefined;
    expect(await api.getAsOfTradeSummary(tradeUuid1, '2026-04-21' as Datestamp)).to.be.undefined;
    expect(await api.getSinceTradeSummary(tradeUuid1, 1_700_000_000_000)).to.be.undefined;
    const segRows = await api.getSegmentRowsForTradeAndContext(tradeUuid1, OPEN_CONTEXT);
    expect(segRows.length).to.equal(0);
  });

  it('contexts isolate: deleteFactRowsByTradeAndContext for open does not touch asOf', async () => {
    const segs = [makeSegment(tradeUuid1, 1_700_000_000_000, null, 1000, 50)];
    await api.putOpenTradeSummary(makeOpenSummary(tradeUuid1, segs, []), testProvenance);
    const asOfDate = '2026-04-21' as Datestamp;
    await api.putAsOfTradeSummary({
      ...makeOpenSummary(tradeUuid1, segs, []),
      asOfDate,
      asOfEpoch: 1_700_086_400_000,
      priceCoverage: 1.0,
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

  it('sinceContext epoch padding: lexicographic order matches numeric order', () => {
    expect(sinceContext(1).localeCompare(sinceContext(2))).to.be.lessThan(0);
    expect(sinceContext(999).localeCompare(sinceContext(1000))).to.be.lessThan(0);
    expect(sinceContext(1_700_000_000_000).localeCompare(sinceContext(1_800_000_000_000))).to.be.lessThan(0);
  });
});
