/**
 * Copyright (c) 2023 MERCENARIES.AI PTE. LTD.
 * All rights reserved.
 */

import { importRecipes } from '../scripts/server/import.js';

async function init(ctx) {
  console.log('Importing demo recipes...');
  await importRecipes();
}
// TODO: Need to figure out how to get right event to trigger this
const extensionHooks = {
    // 'extensions_loaded': async function(ctx, omniPackage, installationId, orgId, customBaseUrl, duration) {
    //   console.log('Extension loaded:', omniPackage);
    //   console.log('Reconciling published recipes...')
    //   await run();  // Trigger the script to run when a package is installed
    // }
};

export default {hooks: extensionHooks, init}