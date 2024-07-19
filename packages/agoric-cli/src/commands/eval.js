// @ts-check
/* eslint-disable func-names */
/* global fetch */
import { Command } from 'commander';
import { Offers } from '@agoric/inter-protocol/src/clientSupport.js';
import { makeRpcUtils } from '../lib/rpc.js';
import { outputExecuteOfferAction } from '../lib/wallet.js';

/**
 * @param {import('anylogger').Logger} logger
 */
export const makeEvalCommand = logger => {
  const evaluate = new Command('eval')
    .description('Evaluation commands')
    .option('--home [dir]', 'agd application home directory')
    .option(
      '--keyring-backend <os|file|test>',
      'keyring\'s backend (os|file|test) (default "os")',
    );

  evaluate
    .command('offer <stringToEval>')
    .description('Prepare an offer to evaluate a string')
    .option('--offerId <string>', 'Offer id', String, `eval-${Date.now()}`)
    // .option('--collateralBrand <string>', 'Collateral brand key', 'ATOM')
    .action(async function (stringToEval, opts) {
      logger.warn('running with options', opts);
      const { agoricNames } = await makeRpcUtils({ fetch });

      const offer = Offers.evaluators.Eval(agoricNames, {
        // giveCollateral: opts.giveCollateral,
        // wantMinted: opts.wantMinted,
        offerId: opts.offerId,
        stringToEval,
        // rename to allow CLI to be more concise
        // collateralBrandKey: opts.collateralBrand,
      });

      outputExecuteOfferAction(offer);
    });

  return evaluate;
};
