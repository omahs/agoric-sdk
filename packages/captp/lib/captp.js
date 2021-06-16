// @ts-check

// Your app may need to `import '@agoric/eventual-send/shim'` to get HandledPromise

// This logic was mostly lifted from @agoric/swingset-vat liveSlots.js
// Defects in it are mfig's fault.
import {
  Remotable as defaultRemotable,
  Far as defaultFar,
  makeMarshal as defaultMakeMarshal,
  QCLASS,
} from '@agoric/marshal';
import { E, HandledPromise } from '@agoric/eventual-send';
import { isPromise } from '@agoric/promise-kit';
import { assert, details as X } from '@agoric/assert';

import { makeTrap, nearTrapImpl } from './trap.js';
import { makeTrapGuest, makeTrapHost } from './trap-driver.js';

import './types.js';

export { E };

/**
 * @template T
 * @typedef {import('@agoric/eventual-send').ERef<T>} ERef
 */

/**
 * @typedef {Object} CapTPOptions the options to makeCapTP
 * @property {(err: any) => void} onReject
 * @property {typeof defaultRemotable} Remotable
 * @property {typeof defaultFar} Far
 * @property {typeof defaultMakeMarshal} makeMarshal
 * @property {number} epoch an integer tag to attach to all messages in order to
 * assist in ignoring earlier defunct instance's messages
 * @property {TakeTrapReply} takeTrapReply if specified, enable this CapTP
 * (guest) to use Trap(target) to block while the recipient (host) resolves and
 * communicates the message
 * @property {GiveTrapReply} giveTrapReply if specified, enable this CapTP
 * (host) to serve objects marked with makeTrapHandler to synchronous clients
 * (guests)
 */

/**
 * Create a CapTP connection.
 *
 * @param {string} ourId our name for the current side
 * @param {(obj: Record<string, any>) => void} rawSend send a JSONable packet
 * @param {any} bootstrapObj the object to export to the other side
 * @param {Partial<CapTPOptions>} opts options to the connection
 */
