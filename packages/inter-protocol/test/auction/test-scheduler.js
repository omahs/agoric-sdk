import { test } from '@agoric/zoe/tools/prepare-test-env-ava.js';
import { buildManualTimer } from '@agoric/swingset-vat/tools/manual-timer.js';
import { TimeMath } from '@agoric/time';
import { setupZCFTest } from '@agoric/zoe/test/unitTests/zcf/setupZcfTest.js';
import { eventLoopIteration } from '@agoric/zoe/tools/eventLoopIteration.js';

import { makeScheduler } from '../../src/auction/scheduler.js';
import {
  makeAuctioneerParamManager,
  makeAuctioneerParams,
} from '../../src/auction/params.js';
import {
  getInvitation,
  makeDefaultParams,
  makeFakeAuctioneer,
  makePublisherFromFakes,
  setUpInstallations,
} from './tools.js';

/** @typedef {import('@agoric/time/src/types').TimerService} TimerService */

test('schedule start to finish', async t => {
  const { zoe } = await setupZCFTest();
  const installations = await setUpInstallations(zoe);
  const timer = buildManualTimer();
  const timerBrand = await timer.getTimerBrand();

  const fakeAuctioneer = makeFakeAuctioneer();
  const { fakeInvitationPayment } = await getInvitation(zoe, installations);
  const publisherKit = makePublisherFromFakes();

  let defaultParams = makeDefaultParams(fakeInvitationPayment, timerBrand);
  defaultParams = {
    ...defaultParams,
    auctionStartDelay: 1n,
    startFreq: 10n,
    priceLockPeriod: 5n,
  };
  const params = makeAuctioneerParams(defaultParams);
  const params2 = {};
  for (const key of Object.keys(params)) {
    const { value } = params[key];
    params2[key] = value;
  }

  /** @type {bigint} */
  let now = await timer.advanceTo(127n);

  const paramManager = await makeAuctioneerParamManager(
    publisherKit,
    zoe,
    // @ts-expect-error 3rd parameter of makeAuctioneerParamManager
    params2,
  );

  const scheduler = await makeScheduler(
    fakeAuctioneer,
    timer,
    paramManager,
    timer.getTimerBrand(),
  );
  const schedule = scheduler.getSchedule();
  t.deepEqual(schedule.liveAuctionSchedule, undefined);
  const firstSchedule = {
    startTime: TimeMath.toAbs(131n, timerBrand),
    endTime: TimeMath.toAbs(135n, timerBrand),
    steps: 2n,
    endRate: 6500n,
    startDelay: TimeMath.toRel(1n, timerBrand),
    clockStep: TimeMath.toRel(2n, timerBrand),
    lockTime: TimeMath.toAbs(126n, timerBrand),
  };
  t.deepEqual(schedule.nextAuctionSchedule, firstSchedule);

  t.false(fakeAuctioneer.getState().final);
  t.is(fakeAuctioneer.getState().step, 0);
  t.false(fakeAuctioneer.getState().final);

  now = await timer.advanceTo(now + 1n);

  t.is(fakeAuctioneer.getState().step, 0);
  t.false(fakeAuctioneer.getState().final);

  now = await timer.advanceTo(131n);
  await eventLoopIteration();

  const schedule2 = scheduler.getSchedule();
  t.deepEqual(schedule2.liveAuctionSchedule, firstSchedule);
  t.deepEqual(schedule2.nextAuctionSchedule, {
    startTime: TimeMath.toAbs(141n, timerBrand),
    endTime: TimeMath.toAbs(145n, timerBrand),
    steps: 2n,
    endRate: 6500n,
    startDelay: TimeMath.toRel(1n, timerBrand),
    clockStep: TimeMath.toRel(2n, timerBrand),
    lockTime: TimeMath.toAbs(136, timerBrand),
  });

  t.is(fakeAuctioneer.getState().step, 1);
  t.false(fakeAuctioneer.getState().final);

  // xxx I shouldn't have to tick twice.
  now = await timer.advanceTo(now + 1n);
  now = await timer.advanceTo(now + 1n);

  t.is(fakeAuctioneer.getState().step, 2);
  t.false(fakeAuctioneer.getState().final);

  // final step
  now = await timer.advanceTo(now + 1n);
  now = await timer.advanceTo(now + 1n);

  t.is(fakeAuctioneer.getState().step, 3);
  t.true(fakeAuctioneer.getState().final);

  // Auction finished, nothing else happens
  now = await timer.advanceTo(now + 1n);
  now = await timer.advanceTo(now + 1n);

  t.is(fakeAuctioneer.getState().step, 3);
  t.true(fakeAuctioneer.getState().final);

  t.deepEqual(fakeAuctioneer.getStartRounds(), [0]);

  const finalSchedule = scheduler.getSchedule();
  t.deepEqual(finalSchedule.liveAuctionSchedule, undefined);
  const secondSchedule = {
    startTime: TimeMath.toAbs(141n, timerBrand),
    endTime: TimeMath.toAbs(145n, timerBrand),
    steps: 2n,
    endRate: 6500n,
    startDelay: TimeMath.toRel(1n, timerBrand),
    clockStep: TimeMath.toRel(2n, timerBrand),
    lockTime: TimeMath.toAbs(136n, timerBrand),
  };
  t.deepEqual(finalSchedule.nextAuctionSchedule, secondSchedule);

  now = await timer.advanceTo(140n);

  t.deepEqual(finalSchedule.liveAuctionSchedule, undefined);
  t.deepEqual(finalSchedule.nextAuctionSchedule, secondSchedule);

  now = await timer.advanceTo(now + 1n);
  await eventLoopIteration();

  const schedule3 = scheduler.getSchedule();
  t.deepEqual(schedule3.liveAuctionSchedule, secondSchedule);
  t.deepEqual(schedule3.nextAuctionSchedule, {
    startTime: TimeMath.toAbs(151n, timerBrand),
    endTime: TimeMath.toAbs(155n, timerBrand),
    steps: 2n,
    endRate: 6500n,
    startDelay: TimeMath.toRel(1n, timerBrand),
    clockStep: TimeMath.toRel(2n, timerBrand),
    lockTime: TimeMath.toAbs(146n, timerBrand),
  });

  t.is(fakeAuctioneer.getState().step, 4);
  t.false(fakeAuctioneer.getState().final);

  // xxx I shouldn't have to tick twice.
  now = await timer.advanceTo(now + 1n);
  now = await timer.advanceTo(now + 1n);

  t.is(fakeAuctioneer.getState().step, 5);
  t.false(fakeAuctioneer.getState().final);

  // final step
  now = await timer.advanceTo(now + 1n);
  now = await timer.advanceTo(now + 1n);

  t.is(fakeAuctioneer.getState().step, 6);
  t.true(fakeAuctioneer.getState().final);

  // Auction finished, nothing else happens
  now = await timer.advanceTo(now + 1n);
  await timer.advanceTo(now + 1n);

  t.is(fakeAuctioneer.getState().step, 6);
  t.true(fakeAuctioneer.getState().final);

  t.deepEqual(fakeAuctioneer.getStartRounds(), [0, 3]);
});

