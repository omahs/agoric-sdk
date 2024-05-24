import { test } from '@agoric/zoe/tools/prepare-test-env-ava.js';

import { makeIssuerKit } from '@agoric/ertp';
import { setUpZoeForTest } from '@agoric/zoe/tools/setup-zoe.js';
import { E } from '@endo/far';
import path from 'path';
import { makeFakeStorageKit } from '@agoric/internal/src/storage-test-utils.js';
import { makeHeapZone } from '@agoric/zone';
import { prepareLocalChainTools } from '@agoric/vats/src/localchain.js';
import { withAmountUtils } from '@agoric/zoe/tools/test-utils.js';
import { makeFakeBankManagerKit } from '@agoric/vats/tools/bank-utils.js';
import { LOCALCHAIN_DEFAULT_ADDRESS } from '@agoric/vats/tools/fake-bridge.js';
import { makeFakeLocalchainBridge } from '../supports.js';

const dirname = path.dirname(new URL(import.meta.url).pathname);

const contractFile = `${dirname}/../../src/examples/swapExample.contract.js`;
type StartFn =
  typeof import('@agoric/orchestration/src/examples/swapExample.contract.js').start;

test('start', async t => {
  const issuerKit = makeIssuerKit('IST');
  const stable = withAmountUtils(issuerKit);
  const { zoe, bundleAndInstall } = await setUpZoeForTest();
  const installation: Installation<StartFn> =
    await bundleAndInstall(contractFile);

  const zone = makeHeapZone();
  const { makeLocalChain } = prepareLocalChainTools(zone.subZone('localchain'));

  const { bankManager, pourPayment } = await makeFakeBankManagerKit();

  await E(bankManager).addAsset('uist', 'IST', 'Inter Stable Token', issuerKit);

  const localchainBridge = makeFakeLocalchainBridge(zone);

  const localchain = makeLocalChain({
    bankManager,
    system: localchainBridge,
  });

  const storage = makeFakeStorageKit('mockChainStorageRoot', {
    sequence: false,
  });

  const privateArgs = {
    localchain,
    orchestrationService: null as any,
    storageNode: storage.rootNode,
    timerService: null as any,
    zone,
  };

  const { publicFacet } = await E(zoe).startInstance(
    installation,
    { Stable: stable.issuer },
    {},
    privateArgs,
  );

  const inv = E(publicFacet).makeSwapAndStakeInvitation();

  t.is(
    (await E(zoe).getInvitationDetails(inv)).description,
    'Swap for TIA and stake',
  );

  const bank = await E(bankManager).getBankForAddress(
    LOCALCHAIN_DEFAULT_ADDRESS,
  );

  const istPurse = await E(bank).getPurse(issuerKit.brand);
  // bank purse is empty
  t.like(await E(istPurse).getCurrentAmount(), stable.makeEmpty());

  const ten = stable.units(10);
  const userSeat = await E(zoe).offer(
    inv,
    { give: { Stable: ten } },
    { Stable: await pourPayment(ten) },
    {
      staked: ten,
      validator: {
        chainId: 'agoric-3',
        address: 'agoric1valoperfufu',
        addressEncoding: 'bech32',
      } as const,
    },
  );
  const result = await E(userSeat).getOfferResult();
  t.is(result, undefined);

  // bank purse now has the 10 IST
  t.like(await E(istPurse).getCurrentAmount(), ten);
});