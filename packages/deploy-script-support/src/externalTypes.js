// @ts-check
export {};

// TODO move this type somewhere better
/**
 * @typedef {string | string[]} Petname A petname can either be a plain string
 * or a path for which the first element is a petname for the origin, and the
 * rest of the elements are a snapshot of the names that were first given by that
 * origin.  We are migrating away from using plain strings, for consistency.
 */

/**
 * @typedef ProposalResult
 * @property {string} sourceSpec
 * @property {[exportedGetManifest: string, ...manifestArgs: any[]]} getManifestCall
 */

/**
 * @callback PublishBundleRef
 * @param {ERef<VatSourceRef>} bundle
 * @returns {Promise<VatSourceRef>}
 */

/**
 * @callback InstallBundle
 * @param {string} srcSpec
 * @param {string} bundlePath
 * @param {any} [opts]
 * @returns {ERef<VatSourceRef>}
 */

/**
 * @callback ProposalBuilder
 * @param {{
 *   publishRef: PublishBundleRef,
 *   install: InstallBundle,
 *   wrapInstall?: <T>(f: T) => T }
 * } powers
 * @param {...any} args
 * @returns {Promise<ProposalResult>}
 */
