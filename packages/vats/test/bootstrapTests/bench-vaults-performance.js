// @ts-check
/**
 * @file Bootstrap stress test of vaults
 */
import { test as anyTest } from '@agoric/zoe/tools/prepare-test-env-ava.js';
import { PerformanceObserver, performance } from 'node:perf_hooks';
import v8 from 'node:v8';
import process from 'node:process';
import fs from 'node:fs';

import { Fail } from '@agoric/assert';
import { Offers } from '@agoric/inter-protocol/src/clientSupport.js';
import engineGC from '@agoric/swingset-vat/src/lib-nodejs/engine-gc.js';

import { eventLoopIteration } from '@agoric/internal/src/testing-utils.js';
import { makeAgoricNamesRemotesFromFakeStorage } from '../../tools/board-utils.js';
import { makeSwingsetTestKit } from './supports.js';
import { makeWalletFactoryDriver } from './drivers.js';

/**
 * @type {import('ava').TestFn<Awaited<ReturnType<typeof makeDefaultTestContext>>>}
 */
const test = anyTest;

let snapshotNum = 0;
const collectStats = async (step, dumpHeap) => {
  await eventLoopIteration();
  try {
    const t0 = performance.now();
    engineGC();
    const t1 = performance.now();
    const memoryUsage = process.memoryUsage();
    const t2 = performance.now();
    const heapStats = v8.getHeapStatistics();
    const t3 = performance.now();

    const memStats = {
      memoryUsage,
      heapStats,
      statsTime: {
        forcedGcMs: t1 - t0,
        memoryUsageMs: t2 - t1,
        heapStatsMs: t3 - t2,
      },
    };

    if (dumpHeap) {
      console.log(`Snapshotting heap at step ${step}...`);

      // process.pid increments so these will be lexically sorted pathnames.
      const heapSnapshot = `Heap-${process.pid}-${snapshotNum}-${step}.heapsnapshot`;
      snapshotNum += 1;

      v8.writeHeapSnapshot(heapSnapshot);
      const heapSnapshotTime = performance.now() - t3;
      memStats.heapSnapshot = heapSnapshot;
      memStats.statsTime.heapSnapshot = heapSnapshotTime;
    }

    console.log(`Heap details at step ${step} vaults: `, memStats);
    return memStats;
  } catch (err) {
    console.warn('Failed to gather memory stats', err);
    return undefined;
  }
};

// presently all these tests use one collateral manager
const collateralBrandKey = 'ATOM';

const makeDefaultTestContext = async t => {
  console.time('DefaultTestContext');
  const swingsetTestKit = await makeSwingsetTestKit(t);

  const { runUtils, storage } = swingsetTestKit;
  console.timeLog('DefaultTestContext', 'swingsetTestKit');
  const { EV } = runUtils;

  // Wait for ATOM to make it into agoricNames
  await EV.vat('bootstrap').consumeItem('vaultFactoryKit');
  console.timeLog('DefaultTestContext', 'vaultFactoryKit');

  // has to be late enough for agoricNames data to have been published
  const agoricNamesRemotes = makeAgoricNamesRemotesFromFakeStorage(
    swingsetTestKit.storage,
  );
  agoricNamesRemotes.brand.ATOM || Fail`ATOM missing from agoricNames`;
  console.timeLog('DefaultTestContext', 'agoricNamesRemotes');

  const walletFactoryDriver = await makeWalletFactoryDriver(
    runUtils,
    storage,
    agoricNamesRemotes,
  );
  console.timeLog('DefaultTestContext', 'walletFactoryDriver');

  console.timeEnd('DefaultTestContext');

  return { ...swingsetTestKit, agoricNamesRemotes, walletFactoryDriver };
};

test.before(async t => {
  t.context = await makeDefaultTestContext(t);
});
test.after.always(t => t.context.shutdown());

const rows = [];
const perfObserver = new PerformanceObserver(items => {
  items.getEntries().forEach(entry => {
    // @ts-expect-error cast
    const { vaultsOpened, round } = entry.detail;
    rows.push({
      name: `${round}:${vaultsOpened}`,
      durationMs: entry.duration,
      avgPerVaultMs: entry.duration / vaultsOpened,
    });
  });
});
perfObserver.observe({ entryTypes: ['measure'] });

