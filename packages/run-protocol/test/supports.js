// @ts-check
/* global setImmediate */

import binaryVoteCounterBundle from '@agoric/governance/bundles/bundle-binaryVoteCounter.js';
import committeeBundle from '@agoric/governance/bundles/bundle-committee.js';
import contractGovernorBundle from '@agoric/governance/bundles/bundle-contractGovernor.js';
import {
  makeAgoricNamesAccess,
  makePromiseSpace,
} from '@agoric/vats/src/core/utils.js';
import * as utils from '@agoric/vats/src/core/utils.js';
import { makeZoeKit } from '@agoric/zoe';
import { makeFakeVatAdmin } from '@agoric/zoe/tools/fakeVatAdmin.js';
import buildManualTimer from '@agoric/zoe/tools/manualTimer.js';
import { makeLoopback } from '@endo/captp';
import { E } from '@endo/far';
import { makeTracer } from '../src/makeTracer.js';

/**
 * @param {*} t
 * @param {string} sourceRoot
 * @param {string} bundleName
 * @returns {Promise<SourceBundle>}
 */
export const provideBundle = (t, sourceRoot, bundleName) => {
  assert(
    t.context && t.context.bundleCache,
    'must set t.context.bundleCache in test.before()',
  );
  const { bundleCache } = t.context;
  return bundleCache.load(sourceRoot, bundleName);
};
harden(provideBundle);

// Some notifier updates aren't propagating sufficiently quickly for
// the tests. This invocation waits for all promises that can fire to
// have all their callbacks run
export const waitForPromisesToSettle = async () =>
  new Promise(resolve => setImmediate(resolve));
harden(waitForPromisesToSettle);

/**
 * Returns promises for `zoe` and the `feeMintAccess`.
 *
 * @param {() => void} setJig
 */
export const setUpZoeForTest = (setJig = () => {}) => {
  const { makeFar } = makeLoopback('zoeTest');

  const { zoeService, feeMintAccess: nonFarFeeMintAccess } = makeZoeKit(
    makeFakeVatAdmin(setJig).admin,
  );
  /** @type {ERef<ZoeService>} */
  const zoe = makeFar(zoeService);
  const feeMintAccess = makeFar(nonFarFeeMintAccess);
  return {
    zoe,
    feeMintAccess,
  };
};
harden(setUpZoeForTest);

export const setupBootstrap = (t, optTimer = undefined) => {
  const trace = makeTracer('PromiseSpace');
  const space = /** @type {any} */ (makePromiseSpace(trace));
  const { produce, consume } =
    /** @type { import('../src/proposals/econ-behaviors.js').EconomyBootstrapPowers & BootstrapPowers } */ (
      space
    );

  const timer = optTimer || buildManualTimer(t.log);
  produce.chainTimerService.resolve(timer);

  const {
    zoe,
    feeMintAccess,
    runKit: { brand: runBrand, issuer: runIssuer },
  } = t.context;
  produce.zoe.resolve(zoe);
  produce.feeMintAccess.resolve(feeMintAccess);

  const { agoricNames, agoricNamesAdmin, spaces } = makeAgoricNamesAccess();
  produce.agoricNames.resolve(agoricNames);
  produce.agoricNamesAdmin.resolve(agoricNamesAdmin);

  const { brand, issuer } = spaces;
  brand.produce.RUN.resolve(runBrand);
  issuer.produce.RUN.resolve(runIssuer);

  return { produce, consume, modules: { utils: { ...utils } }, ...spaces };
};

export const installGovernance = (zoe, produce) => {
  produce.committee.resolve(E(zoe).install(committeeBundle));
  produce.contractGovernor.resolve(E(zoe).install(contractGovernorBundle));
  produce.binaryVoteCounter.resolve(E(zoe).install(binaryVoteCounterBundle));
};

/**
 * Economic Committee of one.
 *
 * @param {ERef<ZoeService>} zoe
 * @param {ERef<CommitteeElectorateCreatorFacet>} electorateCreator
 * @param {ERef<GovernedContractFacetAccess<unknown>>} runStakeGovernorCreatorFacet
 * @param {Installation} counter
 */
export const makeVoterTool = async (
  zoe,
  electorateCreator,
  runStakeGovernorCreatorFacet,
  counter,
) => {
  const [invitation] = await E(electorateCreator).getVoterInvitations();
  await runStakeGovernorCreatorFacet;
  const seat = E(zoe).offer(invitation);
  const voteFacet = E(seat).getOfferResult();
  return harden({
    changeParam: async (paramsSpec, deadline) => {
      /** @type { ContractGovernanceVoteResult } */
      const { details, instance } = await E(
        runStakeGovernorCreatorFacet,
      ).voteOnParamChanges(counter, deadline, paramsSpec);
      const { questionHandle, positions } = await details;
      const cast = E(voteFacet).castBallotFor(questionHandle, [positions[0]]);
      const count = E(zoe).getPublicFacet(instance);
      const outcome = E(count).getOutcome();
      return { cast, outcome };
    },
  });
};

/**
 * @param {bigint} value
 * @param {{
 *   centralSupply: ERef<Installation>,
 *   feeMintAccess: ERef<FeeMintAccess>,
 *   zoe: ERef<ZoeService>,
 * }} powers
 * @returns { Promise<Payment> }
 */
export const mintRunPayment = async (
  value,
  { centralSupply, feeMintAccess: feeMintAccessP, zoe },
) => {
  const feeMintAccess = await feeMintAccessP;

  const { creatorFacet: ammSupplier } = await E(zoe).startInstance(
    centralSupply,
    {},
    { bootstrapPaymentValue: value },
    { feeMintAccess },
  );
  return E(ammSupplier).getBootstrapPayment();
};