export function makeCapTP(ourId, rawSend, bootstrapObj = undefined, opts = {}) {
  const {
    onReject = err => console.error('CapTP', ourId, 'exception:', err),
    Remotable = defaultRemotable,
    makeMarshal = defaultMakeMarshal,
    Far = defaultFar,
    epoch = 0,
    takeTrapReply,
    giveTrapReply,
  } = opts;

  const disconnectReason = id =>
    Error(`${JSON.stringify(id)} connection closed`);

  /** @type {any} */
  let unplug = false;
  async function quietReject(reason = undefined, returnIt = true) {
    if ((unplug === false || reason !== unplug) && reason !== undefined) {
      onReject(reason);
    }
    if (!returnIt) {
      return Promise.resolve();
    }

    // Silence the unhandled rejection warning, but don't affect
    // the user's handlers.
    const p = Promise.reject(reason);
    p.catch(_ => {});
    return p;
  }

  /**
   * @param {Record<string, any>} obj
   */
  function send(obj) {
    // Don't throw here if unplugged, just don't send.
    if (unplug === false) {
      rawSend(obj);
    }
  }

  // convertValToSlot and convertSlotToVal both perform side effects,
  // populating the c-lists (imports/exports/questions/answers) upon
  // marshalling/unmarshalling.  As we traverse the datastructure representing
  // the message, we discover what we need to import/export and send relevant
  // messages across the wire.
  const { serialize, unserialize } = makeMarshal(
    // eslint-disable-next-line no-use-before-define
    convertValToSlot,
    // eslint-disable-next-line no-use-before-define
    convertSlotToVal,
    {
      marshalName: `captp:${ourId}`,
      // TODO Temporary hack.
      // See https://github.com/Agoric/agoric-sdk/issues/2780
      errorIdNum: 20000,
    },
  );

  const trapHost = giveTrapReply && makeTrapHost();
  const trapGuest = takeTrapReply && makeTrapGuest(unserialize);

  /** @type {WeakMap<any, string>} */
  const valToSlot = new WeakMap(); // exports looked up by val
  const slotToVal = new Map(); // reverse
  const exportedTrapHandlers = new WeakSet();

  // Used to construct slot names for promises/non-promises.
  // In this verison of CapTP we use strings for export/import slot names.
  // prefixed with 'p' if promises and 'o' otherwise;
  let lastPromiseID = 0;
  let lastExportID = 0;
  // Since we decide the numbers for questions, we use this to increment
  // the question key
  let lastQuestionID = 0;

  /** @type {Map<number, any>} */
  const questions = new Map(); // chosen by us
  /** @type {Map<number, any>} */
  const answers = new Map(); // chosen by our peer
  /** @type {Map<number, any>} */
  const imports = new Map(); // chosen by our peer

  // Called at marshalling time.  Either retrieves an existing export, or if
  // not yet exported, records this exported object.  If a promise, sets up a
  // promise listener to inform the other side when the promise is
  // fulfilled/broken.
  function convertValToSlot(val) {
    if (!valToSlot.has(val)) {
      // new export
      let slot;
      if (isPromise(val)) {
        // This is a promise, so we're going to increment the lastPromiseId
        // and use that to construct the slot name.  Promise slots are prefaced
        // with 'p+'.
        lastPromiseID += 1;
        const promiseID = lastPromiseID;
        slot = `p+${promiseID}`;
        // Set up promise listener to inform other side when this promise
        // is fulfilled/broken
        val.then(
          res =>
            send({
              type: 'CTP_RESOLVE',
              promiseID,
              res: serialize(harden(res)),
            }),
          rej =>
            send({
              type: 'CTP_RESOLVE',
              promiseID,
              rej: serialize(harden(rej)),
            }),
        );
      } else {
        // Since this isn't a promise, we instead increment the lastExportId and
        // use that to construct the slot name.  Non-promises are prefaced with
        // 'o+' for normal objects, or `t+` for syncable.
        lastExportID += 1;
        const exportID = lastExportID;
        if (exportedTrapHandlers.has(val)) {
          slot = `t+${exportID}`;
        } else {
          slot = `o+${exportID}`;
        }
      }
      // Now record the export in both valToSlot and slotToVal so we can look it
      // up from either the value or the slot name later.
      valToSlot.set(val, slot);
      slotToVal.set(slot, val);
    }
    // At this point, the value is guaranteed to be exported, so return the
    // associated slot number.
    return valToSlot.get(val);
  }

  /**
   * Generate a new question in the questions table and set up a new
   * remote handled promise.
   *
   * @returns {[number, ReturnType<typeof makeRemoteKit>]}
   */
  function makeQuestion() {
    lastQuestionID += 1;
    const questionID = lastQuestionID;
    // eslint-disable-next-line no-use-before-define
    const pr = makeRemoteKit(questionID);
    questions.set(questionID, pr);

    // To fix #2846:
    // We return 'p' to the handler, and the eventual resolution of 'p' will
    // be used to resolve the caller's Promise, but the caller never sees 'p'
    // itself. The caller got back their Promise before the handler ever got
    // invoked, and thus before queueMessage was called. If that caller
    // passes the Promise they received as argument or return value, we want
    // it to serialize as resultVPID. And if someone passes resultVPID to
    // them, we want the user-level code to get back that Promise, not 'p'.
    lastPromiseID += 1;
    const promiseID = lastPromiseID;
    const resultVPID = `p+${promiseID}`;
    valToSlot.set(pr.p, resultVPID);
    slotToVal.set(resultVPID, pr.p);

    return [questionID, pr];
  }

  // Make a remote promise for `target` (an id in the questions table)
  function makeRemoteKit(target) {
    // This handler is set up such that it will transform both
    // attribute access and method invocation of this remote promise
    // as also being questions / remote handled promises
    const handler = {
      get(_o, prop) {
        if (unplug !== false) {
          return quietReject(unplug);
        }
        const [questionID, pr] = makeQuestion();
        send({
          type: 'CTP_CALL',
          epoch,
          questionID,
          target,
          method: serialize(harden([prop])),
        });
        return harden(pr.p);
      },
      applyFunction(_o, args) {
        if (unplug !== false) {
          return quietReject(unplug);
        }
        const [questionID, pr] = makeQuestion();
        send({
          type: 'CTP_CALL',
          epoch,
          questionID,
          target,
          method: serialize(harden([null, args])),
        });
        return harden(pr.p);
      },
      applyMethod(_o, prop, args) {
        if (unplug !== false) {
          return quietReject(unplug);
        }
        // Support: o~.[prop](...args) remote method invocation
        const [questionID, pr] = makeQuestion();
        send({
          type: 'CTP_CALL',
          epoch,
          questionID,
          target,
          method: serialize(harden([prop, args])),
        });
        return harden(pr.p);
      },
    };

    const pr = {};
    pr.p = new HandledPromise((res, rej, resolveWithPresence) => {
      pr.rej = rej;
      pr.resPres = () => resolveWithPresence(handler);
      pr.res = res;
    }, handler);

    // Silence the unhandled rejection warning, but don't affect
    // the user's handlers.
    pr.p.catch(e => quietReject(e, false));

    return harden(pr);
  }

  // Set up import
  function convertSlotToVal(theirSlot, iface = undefined) {
    let val;
    // Invert slot direction from other side.

    // Inverted to prevent namespace collisions between slots we
    // allocate and the ones the other side allocates.  If we allocate
    // a slot, serialize it to the other side, and they send it back to
    // us, we need to reference just our own slot, not one from their
    // side.
    const otherDir = theirSlot[1] === '+' ? '-' : '+';
    const slot = `${theirSlot[0]}${otherDir}${theirSlot.slice(2)}`;
    if (!slotToVal.has(slot)) {
      // Make a new handled promise for the slot.
      const pr = makeRemoteKit(slot);
      if (slot[0] === 'o' || slot[0] === 't') {
        // A new remote presence
        const pres = pr.resPres();
        if (iface === undefined) {
          iface = `Alleged: Presence ${ourId} ${slot}`;
        }
        val = Remotable(iface, undefined, pres);
      } else {
        // A new promise
        imports.set(Number(slot.slice(2)), pr);
        val = pr.p;
      }
      slotToVal.set(slot, val);
      valToSlot.set(val, slot);
    }
    return slotToVal.get(slot);
  }

  // Message handler used for CapTP dispatcher
  const handler = {
    // Remote is asking for bootstrap object
    async CTP_BOOTSTRAP(obj) {
      const { questionID } = obj;
      const bootstrap =
        typeof bootstrapObj === 'function' ? bootstrapObj(obj) : bootstrapObj;
      E.when(bootstrap, bs => {
        // console.log('sending bootstrap', bootstrap);
        answers.set(questionID, bs);
        return send({
          type: 'CTP_RETURN',
          epoch,
          answerID: questionID,
          result: serialize(bs),
        });
      });
    },
    // Remote is invoking a method or retrieving a property.
    async CTP_CALL(obj) {
      // questionId: Remote promise (for promise pipelining) this call is
      //   to fulfill
      // target: Slot id of the target to be invoked.  Checks against
      //   answers first; otherwise goes through unserializer
      const { questionID, target, trap } = obj;

      const [prop, args] = unserialize(obj.method);
      let val;
      if (answers.has(target)) {
        val = answers.get(target);
      } else {
        val = unserialize({
          body: JSON.stringify({
            [QCLASS]: 'slot',
            index: 0,
          }),
          slots: [target],
        });
      }

      /** @type {(isReject: boolean, value: any) => void} */
      let sendReturn = (isReject, value) => {
        send({
          type: 'CTP_RETURN',
          epoch,
          answerID: questionID,
          [isReject ? 'exception' : 'result']: serialize(harden(value)),
        });
      };
      if (trap) {
        try {
          assert(
            exportedTrapHandlers.has(val),
            X`Refused Trap(${val}) because target was not registered with makeTrapHandler`,
          );
          assert.typeof(
            giveTrapReply,
            'function',
            X`CapTP cannot answer Trap(x) without opts.giveTrapReply`,
          );
          assert(trapHost, X`CatTP internal error; trapHost is not defined`);
          sendReturn = async (isReject, value) => {
            const serialized = serialize(harden(value));
            const it = giveTrapReply(isReject, serialized);
            await trapHost.sendTrapReply(questionID, it);
          };
        } catch (e) {
          sendReturn(true, e);
          throw e;
        }
      }

      // If `args` is supplied, we're applying a method or function... otherwise this is
      // property access
      let hp;
      if (!args) {
        hp = HandledPromise.get(val, prop);
      } else if (prop === null) {
        hp = HandledPromise.applyFunction(val, args);
      } else {
        hp = HandledPromise.applyMethod(val, prop, args);
      }

      // Answer with our handled promise
      answers.set(questionID, hp);

      // Set up promise resolver for this handled promise to send
      // message to other vat when fulfilled/broken.
      return hp
        .then(res => sendReturn(false, res))
        .catch(rej => sendReturn(true, rej))
        .catch(rej => quietReject(rej, false));
    },
    // Have the host serve the next buffer request.
    CTP_TRAP_NEXT_BUFFER:
      trapHost && (obj => trapHost.trapNextBuffer(obj.questionID, obj.trapBuf)),
    // Answer to one of our questions.
    async CTP_RETURN(obj) {
      const { result, exception, answerID } = obj;
      if (!questions.has(answerID)) {
        throw new Error(
          `Got an answer to a question we have not asked. (answerID = ${answerID} )`,
        );
      }
      const pr = questions.get(answerID);
      if ('exception' in obj) {
        pr.rej(unserialize(exception));
      } else {
        pr.res(unserialize(result));
      }
    },
    // Resolution to an imported promise
    async CTP_RESOLVE(obj) {
      const { promiseID, res, rej } = obj;
      if (!imports.has(promiseID)) {
        throw new Error(
          `Got a resolvement of a promise we have not imported. (promiseID = ${promiseID} )`,
        );
      }
      const pr = imports.get(promiseID);
      if ('rej' in obj) {
        pr.rej(unserialize(rej));
      } else {
        pr.res(unserialize(res));
      }
      imports.delete(promiseID);
    },
    // The other side has signaled something has gone wrong.
    // Pull the plug!
    async CTP_DISCONNECT(obj) {
      const { reason = disconnectReason(ourId) } = obj;
      if (unplug === false) {
        // Reject with the original reason.
        quietReject(obj.reason, false);
        unplug = reason;
        // Deliver the object, even though we're unplugged.
        rawSend(obj);
      }
      for (const pr of questions.values()) {
        pr.rej(reason);
      }
      for (const pr of imports.values()) {
        pr.rej(reason);
      }
    },
  };

  // Get a reference to the other side's bootstrap object.
  const getBootstrap = async () => {
    if (unplug !== false) {
      return quietReject(unplug);
    }
    const [questionID, pr] = makeQuestion();
    send({
      type: 'CTP_BOOTSTRAP',
      epoch,
      questionID,
    });
    return harden(pr.p);
  };
  harden(handler);

  // Return a dispatch function.
  const dispatch = obj => {
    try {
      if (unplug !== false) {
        return false;
      }
      const fn = handler[obj.type];
      if (fn) {
        fn(obj).catch(e => quietReject(e, false));
        return true;
      }
      return false;
    } catch (e) {
      quietReject(e, false);
      return false;
    }
  };

  // Abort a connection.
  const abort = (reason = undefined) => {
    dispatch({ type: 'CTP_DISCONNECT', epoch, reason });
  };

  const makeTrapHandler = (name, obj) => {
    const far = Far(name, obj);
    exportedTrapHandlers.add(far);
    return far;
  };

  // Put together our return value.
  const rets = {
    abort,
    dispatch,
    getBootstrap,
    serialize,
    unserialize,
    makeTrapHandler,
    Trap: /** @type {Trap | undefined} */ (undefined),
  };

  if (takeTrapReply) {
    // Create the Trap proxy maker.
    const makeTrapImpl = implMethod => (target, ...implArgs) => {
      assert(
        Promise.resolve(target) !== target,
        X`Trap(${target}) target cannot be a promise`,
      );

      const slot = valToSlot.get(target);
      assert(
        slot && slot[1] === '-',
        X`Trap(${target}) target was not imported`,
      );
      assert(
        slot[0] === 't',
        X`Trap(${target}) imported target was not created with makeTrapHandler`,
      );
      assert(
        takeTrapReply,
        X`Trap(${target}) failed; no opts.takeTrapReply supplied to makeCapTP`,
      );

      // Send a "trap" message.
      lastQuestionID += 1;
      const questionID = lastQuestionID;

      // Encode the "method" parameter of the CTP_CALL.
      let method;
      switch (implMethod) {
        case 'get': {
          const [prop] = implArgs;
          method = serialize(harden([prop]));
          break;
        }
        case 'applyFunction': {
          const [args] = implArgs;
          method = serialize(harden([null, args]));
          break;
        }
        case 'applyMethod': {
          const [prop, args] = implArgs;
          method = serialize(harden([prop, args]));
          break;
        }
        default: {
          assert.fail(X`Internal error; unrecognized implMethod ${implMethod}`);
        }
      }

      assert(trapGuest, X`Trap(${target}) internal error; no trapGuest`);

      // Set up the trap call with its identifying information.
      const takeIt = takeTrapReply(implMethod, slot, implArgs);
      return trapGuest.doTrap(
        takeIt,
        () =>
          send({
            type: 'CTP_CALL',
            epoch,
            trap: true, // This is the magic marker.
            questionID,
            target: slot,
            method,
          }),
        trapBuf =>
          send({
            type: 'CTP_TRAP_NEXT_BUFFER',
            epoch,
            questionID,
            trapBuf,
          }),
      );
    };

    /** @type {TrapImpl} */
    const trapImpl = {
      applyFunction: makeTrapImpl('applyFunction'),
      applyMethod: makeTrapImpl('applyMethod'),
      get: makeTrapImpl('get'),
    };
    harden(trapImpl);

    rets.Trap = makeTrap(trapImpl);
  }

  return harden(rets);
}

