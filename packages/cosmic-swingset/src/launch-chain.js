// @ts-check
/* global process */

// XXX the JSON configs specify that launching the chain requires @agoric/builders,
// so let the JS tooling know about it by importing it here.
import '@agoric/builders';

import anylogger from 'anylogger';

import { assert, Fail } from '@endo/errors';
import { E } from '@endo/far';
import bundleSource from '@endo/bundle-source';

import {
  buildMailbox,
  buildMailboxStateMap,
  buildTimer,
  buildBridge,
  swingsetIsInitialized,
  initializeSwingset,
  makeSwingsetController,
  loadBasedir,
  loadSwingsetConfigFile,
} from '@agoric/swingset-vat';
import { waitUntilQuiescent } from '@agoric/internal/src/lib-nodejs/waitUntilQuiescent.js';
import { openSwingStore } from '@agoric/swing-store';
import { BridgeId as BRIDGE_ID } from '@agoric/internal';
import { makeWithQueue } from '@agoric/internal/src/queue.js';
import * as ActionType from '@agoric/internal/src/action-types.js';

import {
  extractCoreProposalBundles,
  mergeCoreProposals,
} from '@agoric/deploy-script-support/src/extract-proposal.js';
import { fileURLToPath } from 'url';

import {
  makeDefaultMeterProvider,
  makeInboundQueueMetrics,
  exportKernelStats,
  makeSlogCallbacks,
} from './kernel-stats.js';

import {
  BeansPerBlockComputeLimit,
  BeansPerVatCreation,
  BeansPerXsnapComputron,
} from './sim-params.js';
import { parseParams } from './params.js';
import { makeQueue, makeQueueStorageMock } from './helpers/make-queue.js';
import { exportStorage } from './export-storage.js';
import { parseLocatedJson } from './helpers/json.js';

/** @import {RunPolicy} from '@agoric/swingset-vat' */

const console = anylogger('launch-chain');
const blockManagerConsole = anylogger('block-manager');

/**
 * @param {{ info: string } | null | undefined} upgradePlan
 * @param {string} prefix
 */
const parseUpgradePlanInfo = (upgradePlan, prefix = '') => {
  const { info: upgradeInfoJson = null } = upgradePlan || {};

  const upgradePlanInfo =
    upgradeInfoJson &&
    parseLocatedJson(
      upgradeInfoJson,
      `${prefix && `${prefix} `}upgradePlan.info`,
    );

  return harden(upgradePlanInfo || {});
};

/** @import {SwingSetConfig} from '@agoric/swingset-vat' */

/**
 * @typedef {object} CosmicSwingsetConfig
 * @property {import('@agoric/deploy-script-support/src/extract-proposal.js').ConfigProposal[]} [coreProposals]
 * @property {string[]} [clearStorageSubtrees] chain storage paths identifying
 *   roots of subtrees for which data should be deleted (including overlaps with
 *   exportStorageSubtrees, which are *not* preserved).
 * @property {string[]} [exportStorageSubtrees] chain storage paths identifying roots of subtrees
 *   for which data should be exported into bootstrap vat parameter `chainStorageEntries`
 *   (e.g., `exportStorageSubtrees: ['c.o']` might result in vatParameters including
 *   `chainStorageEntries: [ ['c.o', '"top"'], ['c.o.i'], ['c.o.i.n', '42'], ['c.o.w', '"moo"'] ]`).
 */

/**
 * Return the key in the reserved "host.*" section of the swing-store
 *
 * @param {string} path
 */
const getHostKey = path => `host.${path}`;

/**
 * @param {Map<*, *>} mailboxStorage
 * @param {undefined | ((dstID: string, obj: any) => any)} bridgeOutbound
 * @param {SwingStoreKernelStorage} kernelStorage
 * @param {string | (() => string | Promise<string>)} vatconfig absolute path or thunk
 * @param {unknown} bootstrapArgs JSON-serializable data
 * @param {{}} env
 * @param {*} options
 */
