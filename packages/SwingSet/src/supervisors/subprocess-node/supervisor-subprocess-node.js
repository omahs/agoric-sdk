/* global WeakRef, FinalizationRegistry, setImmediate, process */

// this file is loaded at the start of a new subprocess
import '@endo/init';

import anylogger from 'anylogger';
import fs from 'fs';
import { Buffer } from 'buffer';
import v8 from 'node:v8';

import { assert, details as X, Fail } from '@agoric/assert';
import { importBundle } from '@endo/import-bundle';
import { makeMarshal } from '@endo/marshal';
import {
  makeLiveSlots,
  insistVatDeliveryObject,
  insistVatSyscallResult,
} from '@agoric/swingset-liveslots';
import engineGC from '../../lib-nodejs/engine-gc.js';
import { makeGcAndFinalize } from '../../lib-nodejs/gc-and-finalize.js';
import { makeDummyMeterControl } from '../../kernel/dummyMeterControl.js';
import { encode, decode } from '../../lib/netstring.js';
import { waitUntilQuiescent } from '../../lib-nodejs/waitUntilQuiescent.js';
import {
  makeSupervisorDispatch,
  makeSupervisorSyscall,
  makeVatConsole,
} from '../supervisor-helper.js';

// eslint-disable-next-line no-unused-vars
function workerLog(...args) {
  // console.error(`---worker:`, ...args);
}

workerLog(`supervisor started`);

const eventLoopIteration = async () =>
  new Promise(resolve => setImmediate(resolve));
harden(eventLoopIteration);

let vatID;

let snapshotNum = 0;
const snapshotHeap = async () => {
  workerLog(`Snapshotting heap ${snapshotNum}...`);
  await eventLoopIteration();
  try {
    engineGC();

    // process.pid increments so these will be lexically sorted pathnames.
    const heapSnapshot = `Heap-${vatID || 'vXX'}-${
      process.pid
    }-${snapshotNum}.heapsnapshot`;
    snapshotNum += 1;

    v8.writeHeapSnapshot(heapSnapshot);
  } catch (err) {
    workerLog('Failed to take heap snapshot', err);
  }
};

function makeNetstringReader({ fd, encoding }) {
  const input = Buffer.alloc(32 * 1024);
  let buffered = Buffer.alloc(0);
  let decoded = [];

  const readMore = () => {
    assert(!decoded.length);
    // we could be smarter about read lengths (parse the the netstring
    // header and do a blocking read of the entire payload), but the
    // efficiency gain is not huge
    const bytesRead = fs.readSync(fd, input); // blocking read
    if (!bytesRead) {
      throw Error('read pipe closed');
    }
    const more = input.subarray(0, bytesRead);
    buffered = Buffer.concat([buffered, more]);
    const { leftover, payloads } = decode(buffered);
    buffered = leftover;
    decoded = payloads;
  };

  return harden({
    read: () => {
      for (;;) {
        if (decoded.length) {
          const ns = decoded.shift();
          return JSON.parse(ns.toString(encoding));
        }
        readMore(); // blocks
      }
    },
  });
}

let dispatch;

function writeToParent(command) {
  let buf = encode(Buffer.from(JSON.stringify(command)));
  while (buf.length) {
    const bytesWritten = fs.writeSync(4, buf);
    if (!bytesWritten) {
      throw Error('write pipe closed');
    }
    buf = buf.subarray(bytesWritten);
  }
}
const toParent = { write: writeToParent };
const fromParent = makeNetstringReader({ fd: 3, encoding: 'utf-8' });

function sendUplink(msg) {
  msg instanceof Array || Fail`msg must be an Array`;
  toParent.write(msg);
}

function handleStart(_margs) {
  // TODO: parent should send ['start', vatID]
  workerLog(`got start`);
  sendUplink(['gotStart']);
}

function handleSetBundle(margs) {
  const [, bundle, liveSlotsOptions] = margs;
  vatID = margs[0];

  function testLog(...args) {
    sendUplink(['testLog', ...args]);
  }

  // syscallToManager can throw or return OK/ERR
  function syscallToManager(vatSyscallObject) {
    sendUplink(['syscall', vatSyscallObject]);
    const result = fromParent.read();
    workerLog(' ... syscall result:', result);
    insistVatSyscallResult(result);
    return result;
  }
  // this 'syscall' throws or returns data
  const syscall = makeSupervisorSyscall(syscallToManager);
  const vatPowers = {
    makeMarshal,
    testLog,
  };

  const gcTools = harden({
    WeakRef,
    FinalizationRegistry,
    waitUntilQuiescent,
    gcAndFinalize: makeGcAndFinalize(engineGC),
    meterControl: makeDummyMeterControl(),
  });

  const makeLogMaker = tag => {
    const logger = anylogger(tag);
    const makeLog = level => {
      const log = logger[level];
      assert.typeof(log, 'function', X`logger[${level}] must be a function`);
      return (...args) => {
        log(...args);
      };
    };
    return makeLog;
  };

  // Enable or disable the console accordingly.
  const workerEndowments = {
    console: makeVatConsole(makeLogMaker(`SwingSet:vat:${vatID}`)),
    assert,
  };

  async function buildVatNamespace(lsEndowments, inescapableGlobalProperties) {
    const vatNS = await importBundle(bundle, {
      endowments: { ...workerEndowments, ...lsEndowments },
      inescapableGlobalProperties,
    });
    workerLog(`got vatNS:`, Object.keys(vatNS).join(','));
    return vatNS;
  }

  const ls = makeLiveSlots(
    syscall,
    vatID,
    vatPowers,
    liveSlotsOptions,
    gcTools,
    makeVatConsole(makeLogMaker(`SwingSet:ls:${vatID}`)),
    buildVatNamespace,
  );

  sendUplink(['gotBundle']);
  assert(ls.dispatch);
  dispatch = makeSupervisorDispatch(ls.dispatch);
  workerLog(`created dispatch()`);
  sendUplink(['dispatchReady']);
}

async function handleDeliver(margs) {
  if (!dispatch) {
    throw Error(`error: deliver before dispatchReady`);
  }
  const [vatDeliveryObject] = margs;
  harden(vatDeliveryObject);
  insistVatDeliveryObject(vatDeliveryObject);
  const vatDeliveryResults = await dispatch(vatDeliveryObject);
  sendUplink(['deliverDone', vatDeliveryResults]);
  if (vatDeliveryObject[0] !== 'bringOutYourDead') {
    return;
  }
  return snapshotHeap();
}

async function handleCommand(command) {
  const [type, ...margs] = command;
  workerLog(`received`, type);
  switch (type) {
    case 'start':
      return handleStart(margs);
    case 'setBundle':
      return handleSetBundle(margs);
    case 'deliver':
      return handleDeliver(margs);
    default:
      throw Error(`unrecognized downlink message ${type}`);
  }
}

async function loop() {
  await 47; // I can wait for anything, so I choose 47.  It's the most ideal number.
  for (;;) {
    const command = fromParent.read();
    await handleCommand(command);
  }
}

loop().catch(err => console.log(`error in loop`, err));