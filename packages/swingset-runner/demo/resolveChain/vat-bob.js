import { Far } from '@endo/marshal';

const makePR = () => {
  let r;
  const p = new Promise((resolve, _reject) => {
    r = resolve;
  });
  return [p, r];
};

export const buildRootObject = _vatPowers => {
  let r = null;
  let value = 0;
  return Far('root', {
    init: () => {
      let p;
      // eslint-disable-next-line prefer-const
      [p, r] = makePR();
      return p;
    },
    gen: () => {
      // eslint-disable-next-line prefer-const
      let [p, newR] = makePR();
      const answer = [value, p];
      value += 1;
      r(answer);
      r = newR;
    },
  });
};
