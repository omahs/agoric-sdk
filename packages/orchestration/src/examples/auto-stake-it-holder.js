import { E } from '@endo/far';
import { getInterfaceGuardPayload, M } from '@endo/patterns';
import {
  makeSyncMethodCallback,
  prepareGuardedAttenuator,
} from '@agoric/internal/src/callback.js';
import { EmptyProposalShape } from '@agoric/zoe/src/typeGuards.js';
import { pickFacet } from '@agoric/vat-data';
import { PortfolioHolderKitI } from '../exos/portfolio-holder-kit.js';
import { ChainAddressShape } from '../typeGuards.js';

/**
 * @import {Zone} from '@agoric/zone';
 * @import {MakeAttenuator} from '@agoric/internal/src/callback.js';
 * @import {TargetRegistration} from '@agoric/vats/src/bridge-target.js';
 * @import {CosmosValidatorAddress} from '@agoric/orchestration';
 * @import {PortfolioHolderKit} from '../exos/portfolio-holder-kit.js';
 * @import {StakingTapHolder} from './auto-stake-it-tap-kit.js';
 */

const AutoStakeInvitationMakersShape = harden({
  UpdateValidator: M.call(ChainAddressShape).returns(M.promise()),
  CancelAutoStake: M.call().returns(M.promise()),
});

/**
 * @param {Zone} zone
 * @param {ZCF} zcf
 */
export const prepareAutoStakeInvMakersFacet = (zone, zcf) =>
  zone.exoClass(
    'AutoStakeHolder Inv Makers',
    M.interface('AutoStakeInvitationMakers', AutoStakeInvitationMakersShape),
    /**
     * @param {TargetRegistration} appRegistration
     * @param {StakingTapHolder} tapHolder
     */
    (appRegistration, tapHolder) => ({ appRegistration, tapHolder }),
    {
      /** @param {CosmosValidatorAddress} validator */
      UpdateValidator(validator) {
        return zcf.makeInvitation(
          seat => {
            seat.exit();
            return E(this.state.tapHolder).updateValidator(validator);
          },
          'UpdateValidator',
          undefined,
          EmptyProposalShape,
        );
      },
      CancelAutoStake() {
        return zcf.makeInvitation(
          seat => {
            seat.exit();
            return E(this.state.appRegistration).revoke();
          },
          'CancelAutoStake',
          undefined,
          EmptyProposalShape,
        );
      },
    },
  );

/** @typedef {ReturnType<typeof prepareAutoStakeInvMakersFacet>} MakeAutoStakeInvMakersFacet */

/**
 * @param {Zone} zone
 * @param {MakeAutoStakeInvMakersFacet} makeAutoStakeInvMakersFacet
 */
export const prepareMixinInvitationMakers = (
  zone,
  makeAutoStakeInvMakersFacet,
) => {
  const MixinI = M.interface('Custom InvitationMakers', {
    ...getInterfaceGuardPayload(PortfolioHolderKitI.invitationMakers)
      .methodGuards,
    ...AutoStakeInvitationMakersShape,
  });

  // XXX i think this should be `PortfolioHolderKit` with our new `invitationMakers`
  /** @type {MakeAttenuator<PortfolioHolderKit>} */
  const mixin = prepareGuardedAttenuator(zone, MixinI, {
    tag: 'AutoStakeItInvitationMakers',
  });

  /**
   * @param {PortfolioHolderKit} portfolioHolderKit
   * @param {TargetRegistration} appRegistration
   * @param {StakingTapHolder} tapHolder
   */
  const mixinInvitationMakers = (
    portfolioHolderKit,
    appRegistration,
    tapHolder,
  ) => {
    const invitationMakers = makeAutoStakeInvMakersFacet(
      appRegistration,
      tapHolder,
    );
    return mixin({
      /// XXX is this is kit, we can include in the prepare? ~~Or an actual
      // instance~~
      target: portfolioHolderKit,
      // does not 'override' anything, but mixes in
      overrides: {
        UpdateValidator: makeSyncMethodCallback(
          invitationMakers,
          'UpdateValidator',
        ),
        CancelAutoStake: makeSyncMethodCallback(
          invitationMakers,
          'CancelAutoStake',
        ),
      },
    });
  };

  return mixinInvitationMakers;
};

/**
 * @param {Zone} zone
 * @param {ZCF} zcf
 */
export const prepareAutoStakeHolder = (zone, zcf) => {
  const makeAutoStakeInvMakersFacet = prepareAutoStakeInvMakersFacet(zone, zcf);
  const makeMixinInvitationMakers = prepareMixinInvitationMakers(
    zone,
    makeAutoStakeInvMakersFacet,
  );
  return pickFacet(makeMixinInvitationMakers, 'holder');
};
