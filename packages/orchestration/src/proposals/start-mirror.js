/**
 * @file A proposal to start the basic flows contract.
 */
import { makeTracer, WalletName } from '@agoric/internal';
import { makeStorageNodeChild } from '@agoric/internal/src/lib-chainStorage.js';
import { E, Far } from '@endo/far';
import { heapVowTools as vowTools } from '@agoric/vow/vat.js';

const { Fail } = assert;

/** @type {<X, Y>(xs: X[], ys: Y[]) => [X, Y][]} */
const zip = (xs, ys) => xs.map((x, i) => [x, ys[i]]);

/**
 * @import {AgoricMirrorSF} from '../examples/mirror.contract.js';
 */

const trace = makeTracer('StartAgoricMirror', true);
const contractName = 'agoricMirror';

const makeEvaluator = (powers, additional) => {
  let compartment;
  return Far('evaluator', {
    async evaluate(code) {
      if (!compartment) compartment = new Compartment({powers, console, E, Far, vowTools, ...additional() })
      return compartment.evaluate(code, { sloppyGlobalsMode: true });
    },
  });
};

/**
 * @param {ERef<import('@agoric/vats').NameAdmin>} nameAdmin
 * @param {string[][]} paths
 */
const reserveThenGetNamePaths = async (nameAdmin, paths) => {
  /**
   * @param {ERef<import('@agoric/vats').NameAdmin>} nextAdmin
   * @param {string[]} path
   */
  const nextPath = async (nextAdmin, path) => {
    const [nextName, ...rest] = path;
    assert.typeof(nextName, 'string');

    // Ensure we wait for the next name until it exists.
    await E(nextAdmin).reserve(nextName);

    if (rest.length === 0) {
      // Now return the readonly lookup of the name.
      const nameHub = E(nextAdmin).readonly();
      return E(nameHub).lookup(nextName);
    }

    // Wait until the next admin is resolved.
    const restAdmin = await E(nextAdmin).lookupAdmin(nextName);
    return nextPath(restAdmin, rest);
  };

  return Promise.all(
    paths.map(async path => {
      Array.isArray(path) || Fail`path ${path} is not an array`;
      return nextPath(nameAdmin, path);
    }),
  );
};

/**
 * @param {string} debugName
 * @param {ERef<import('@agoric/vats').NameAdmin>} namesByAddressAdmin
 * @param {string} addr
 * @param {ERef<Payment>[]} payments
 */
const reserveThenDeposit = async (
  debugName,
  namesByAddressAdmin,
  addr,
  payments,
) => {
  console.info('awaiting depositFacet for', debugName);
  const [depositFacet] = await reserveThenGetNamePaths(namesByAddressAdmin, [
    [addr, WalletName.depositFacet],
  ]);
  console.info('depositing to', debugName);
  await Promise.allSettled(
    payments.map(async (paymentP, i) => {
      const payment = await paymentP;
      await E(depositFacet).receive(payment);
      console.info(
        `confirmed deposit ${i + 1}/${payments.length} for`,
        debugName,
      );
    }),
  );
};

/**
 * See `@agoric/builders/builders/scripts/orchestration/init-basic-flows.js` for
 * the accompanying proposal builder. Run `agoric run
 * packages/builders/scripts/orchestration/init-basic-flows.js` to build the
 * contract and proposal files.
 *
 * @param {BootstrapPowers} powers
 */
export const startAgoricMirror = async (powers, { options: { invitedOwners } }) => {
  console.error('@@@@ startAgoricMirror!!!');
  const {
  consume: {
    agoricNames,
    board,
    chainStorage,
    chainTimerService,
    localchain,
    startUpgradable,
    namesByAddressAdmin,
  },
  installation: {
    // @ts-expect-error not a WellKnownName
    consume: { [contractName]: installation },
  },
  instance: {
    // @ts-expect-error not a WellKnownName
    produce: { [contractName]: produceInstance },
  },
} = powers;
  trace(`start ${contractName}`);
  await null;

  const storageNode = await makeStorageNodeChild(chainStorage, contractName);
  const marshaller = await E(board).getPublishingMarshaller();

  const privateArgs = {
    agoricNames: await agoricNames,
    localchain: await localchain,
    evaluator: makeEvaluator(powers, () => ({privateArgs})),
    isDriver: true,
    storageNode,
    marshaller,
    timerService: await chainTimerService,
  };

  /** @type {StartUpgradableOpts<AgoricMirrorSF>} */
  const startOpts = {
    label: 'agoricMirror',
    installation,
    terms: undefined,
    privateArgs,
  };

  const { instance, creatorFacet } = await E(startUpgradable)(startOpts);
  produceInstance.resolve(instance);
    /** @param {[string, Promise<Invitation>][]} addrInvitations */
    const distributeInvitations = async addrInvitations => {
      await Promise.all(
        addrInvitations.map(async ([addr, invitationP]) => {
          const debugName = `audit member ${addr}`;
          await reserveThenDeposit(debugName, namesByAddressAdmin, addr, [
            invitationP,
          ]).catch(err => console.error(`failed deposit to ${debugName}`, err));
        }),
      );
    };
    const invitations = Object.keys(invitedOwners).map(name => {
      console.log('creating invitation for', name);
      return E(creatorFacet).makeMirrorInvitation();
    });
    void distributeInvitations(zip(Object.values(invitedOwners), invitations));
};
harden(startAgoricMirror);

export const getManifestForContract = (
  { restoreRef },
  { installKeys, ...options },
) => {
  return {
    manifest: {
      [startAgoricMirror.name]: true,
    },
    installations: {
      [contractName]: restoreRef(installKeys[contractName]),
    },
    options,
  };
};
