// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import { compilation, Compiler } from 'webpack';
import { createHash } from 'crypto';
import { Tap } from 'tapable';
import * as RequestShortener from 'webpack/lib/RequestShortener';

import { STAGE_AFTER, STAGE_BEFORE } from './Constants';
import { INormalModuleFactoryModuleData, IExtendedModule } from './ModuleMinifierPlugin.types';

const PLUGIN_NAME: 'StableMinifierIdsPlugin' = 'StableMinifierIdsPlugin';

const TAP_BEFORE: Tap = {
  name: PLUGIN_NAME,
  stage: STAGE_BEFORE
} as Tap;

const TAP_AFTER: Tap = {
  name: PLUGIN_NAME,
  stage: STAGE_AFTER
} as Tap;

const STABLE_MODULE_ID_PREFIX: '__MODULEID_SHA_' = '__MODULEID_SHA_';
const STABLE_MODULE_ID_REGEX: RegExp = /['"]?(__MODULEID_SHA_[0-9a-f]+)['"]?/g;

/**
 * Plugin responsible for converting the Webpack module ids (of whatever variety) to stable ids before code is handed to the minifier, then back again.
 * Uses the node module identity of the target module. Will emit an error if it encounters multiple versions of the same package in the same compilation.
 * @public
 */
export class StableMinifierIdsPlugin {
  private readonly _stableIdToFinalId: Map<string | number, string | number>;

  public constructor() {
    this._stableIdToFinalId = new Map();
  }

  public apply(compiler: Compiler): void {
    // Ensure that "EXTERNAL MODULE: " comments are portable and module version invariant
    const baseShorten: (request: string) => string = RequestShortener.prototype.shorten;
    RequestShortener.prototype.shorten = function (this: RequestShortener, request: string): string {
      const baseResult: string = baseShorten.call(this, request);
      const nodeModules: '/node_modules/' = '/node_modules/';

      if (!baseResult) {
        return baseResult;
      }

      const nodeModulesIndex: number = baseResult.lastIndexOf(nodeModules);
      if (nodeModulesIndex < 0) {
        return baseResult;
      }

      const nodeModulePath: string = baseResult.slice(nodeModulesIndex + nodeModules.length);
      this.cache.set(request, nodeModulePath);
      return nodeModulePath;
    }

    const nameByResource: Map<string | undefined, string> = new Map();
    const {
      _stableIdToFinalId: stableIdToFinalId
    } = this;

    /**
     * Figure out portable ids for modules by using their id based on the node module resolution algorithm
     */
    compiler.hooks.normalModuleFactory.tap(PLUGIN_NAME, (nmf: compilation.NormalModuleFactory) => {
      nmf.hooks.module.tap(PLUGIN_NAME, (mod: IExtendedModule, data: INormalModuleFactoryModuleData) => {
        const {
          resourceResolveData: resolveData
        } = data;

        if (resolveData) {
          const {
            descriptionFileData: packageJson,
            relativePath
          } = resolveData;

          if (packageJson && relativePath) {
            const nodeId: string = `${packageJson.name}${relativePath.slice(1).replace(/\.js(on)?$/, '')}`;
            nameByResource.set(mod.resource, nodeId);
            return;
          }
        }

        console.error(`Missing resolution data for ${mod.resource}`);
      });
    });

    compiler.hooks.compilation.tap(PLUGIN_NAME, (compilation: compilation.Compilation) => {

      // Make module ids portable immediately before rendering.
      // Unfortunately, other means of altering these ids don't work in Webpack 4 without a lot more code and work.
      // Namely, a number of functions reference "module.id" directly during code generation
      compilation.hooks.beforeChunkAssets.tap(TAP_AFTER, () => {
        // For tracking collisions
        const resourceById: Map<string | number, string> = new Map();

        for (const module of compilation.modules) {
          const originalId: string | number = module.id;

          // Need to handle ConcatenatedModules, which don't have the resource property directly
          const resource: string = (module.rootModule || module).resource;

          // Map to the friendly node module identifier
          const preferredId: string | undefined = nameByResource.get(resource);
          if (preferredId) {
            const hashId: string = createHash('sha256').update(preferredId).digest('hex');

            // This is designed to be an easily regex-findable string
            const stableId: string = `${STABLE_MODULE_ID_PREFIX}${hashId}`;
            const existingResource: string | undefined = resourceById.get(stableId);

            if (existingResource) {
              compilation.errors.push(new Error(`Module id collision for ${resource} with ${existingResource}.\n This means you are bundling multiple versions of the same module.`));
            }

            stableIdToFinalId.set(stableId, originalId);

            // Record to detect collisions
            resourceById.set(stableId, resource);
            module.id = stableId;
          }
        }
      });

      // This is the hook immediately following chunk asset rendering. Fix the module ids.
      compilation.hooks.additionalChunkAssets.tap(TAP_BEFORE, () => {
        // Restore module ids in case any later hooks need them
        for (const mod of compilation.modules) {
          const stableId: string | number = mod.id;
          const finalId: string | number | undefined = stableIdToFinalId.get(stableId);
          if (finalId !== undefined) {
            mod.id = finalId;
          }
        }
      });
    })
  }

  /**
   * Replaces stable ids in code with the original output ids
   * @param code - The ECMAScript code to process
   * @param context - Context information for error logging
   */
  public restoreIdsInCode(code: string, context: string): string {
    STABLE_MODULE_ID_REGEX.lastIndex = -1;
    const {
      _stableIdToFinalId: stableIdToFinalId
    } = this;

    return code.replace(STABLE_MODULE_ID_REGEX, (moduleIdToken: string, id: string) => {
      const mapped: string | number | undefined = stableIdToFinalId.get(id);

      if (mapped === undefined) {
        console.error(`Missing module id for ${id} in ${context}!`);
        return moduleIdToken;
      }

      return `${mapped}`;
    });
  }

  /**
   * Maps a module id to the expected output id
   * @param id - The current value of `module.id`
   */
  public getMappedId(id: string | number): string | number | undefined {
    return this._stableIdToFinalId.get(id);
  }
}