test('lowest >= starting', async t => {
  const { zoe } = await setupZCFTest();
  const installations = await setUpInstallations(zoe);
  /** @type {TimerService & { advanceTo: (when: Timestamp) => void; }} */
  const timer = buildManualTimer();
  const timerBrand = await timer.getTimerBrand();

  const fakeAuctioneer = makeFakeAuctioneer();
  const { fakeInvitationPayment } = await getInvitation(zoe, installations);
  const publisherKit = makePublisherFromFakes();

  let defaultParams = makeDefaultParams(fakeInvitationPayment, timerBrand);
  defaultParams = {
    ...defaultParams,
    lowestRate: 110n,
    startingRate: 105n,
  };
  const params = makeAuctioneerParams(defaultParams);
  const params2 = {};
  for (const key of Object.keys(params)) {
    const { value } = params[key];
    params2[key] = value;
  }

  await timer.advanceTo(127n);

  const paramManager = await makeAuctioneerParamManager(
    publisherKit,
    zoe,
    // @ts-expect-error 3rd parameter of makeAuctioneerParamManager
    params2,
  );

  await t.throwsAsync(
    () =>
      makeScheduler(fakeAuctioneer, timer, paramManager, timer.getTimerBrand()),
    { message: /startingRate "\[105n]" must be more than lowest: "\[110n]"/ },
  );
});

