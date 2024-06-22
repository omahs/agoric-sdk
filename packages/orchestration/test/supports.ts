import { makeIssuerKit } from '@agoric/ertp';
import { VTRANSFER_IBC_EVENT } from '@agoric/internal';
import { makeFakeStorageKit } from '@agoric/internal/src/storage-test-utils.js';
import { prepareLocalChainTools } from '@agoric/vats/src/localchain.js';
import { prepareBridgeTargetModule } from '@agoric/vats/src/bridge-target.js';
import { prepareTransferTools } from '@agoric/vats/src/transfer.js';
import { makeFakeBankManagerKit } from '@agoric/vats/tools/bank-utils.js';
import { makeFakeBoard } from '@agoric/vats/tools/board-utils.js';
import {
  makeFakeLocalchainBridge,
  makeFakeTransferBridge,
} from '@agoric/vats/tools/fake-bridge.js';
import { prepareVowTools } from '@agoric/vow';
import type { Installation } from '@agoric/zoe/src/zoeService/utils.js';
import { buildZoeManualTimer } from '@agoric/zoe/tools/manualTimer.js';
import { withAmountUtils } from '@agoric/zoe/tools/test-utils.js';
import { makeHeapZone } from '@agoric/zone';
import { E } from '@endo/far';
import { makeNameHubKit } from '@agoric/vats';
import { makeWellKnownSpaces } from '@agoric/vats/src/core/utils.js';
import { fakeNetworkEchoStuff } from './network-fakes.js';
import { prepareOrchestrationTools } from '../src/service.js';
import { registerChainNamespace } from '../src/chain-info.js';

export {
  makeFakeLocalchainBridge,
  makeFakeTransferBridge,
} from '@agoric/vats/tools/fake-bridge.js';

export const commonSetup = async t => {
  t.log('bootstrap vat dependencies');
  // The common setup cannot support a durable zone because many of the fakes are not durable.
  // They were made before we had durable kinds (and thus don't take a zone or baggage).
  // To test durability in unit tests, test a particular entity with `relaxDurabilityRules: false`.
  // To test durability integrating multiple vats, use a RunUtils/bootstrap test.
  const rootZone = makeHeapZone();

  const { nameHub: agoricNames, nameAdmin: agoricNamesAdmin } =
    makeNameHubKit();

  const bld = withAmountUtils(makeIssuerKit('BLD'));
  const ist = withAmountUtils(makeIssuerKit('IST'));
  const { bankManager, pourPayment } = await makeFakeBankManagerKit();
  await E(bankManager).addAsset('ubld', 'BLD', 'Staking Token', bld.issuerKit);
  await E(bankManager).addAsset(
    'uist',
    'IST',
    'Inter Stable Token',
    ist.issuerKit,
  );
  // These mints no longer stay in sync with bankManager.
  // Use pourPayment() for IST.
  const { mint: _b, ...bldSansMint } = bld;
  const { mint: _i, ...istSansMint } = ist;
  // XXX real bankManager does this. fake should too?
  await makeWellKnownSpaces(agoricNamesAdmin, t.log, ['vbankAsset']);
  await E(E(agoricNamesAdmin).lookupAdmin('vbankAsset')).update(
    'uist',
    /** @type {AssetInfo} */ harden({
      brand: ist.brand,
      issuer: ist.issuer,
      issuerName: 'IST',
      denom: 'uist',
      proposedName: 'IST',
      displayInfo: { IOU: true },
    }),
  );

  const vowTools = prepareVowTools(rootZone.subZone('vows'));

  const transferBridge = makeFakeTransferBridge(rootZone);
  const { makeBridgeTargetKit } = prepareBridgeTargetModule(
    rootZone.subZone('bridge'),
  );
  const { makeTransferMiddlewareKit } = prepareTransferTools(
    rootZone.subZone('transfer'),
    vowTools,
  );

  const { finisher, interceptorFactory, transferMiddleware } =
    makeTransferMiddlewareKit();
  const bridgeTargetKit = makeBridgeTargetKit(
    transferBridge,
    VTRANSFER_IBC_EVENT,
    interceptorFactory,
  );
  finisher.useRegistry(bridgeTargetKit.targetRegistry);

  const localBrigeMessages = [] as any[];
  const localchainBridge = makeFakeLocalchainBridge(rootZone, obj =>
    localBrigeMessages.push(obj),
  );
  const localchain = prepareLocalChainTools(
    rootZone.subZone('localchain'),
    vowTools,
  ).makeLocalChain({
    bankManager,
    system: localchainBridge,
    transfer: transferMiddleware,
  });
  const timer = buildZoeManualTimer(t.log);
  const marshaller = makeFakeBoard().getReadonlyMarshaller();
  const storage = makeFakeStorageKit('mockChainStorageRoot', {
    sequence: false,
  });

  const { portAllocator } = fakeNetworkEchoStuff(rootZone.subZone('network'));

  const { makeOrchestrationKit } = prepareOrchestrationTools(
    rootZone.subZone('orchestration'),
    vowTools,
  );
  const { public: orchestration } = makeOrchestrationKit({ portAllocator });

  await registerChainNamespace(agoricNamesAdmin, () => {});

  return {
    bootstrap: {
      agoricNames,
      agoricNamesAdmin,
      bankManager,
      timer,
      localchain,
      marshaller,
      orchestration,
      // TODO remove; bootstrap doesn't have a zone
      rootZone: rootZone.subZone('contract'),
      storage,
      vowTools,
    },
    brands: {
      bld: bldSansMint,
      ist: istSansMint,
    },
    commonPrivateArgs: {
      agoricNames,
      localchain,
      orchestrationService: orchestration,
      storageNode: storage.rootNode,
      marshaller,
      timerService: timer,
    },
    facadeServices: {
      agoricNames,
      localchain,
      orchestrationService: orchestration,
      timerService: timer,
    },
    utils: {
      pourPayment,
      inspectLocalBridge: () => harden([...localBrigeMessages]),
    },
  };
};

export const makeDefaultContext = <SF>(contract: Installation<SF>) => {};