export async function buildSwingset(
  mailboxStorage,
  bridgeOutbound,
  kernelStorage,
  vatconfig,
  bootstrapArgs,
  env,
  {
    callerWillEvaluateCoreProposals = !!bridgeOutbound,
    debugName = undefined,
    slogCallbacks,
    slogSender,
    verbose,
    profileVats,
    debugVats,
  },
) {
  const debugPrefix = debugName === undefined ? '' : `${debugName}:`;
  const mbs = buildMailboxStateMap(mailboxStorage);

  const bridgeDevice = bridgeOutbound && buildBridge(bridgeOutbound);
  const mailboxDevice = buildMailbox(mbs);
  const timerDevice = buildTimer();

  const deviceEndowments = {
    mailbox: { ...mailboxDevice.endowments },
    timer: { ...timerDevice.endowments },
  };
  if (bridgeDevice) {
    deviceEndowments.bridge = { ...bridgeDevice.endowments };
  }

  async function ensureSwingsetInitialized() {
    if (swingsetIsInitialized(kernelStorage)) {
      return;
    }

    const configLocation = await (typeof vatconfig === 'function'
      ? vatconfig()
      : vatconfig);
    let config = await loadSwingsetConfigFile(configLocation);
    if (config === null) {
      config = loadBasedir(configLocation);
    }

    config.devices = {
      mailbox: {
        sourceSpec: mailboxDevice.srcPath,
      },
      timer: {
        sourceSpec: timerDevice.srcPath,
      },
    };

    if (bridgeDevice) {
      config.devices.bridge = {
        sourceSpec: bridgeDevice.srcPath,
      };
    }

    const {
      coreProposals,
      clearStorageSubtrees,
      exportStorageSubtrees = [],
      ...swingsetConfig
    } = /** @type {SwingSetConfig & CosmicSwingsetConfig} */ (config);

    // XXX `initializeSwingset` does not have a default for the `bootstrap` property;
    // should we universally ensure its presence above?
    const bootVat =
      swingsetConfig.vats[swingsetConfig.bootstrap || 'bootstrap'];

    if (bridgeOutbound) {
      const batchChainStorage = (method, args) =>
        bridgeOutbound(BRIDGE_ID.STORAGE, { method, args });

      // Extract data from chain storage as [path, value?] pairs.
      const chainStorageEntries = exportStorage(
        batchChainStorage,
        exportStorageSubtrees,
        clearStorageSubtrees,
      );
      bootVat.parameters = { ...bootVat.parameters, chainStorageEntries };
    }

    // Since only on-chain swingsets like `agd` have a bridge (and thereby
    // `CORE_EVAL` support), things like `ag-solo` will need to do the
    // coreProposals in the bootstrap vat.
    let bridgedCoreProposals;
    if (callerWillEvaluateCoreProposals) {
      // We have a bridge to run the coreProposals, so do it in the caller.
      bridgedCoreProposals = coreProposals;
    } else if (coreProposals) {
      // We don't have a bridge to run the coreProposals, so do it in the bootVat.
      const { bundles, codeSteps } = await extractCoreProposalBundles(
        coreProposals,
        configLocation, // for path resolution
      );
      swingsetConfig.bundles = { ...swingsetConfig.bundles, ...bundles };
      bootVat.parameters = {
        ...bootVat.parameters,
        coreProposalCodeSteps: codeSteps,
      };
    }

    swingsetConfig.pinBootstrapRoot = true;
    await initializeSwingset(swingsetConfig, bootstrapArgs, kernelStorage, {
      // @ts-expect-error debugPrefix? what's that?
      debugPrefix,
    });
    // Let our caller schedule our core proposals.
    return bridgedCoreProposals;
  }

  const coreProposals = await ensureSwingsetInitialized();
  const controller = await makeSwingsetController(
    kernelStorage,
    deviceEndowments,
    {
      env,
      slogCallbacks,
      slogSender,
      verbose,
      profileVats,
      debugVats,
    },
  );

  // We DON'T want to run the kernel yet, only when the application decides
  // (either on bootstrap block (0) or in endBlock).

  return {
    coreProposals,
    controller,
    mb: mailboxDevice,
    bridgeInbound: bridgeDevice && bridgeDevice.deliverInbound,
    timer: timerDevice,
  };
}

/**
 * @typedef {RunPolicy & {
 *   shouldRun(): boolean;
 *   remainingBeans(): bigint | undefined;
 *   totalBeans(): bigint;
 * }} ChainRunPolicy
 */

