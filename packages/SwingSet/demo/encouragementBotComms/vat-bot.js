import { Far } from '@endo/marshal';

export const buildRootObject = vatPowers =>
  Far('root', {
    encourageMe: name => {
      vatPowers.testLog(
        `=> encouragementBot.encourageMe got the name: ${name}`,
      );
      return `${name}, you are awesome, keep it up!`;
    },
  });
