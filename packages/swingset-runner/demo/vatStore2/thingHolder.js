import { E } from '@agoric/eventual-send';
import { Far } from '@endo/marshal';
import {
  makeKind,
  makeScalarBigWeakMapStore,
} from '@agoric/swingset-vat/src/storeModule.js';

const p = console.log;

const build = name => {
  const makeThingInnards = state => ({
    init: (label, companion, companionName) => {
      p(`${name}'s thing ${label}: initialize ${companionName}`);
      state.label = label;
      state.companion = companion;
      state.companionName = companionName;
      state.count = 0;
    },
    self: Far('thing', {
      echo: message => {
        state.count += 1;
        E(state.companion).say(message);
      },
      changePartner: async newCompanion => {
        state.count += 1;
        state.companion = newCompanion;
        const companionName = await E(newCompanion).getName();
        state.companionName = companionName;
        p(`${name}'s thing ${state.label}: changePartner ${companionName}`);
      },
      getLabel: () => {
        const label = state.label;
        p(`${name}'s thing ${label}: getLabel`);
        state.count += 1;
        return label;
      },
      report: () => {
        p(`${name}'s thing ${state.label} invoked ${state.count} times`);
      },
    }),
  });

  const makeThing = makeKind(makeThingInnards);
  let nextThingNumber = 0;

  let myThings;

  const ensureCollection = () => {
    if (!myThings) {
      myThings = makeScalarBigWeakMapStore('things');
    }
  };

  return Far('root', {
    introduce: async other => {
      const otherName = await E(other).getName();
      const thing = makeThing(`thing-${nextThingNumber}`, other, otherName);
      nextThingNumber += 1;
      ensureCollection();
      myThings.init(thing, 0);
      return thing;
    },
    doYouHave: thing => {
      ensureCollection();
      if (myThings.has(thing)) {
        const queryCount = myThings.get(thing) + 1;
        myThings.set(thing, queryCount);
        p(`${name}: ${queryCount} queries about ${thing.getLabel()}`);
        return true;
      } else {
        p(`${name}: query about unknown thing`);
        return false;
      }
    },
  });
};

export const buildRootObject = (_vatPowers, vatParameters) =>
  build(vatParameters.name);