test('zero time for auction', async t => {
  const { zoe } = await setupZCFTest();
  const installations = await setUpInstallations(zoe);
  /** @type {TimerService & { advanceTo: (when: Timestamp) => void; }} */
  const timer = buildManualTimer();
  const timerBrand = await timer.getTimerBrand();

  const fakeAuctioneer = makeFakeAuctioneer();
  const { fakeInvitationPayment } = await getInvitation(zoe, installations);
  const publisherKit = makePublisherFromFakes();

  let defaultParams = makeDefaultParams(fakeInvitationPayment, timerBrand);
  defaultParams = {
    ...defaultParams,
    startFreq: 2n,
    clockStep: 3n,
    auctionStartDelay: 1n,
    priceLockPeriod: 1n,
  };
  const params = makeAuctioneerParams(defaultParams);
  const params2 = {};
  for (const key of Object.keys(params)) {
    const { value } = params[key];
    params2[key] = value;
  }

  await timer.advanceTo(127n);

  const paramManager = await makeAuctioneerParamManager(
    publisherKit,
    zoe,
    // @ts-expect-error 3rd parameter of makeAuctioneerParamManager
    params2,
  );

  await t.throwsAsync(
    () =>
      makeScheduler(fakeAuctioneer, timer, paramManager, timer.getTimerBrand()),
    {
      message:
        /clockStep "\[3n]" must be shorter than startFrequency "\[2n]" to allow at least one step down/,
    },
  );
});

test('discountStep 0', async t => {
  const { zoe } = await setupZCFTest();
  const installations = await setUpInstallations(zoe);
  /** @type {TimerService & { advanceTo: (when: Timestamp) => void; }} */
  const timer = buildManualTimer();
  const timerBrand = await timer.getTimerBrand();

  const fakeAuctioneer = makeFakeAuctioneer();
  const { fakeInvitationPayment } = await getInvitation(zoe, installations);
  const publisherKit = makePublisherFromFakes();

  let defaultParams = makeDefaultParams(fakeInvitationPayment, timerBrand);
  defaultParams = {
    ...defaultParams,
    discountStep: 0n,
  };
  const params = makeAuctioneerParams(defaultParams);
  const params2 = {};
  for (const key of Object.keys(params)) {
    const { value } = params[key];
    params2[key] = value;
  }

  await timer.advanceTo(127n);

  const paramManager = await makeAuctioneerParamManager(
    publisherKit,
    zoe,
    // @ts-expect-error 3rd parameter of makeAuctioneerParamManager
    params2,
  );

  await t.throwsAsync(
    () =>
      makeScheduler(fakeAuctioneer, timer, paramManager, timer.getTimerBrand()),
    { message: 'Division by zero' },
  );
});

