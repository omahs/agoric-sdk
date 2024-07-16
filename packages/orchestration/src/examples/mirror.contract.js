/**
 * @file Primarily a testing fixture, but also serves as an example of how to
 *   leverage basic functionality of the Orchestration API with async-flow.
 */
import { InvitationShape } from '@agoric/zoe/src/typeGuards.js';
import { M } from '@endo/patterns';
import { makeDurableZone } from '@agoric/zone/durable.js';

/**
 * @import {Baggage} from '@agoric/vat-data';
 **/

/**
 * @param {ZCF} zcf
 * @param { {
 *   [x: PropertyKey]: any;
 *   isDriver: boolean;
 *   marshaller: Marshaller;
 * }} privateArgs
 * @param {Baggage} baggage
 */
export const start = async (zcf, privateArgs, baggage) => {
  const zone = makeDurableZone(baggage);

  const publicFacet = zone.exo(
    'Mirror Public Facet',
    M.interface('Mirror PF', {
      makeMirrorInvitation: M.callWhen(M.boolean()).returns(InvitationShape),
    }),
    {
      makeMirrorInvitation(isDriver) {
        assert.equal(isDriver, privateArgs.isDriver);
        if (isDriver) {
          return zcf.makeInvitation(
            /** @type {OfferHandler} */
            (zcfSeat) => { zcfSeat.exit() },
            'Mirror driver'
          );
        }
        return zcf.makeInvitation(
          /** @type {OfferHandler} */
          (zcfSeat) => { zcfSeat.exit() },
          'Mirror target',
        );
      },
    },
  );

  return { publicFacet };
};

/** @typedef {typeof start} AgoricMirrorSF */
