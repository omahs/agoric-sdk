import { makeHelpers } from '@agoric/deploy-script-support';
import { startAgoricMirror } from '@agoric/orchestration/src/proposals/start-mirror.js';

/** @type {import('@agoric/deploy-script-support/src/externalTypes.js').CoreEvalBuilder} */
export const defaultProposalBuilder = async ({ publishRef, install }) => {
  return harden({
    sourceSpec: '@agoric/orchestration/src/proposals/start-mirror.js',
    getManifestCall: [
      'getManifestForContract',
      {
        installKeys: {
          agoricMirror: publishRef(
            install(
              '@agoric/orchestration/src/examples/mirror.contract.js',
            ),
          ),
        },
        isDriver: true,
        invitedOwners: {
          atredis1: 'agoric1paxqxfmz9a0w509q80ypwc0hkz3g2jnhcjf7nt',
          atredis2: 'agoric1cyhnt00v8z0g5s6vjnwe4wykrs3x6km6wj22xw',
          agoricsec1: 'agoric1wh060h62uc7m98trnn49hx9x80sqwzyamguawq'
        },
      },
    ],
  });
};

export default async (homeP, endowments) => {
  const { writeCoreEval } = await makeHelpers(homeP, endowments);
  await writeCoreEval(startAgoricMirror.name, defaultProposalBuilder);
};
