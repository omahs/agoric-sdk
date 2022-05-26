// @ts-check

import { observeIteration } from '@agoric/notifier';
import { E } from '@endo/far';

/**
 * Publish results of an async iterable into a chain storage node as an array
 * serialized using JSON.stringify or an optionally provided function (e.g.,
 * leveraging a serialize function from makeMarshal).
 * Array items are possibly-duplicated [index, value] pairs, where index is a
 * string (ascending numeric or terminal "finish" or "fail").
 *
 * @param {ERef<AsyncIterable>} source
 * @param {{ setValue: (val: any) => void }} chainStorageNode
 * @param {{ timerService: ERef<TimerService>, serialize?: (obj: any) => string }} powers
 */
export async function publishToChainNode(
  source,
  chainStorageNode,
  { timerService, serialize = JSON.stringify },
) {
  let nextIndex = 0n;
  let isNewBlock = true;
  let oldResults = [];
  let results = [];
  const makeAcceptor = forceIndex => {
    return value => {
      if (isNewBlock) {
        isNewBlock = false;
        oldResults = results;
        results = [];
        E(timerService)
          .delay(1n)
          .then(() => {
            isNewBlock = true;
          });
      }
      // To avoid loss when detecting the new block *after* already consuming
      // results produced within it, we associate each result with an index and
      // include results of the previous batch.
      // Downstream consumers are expected to deduplicate by index.
      // We represent the index as a string to maintain compatibility with
      // JSON.stringify and to avoid overly inflating the data size (e.g. with
      // "@qclass" objects from makeMarshal serialize functions).
      const index = forceIndex || String(nextIndex);
      nextIndex += 1n;
      results.push([index, value]);
      const combined = harden(oldResults.slice().concat(results));
      E(chainStorageNode).setValue(serialize(combined));
    };
  };
  await observeIteration(source, {
    updateState: makeAcceptor(),
    finish: makeAcceptor('finish'),
    fail: makeAcceptor('fail'),
  });
}
