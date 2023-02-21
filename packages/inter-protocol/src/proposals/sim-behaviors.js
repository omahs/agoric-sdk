import { E, Far } from '@endo/far';
import { addRemote } from '@agoric/vats/src/core/utils.js';

import { connectFaucet } from './demoIssuers.js';

export { connectFaucet };

/** @param {BootstrapPowers} powers */
export const installSimEgress = async ({
  vatParameters: { argv },
  vats: { vattp, comms },
  consume: { clientCreator },
}) => {
  const PROVISIONER_INDEX = 1;

  await Promise.all(
    argv.hardcodedClientAddresses.map(async (addr, i) => {
      const clientFacet = await E(clientCreator).createClientFacet(
        `solo${i}`,
        addr,
        ['agoric.ALL_THE_POWERS'],
      );

      await addRemote(addr, { vats: { comms, vattp } });
      await E(comms).addEgress(addr, PROVISIONER_INDEX, clientFacet);
    }),
  );
};
harden(installSimEgress);

/** @param {BootstrapPowers} powers */
export const grantRunBehaviors = async ({
  runBehaviors,
  consume: { client },
}) => {
  const bundle = {
    behaviors: Far('behaviors', { run: manifest => runBehaviors(manifest) }),
  };
  return E(client).assignBundle([_addr => bundle]);
};
harden(grantRunBehaviors);

/** @type {import('@agoric/vats').BootstrapManifest} */
export const SIM_CHAIN_BOOTSTRAP_PERMITS = harden({
  /** @type {import('@agoric/vats').BootstrapManifestPermit} */
  [installSimEgress.name]: {
    vatParameters: { argv: { hardcodedClientAddresses: true } },
    vats: {
      vattp: true,
      comms: true,
    },
    consume: { clientCreator: true },
  },
  [connectFaucet.name]: {
    consume: {
      bankManager: true,
      bldIssuerKit: true,
      client: true,
      feeMintAccess: true,
      loadVat: true,
      zoe: true,
    },
    installation: {
      consume: { centralSupply: 'zoe' },
    },
    produce: { mints: true },
    home: { produce: { faucet: true } },
  },
  [grantRunBehaviors.name]: {
    runBehaviors: true,
    consume: { client: true },
    home: { produce: { runBehaviors: true, governanceActions: true } },
  },
});
