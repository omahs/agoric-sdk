import { makeTracer } from '@agoric/internal';
import { E } from '@endo/far';
import {
  atomicRearrange,
  provideAll,
} from '@agoric/zoe/src/contractSupport/index.js';
import { M, prepareExoClass, provide } from '@agoric/vat-data';
import { AmountMath } from '@agoric/ertp';

const trace = makeTracer('ZCF Probe');

const ZcfProbeI = M.interface('ZCF Probe', {
  makeProbeHelperInvitation: M.call().returns(M.promise()),
  makeProbeInternalInvitation: M.call().returns(M.promise()),
  makeProbeStagingInvitation: M.call().returns(M.promise()),
  getAllocation: M.call().returns(M.any()),
  makeFaucetInvitation: M.call().returns(M.promise()),
});

/**
 * @param {ZCF} zcf
 * @param {{storageNode: StorageNode}} privateArgs
 * @param {import('@agoric/vat-data').Baggage} baggage
 */
export const prepare = async (zcf, privateArgs, baggage) => {
  const { probeMint } = await provideAll(baggage, {
    probeMint: () => zcf.makeZCFMint('Ducats'),
  });

  const { storageNode } = privateArgs;
  const makeZcfProbe = await prepareExoClass(
    baggage,
    'zcfProbe',
    ZcfProbeI,
    () => ({
      stashSeat: zcf.makeEmptySeatKit().zcfSeat,
      probeMint: null,
    }),
    {
      makeProbeHelperInvitation() {
        const { stashSeat } = this.state;

        const probeHelper = seat => {
          trace('ProbeHelper');
          const originalAlloc = seat.getCurrentAllocation().Ducats;
          const one = AmountMath.make(originalAlloc.brand, 1n);
          let result;
          try {
            atomicRearrange(zcf, harden([[seat, stashSeat, { Ducats: one }]]));
            result = true;
          } catch (e) {
            result = false;
          }

          seat.exit();
          return result;
        };

        return zcf.makeInvitation(probeHelper, 'probe helper');
      },
      makeProbeInternalInvitation() {
        const { stashSeat } = this.state;
        const probeInternal = seat => {
          trace('ProbeIntrinsics');
          const originalAlloc = seat.getCurrentAllocation().Ducats;
          const one = AmountMath.make(originalAlloc.brand, 1n);
          let result;
          try {
            zcf.atomicRearrange(harden([[seat, stashSeat, { Ducats: one }]]));
            result = true;
          } catch (e) {
            result = false;
          }

          seat.clear();
          seat.exit();

          trace('Intrinsics', result);
          // write to vstorage so a test can detect it.
          void E(storageNode).setValue(`${result}`);

          return result;
        };

        return zcf.makeInvitation(probeInternal, 'probe intrinsic');
      },
      makeProbeStagingInvitation() {
        const { stashSeat } = this.state;

        const probeStaging = seat => {
          trace('ProbeStaging');

          const originalAlloc = seat.getCurrentAllocation().Ducats;
          const one = AmountMath.make(originalAlloc.brand, 1n);
          let result;
          try {
            stashSeat.incrementBy(seat.decrementBy({ Ducats: one }));
            zcf.reallocate(seat, stashSeat);
            result = true;
          } catch (e) {
            seat.clear();
            stashSeat.clear();
            result = false;
          }

          seat.exit();
          return result;
        };

        return zcf.makeInvitation(probeStaging, 'probe staging');
      },
      getAllocation() {
        const { stashSeat } = this.state;
        trace('getAllocation');

        return stashSeat.getCurrentAllocation();
      },
      makeFaucetInvitation() {
        return zcf.makeInvitation(async seat => {
          trace('faucet');
          const { brand } = await probeMint.getIssuerRecord();

          await probeMint.mintGains(
            { Ducats: AmountMath.make(brand, 16n) },
            seat,
          );
          seat.exit();
          return 'minted 16n Ducats';
        }, 'faucet');
      },
    },
  );

  const probe = await provide(baggage, 'probe', () => makeZcfProbe());
  return harden({
    creatorFacet: probe,
  });
};
