import { Far } from '@endo/marshal';

export const buildRootObject = _vatPowers =>
  Far('root', {
    encourageMe: name => {
      console.log(`=> encouragementBot.encourageMe got the name: ${name}`);
      return `${name}, you are awesome, keep it up!\nbot vat is happy`;
    },
  });
