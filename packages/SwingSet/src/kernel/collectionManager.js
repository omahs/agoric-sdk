// @ts-check
import { assert, details as X, q } from '@agoric/assert';
import {
  getRankCover,
  assertKeyPattern,
  assertPattern,
  matches,
  compareRank,
  M,
  BIGINT_TAG_LEN,
  zeroPad,
  makeEncodeKey,
  makeDecodeKey,
} from '@agoric/store';
import { Far, passStyleOf } from '@endo/marshal';
import { parseVatSlot } from '../parseVatSlots.js';

const pattEq = (p1, p2) => compareRank(p1, p2) === 0;

export const makeCollectionManager = (
  syscall,
  vrm,
  allocateExportID,
  convertValToSlot,
  convertSlotToVal,
  registerEntry,
  serialize,
  unserialize,
) => {
  const storeKindIDToName = new Map();

  let storeKindInfoNeedsInitialization = true;
  const storeKindInfo = {
    scalarMapStore: {
      hasWeakKeys: false,
      kindID: 0,
      // eslint-disable-next-line no-use-before-define
      reanimator: reanimateScalarMapStore,
      durable: false,
    },
    scalarWeakMapStore: {
      hasWeakKeys: true,
      kindID: 0,
      // eslint-disable-next-line no-use-before-define
      reanimator: reanimateScalarWeakMapStore,
      durable: false,
    },
    scalarSetStore: {
      hasWeakKeys: false,
      kindID: 0,
      // eslint-disable-next-line no-use-before-define
      reanimator: reanimateScalarSetStore,
      durable: false,
    },
    scalarWeakSetStore: {
      hasWeakKeys: true,
      kindID: 0,
      // eslint-disable-next-line no-use-before-define
      reanimator: reanimateScalarWeakSetStore,
      durable: false,
    },
    scalarDurableMapStore: {
      hasWeakKeys: false,
      kindID: 0,
      // eslint-disable-next-line no-use-before-define
      reanimator: reanimateScalarMapStore,
      durable: true,
    },
    scalarDurableWeakMapStore: {
      hasWeakKeys: true,
      kindID: 0,
      // eslint-disable-next-line no-use-before-define
      reanimator: reanimateScalarWeakMapStore,
      durable: true,
    },
    scalarDurableSetStore: {
      hasWeakKeys: false,
      kindID: 0,
      // eslint-disable-next-line no-use-before-define
      reanimator: reanimateScalarSetStore,
      durable: true,
    },
    scalarDurableWeakSetStore: {
      hasWeakKeys: true,
      kindID: 0,
      // eslint-disable-next-line no-use-before-define
      reanimator: reanimateScalarWeakSetStore,
      durable: true,
    },
  };

  const prefixc = (collectionID, dbEntryKey) =>
    `vc.${collectionID}.${dbEntryKey}`;

  const obtainStoreKindID = kindName => {
    if (storeKindInfoNeedsInitialization) {
      storeKindInfoNeedsInitialization = false;

      let storeKindIDs = {};
      const rawTable = syscall.vatstoreGet('storeKindIDTable');
      if (rawTable) {
        storeKindIDs = JSON.parse(rawTable);
      }
      for (const kind of Object.getOwnPropertyNames(storeKindInfo)) {
        let kindID = storeKindIDs[kind];
        if (!kindID) {
          kindID = allocateExportID();
          storeKindIDs[kind] = kindID;
        }
        storeKindInfo[kind].kindID = kindID;
        storeKindIDToName.set(`${kindID}`, kind);
        vrm.registerKind(
          kindID,
          storeKindInfo[kind].reanimator,
          // eslint-disable-next-line no-use-before-define
          deleteCollection,
          storeKindInfo[kind].durable,
        );
      }
      syscall.vatstoreSet('storeKindIDTable', JSON.stringify(storeKindIDs));
    }
    return storeKindInfo[kindName].kindID;
  };

  const summonCollectionInternal = (
    _initial,
    label,
    collectionID,
    kindName,
    keySchema = M.any(),
    valueSchema,
  ) => {
    const { hasWeakKeys, durable } = storeKindInfo[kindName];
    const dbKeyPrefix = `vc.${collectionID}.`;
    let currentGenerationNumber = 0;

    const prefix = dbEntryKey => `${dbKeyPrefix}${dbEntryKey}`;

    const encodeRemotable = remotable => {
      // eslint-disable-next-line no-use-before-define
      const ordinal = getOrdinal(remotable);
      assert(ordinal !== undefined, X`no ordinal for ${remotable}`);
      const ordinalTag = zeroPad(ordinal, BIGINT_TAG_LEN);
      return `r${ordinalTag}:${convertValToSlot(remotable)}`;
    };

    const encodeKey = makeEncodeKey(encodeRemotable);

    const decodeRemotable = encodedKey =>
      convertSlotToVal(encodedKey.substring(BIGINT_TAG_LEN + 2));

    const decodeKey = makeDecodeKey(decodeRemotable);

    const generateOrdinal = remotable => {
      const nextOrdinal = Number.parseInt(
        syscall.vatstoreGet(prefix('|nextOrdinal')),
        10,
      );
      syscall.vatstoreSet(
        prefix(`|${convertValToSlot(remotable)}`),
        `${nextOrdinal}`,
      );
      syscall.vatstoreSet(prefix('|nextOrdinal'), `${nextOrdinal + 1}`);
    };

    const getOrdinal = remotable =>
      syscall.vatstoreGet(prefix(`|${convertValToSlot(remotable)}`));

    const deleteOrdinal = remotable => {
      syscall.vatstoreDelete(prefix(`|${convertValToSlot(remotable)}`));
    };

    const keyToDBKey = key => prefix(encodeKey(key));

    const dbKeyToKey = dbKey => {
      const dbEntryKey = dbKey.substring(dbKeyPrefix.length);
      return decodeKey(dbEntryKey);
    };

    const has = key => {
      if (!matches(key, keySchema)) {
        return false;
      }
      if (passStyleOf(key) === 'remotable') {
        return getOrdinal(key) !== undefined;
      } else {
        return syscall.vatstoreGet(keyToDBKey(key)) !== undefined;
      }
    };

    const get = key => {
      assert(
        matches(key, keySchema),
        X`invalid key type for collection ${q(label)}`,
      );
      const result = syscall.vatstoreGet(keyToDBKey(key));
      if (result) {
        return unserialize(JSON.parse(result));
      }
      assert.fail(X`key ${key} not found in collection ${q(label)}`);
    };

    const updateEntryCount = delta => {
      if (!hasWeakKeys) {
        const entryCount = Number.parseInt(
          syscall.vatstoreGet(prefix('|entryCount')),
          10,
        );
        syscall.vatstoreSet(prefix('|entryCount'), `${entryCount + delta}`);
      }
    };

    const entryDeleter = vobjID => {
      const ordinalKey = prefix(`|${vobjID}`);
      const ordinalString = syscall.vatstoreGet(ordinalKey);
      syscall.vatstoreDelete(ordinalKey);
      const ordinalTag = zeroPad(ordinalString, BIGINT_TAG_LEN);
      syscall.vatstoreDelete(prefix(`r${ordinalTag}:${vobjID}`));
    };

    const init = (key, value) => {
      assert(
        matches(key, keySchema),
        X`invalid key type for collection ${q(label)}`,
      );
      assert(
        !has(key),
        X`key ${key} already registered in collection ${q(label)}`,
      );
      if (valueSchema) {
        assert(
          matches(value, valueSchema),
          X`invalid value type for collection ${q(label)}`,
        );
      }
      currentGenerationNumber += 1;
      const serializedValue = serialize(value);
      if (durable) {
        serializedValue.slots.map(vref =>
          assert(vrm.isDurable(vref), X`value is not durable`),
        );
      }
      if (passStyleOf(key) === 'remotable') {
        const vref = convertValToSlot(key);
        if (durable) {
          assert(vrm.isDurable(vref), X`key is not durable`);
        }
        generateOrdinal(key);
        if (hasWeakKeys) {
          vrm.addRecognizableValue(key, entryDeleter);
        } else {
          vrm.addReachableVref(vref);
        }
      }
      serializedValue.slots.map(vrm.addReachableVref);
      syscall.vatstoreSet(keyToDBKey(key), JSON.stringify(serializedValue));
      updateEntryCount(1);
    };

    const set = (key, value) => {
      assert(
        matches(key, keySchema),
        X`invalid key type for collection ${q(label)}`,
      );
      if (valueSchema) {
        assert(
          matches(value, valueSchema),
          X`invalid value type for collection ${q(label)}`,
        );
      }
      const after = serialize(harden(value));
      if (durable) {
        after.slots.map(vref =>
          assert(vrm.isDurable(vref), X`value is not durable`),
        );
      }
      const dbKey = keyToDBKey(key);
      const rawBefore = syscall.vatstoreGet(dbKey);
      assert(rawBefore, X`key ${key} not found in collection ${q(label)}`);
      const before = JSON.parse(rawBefore);
      vrm.updateReferenceCounts(before.slots, after.slots);
      syscall.vatstoreSet(dbKey, JSON.stringify(after));
    };

    const deleteInternal = key => {
      assert(
        matches(key, keySchema),
        X`invalid key type for collection ${q(label)}`,
      );
      const dbKey = keyToDBKey(key);
      const rawValue = syscall.vatstoreGet(dbKey);
      assert(rawValue, X`key ${key} not found in collection ${q(label)}`);
      const value = JSON.parse(rawValue);
      value.slots.map(vrm.removeReachableVref);
      syscall.vatstoreDelete(dbKey);
      let doMoreGC = false;
      if (passStyleOf(key) === 'remotable') {
        deleteOrdinal(key);
        if (hasWeakKeys) {
          vrm.removeRecognizableValue(key, entryDeleter);
        } else {
          doMoreGC = vrm.removeReachableVref(convertValToSlot(key));
        }
      }
      return doMoreGC;
    };

    const del = key => {
      deleteInternal(key);
      updateEntryCount(-1);
    };

    const entriesInternal = (
      needKeys,
      needValues,
      keyPatt = M.any(),
      valuePatt = M.any(),
    ) => {
      assert(needKeys || needValues);
      assertKeyPattern(keyPatt);
      assertPattern(valuePatt);
      const [coverStart, coverEnd] = getRankCover(keyPatt, encodeKey);
      let priorDBKey = '';
      const start = prefix(coverStart);
      const end = prefix(coverEnd);
      const ignoreKeys = !needKeys && pattEq(keyPatt, M.any());
      const ignoreValues = !needValues && pattEq(valuePatt, M.any());
      function* iter() {
        const generationAtStart = currentGenerationNumber;
        while (priorDBKey !== undefined) {
          assert(
            generationAtStart === currentGenerationNumber,
            X`keys in store cannot be added to during iteration`,
          );
          const [dbKey, dbValue] = syscall.vatstoreGetAfter(
            priorDBKey,
            start,
            end,
          );
          if (!dbKey) {
            break;
          }
          if (dbKey < end) {
            priorDBKey = dbKey;
            if (ignoreKeys) {
              const value = unserialize(JSON.parse(dbValue));
              if (matches(value, valuePatt)) {
                yield [undefined, value];
              }
            } else if (ignoreValues) {
              const key = dbKeyToKey(dbKey);
              if (matches(key, keyPatt)) {
                yield [key, undefined];
              }
            } else {
              const key = dbKeyToKey(dbKey);
              if (matches(key, keyPatt)) {
                const value = unserialize(JSON.parse(dbValue));
                if (matches(value, valuePatt)) {
                  yield [key, value];
                }
              }
            }
          }
        }
      }
      return iter();
    };

    const keys = (keyPatt, valuePatt) => {
      function* iter() {
        for (const entry of entriesInternal(true, false, keyPatt, valuePatt)) {
          yield entry[0];
        }
      }
      return iter();
    };

    const clearInternal = (isDeleting, keyPatt, valuePatt) => {
      let doMoreGC = false;
      for (const k of keys(keyPatt, valuePatt)) {
        doMoreGC = doMoreGC || deleteInternal(k);
      }
      if (!hasWeakKeys && !isDeleting) {
        syscall.vatstoreSet(prefix('|entryCount'), '0');
      }
      return doMoreGC;
    };

    const clear = (keyPatt, valuePatt) => {
      clearInternal(false, keyPatt, valuePatt);
    };

    const values = (keyPatt, valuePatt) => {
      function* iter() {
        for (const entry of entriesInternal(false, true, keyPatt, valuePatt)) {
          yield entry[1];
        }
      }
      return iter();
    };

    const entries = (keyPatt, valuePatt) => {
      function* iter() {
        for (const entry of entriesInternal(true, true, keyPatt, valuePatt)) {
          yield entry;
        }
      }
      return iter();
    };

    const countEntries = (keyPatt, valuePatt) => {
      let count = 0;
      // eslint-disable-next-line no-use-before-define, no-unused-vars
      for (const k of keys(keyPatt, valuePatt)) {
        count += 1;
      }
      return count;
    };

    const getSize = (keyPatt, valuePatt) => {
      if (
        (keyPatt === undefined || pattEq(keyPatt, M.any())) &&
        (valuePatt === undefined || pattEq(valuePatt, M.any()))
      ) {
        return Number.parseInt(syscall.vatstoreGet(prefix('|entryCount')), 10);
      }
      return countEntries(keyPatt, valuePatt);
    };

    const sizeInternal = () => countEntries();

    const snapshot = () => {
      assert.fail(X`snapshot not yet implemented`);
    };

    return {
      has,
      get,
      getSize,
      init,
      set,
      delete: del,
      keys,
      values,
      entries,
      snapshot,
      sizeInternal,
      clear,
      clearInternal,
    };
  };

  const summonCollection = (
    initial,
    label,
    collectionID,
    kindName,
    keySchema,
    valueSchema,
  ) => {
    const hasWeakKeys = storeKindInfo[kindName].hasWeakKeys;
    const raw = summonCollectionInternal(
      initial,
      label,
      collectionID,
      kindName,
      keySchema,
      valueSchema,
    );

    const { has, get, init, set, delete: del } = raw;
    const weakMethods = {
      has,
      get,
      init,
      set,
      delete: del,
    };

    let collection;
    if (hasWeakKeys) {
      collection = weakMethods;
    } else {
      const { keys, values, entries, sizeInternal, getSize, snapshot, clear } =
        raw;
      collection = {
        ...weakMethods,
        keys,
        values,
        entries,
        sizeInternal,
        getSize,
        snapshot,
        clear,
      };
    }
    return collection;
  };

  const storeSizeInternal = vobjID => {
    const { id, subid } = parseVatSlot(vobjID);
    const kindName = storeKindIDToName.get(`${id}`);
    const collection = summonCollectionInternal(false, 'test', subid, kindName);
    return collection.sizeInternal();
  };

  const deleteCollection = vobjID => {
    const { id, subid } = parseVatSlot(vobjID);
    const kindName = storeKindIDToName.get(`${id}`);
    const collection = summonCollectionInternal(false, 'GC', subid, kindName);

    const doMoreGC = collection.clearInternal(true);
    let priorKey = '';
    const keyPrefix = prefixc(subid, '|');
    while (priorKey !== undefined) {
      [priorKey] = syscall.vatstoreGetAfter(priorKey, keyPrefix);
      if (!priorKey) {
        break;
      }
      syscall.vatstoreDelete(priorKey);
    }
    return doMoreGC;
  };

  let nextCollectionID = 1;

  const makeCollection = (label, kindName, keySchema, valueSchema) => {
    assert.typeof(label, 'string');
    assert(storeKindInfo[kindName]);
    assertKeyPattern(keySchema);
    const schemata = [keySchema];
    if (valueSchema) {
      assertPattern(valueSchema);
      schemata.push(valueSchema);
    }
    const collectionID = nextCollectionID;
    nextCollectionID += 1;
    const kindID = obtainStoreKindID(kindName);
    const vobjID = `o+${kindID}/${collectionID}`;

    syscall.vatstoreSet(prefixc(collectionID, '|nextOrdinal'), '1');
    const { hasWeakKeys } = storeKindInfo[kindName];
    if (!hasWeakKeys) {
      syscall.vatstoreSet(prefixc(collectionID, '|entryCount'), '0');
    }
    syscall.vatstoreSet(
      prefixc(collectionID, '|schemata'),
      JSON.stringify(serialize(harden(schemata))),
    );
    syscall.vatstoreSet(prefixc(collectionID, '|label'), label);

    return [
      vobjID,
      summonCollection(
        true,
        label,
        collectionID,
        kindName,
        keySchema,
        valueSchema,
      ),
    ];
  };

  const collectionToMapStore = collection => Far('mapStore', collection);

  const collectionToWeakMapStore = collection =>
    Far('weakMapStore', collection);

  const collectionToSetStore = collection => {
    const {
      has,
      init,
      delete: del,
      keys,
      sizeInternal,
      getSize,
      snapshot,
      clear,
    } = collection;
    function* entries(patt) {
      for (const k of keys(patt)) {
        yield [k, k];
      }
    }
    const addAll = elems => {
      for (const elem of elems) {
        init(elem, null);
      }
    };

    const setStore = {
      has,
      add: elem => init(elem, null),
      addAll,
      delete: del,
      keys: patt => keys(patt),
      values: patt => keys(patt),
      entries,
      sizeInternal,
      getSize: patt => getSize(patt),
      snapshot,
      clear,
    };
    return Far('setStore', setStore);
  };

  const collectionToWeakSetStore = collection => {
    const { has, init, delete: del } = collection;
    const addAll = elems => {
      for (const elem of elems) {
        init(elem, null);
      }
    };

    const weakSetStore = {
      has,
      add: elem => init(elem, null),
      addAll,
      delete: del,
    };
    return Far('weakSetStore', weakSetStore);
  };

  /**
   * Produce a *scalar* big map: keys can only be atomic values, primitives, or
   * remotables.
   *
   * @template K,V
   * @param {string} [label='map'] - diagnostic label for the store
   * @param {StoreOptions=} options
   * @returns {MapStore<K,V>}
   */
  const makeScalarBigMapStore = (
    label = 'map',
    { keySchema = M.scalar(), valueSchema = undefined, durable = false } = {},
  ) => {
    const kindName = durable ? 'scalarDurableMapStore' : 'scalarMapStore';
    const [vobjID, collection] = makeCollection(
      label,
      kindName,
      keySchema,
      valueSchema,
    );
    const store = collectionToMapStore(collection);
    registerEntry(vobjID, store);
    return store;
  };

  /**
   * Produce a *scalar* weak big map: keys can only be atomic values,
   * primitives, or remotables.
   *
   * @template K,V
   * @param {string} [label='weakMap'] - diagnostic label for the store
   * @param {StoreOptions=} options
   * @returns {WeakMapStore<K,V>}
   */
  const makeScalarBigWeakMapStore = (
    label = 'weakMap',
    { keySchema = M.scalar(), valueSchema = undefined, durable = false } = {},
  ) => {
    const kindName = durable
      ? 'scalarDurableWeakMapStore'
      : 'scalarWeakMapStore';
    const [vobjID, collection] = makeCollection(
      label,
      kindName,
      keySchema,
      valueSchema,
    );
    const store = collectionToWeakMapStore(collection);
    registerEntry(vobjID, store);
    return store;
  };

  /**
   * Produce a *scalar* big set: keys can only be atomic values, primitives, or
   * remotables.
   *
   * @template K
   * @param {string} [label='set'] - diagnostic label for the store
   * @param {StoreOptions=} options
   * @returns {SetStore<K>}
   */
  const makeScalarBigSetStore = (
    label = 'set',
    { keySchema = M.scalar(), valueSchema = undefined, durable = false } = {},
  ) => {
    const kindName = durable ? 'scalarDurableSetStore' : 'scalarSetStore';
    const [vobjID, collection] = makeCollection(
      label,
      kindName,
      keySchema,
      valueSchema,
    );
    const store = collectionToSetStore(collection);
    registerEntry(vobjID, store);
    return store;
  };

  /**
   * Produce a *scalar* weak big set: keys can only be atomic values,
   * primitives, or remotables.
   *
   * @template K
   * @param {string} [label='weakSet'] - diagnostic label for the store
   * @param {StoreOptions=} options
   * @returns {WeakSetStore<K>}
   */
  const makeScalarBigWeakSetStore = (
    label = 'weakSet',
    { keySchema = M.scalar(), valueSchema = undefined, durable = false } = {},
  ) => {
    const kindName = durable
      ? 'scalarDurableWeakSetStore'
      : 'scalarWeakSetStore';
    const [vobjID, collection] = makeCollection(
      label,
      kindName,
      keySchema,
      valueSchema,
    );
    const store = collectionToWeakSetStore(collection);
    registerEntry(vobjID, store);
    return store;
  };

  const reanimateCollection = vobjID => {
    const { id, subid } = parseVatSlot(vobjID);
    const kindName = storeKindIDToName.get(`${id}`);
    const rawSchemata = JSON.parse(
      syscall.vatstoreGet(prefixc(subid, '|schemata')),
    );
    const [keySchema, valueSchema] = unserialize(rawSchemata);
    const label = syscall.vatstoreGet(prefixc(subid, '|label'));
    return summonCollection(
      false,
      label,
      subid,
      kindName,
      keySchema,
      valueSchema,
    );
  };

  const reanimateScalarMapStore = (vobjID, proForma) =>
    proForma ? null : collectionToMapStore(reanimateCollection(vobjID));

  const reanimateScalarWeakMapStore = (vobjID, proForma) =>
    proForma ? null : collectionToWeakMapStore(reanimateCollection(vobjID));

  const reanimateScalarSetStore = (vobjID, proForma) =>
    proForma ? null : collectionToSetStore(reanimateCollection(vobjID));

  const reanimateScalarWeakSetStore = (vobjID, proForma) =>
    proForma ? null : collectionToWeakSetStore(reanimateCollection(vobjID));

  const testHooks = { storeSizeInternal, makeCollection };

  return harden({
    makeScalarBigMapStore,
    makeScalarBigWeakMapStore,
    makeScalarBigSetStore,
    makeScalarBigWeakSetStore,
    testHooks,
  });
};
