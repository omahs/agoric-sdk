import { E } from '@agoric/eventual-send';
import { Far } from '@endo/marshal';

export const buildRootObject = () => {
  const self = Far('root', {
    bootstrap: async (vats, devices) => {
      const vatMaker = E(vats.vatAdmin).createVatAdminService(devices.vatAdmin);

      // create a dynamic vat, send it a message and let it respond, to make
      // sure everything is working
      const weatherwax = await E(vatMaker).createVatByName('weatherwax');
      await E(weatherwax.root).live();
      E(weatherwax.adminNode).terminateWithFailure('no zombies?');
      try {
        await E(weatherwax.adminNode).done();
      } catch (e) {
        // ignored
      }
      return 'bootstrap done';
    },
  });
  return self;
};
