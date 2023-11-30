/**
 * Copyright (c) 2023 MERCENARIES.AI PTE. LTD.
 * All rights reserved.
 */

//import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'url';
import BetterSqlite3 from 'better-sqlite3';

const MONO_COLLECTION_ID = "legacyMonoCollection";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function addMetaTag(doc, tag) {
    if (!doc.meta.tags.includes(tag)) {
        doc.meta.tags.push(tag);
    }
}

function generateHashId(name) {
    const hash = crypto.createHash('sha1');
    hash.update(name);
    return hash.digest('hex').substring(0, 36); // Creating a substring to match UUID format
}

async function importRecipes() {
    try {
        const templateDir = path.join(__dirname, '../../templates');
        if (!(fs.statSync(templateDir)).isDirectory()) { 
            console.error('Directory does not exist:', templateDir);
            return;
        }

        const files = fs.readdirSync(templateDir);
        const jsonFiles = files.filter(file => path.extname(file).toLowerCase() === '.json');
        const systemRecipes = [
            ['Bugbear', 'c0deba5e-417d-49df-96d3-8aeb8fc15402', false], //false means not visible
            ['Socket', 'c0deba5e-786a-4d4b-88d9-1694ebc85527', false]
        ];

        let jsonArray = [];
        for (let file of jsonFiles) {
            console.info('Processing recipe json:', file);
            let content = fs.readFileSync(path.join(templateDir, file));
            let doc = JSON.parse(content);
            doc.owner = '-----public-----';

            // Hack to update timestamp if recipe is "Yearbook Photo Studio" to make it on top
            if (doc.meta.name === "Yearbook Photo Studio") {
                doc.meta.updated = Date.now();
            }

            for (let nodeId in doc.rete.nodes) {
                let node = doc.rete.nodes[nodeId];
                // add chat enabled flag when chat node is present
                if (node.name === "omnitool.chat_input") {
                    doc.ui = doc.ui ?? {};
                    doc.ui.chat = doc.ui.chat ?? {};
                    doc.ui.chat.enabled = true;
                }
                // add formio enabled flag when formio node is present
                else if (node.name === "omni-core-formio:formio.auto_ui" || node.name === "omni-extension-formio:formio.auto_ui") {
                    doc.ui = doc.ui ?? {};
                    doc.ui.formIO = doc.ui.formIO ?? {};
                    doc.ui.formIO.enabled = true;
                }
            }

            for (let [fileNamePrefix, overrideId, visible] of systemRecipes) {
                if (file.startsWith(fileNamePrefix)) {
                    doc.id = overrideId;
                    addMetaTag(doc, 'system');
                    doc.meta.visible = visible;
                }
            }

            // Update the recipe metadata block with the desired values from 'meta'
            const metadataNodeKey = Object.keys(doc.rete.nodes).find(key => doc.rete.nodes[key].name === "omnitool.recipe_metadata");
            if (metadataNodeKey) {
                const metadataNode = doc.rete.nodes[metadataNodeKey];
                metadataNode.data.title = doc.meta.name;
                metadataNode.data.author = "Omnitool.ai team";
                metadataNode.data.description = doc.meta.description;
                metadataNode.data.help = doc.meta.help;
                metadataNode.data.tags = doc.meta.tags;
            }
            // Flag it as template recipe
            // addMetaTag(doc, '#template');
            doc.meta.template = true;
            doc.meta.author = 'Omnitool.ai team';
            doc.meta.org = 'omnitool_core_recipes';
            doc['publishedTo'] = [];
            doc['_id'] = `wf:${doc.id}`;
            jsonArray.push(doc);
        }

        await reconcilePublishedRecipes(jsonArray);
        await reconcilePublishedRecipesSQLite(jsonArray);
    } catch (error) {
        console.error(error);
    }
}

async function reconcilePublishedRecipesSQLite(publishedRecipes) {
    const dbpath = path.join(process.cwd(), 'data.local', 'db', 'legacy_monolith.db');
    // do nothing if the db file does not exist
    if (!fs.existsSync(dbpath)) {
        return;
    }
    const db = new BetterSqlite3(dbpath);
    try {
        // Prepare statements
        const deleteStmt = db.prepare(`DELETE FROM kvstore WHERE key = ?`);
        const insertStmt = db.prepare(`INSERT OR REPLACE INTO kvstore (key, value, valueType) VALUES (?, ?, 'object')`);
        const begin = db.prepare('BEGIN');
        const commit = db.prepare('COMMIT');
        const rollback = db.prepare('ROLLBACK');

        // Fetch old records
        const oldRecords = db.prepare(
            `SELECT key FROM kvstore WHERE (json_extract(value, '$.meta.template') = true OR json_extract(value, '$.owner') = '-----public-----') 
                AND key LIKE 'wf%'`,
        )
        .all();

                                       

        // Delete old records
        begin.run();
        try {
            for (const record of oldRecords) {
                deleteStmt.run(record.id);
            }
            commit.run();
        } catch (e) {
            rollback.run();
            throw e;
        }
        console.info(`Deleted ${oldRecords.length} demo recipes.`);

        // Create new records
        begin.run();
        try {
            for (const element of publishedRecipes) {
                if (!element.meta.tags.includes("system")) {
                    // Use hash function to generate consistent ID based on recipe name
                    element.id = generateHashId(element.meta.name);
                    element._id = `wf:${element.id}`;
                }
                let omni_id = element._id;
                let blob = JSON.stringify(element); // Assuming the blob is a JSON object
                //console.log(`Inserting ${omni_id}`);
                insertStmt.run(omni_id, blob);
            }
            commit.run();
        } catch (e) {
            rollback.run();
            throw e;
        }
        omnilog.status_success(`Updated ${publishedRecipes.length} demo recipes.`);
    } catch (error) {
        console.error(error);
    } finally {
        db.close();
    }
}

async function reconcilePublishedRecipes(publishedRecipes) {
    try {
        const Pocketbase = (await import('pocketbase')).default;
        let pb = new Pocketbase(process.env.DATABASE_URL || 'http://127.0.0.1:8090');
        pb.autoCancellation(false);

        let oldrecords = await pb.collection(MONO_COLLECTION_ID).getFullList(
            { filter: `(blob.meta.template=true || blob.owner="-----public-----") && omni_id~"wf"` }
        );
        let deleteCmd = oldrecords.map(record => pb.collection(MONO_COLLECTION_ID).delete(record.id));
        await Promise.all(deleteCmd);
        console.info(`Deleted ${oldrecords.length} demo recipes.`);

        let createCmd = publishedRecipes.map(element => {
            if (!element.meta.tags.includes("system")) {
                // Use hash function to generate consistent ID based on recipe name
                element.id = generateHashId(element.meta.name);
                element._id = `wf:${element.id}`;
            }
            let omni_id = element._id;
            return pb.collection(MONO_COLLECTION_ID).create({ omni_id: omni_id, blob: element });
        });

        await Promise.all(createCmd);
        omnilog.status_success(`Updated ${createCmd.length} demo recipes.`);
    } catch (error) {
        if (error.originalError.cause.code === 'ECONNREFUSED') {
            // continue - pocketbase is not running and deprecated            
        }
        else {
            console.error(error);
        }
    }
}

const script = {
    name: 'import',
    exec: async function (ctx, payload) {
        console.info('Starting recipe import...');
        await importRecipes();
        console.info('Recipe import completed.');
        return { status: 'success', message: 'Recipe import completed.' };
    }
};

export { importRecipes, script };
