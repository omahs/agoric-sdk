/**
 * @file A proposal to start the basic flows contract.
 */
import { makeTracer } from '@agoric/internal';
import { makeStorageNodeChild } from '@agoric/internal/src/lib-chainStorage.js';
import { E } from '@endo/far';

/**
 * @import {AgoricMirrorSF} from '../examples/mirror.contract.js';
 */

const trace = makeTracer('StartAgoricMirror', true);
const contractName = 'agoricMirror';

/**
 * See `@agoric/builders/builders/scripts/orchestration/init-basic-flows.js` for
 * the accompanying proposal builder. Run `agoric run
 * packages/builders/scripts/orchestration/init-basic-flows.js` to build the
 * contract and proposal files.
 *
 * @param {BootstrapPowers} powers
 */
export const startAgoricMirror = async ({
  consume: {
    agoricNames,
    board,
    chainStorage,
    chainTimerService,
    localchain,
    startUpgradable,
  },
  installation: {
    // @ts-expect-error not a WellKnownName
    consume: { [contractName]: installation },
  },
  instance: {
    // @ts-expect-error not a WellKnownName
    produce: { [contractName]: produceInstance },
  },
}, {options: {isDriver}}) => {
  trace(`start ${contractName}`);
  await null;

  const storageNode = await makeStorageNodeChild(chainStorage, contractName);
  const marshaller = await E(board).getPublishingMarshaller();

  /** @type {StartUpgradableOpts<AgoricMirrorSF>} */
  const startOpts = {
    label: 'agoricMirror',
    installation,
    terms: undefined,
    privateArgs: {
      agoricNames: await agoricNames,
      localchain: await localchain,
      isDriver,
      storageNode,
      marshaller,
      timerService: await chainTimerService,
    },
  };

  const { instance } = await E(startUpgradable)(startOpts);
  produceInstance.resolve(instance);
};
harden(startAgoricMirror);

export const getManifestForContract = (
  { restoreRef },
  { installKeys, ...options },
) => {
  return {
    manifest: {
      [startAgoricMirror.name]: {
        consume: {
          agoricNames: true,
          board: true,
          chainStorage: true,
          chainTimerService: true,
          localchain: true,
          startUpgradable: true,
        },
        installation: {
          consume: { [contractName]: true },
        },
        instance: {
          produce: { [contractName]: true },
        },
      },
    },
    installations: {
      [contractName]: restoreRef(installKeys[contractName]),
    },
    options,
  };
};
