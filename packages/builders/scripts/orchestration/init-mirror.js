import { makeHelpers } from '@agoric/deploy-script-support';
import { startBasicFlows } from '@agoric/orchestration/src/proposals/start-basic-flows.js';

/** @type {import('@agoric/deploy-script-support/src/externalTypes.js').CoreEvalBuilder} */
export const defaultProposalBuilder = async ({ publishRef, install }, {isDriver}) => {
  return harden({
    sourceSpec: '@agoric/orchestration/src/proposals/start-mirror.js',
    getManifestCall: [
      'getManifestForContract',
      {
        installKeys: {
          mirror: publishRef(
            install(
              '@agoric/orchestration/src/examples/mirror.contract.js',
            ),
          ),
        },
        isDriver,
      },
    ],
  });
};

export default async (homeP, endowments) => {
  const { writeCoreEval } = await makeHelpers(homeP, endowments);
  await writeCoreEval(startBasicFlows.name, defaultProposalBuilder);
};