/**
 * @typedef {object} BeansPerUnit
 * @property {bigint} blockComputeLimit
 * @property {bigint} vatCreation
 * @property {bigint} xsnapComputron
 */

/**
 * @param {BeansPerUnit} beansPerUnit
 * @param {boolean} [ignoreBlockLimit]
 * @returns {ChainRunPolicy}
 */
function computronCounter(
  {
    [BeansPerBlockComputeLimit]: blockComputeLimit,
    [BeansPerVatCreation]: vatCreation,
    [BeansPerXsnapComputron]: xsnapComputron,
  },
  ignoreBlockLimit = false,
) {
  assert.typeof(blockComputeLimit, 'bigint');
  assert.typeof(vatCreation, 'bigint');
  assert.typeof(xsnapComputron, 'bigint');
  let totalBeans = 0n;
  const shouldRun = () => ignoreBlockLimit || totalBeans < blockComputeLimit;
  const remainingBeans = () =>
    ignoreBlockLimit ? undefined : blockComputeLimit - totalBeans;

  const policy = harden({
    vatCreated() {
      totalBeans += vatCreation;
      return shouldRun();
    },
    crankComplete(details = {}) {
      assert.typeof(details, 'object');
      if (details.computrons) {
        assert.typeof(details.computrons, 'bigint');

        // TODO: xsnapComputron should not be assumed here.
        // Instead, SwingSet should describe the computron model it uses.
        totalBeans += details.computrons * xsnapComputron;
      }
      return shouldRun();
    },
    crankFailed() {
      const failedComputrons = 1000000n; // who knows, 1M is as good as anything
      totalBeans += failedComputrons * xsnapComputron;
      return shouldRun();
    },
    emptyCrank() {
      return shouldRun();
    },
    shouldRun,
    remainingBeans,
    totalBeans() {
      return totalBeans;
    },
  });
  return policy;
}

