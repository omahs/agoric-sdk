/* eslint-disable @jessie.js/no-nested-await */
// @ts-check
/* eslint-disable func-names */
/* global globalThis, process, setTimeout */
import { execFileSync as execFileSyncAmbient } from 'child_process';
import { Command, CommanderError } from 'commander';
import { normalizeAddressWithOptions, pollBlocks } from '../lib/chain.js';
import { getNetworkConfig, makeRpcUtils } from '../lib/rpc.js';
import { outputExecuteOfferAction, sendAction } from '../lib/wallet.js';

/** @typedef {import('@agoric/smart-wallet/src/offers.js').OfferSpec} OfferSpec */

/**
 *
 * @param {import('anylogger').Logger} _logger
 * @param {{
 *   env?: Record<string, string|undefined>,
 *   fetch?: typeof window.fetch,
 *   stdout?: Pick<import('stream').Writable, 'write'>,
 *   execFileSync?: typeof execFileSyncAmbient,
 *   delay?: (ms: number) => Promise<void>,
 * }} [io]
 */
export const makeEconomicCommiteeCommand = async (_logger, io = {}) => {
  const {
    // Allow caller to provide access explicitly, but
    // default to conventional ambient IO facilities.
    env = process.env,
    stdout = process.stdout,
    fetch = globalThis.fetch,
    execFileSync = execFileSyncAmbient,
    delay = ms => new Promise(resolve => setTimeout(resolve, ms)),
  } = io;

  const ec = new Command('ec').description('Economic Committee commands');

  /** @param {string} literalOrName */
  const normalizeAddress = literalOrName =>
    normalizeAddressWithOptions(literalOrName, { keyringBackend: 'test' });

  const show = (info, indent) =>
    stdout.write(`${JSON.stringify(info, null, indent ? 2 : undefined)}\n`);

  const findContinuingIds = (current, agoricNames) => {
    // XXX should runtime type-check
    /** @type {{ offerToUsedInvitation: [string, Amount<'set'>][]}} */
    const { offerToUsedInvitation: entries } = /** @type {any} */ (current);

    assert(Array.isArray(entries));

    const keyOf = (obj, val) => {
      const found = Object.entries(obj).find(e => e[1] === val);
      return found && found[0];
    };

    const found = [];
    for (const [offerId, { value }] of entries) {
      /** @type {{ description: string, instance: unknown }[]} */
      const [{ description, instance }] = value;
      if (
        description === 'charter member invitation' ||
        /Voter\d+/.test(description)
      ) {
        const instanceName = keyOf(agoricNames.instance, instance);
        found.push({ instance, instanceName, description, offerId });
      }
    }
    return found;
  };

  const abortIfSeen = (instanceName, found) => {
    const done = found.filter(it => it.instanceName === instanceName);
    if (done.length > 0) {
      console.warn(`invitation to ${instanceName} already accepted`, done);
      throw new CommanderError(1, 'ELREADY', `already accepted`);
    }
  };

  /**
   * Sign and send an offer, given a sendFrom address;
   * else print it.
   *
   * Given sendFrom and instanceName, abort early if
   * such an offer is already accepted.
   *
   * @param {{
   *   toOffer: (agoricNames: *, current: *) => OfferSpec,
   *   sendFrom: string,
   *   instanceName?: string,
   * }} detail
   * @param {Awaited<ReturnType<makeRpcUtils>>} [optUtils]
   */
  const processOffer = async function (
    { toOffer, sendFrom, instanceName },
    optUtils,
  ) {
    const networkConfig = await getNetworkConfig(env);
    const utils = await (optUtils || makeRpcUtils({ fetch }));
    const { agoricNames, readLatestHead } = utils;

    let current;
    if (sendFrom) {
      current = await readLatestHead(`published.wallet.${sendFrom}.current`);
    }

    const offer = toOffer(agoricNames, current);
    if (!sendFrom) {
      outputExecuteOfferAction(offer);

      console.warn('Now execute the prepared offer');
      return;
    }

    const result = await sendAction(
      { method: 'executeOffer', offer },
      {
        keyring: { backend: 'test' }, // XXX
        from: sendFrom,
        verbose: false,
        ...networkConfig,
        execFileSync,
        stdout,
        delay,
      },
    );
    const { timestamp, txhash, height } = result;
    console.error('wallet action is broadcast:');
    show({ timestamp, height, offerId: offer.id, txhash });
    const checkInWallet = async blockInfo => {
      const [state, update] = await Promise.all([
        readLatestHead(`published.wallet.${sendFrom}.current`),
        readLatestHead(`published.wallet.${sendFrom}`),
      ]);
      if (update.updated === 'offerStatus' && update.status.id === offer.id) {
        return blockInfo;
      }
      const info = await findContinuingIds(state, agoricNames);
      const done = info.filter(it => it.offerId === offer.id);
      if (!(done.length > 0)) throw Error('retry');
      return blockInfo;
    };
    const blockInfo = await pollBlocks({
      retryMessage: 'offer not yet in block',
      ...networkConfig,
      execFileSync,
      delay,
    })(checkInWallet);
    console.error('offer accepted in block');
    show(blockInfo);
  };

  ec.command('committee')
    .description('accept invitation to join the economic committee')
    .option('--voter [number]', 'Voter number', Number, 0)
    .option(
      '--offerId [string]',
      'Offer id',
      String,
      `ecCommittee-${Date.now()}`,
    )
    .option(
      '--send-from <name-or-address>',
      'Send from address',
      normalizeAddress,
    )
    .action(async function (opts) {
      /** @type {(a: *, c: *) => OfferSpec} */
      const toOffer = (agoricNames, current) => {
        const instance = agoricNames.instance.economicCommittee;
        assert(instance, `missing economicCommittee`);

        const found = findContinuingIds(current, agoricNames);
        abortIfSeen('economicCommittee', found);

        return {
          id: opts.offerId,
          invitationSpec: {
            source: 'purse',
            instance,
            description: `Voter${opts.voter}`,
          },
          proposal: {},
        };
      };

      await processOffer({
        toOffer,
        instanceName: 'economicCommittee',
        ...opts,
      });
    });

  ec.command('charter')
    .description('accept the charter invitation')
    .option('--offerId [string]', 'Offer id', String, `ecCharter-${Date.now()}`)
    .option(
      '--send-from <name-or-address>',
      'Send from address',
      normalizeAddress,
    )
    .action(async function (opts) {
      /** @type {(a: *, c: *) => OfferSpec} */
      const toOffer = (agoricNames, current) => {
        const instance = agoricNames.instance.econCommitteeCharter;
        assert(instance, `missing econCommitteeCharter`);

        const found = findContinuingIds(current, agoricNames);
        abortIfSeen('econCommitteeCharter', found);

        return {
          id: opts.offerId,
          invitationSpec: {
            source: 'purse',
            instance,
            description: 'charter member invitation',
          },
          proposal: {},
        };
      };

      await processOffer({
        toOffer,
        instanceName: 'econCommitteeCharter',
        ...opts,
      });
    });

  ec.command('find-continuing-ids')
    .description('find ids of proposing, voting continuing invitations')
    .requiredOption(
      '--from <name-or-address>',
      'from address',
      normalizeAddress,
    )
    .action(async opts => {
      const { agoricNames, readLatestHead } = await makeRpcUtils({ fetch });
      const current = await readLatestHead(
        `published.wallet.${opts.from}.current`,
      );

      const found = findContinuingIds(current, agoricNames);
      found.forEach(it => show({ ...it, address: opts.from }));
    });

  ec.command('vote')
    .description('vote on a question (hard-coded for now))')
    .option('--offerId [number]', 'Offer id', String, `ecVote-${Date.now()}`)
    .requiredOption(
      '--forPosition [number]',
      'index of one position to vote for (within the question description.positions); ',
      Number,
    )
    .option(
      '--send-from <name-or-address>',
      'Send from address',
      normalizeAddress,
    )
    .action(async function (opts) {
      const utils = await makeRpcUtils({ fetch });
      const { readLatestHead } = utils;

      const info = await readLatestHead(
        'published.committees.Economic_Committee.latestQuestion',
      );
      // XXX runtime shape-check
      const questionDesc = /** @type {any} */ (info);

      // TODO support multiple position arguments
      const chosenPositions = [questionDesc.positions[opts.forPosition]];
      assert(chosenPositions, `undefined position index ${opts.forPosition}`);

      /** @type {(a: *, c: *) => OfferSpec} */
      const toOffer = (agoricNames, current) => {
        const cont = findContinuingIds(current, agoricNames);
        const votingRight = cont.find(
          it => it.instance === agoricNames.instance.economicCommittee,
        );
        if (!votingRight) {
          throw new CommanderError(
            1,
            'NO_INVITATION',
            'first, try: agops ec committee ...',
          );
        }
        return {
          id: opts.offerId,
          invitationSpec: {
            source: 'continuing',
            previousOffer: votingRight.offerId,
            invitationMakerName: 'makeVoteInvitation',
            // (positionList, questionHandle)
            invitationArgs: harden([
              chosenPositions,
              questionDesc.questionHandle,
            ]),
          },
          proposal: {},
        };
      };

      await processOffer({ toOffer, sendFrom: opts.sendFrom }, utils);
    });

  return ec;
};
