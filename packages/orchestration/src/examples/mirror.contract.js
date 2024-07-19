/**
 * @file Primarily a testing fixture, but also serves as an example of how to
 *   leverage basic functionality of the Orchestration API with async-flow.
 */
import { InvitationShape } from '@agoric/zoe/src/typeGuards.js';
import { M } from '@endo/patterns';
import { E } from '@endo/far';
import { prepareSwingsetVowTools } from '@agoric/vow/vat.js';
import { makeDurableZone } from '@agoric/zone/durable.js';

/**
 * @import {Baggage} from '@agoric/vat-data';
 */

/**
 * @param {ZCF} zcf
 * @param {{
 *   [x: PropertyKey]: any;
 *   isDriver: boolean;
 *   evaluator: ERef<{
 *     evaluate(code: string): import('@agoric/vow').PromiseVow<any>;
 *   }>;
 *   marshaller: Marshaller;
 * }} privateArgs
 * @param {Baggage} baggage
 */
export const start = async (zcf, privateArgs, baggage) => {
  const zone = makeDurableZone(baggage);

  const vowTools = prepareSwingsetVowTools(zone.subZone('vow'));
  const { when } = vowTools;

  const creatorFacet = zone.exo(
    'Mirror Creator Facet',
    M.interface('Mirror CF', {
      makeEvalInvitation: M.callWhen().returns(InvitationShape),
    }),
    {
      makeEvalInvitation(stringToEval) {
        return zcf.makeInvitation(async zcfSeat => {
          const { evaluator } = privateArgs;
          console.log('evaluating', stringToEval);
          const result = await when(E(evaluator).evaluate(stringToEval));
          console.log('evaluator replied with', result);
          zcfSeat.exit();
        }, 'evaluate string');
      },
    },
  );

  return { creatorFacet };
};

/** @typedef {typeof start} AgoricMirrorSF */