const memStats = [];
const whereUrl = import.meta.url;
const sdkPathStart = whereUrl.lastIndexOf('agoric-sdk/');
const where = sdkPathStart > 0 ? whereUrl.substring(sdkPathStart) : whereUrl;

async function stressVaults(t, dumpHeap) {
  rows.length = 0;
  const dumpTag = dumpHeap ? '-with-dump' : '';
  const name = `stress-vaults${dumpTag}`;

  const reapAll = async vatPos => {
    if (!dumpHeap) return;

    const endPos = await t.context.controller.debug.reapAll(vatPos);
    await t.context.controller.run();
    return endPos;
  };

  const { walletFactoryDriver } = t.context;
  const wds = await Promise.all(
    [...Array(5)].map(async (_, i) =>
      walletFactoryDriver.provideSmartWallet(`agoric1open${i + 1}`),
    ),
  );

  /**
   * @param {number} i
   * @param {number} n
   * @param {number} r
   */
  const openVault = async (i, n, r) => {
    assert.typeof(i, 'number');
    assert.typeof(n, 'number');
    assert.typeof(r, 'number');

    const offerId = `open-vault-${i}-of-${n}-round-${r}${dumpTag}`;
    const wd = wds[r - 1];

    const vatPos = await t.context.controller.debug.getAllVatPos();
    t.context.controller.writeSlogObject({
      type: 'open-vault-start',
      round: r,
      iteration: i,
      iterationLength: n,
      vatPos,
    });

    await wd.executeOfferMaker(Offers.vaults.OpenVault, {
      offerId,
      collateralBrandKey,
      wantMinted: 5,
      giveCollateral: 1.0,
    });

    // t.like(wd.getLatestUpdateRecord(), {
    //   updated: 'offerStatus',
    //   status: { id: offerId, numWantsSatisfied: 1 },
    // });

    const endPos = await reapAll(vatPos).then(
      pos => pos || t.context.controller.debug.getAllVatPos(),
    );

    t.context.controller.writeSlogObject({
      type: 'open-vault-finish',
      round: r,
      iteration: i,
      iterationLength: n,
      endPos,
    });
  };

  /**
   * @param {number} n
   * @param {number} r
   */
  const openN = async (n, r) => {
    t.log(`opening ${n} vaults`);
    const range = [...Array(n)].map((_, i) => i + 1);
    performance.mark(`start-open`);
    for await (const i of range) {
      await openVault(i, n, r);
    }
    performance.mark(`end-open`);
    performance.measure(`open-${n}-round-${r}`, {
      start: 'start-open',
      end: 'end-open',
      detail: { vaultsOpened: n, round: r },
    });
  };

  await t.context.controller.run();
  // clear out for a baseline
  await reapAll();
  const initMemStats = await collectStats('start', dumpHeap);
  for (let i = 1; i <= wds.length; i += 1) {
    // 10 is enough to compare retention in heaps
    await openN(20, i);
    await reapAll();
    memStats.push(await collectStats(`round${i}`, dumpHeap));
  }

  // let perfObserver get the last measurement
  await eventLoopIteration();

  const benchmarkReport = {
    ...rows[1],
    rounds: rows.map((details, i) => ({ ...details, memStats: memStats[i] })),
    initMemStats,
    name,
    test: t.title,
    where,
  };
  fs.writeFileSync(
    `benchmark-${name}.json`,
    JSON.stringify(benchmarkReport, null, 2),
  );

  console.table(rows);
}

// Note: it is probably not useful to enable both of the two following benchmark
// tests at the same time.  Nothing bad per se will happen if you do, but it
// will take longer to run with no particular benefit resulting.  However, if you run
// both you *must* run them serially, so that their executions don't get
// comingled and mess up the numbers.

test.serial('stress vaults with heap snapshots', async t => {
  await stressVaults(t, true);
});

test.skip('stress vaults', async t => {
  await stressVaults(t, false);
});