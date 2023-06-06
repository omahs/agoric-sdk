// @ts-check
import fs from 'fs';
import { E } from '@endo/far';
import { deeplyFulfilled } from '@endo/marshal';

import { createBundles } from '@agoric/internal/src/node/createBundles.js';
import { defangAndTrim, mergePermits, stringify } from './code-gen.js';
import { makeCoreProposalBehavior, permits } from './coreProposalBehavior.js';

/**
 *
 * @param {Promise<Record<string, unknown>>} homeP
 * @param {{ bundleSource: import('@endo/bundle-source').default, pathResolve: typeof import('path').join}} endowments
 * @param {object} helpers
 * @param {import('./cachedBundleSpec.js').CacheAndGetBundleSpec} helpers.getBundleSpec
 * @param {typeof console.log} [helpers.log]
 * @param {typeof fs.promises.writeFile} [helpers.writeFile]
 */
export const makeWriteCoreProposal = (
  homeP,
  endowments,
  { getBundleSpec, log = console.log, writeFile = fs.promises.writeFile },
) => {
  const { bundleSource, pathResolve } = endowments;

  const mergeProposalPermit = async (proposal, additionalPermits) => {
    const {
      sourceSpec,
      getManifestCall: [exportedGetManifest, ...manifestArgs],
    } = proposal;

    const manifestNs = await import(pathResolve(sourceSpec));

    // We only care about the manifest, not any restoreRef calls.
    const { manifest } = await manifestNs[exportedGetManifest](
      { restoreRef: x => `restoreRef:${x}` },
      ...manifestArgs,
    );

    const mergedPermits = mergePermits(manifest);
    return {
      manifest,
      permits: mergePermits({ mergedPermits, additionalPermits }),
    };
  };

  /** @type {ReturnType<import('./cachedBundleSpec.js').CacheAndGetBundleSpec>} */
  // @ts-expect-error when it's returned it will have this type
  let mutex = Promise.resolve();
  /**
   *
   * @param {string} filePrefix
   * @param {import('./externalTypes.js').ProposalBuilder} proposalBuilder
   */
  const writeCoreProposal = async (filePrefix, proposalBuilder) => {
    /**
     *
     * @param {string} entrypoint
     * @param {string} [bundlePath]
     * @returns {Promise<import('agoric/src/publish.js').EndoZipBase64Sha512Bundle>}
     */
    const getBundle = async (entrypoint, bundlePath) => {
      if (!bundlePath) {
        return bundleSource(pathResolve(entrypoint));
      }
      const bundleCache = pathResolve(bundlePath);
      await createBundles([[pathResolve(entrypoint), bundleCache]]);
      const ns = await import(bundleCache);
      return ns.default;
    };

    /**
     * Install an entrypoint.
     *
     * @param {string} entrypoint
     * @param {string} [bundlePath]
     */
    const install = async (entrypoint, bundlePath) => {
      const bundle = getBundle(entrypoint, bundlePath);

      // Serialise the installations.
      mutex = E.when(mutex, () => {
        // console.log('installing', { filePrefix, entrypoint, bundlePath });
        return getBundleSpec(bundle);
      });
      return mutex;
    };

    // Await a reference then publish to the board.
    const cmds = [];
    const publishRef = async refP => {
      const { fileName, ...ref } = await refP;
      if (fileName) {
        cmds.push(`agd tx swingset install-bundle @${fileName}`);
      }

      return harden(ref);
    };

    // Create the proposal structure.
    const proposal = await deeplyFulfilled(
      harden(proposalBuilder({ publishRef, install })),
    );
    const { sourceSpec, getManifestCall } = proposal;
    // console.log('created', { filePrefix, sourceSpec, getManifestCall });

    // Extract the top-level permit.
    const { permits: proposalPermit, manifest: overrideManifest } =
      await mergeProposalPermit(proposal, permits);

    // Get an install
    const manifestBundleRef = await publishRef(install(sourceSpec));

    // console.log('writing', { filePrefix, manifestBundleRef, sourceSpec });
    const code = `\
// This is generated by writeCoreProposal; please edit!
/* eslint-disable */

const manifestBundleRef = ${stringify(manifestBundleRef)};
const getManifestCall = harden(${stringify(getManifestCall, true)});
const overrideManifest = ${stringify(overrideManifest, true)};

// Make the behavior the completion value.
(${makeCoreProposalBehavior})({ manifestBundleRef, getManifestCall, overrideManifest, E });
`;

    const trimmed = defangAndTrim(code);

    const proposalPermitJsonFile = `${filePrefix}-permit.json`;
    log(`creating ${proposalPermitJsonFile}`);
    await writeFile(
      proposalPermitJsonFile,
      JSON.stringify(proposalPermit, null, 2),
    );

    const proposalJsFile = `${filePrefix}.js`;
    log(`creating ${proposalJsFile}`);
    await writeFile(proposalJsFile, trimmed);

    log(`\
You can now run a governance submission command like:
  agd tx gov submit-proposal swingset-core-eval ${proposalPermitJsonFile} ${proposalJsFile} \\
    --title="Enable <something>" --description="Evaluate ${proposalJsFile}" --deposit=1000000ubld \\
    --gas=auto --gas-adjustment=1.2
Remember to install bundles before submitting the proposal:
  ${cmds.join('\n  ')}
`);
  };

  return writeCoreProposal;
};
