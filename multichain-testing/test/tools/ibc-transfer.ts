import anyTest from '@endo/ses-ava/prepare-endo.js';
import type { TestFn } from 'ava';
import { getTimeout } from '../../tools/ibc-transfer.js';
import {
  NANOSECONDS_PER_MILLISECOND,
  SECONDS_PER_MINUTE,
  MILLISECONDS_PER_SECOND,
} from '@agoric/orchestration/src/utils/time.js';

const test = anyTest as TestFn<Record<string, never>>;

const minutesInFuture = (now: bigint, minutes = 5n) =>
  now + minutes * SECONDS_PER_MINUTE * MILLISECONDS_PER_SECOND;

test('getTimeout returns nanoseconds 5 minutes in the future', async t => {
  const now = Date.now();
  const fiveMinutesInFuture = minutesInFuture(BigInt(now));

  const timeout = getTimeout(now);
  const timeoutInMS = timeout / NANOSECONDS_PER_MILLISECOND;
  t.is(fiveMinutesInFuture, timeoutInMS);
});

test('getTimeout accepts minutes in future for 2nd arg', async t => {
  const now = Date.now();
  const twoMinutesInFuture = minutesInFuture(BigInt(now), 2n);

  const timeout = getTimeout(now, 2n);
  const timeoutInMS = timeout / NANOSECONDS_PER_MILLISECOND;
  t.is(twoMinutesInFuture, timeoutInMS);
});