test('discountStep larger than starting rate', async t => {
  const { zoe } = await setupZCFTest();
  const installations = await setUpInstallations(zoe);
  /** @type {TimerService & { advanceTo: (when: Timestamp) => void; }} */
  const timer = buildManualTimer();
  const timerBrand = await timer.getTimerBrand();

  const fakeAuctioneer = makeFakeAuctioneer();
  const { fakeInvitationPayment } = await getInvitation(zoe, installations);
  const publisherKit = makePublisherFromFakes();

  let defaultParams = makeDefaultParams(fakeInvitationPayment, timerBrand);
  defaultParams = {
    ...defaultParams,
    startingRate: 10100n,
    discountStep: 10500n,
  };
  const params = makeAuctioneerParams(defaultParams);
  const params2 = {};
  for (const key of Object.keys(params)) {
    const { value } = params[key];
    params2[key] = value;
  }

  await timer.advanceTo(127n);

  const paramManager = await makeAuctioneerParamManager(
    publisherKit,
    zoe,
    // @ts-expect-error 3rd parameter of makeAuctioneerParamManager
    params2,
  );

  await t.throwsAsync(
    () =>
      makeScheduler(fakeAuctioneer, timer, paramManager, timer.getTimerBrand()),
    { message: /discountStep .* too large for requested rates/ },
  );
});

test('start Freq 0', async t => {
  const { zoe } = await setupZCFTest();
  const installations = await setUpInstallations(zoe);
  /** @type {TimerService & { advanceTo: (when: Timestamp) => void; }} */
  const timer = buildManualTimer();
  const timerBrand = await timer.getTimerBrand();

  const fakeAuctioneer = makeFakeAuctioneer();
  const { fakeInvitationPayment } = await getInvitation(zoe, installations);
  const publisherKit = makePublisherFromFakes();

  let defaultParams = makeDefaultParams(fakeInvitationPayment, timerBrand);
  defaultParams = {
    ...defaultParams,
    startFreq: 0n,
  };
  const params = makeAuctioneerParams(defaultParams);
  const params2 = {};
  for (const key of Object.keys(params)) {
    const { value } = params[key];
    params2[key] = value;
  }

  await timer.advanceTo(127n);

  const paramManager = await makeAuctioneerParamManager(
    publisherKit,
    zoe,
    // @ts-expect-error 3rd parameter of makeAuctioneerParamManager
    params2,
  );

  await t.throwsAsync(
    () =>
      makeScheduler(fakeAuctioneer, timer, paramManager, timer.getTimerBrand()),
    { message: /startFrequency must exceed startDelay.*0n.*10n.*/ },
  );
});

test('delay > freq', async t => {
  const { zoe } = await setupZCFTest();
  const installations = await setUpInstallations(zoe);
  /** @type {TimerService & { advanceTo: (when: Timestamp) => void; }} */
  const timer = buildManualTimer();
  const timerBrand = await timer.getTimerBrand();

  const fakeAuctioneer = makeFakeAuctioneer();
  const { fakeInvitationPayment } = await getInvitation(zoe, installations);
  const publisherKit = makePublisherFromFakes();

  let defaultParams = makeDefaultParams(fakeInvitationPayment, timerBrand);
  defaultParams = {
    ...defaultParams,
    auctionStartDelay: 40n,
    startFreq: 20n,
  };
  const params = makeAuctioneerParams(defaultParams);
  const params2 = {};
  for (const key of Object.keys(params)) {
    const { value } = params[key];
    params2[key] = value;
  }

  await timer.advanceTo(127n);

  const paramManager = await makeAuctioneerParamManager(
    publisherKit,
    zoe,
    // @ts-expect-error 3rd parameter of makeAuctioneerParamManager
    params2,
  );

  await t.throwsAsync(
    () =>
      makeScheduler(fakeAuctioneer, timer, paramManager, timer.getTimerBrand()),
    { message: /startFrequency must exceed startDelay.*\[20n\].*\[40n\].*/ },
  );
});