export async function launch({
  actionQueueStorage,
  highPriorityQueueStorage,
  kernelStateDBDir,
  mailboxStorage,
  clearChainSends,
  replayChainSends,
  bridgeOutbound,
  makeInstallationPublisher,
  vatconfig,
  argv,
  env = process.env,
  debugName = undefined,
  verboseBlocks = false,
  metricsProvider = makeDefaultMeterProvider(),
  slogSender,
  swingStoreTraceFile,
  swingStoreExportCallback,
  keepSnapshots,
  afterCommitCallback = async () => ({}),
}) {
  console.info('Launching SwingSet kernel');

  // The swingStore's exportCallback is synchronous, however we allow the
  // callback provided to launch-chain to be asynchronous. The callbacks are
  // invoked sequentially like if they were awaited, and the block manager
  // synchronizes before finishing END_BLOCK
  let pendingSwingStoreExport = Promise.resolve();
  const swingStoreExportCallbackWithQueue =
    swingStoreExportCallback && makeWithQueue()(swingStoreExportCallback);
  const swingStoreExportSyncCallback =
    swingStoreExportCallback &&
    (updates => {
      pendingSwingStoreExport = swingStoreExportCallbackWithQueue(updates);
    });

  const { kernelStorage, hostStorage } = openSwingStore(kernelStateDBDir, {
    traceFile: swingStoreTraceFile,
    exportCallback: swingStoreExportSyncCallback,
    keepSnapshots,
  });
  const { kvStore, commit } = hostStorage;

  /** @typedef {ReturnType<typeof makeQueue<{context: any, action: any}>>} InboundQueue */
  /** @type {InboundQueue} */
  const actionQueue = makeQueue(actionQueueStorage);
  /** @type {InboundQueue} */
  const highPriorityQueue = makeQueue(highPriorityQueueStorage);
  /**
   * In memory queue holding actions that must be consumed entirely
   * during the block. If it's not drained, we open the gates to
   * hangover hell.
   *
   * @type {InboundQueue}
   */
  const runThisBlock = makeQueue(makeQueueStorageMock().storage);

  // Not to be confused with the gas model, this meter is for OpenTelemetry.
  const metricMeter = metricsProvider.getMeter('ag-chain-cosmos');
  const slogCallbacks = makeSlogCallbacks({
    metricMeter,
  });

  console.debug(`buildSwingset`);
  const {
    coreProposals: bootstrapCoreProposals,
    controller,
    mb,
    bridgeInbound,
    timer,
  } = await buildSwingset(
    mailboxStorage,
    bridgeOutbound,
    kernelStorage,
    vatconfig,
    argv,
    env,
    {
      debugName,
      slogCallbacks,
      slogSender,
    },
  );

  /** @type {{publish: (value: unknown) => Promise<void>} | undefined} */
  let installationPublisher;

  // Artificially create load if set.
  const END_BLOCK_SPIN_MS = env.END_BLOCK_SPIN_MS
    ? parseInt(env.END_BLOCK_SPIN_MS, 10)
    : 0;

  const inboundQueueMetrics = makeInboundQueueMetrics(
    actionQueue.size() + highPriorityQueue.size(),
  );
  const { crankScheduler } = exportKernelStats({
    controller,
    metricMeter,
    // @ts-expect-error Type 'Logger<BaseLevels>' is not assignable to type 'Console'.
    log: console,
    inboundQueueMetrics,
  });

  /**
   * @param {number} blockHeight
   * @param {ChainRunPolicy} runPolicy
   */
  function makeRunSwingset(blockHeight, runPolicy) {
    let runNum = 0;
    async function runSwingset() {
      const startBeans = runPolicy.totalBeans();
      controller.writeSlogObject({
        type: 'cosmic-swingset-run-start',
        blockHeight,
        runNum,
        startBeans,
        remainingBeans: runPolicy.remainingBeans(),
      });
      // TODO: crankScheduler does a schedulerBlockTimeHistogram thing
      // that needs to be revisited, it used to be called once per
      // block, now it's once per processed inbound queue item
      await crankScheduler(runPolicy);
      const finishBeans = runPolicy.totalBeans();
      controller.writeSlogObject({
        type: 'kernel-stats',
        stats: controller.getStats(),
      });
      controller.writeSlogObject({
        type: 'cosmic-swingset-run-finish',
        blockHeight,
        runNum,
        startBeans,
        finishBeans,
        usedBeans: finishBeans - startBeans,
        remainingBeans: runPolicy.remainingBeans(),
      });
      runNum += 1;
      return runPolicy.shouldRun();
    }
    return runSwingset;
  }

  async function bootstrapBlock(blockHeight, blockTime, params) {
    // We need to let bootstrap know of the chain time. The time of the first
    // block may be the genesis time, or the block time of the upgrade block.
    timer.poll(blockTime);
    // This is before the initial block, we need to finish processing the
    // entire bootstrap before opening for business.
    const runPolicy = computronCounter(params.beansPerUnit, true);
    const runSwingset = makeRunSwingset(blockHeight, runPolicy);

    await runSwingset();
  }

  async function saveChainState() {
    // Save the mailbox state.
    await mailboxStorage.commit();
  }

  async function saveOutsideState(blockHeight) {
    const chainSends = await clearChainSends();
    kvStore.set(getHostKey('height'), `${blockHeight}`);
    kvStore.set(getHostKey('chainSends'), JSON.stringify(chainSends));

    await commit();
  }

  async function deliverInbound(sender, messages, ack, inboundNum) {
    Array.isArray(messages) || Fail`inbound given non-Array: ${messages}`;
    controller.writeSlogObject({
      type: 'cosmic-swingset-deliver-inbound',
      inboundNum,
      sender,
      count: messages.length,
    });
    if (!mb.deliverInbound(sender, messages, ack)) {
      return;
    }
    console.debug(`mboxDeliver:   ADDED messages`);
  }

  async function doBridgeInbound(source, body, inboundNum) {
    controller.writeSlogObject({
      type: 'cosmic-swingset-bridge-inbound',
      inboundNum,
      source,
    });
    if (!bridgeInbound) throw Fail`bridgeInbound undefined`;
    // console.log(`doBridgeInbound`);
    // the inbound bridge will push messages onto the kernel run-queue for
    // delivery+dispatch to some handler vat
    bridgeInbound(source, body);
  }

  async function installBundle(bundleJson) {
    let bundle;
    try {
      bundle = JSON.parse(bundleJson);
    } catch (e) {
      blockManagerConsole.warn('INSTALL_BUNDLE warn:', e);
      return;
    }
    harden(bundle);

    const error = await controller.validateAndInstallBundle(bundle).then(
      () => null,
      (/** @type {unknown} */ errorValue) => errorValue,
    );

    const { endoZipBase64Sha512 } = bundle;

    if (installationPublisher === undefined) {
      return;
    }

    await installationPublisher.publish(
      harden({
        endoZipBase64Sha512,
        installed: error === null,
        error,
      }),
    );
  }

  function provideInstallationPublisher() {
    if (
      installationPublisher === undefined &&
      makeInstallationPublisher !== undefined
    ) {
      installationPublisher = makeInstallationPublisher();
    }
  }

  let savedHeight = Number(kvStore.get(getHostKey('height')) || 0);
  let savedBeginHeight = Number(
    kvStore.get(getHostKey('beginHeight')) || savedHeight,
  );
  let runTime = 0;
  let chainTime;
  let saveTime = 0;
  let endBlockFinish = 0;
  let blockParams;
  let decohered;
  let afterCommitWorkDone = Promise.resolve();

  async function performAction(action, inboundNum) {
    // blockManagerConsole.error('Performing action', action);
    let p;
    switch (action.type) {
      case ActionType.DELIVER_INBOUND: {
        p = deliverInbound(
          action.peer,
          action.messages,
          action.ack,
          inboundNum,
        );
        break;
      }

      case ActionType.VBANK_BALANCE_UPDATE: {
        p = doBridgeInbound(BRIDGE_ID.BANK, action, inboundNum);
        break;
      }

      case ActionType.IBC_EVENT: {
        p = doBridgeInbound(BRIDGE_ID.DIBC, action, inboundNum);
        break;
      }

      case ActionType.VTRANSFER_IBC_EVENT: {
        p = doBridgeInbound(BRIDGE_ID.VTRANSFER, action, inboundNum);
        break;
      }

      case ActionType.PLEASE_PROVISION: {
        p = doBridgeInbound(BRIDGE_ID.PROVISION, action, inboundNum);
        break;
      }

      case ActionType.INSTALL_BUNDLE: {
        p = installBundle(action.bundle);
        break;
      }

      case ActionType.CORE_EVAL: {
        p = doBridgeInbound(BRIDGE_ID.CORE, action, inboundNum);
        break;
      }

      case ActionType.WALLET_ACTION: {
        p = doBridgeInbound(BRIDGE_ID.WALLET, action, inboundNum);
        break;
      }

      case ActionType.WALLET_SPEND_ACTION: {
        p = doBridgeInbound(BRIDGE_ID.WALLET, action, inboundNum);
        break;
      }

      default: {
        Fail`${action.type} not recognized`;
      }
    }
    return p;
  }

  /**
   * Process as much as we can from an inbound queue, which contains
   * first the old actions not previously processed, followed by actions
   * newly added, running the kernel to completion after each.
   *
   * @param {InboundQueue} inboundQueue
   * @param {ReturnType<typeof makeRunSwingset>} runSwingset
   */
  async function processActions(inboundQueue, runSwingset) {
    let keepGoing = true;
    for await (const { action, context } of inboundQueue.consumeAll()) {
      const inboundNum = `${context.blockHeight}-${context.txHash}-${context.msgIdx}`;
      inboundQueueMetrics.decStat();
      await performAction(action, inboundNum);
      keepGoing = await runSwingset();
      if (!keepGoing) {
        // any leftover actions will remain on the inbound queue for possible
        // processing in the next block
        break;
      }
    }
    return keepGoing;
  }

  async function runKernel(runSwingset, blockHeight, blockTime) {
    // First, complete leftover work, if any
    let keepGoing = await runSwingset();
    if (!keepGoing) return;

    // Then, if we have anything in the special runThisBlock queue, process
    // it and do no further work.
    if (runThisBlock.size()) {
      await processActions(runThisBlock, runSwingset);
      return;
    }

    // Then, process as much as we can from the priorityQueue.
    keepGoing = await processActions(highPriorityQueue, runSwingset);
    if (!keepGoing) return;

    // Then, update the timer device with the new external time, which might
    // push work onto the kernel run-queue (if any timers were ready to wake).
    const addedToQueue = timer.poll(blockTime);
    console.debug(
      `polled; blockTime:${blockTime}, h:${blockHeight}; ADDED =`,
      addedToQueue,
    );
    // We must run the kernel even if nothing was added since the kernel
    // only notes state exports and updates consistency hashes when attempting
    // to perform a crank.
    keepGoing = await runSwingset();
    if (!keepGoing) return;

    // Finally, process as much as we can from the actionQueue.
    await processActions(actionQueue, runSwingset);
  }

  async function endBlock(blockHeight, blockTime, params) {
    // This is called once per block, during the END_BLOCK event, and
    // only when we know that cosmos is in sync (else we'd skip kernel
    // execution).

    // First, record new actions (bridge/mailbox/etc events that cosmos
    // added up for delivery to swingset) into our inboundQueue metrics
    inboundQueueMetrics.updateLength(
      actionQueue.size() + highPriorityQueue.size() + runThisBlock.size(),
    );

    // If we have work to complete this block, it needs to run to completion.
    // It will also run to completion any work that swingset still had pending.
    const neverStop = runThisBlock.size() > 0;

    // make a runPolicy that will be shared across all cycles
    const runPolicy = computronCounter(params.beansPerUnit, neverStop);
    const runSwingset = makeRunSwingset(blockHeight, runPolicy);

    await runKernel(runSwingset, blockHeight, blockTime);

    if (END_BLOCK_SPIN_MS) {
      // Introduce a busy-wait to artificially put load on the chain.
      const startTime = Date.now();
      while (Date.now() - startTime < END_BLOCK_SPIN_MS);
    }
  }

  /**
   * @template T
   * @param {string} type
   * @param {() => Promise<T>} fn
   */
  async function processAction(type, fn) {
    const start = Date.now();
    const finish = res => {
      // blockManagerConsole.error(
      //   'Action',
      //   action.type,
      //   action.blockHeight,
      //   'is done!',
      // );
      runTime += Date.now() - start;
      return res;
    };

    const p = fn();
    // Just attach some callbacks, but don't use the resulting neutered result
    // promise.
    void E.when(p, finish, e => {
      // None of these must fail, and if they do, log them verbosely before
      // returning to the chain.
      blockManagerConsole.error(type, 'error:', e);
      finish();
    });
    // Return the original promise so that the caller gets the original
    // resolution or rejection.
    return p;
  }

  function blockNeedsExecution(blockHeight) {
    if (savedHeight === 0) {
      // 0 is the default we use when the DB is empty, so we've only executed
      // the bootstrap block but no others. The first non-bootstrap block can
      // have an arbitrary height (the chain may not start at 1), but since the
      // bootstrap block doesn't commit (and doesn't have a begin/end) there is
      // no risk of hangover inconsistency for the first block, and it can
      // always be executed.
      return true;
    }

    if (blockHeight === savedHeight + 1) {
      // execute the next block
      return true;
    }

    if (blockHeight === savedHeight) {
      // we have already committed this block, so "replay" by not executing
      // (but returning all the results from the last time)
      return false;
    }

    // we're being asked to rewind by more than one block, or execute something
    // more than one block in the future, neither of which we can accommodate.
    // Keep throwing forever.
    decohered = Error(
      // TODO unimplemented
      `Unimplemented reset state from ${savedHeight} to ${blockHeight}`,
    );
    throw decohered;
  }

  function saveBeginHeight(blockHeight) {
    savedBeginHeight = blockHeight;
    kvStore.set(getHostKey('beginHeight'), `${savedBeginHeight}`);
  }

  async function afterCommit(blockHeight, blockTime) {
    await waitUntilQuiescent()
      .then(afterCommitCallback)
      .then((afterCommitStats = {}) => {
        controller.writeSlogObject({
          type: 'cosmic-swingset-after-commit-stats',
          blockHeight,
          blockTime,
          ...afterCommitStats,
        });
      });
  }

  const doBootstrap = async action => {
    const { blockTime, blockHeight, params } = action;
    controller.writeSlogObject({
      type: 'cosmic-swingset-bootstrap-block-start',
      blockTime,
    });

    await null;
    try {
      verboseBlocks && blockManagerConsole.info('block bootstrap');
      (savedHeight === 0 && savedBeginHeight === 0) ||
        Fail`Cannot run a bootstrap block at height ${savedHeight}`;
      const bootstrapBlockParams = parseParams(params);

      // Start a block transaction, but without changing state
      // for the upcoming begin block check
      saveBeginHeight(savedBeginHeight);
      await processAction(action.type, async () =>
        bootstrapBlock(blockHeight, blockTime, bootstrapBlockParams),
      );
    } finally {
      controller.writeSlogObject({
        type: 'cosmic-swingset-bootstrap-block-finish',
        blockTime,
      });
    }
  };

  const doCoreProposals = async ({ blockHeight, blockTime }, coreProposals) => {
    controller.writeSlogObject({
      type: 'cosmic-swingset-upgrade-start',
      blockHeight,
      blockTime,
      coreProposals,
    });

    await null;
    try {
      // Start a block transaction, but without changing state
      // for the upcoming begin block check
      saveBeginHeight(savedBeginHeight);

      // Find scripts relative to our location.
      const myFilename = fileURLToPath(import.meta.url);
      const { bundles, codeSteps: coreEvalCodeSteps } =
        await extractCoreProposalBundles(coreProposals, myFilename, {
          handleToBundleSpec: async (handle, source, _sequence, _piece) => {
            const bundle = await bundleSource(source);
            const { endoZipBase64Sha512: hash } = bundle;
            const bundleID = `b1-${hash}`;
            handle.bundleID = bundleID;
            harden(handle);
            return harden([`${bundleID}: ${source}`, bundle]);
          },
        });

      for (const [meta, bundle] of Object.entries(bundles)) {
        await controller
          .validateAndInstallBundle(bundle)
          .catch(e => Fail`Cannot validate and install ${meta}: ${e}`);
      }

      // Now queue each step's code for evaluation.
      for (const [key, coreEvalCode] of Object.entries(coreEvalCodeSteps)) {
        const coreEvalAction = {
          type: ActionType.CORE_EVAL,
          blockHeight,
          blockTime,
          evals: [
            {
              json_permits: 'true',
              js_code: coreEvalCode,
            },
          ],
        };
        runThisBlock.push({
          context: {
            blockHeight,
            txHash: 'x/upgrade',
            msgIdx: key,
          },
          action: coreEvalAction,
        });
      }
    } finally {
      controller.writeSlogObject({
        type: 'cosmic-swingset-upgrade-finish',
        blockHeight,
        blockTime,
      });
    }
  };

  // Handle block related actions
  // Some actions that are integration specific may be handled by the caller
  // For example SWING_STORE_EXPORT is handled in chain-main.js
  async function doBlockingSend(action) {
    await null;
    // blockManagerConsole.warn(
    //   'FIGME: blockHeight',
    //   action.blockHeight,
    //   'received',
    //   action.type,
    // );
    switch (action.type) {
      case ActionType.AG_COSMOS_INIT: {
        const { blockHeight, isBootstrap, upgradeDetails } = action;

        if (!blockNeedsExecution(blockHeight)) {
          return true;
        }

        const softwareUpgradeCoreProposals = upgradeDetails?.coreProposals;

        const { coreProposals: upgradeInfoCoreProposals } =
          parseUpgradePlanInfo(upgradeDetails?.plan, ActionType.AG_COSMOS_INIT);

        if (isBootstrap) {
          // This only runs for the very first block on the chain.
          await doBootstrap(action);
        }

        // Merge the core proposals from the bootstrap block with the
        // ones from the upgrade.
        const coreProposals = mergeCoreProposals(
          bootstrapCoreProposals,
          softwareUpgradeCoreProposals,
          upgradeInfoCoreProposals,
        );

        if (coreProposals.steps.length) {
          upgradeDetails ||
            isBootstrap ||
            Fail`Unexpected core proposals outside of consensus start`;
          await doCoreProposals(action, coreProposals);
        }
        return true;
      }

      case ActionType.COMMIT_BLOCK: {
        const { blockHeight, blockTime } = action;
        verboseBlocks &&
          blockManagerConsole.info('block', blockHeight, 'commit');
        if (blockHeight !== savedHeight) {
          throw Error(
            `Committed height ${blockHeight} does not match saved height ${savedHeight}`,
          );
        }

        runThisBlock.size() === 0 ||
          Fail`We didn't process all "run this block" actions`;

        controller.writeSlogObject({
          type: 'cosmic-swingset-commit-block-start',
          blockHeight,
          blockTime,
        });

        // Save the kernel's computed state just before the chain commits.
        const start2 = Date.now();
        await saveOutsideState(savedHeight);
        saveTime = Date.now() - start2;

        blockParams = undefined;

        blockManagerConsole.debug(
          `wrote SwingSet checkpoint [run=${runTime}ms, chainSave=${chainTime}ms, kernelSave=${saveTime}ms]`,
        );

        return undefined;
      }

      case ActionType.AFTER_COMMIT_BLOCK: {
        const { blockHeight, blockTime } = action;

        const fullSaveTime = Date.now() - endBlockFinish;

        controller.writeSlogObject({
          type: 'cosmic-swingset-commit-block-finish',
          blockHeight,
          blockTime,
          saveTime: saveTime / 1000,
          chainTime: chainTime / 1000,
          fullSaveTime: fullSaveTime / 1000,
        });

        afterCommitWorkDone = afterCommit(blockHeight, blockTime);

        return undefined;
      }

      case ActionType.BEGIN_BLOCK: {
        const { blockHeight, blockTime, params } = action;
        blockParams = parseParams(params);
        verboseBlocks &&
          blockManagerConsole.info('block', blockHeight, 'begin');
        runTime = 0;

        if (blockNeedsExecution(blockHeight)) {
          if (savedBeginHeight === blockHeight) {
            decohered = Error(
              `Inconsistent committed state. Block ${blockHeight} had already began execution`,
            );
            throw decohered;
          }
          // Start a block transaction, recording which block height is executed
          saveBeginHeight(blockHeight);
        }

        controller.writeSlogObject({
          type: 'cosmic-swingset-begin-block',
          blockHeight,
          blockTime,
          inboundQueueStats: inboundQueueMetrics.getStats(),
        });

        return undefined;
      }

      case ActionType.END_BLOCK: {
        const { blockHeight, blockTime } = action;
        controller.writeSlogObject({
          type: 'cosmic-swingset-end-block-start',
          blockHeight,
          blockTime,
        });

        blockParams || Fail`blockParams missing`;

        if (!blockNeedsExecution(blockHeight)) {
          // We are reevaluating, so do not do any work, and send exactly the
          // same downcalls to the chain.
          //
          // This is necessary only after a restart when Tendermint is reevaluating the
          // block that was interrupted and not committed.
          //
          // We assert that the return values are identical, which allows us to silently
          // clear the queue.
          try {
            replayChainSends();
          } catch (e) {
            // Very bad!
            decohered = e;
            throw e;
          }
        } else {
          if (blockHeight !== savedBeginHeight) {
            decohered = Error(
              `Inconsistent committed state. Trying to end block ${blockHeight}, expected began block ${savedBeginHeight}`,
            );
            throw decohered;
          }

          // And now we actually process the queued actions down here, during
          // END_BLOCK, but still reentrancy-protected.

          provideInstallationPublisher();

          await processAction(action.type, async () =>
            endBlock(blockHeight, blockTime, blockParams),
          );

          // We write out our on-chain state as a number of chainSends.
          const start = Date.now();
          await saveChainState();
          chainTime = Date.now() - start;

          // Advance our saved state variables.
          savedHeight = blockHeight;
        }
        controller.writeSlogObject({
          type: 'cosmic-swingset-end-block-finish',
          blockHeight,
          blockTime,
          inboundQueueStats: inboundQueueMetrics.getStats(),
        });

        endBlockFinish = Date.now();

        return undefined;
      }

      default: {
        throw Fail`Unrecognized action ${action}; are you sure you didn't mean to queue it?`;
      }
    }
  }
  async function blockingSend(action) {
    if (decohered) {
      throw decohered;
    }

    await afterCommitWorkDone;

    return doBlockingSend(action).finally(() => pendingSwingStoreExport);
  }

  async function shutdown() {
    return controller.shutdown();
  }

  function writeSlogObject(obj) {
    controller.writeSlogObject(obj);
  }

  console.info('Launched SwingSet kernel');

  return {
    blockingSend,
    shutdown,
    writeSlogObject,
    savedHeight,
    savedChainSends: JSON.parse(kvStore.get(getHostKey('chainSends')) || '[]'),
  };
}