/**
 * @typedef {Object} LoopbackOpts
 * @property {typeof defaultFar} Far
 */

/**
 * Create an async-isolated channel to an object.
 *
 * @param {string} ourId
 * @param {Partial<LoopbackOpts>} [opts]
 * @returns {{ makeFar<T>(x: T): ERef<T>, makeNear<T>(x: T): ERef<T>,
 * makeTrapHandler<T>(x: T): T, Trap: Trap }}
 */
export function makeLoopback(ourId, opts = {}) {
  const { Far = defaultFar } = opts;
  let nextNonce = 0;
  const nonceToRef = new Map();

  const bootstrap = harden({
    refGetter: Far('refGetter', {
      getRef(nonce) {
        // Find the local ref for the specified nonce.
        const xFar = nonceToRef.get(nonce);
        nonceToRef.delete(nonce);
        return xFar;
      },
    }),
  });

  const slotBody = JSON.stringify({
    '@qclass': 'slot',
    index: 0,
  });

  // Create the tunnel.
  let farDispatch;
  const {
    Trap,
    dispatch: nearDispatch,
    getBootstrap: getFarBootstrap,
  } = makeCapTP(`near-${ourId}`, o => farDispatch(o), bootstrap, {
    // eslint-disable-next-line require-yield
    *takeTrapReply(implMethod, slot, implArgs) {
      let value;
      let isException = false;
      try {
        // Cross the boundary to pull out the far object.
        // eslint-disable-next-line no-use-before-define
        const far = farUnserialize({ body: slotBody, slots: [slot] });
        value = nearTrapImpl[implMethod](far, implArgs[0], implArgs[1]);
      } catch (e) {
        isException = true;
        value = e;
      }
      harden(value);
      // eslint-disable-next-line no-use-before-define
      return [isException, farSerialize(value)];
    },
  });
  assert(Trap);

  const {
    makeTrapHandler,
    dispatch,
    getBootstrap: getNearBootstrap,
    unserialize: farUnserialize,
    serialize: farSerialize,
  } = makeCapTP(`far-${ourId}`, nearDispatch, bootstrap, {
    giveTrapReply(_isReject, _serialized) {
      throw Error(`makeLoopback giveTrapReply is not expected to be called`);
    },
  });
  farDispatch = dispatch;

  const farGetter = E.get(getFarBootstrap()).refGetter;
  const nearGetter = E.get(getNearBootstrap()).refGetter;

  /**
   * @param {ERef<{ getRef(nonce: number): any }>} refGetter
   */
  const makeRefMaker = refGetter =>
    /**
     * @param {any} x
     */
    async x => {
      const myNonce = nextNonce;
      nextNonce += 1;
      nonceToRef.set(myNonce, harden(x));
      return E(refGetter).getRef(myNonce);
    };

  return {
    makeFar: makeRefMaker(farGetter),
    makeNear: makeRefMaker(nearGetter),
    makeTrapHandler,
    Trap,
  };
}