test('lockPeriod > freq', async t => {
  const { zoe } = await setupZCFTest();
  const installations = await setUpInstallations(zoe);
  /** @type {TimerService & { advanceTo: (when: Timestamp) => void; }} */
  const timer = buildManualTimer();
  const timerBrand = await timer.getTimerBrand();

  const fakeAuctioneer = makeFakeAuctioneer();
  const { fakeInvitationPayment } = await getInvitation(zoe, installations);
  const publisherKit = makePublisherFromFakes();

  let defaultParams = makeDefaultParams(fakeInvitationPayment, timerBrand);
  defaultParams = {
    ...defaultParams,
    priceLockPeriod: 7200n,
    startFreq: 3600n,
    auctionStartDelay: 500n,
  };
  const params = makeAuctioneerParams(defaultParams);
  const params2 = {};
  for (const key of Object.keys(params)) {
    const { value } = params[key];
    params2[key] = value;
  }

  await timer.advanceTo(127n);

  const paramManager = await makeAuctioneerParamManager(
    publisherKit,
    zoe,
    // @ts-expect-error 3rd parameter of makeAuctioneerParamManager
    params2,
  );

  await t.throwsAsync(
    () =>
      makeScheduler(fakeAuctioneer, timer, paramManager, timer.getTimerBrand()),
    {
      message: /startFrequency must exceed lock period.*\[3600n\].*\[7200n\].*/,
    },
  );
});

// if duration = frequency, we'll start every other freq.
test('duration = freq', async t => {
  const { zoe } = await setupZCFTest();
  const installations = await setUpInstallations(zoe);
  /** @type {TimerService & { advanceTo: (when: Timestamp) => void; }} */
  const timer = buildManualTimer();
  const timerBrand = await timer.getTimerBrand();

  const fakeAuctioneer = makeFakeAuctioneer();
  const { fakeInvitationPayment } = await getInvitation(zoe, installations);
  const publisherKit = makePublisherFromFakes();

  let defaultParams = makeDefaultParams(fakeInvitationPayment, timerBrand);
  // start hourly, request 6 steps down every 10 minutes, so duration would be
  // 1 hour. Instead cut the auction short.
  defaultParams = {
    ...defaultParams,
    priceLockPeriod: 20n,
    startFreq: 360n,
    auctionStartDelay: 5n,
    clockStep: 60n,
    startingRate: 100n,
    lowestRate: 40n,
    discountStep: 10n,
  };
  const params = makeAuctioneerParams(defaultParams);
  const params2 = {};
  for (const key of Object.keys(params)) {
    const { value } = params[key];
    params2[key] = value;
  }

  await timer.advanceTo(127n);

  const paramManager = await makeAuctioneerParamManager(
    publisherKit,
    zoe,
    // @ts-expect-error 3rd parameter of makeAuctioneerParamManager
    params2,
  );

  const scheduler = await makeScheduler(
    fakeAuctioneer,
    timer,
    paramManager,
    timer.getTimerBrand(),
  );
  let schedule = scheduler.getSchedule();
  t.deepEqual(schedule.liveAuctionSchedule, undefined);
  const firstSchedule = {
    startTime: TimeMath.toAbs(365n, timerBrand),
    endTime: TimeMath.toAbs(665n, timerBrand),
    steps: 5n,
    endRate: 50n,
    startDelay: TimeMath.toRel(5n, timerBrand),
    clockStep: TimeMath.toRel(60n, timerBrand),
    lockTime: TimeMath.toAbs(345n, timerBrand),
  };
  t.deepEqual(schedule.nextAuctionSchedule, firstSchedule);

  await timer.advanceTo(725n);
  schedule = scheduler.getSchedule();

  // start the second auction on time
  const secondSchedule = {
    startTime: TimeMath.toAbs(725n, timerBrand),
    endTime: TimeMath.toAbs(1025n, timerBrand),
    steps: 5n,
    endRate: 50n,
    startDelay: TimeMath.toRel(5n, timerBrand),
    clockStep: TimeMath.toRel(60n, timerBrand),
    lockTime: TimeMath.toAbs(705n, timerBrand),
  };
  t.deepEqual(schedule.nextAuctionSchedule, secondSchedule);
});
