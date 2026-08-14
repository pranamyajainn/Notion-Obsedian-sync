#!/usr/bin/env node
/**
 * Manual two-way sync between one or more Notion page trees and matching
 * Obsidian folders, defined as "pairs" in sync-pairs.json.
 *
 * Trigger: manual only. Run `npm run sync` or double-click sync.command.
 * Conflict policy: if both sides changed since the last sync, BOTH versions
 * are kept as separate copies under a "Conflicts" folder/page at that pair's
 * root, with their original names (no suffix). Originals are never touched.
 * Deletions are never propagated automatically.
 *
 * `node sync.js --seed <pairName>` records the current state of a pair as
 * its baseline without creating, pushing, or overwriting anything. Use this
 * once when adding a new pair whose two sides already match, so the first
 * real run doesn't mistake "no prior state" for "both sides just changed".
 */

require('dotenv').config();
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('@notionhq/client');
const { NotionToMarkdown } = require('notion-to-md');
const { markdownToBlocks } = require('@tryfabric/martian');

const NOTION_API_KEY = process.env.NOTION_API_KEY;
const OBSIDIAN_VAULT_PATH = process.env.OBSIDIAN_VAULT_PATH;

if (!NOTION_API_KEY || !OBSIDIAN_VAULT_PATH) {
  console.error('Missing required env vars. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const notion = new Client({ auth: NOTION_API_KEY });
const n2m = new NotionToMarkdown({ notionClient: notion });

const PAIRS_FILE = path.join(__dirname, 'sync-pairs.json');
const STATE_FILE = path.join(__dirname, 'sync-state.json');
const CONFLICT_LOG = path.join(__dirname, 'conflicts.log');

function hash(content) {
  const normalized = content.replace(/\r\n/g, '\n').trim();
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

async function loadPairs() {
  let raw;
  try {
    raw = await fs.readFile(PAIRS_FILE, 'utf8');
  } catch {
    console.error('Missing sync-pairs.json. Copy sync-pairs.example.json to sync-pairs.json and fill it in.');
    process.exit(1);
  }
  const pairs = JSON.parse(raw);
  if (!Array.isArray(pairs) || pairs.length === 0) {
    console.error('sync-pairs.json must be a non-empty array of {name, notionRootPageId, obsidianRootFolder}.');
    process.exit(1);
  }
  return pairs;
}

async function loadState() {
  let raw;
  try {
    raw = JSON.parse(await fs.readFile(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
  // Migrate the old single-pair format ({ items: {...} }) under "personal-essays".
  if (raw.items && !raw['personal-essays']) {
    return { 'personal-essays': { items: raw.items } };
  }
  return raw;
}

async function saveState(state) {
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

async function logConflict(pairName, message) {
  const line = `[${new Date().toISOString()}] (${pairName}) ${message}\n`;
  await fs.appendFile(CONFLICT_LOG, line, 'utf8');
  console.log('CONFLICT:', message);
}

// ---------- Obsidian side (plain filesystem, no plugin required) ----------

async function walkObsidian(dir, relBase = '') {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return {};
  }
  const items = {};
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const fsPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const relPath = relBase ? `${relBase}/${entry.name}` : entry.name;
      items[relPath] = { type: 'folder', fsPath };
      Object.assign(items, await walkObsidian(fsPath, relPath));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      const title = entry.name.slice(0, -3);
      const relPath = relBase ? `${relBase}/${title}` : title;
      const content = await fs.readFile(fsPath, 'utf8');
      items[relPath] = { type: 'file', fsPath, content };
    }
  }
  return items;
}

async function writeObsidianFile(obsidianRootFolder, relPath, content) {
  const fsPath = path.join(OBSIDIAN_VAULT_PATH, obsidianRootFolder, `${relPath}.md`);
  await fs.mkdir(path.dirname(fsPath), { recursive: true });
  await fs.writeFile(fsPath, content, 'utf8');
  return fsPath;
}

// ---------- Notion side ----------

async function getAllBlockChildren(blockId) {
  let results = [];
  let cursor;
  do {
    const res = await notion.blocks.children.list({ block_id: blockId, start_cursor: cursor });
    results = results.concat(res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return results;
}

async function walkNotion(pageId, relBase = '') {
  const items = {};
  const children = await getAllBlockChildren(pageId);
  const childPages = children.filter((b) => b.type === 'child_page');

  for (const cp of childPages) {
    const title = cp.child_page.title;
    const relPath = relBase ? `${relBase}/${title}` : title;
    const grandChildren = await getAllBlockChildren(cp.id);
    const hasSubPages = grandChildren.some((b) => b.type === 'child_page');

    if (hasSubPages) {
      items[relPath] = { type: 'folder', pageId: cp.id };
      Object.assign(items, await walkNotion(cp.id, relPath));
    } else {
      const mdBlocks = await n2m.pageToMarkdown(cp.id);
      const mdString = n2m.toMarkdownString(mdBlocks).parent;
      items[relPath] = { type: 'file', pageId: cp.id, content: mdString };
    }
  }
  return items;
}

async function clearPageContent(pageId) {
  const children = await getAllBlockChildren(pageId);
  for (const block of children) {
    await notion.blocks.delete({ block_id: block.id });
  }
}

async function writeNotionPage(pageId, markdown) {
  await clearPageContent(pageId);
  const blocks = markdownToBlocks(markdown);
  for (let i = 0; i < blocks.length; i += 100) {
    await notion.blocks.children.append({ block_id: pageId, children: blocks.slice(i, i + 100) });
  }
}

async function createNotionPage(parentPageId, title, markdown) {
  const blocks = markdownToBlocks(markdown);
  const page = await notion.pages.create({
    parent: { page_id: parentPageId },
    properties: { title: { title: [{ text: { content: title } }] } },
    children: blocks.slice(0, 100),
  });
  for (let i = 100; i < blocks.length; i += 100) {
    await notion.blocks.children.append({ block_id: page.id, children: blocks.slice(i, i + 100) });
  }
  return page.id;
}

// Finds (or creates) a "Conflicts" child page directly under a pair's root,
// used to hold both-sides-changed copies with their plain, unsuffixed titles.
async function getOrCreateConflictsPage(rootPageId, cache) {
  if (cache.id) return cache.id;
  const children = await getAllBlockChildren(rootPageId);
  const existing = children.find((b) => b.type === 'child_page' && b.child_page.title === 'Conflicts');
  cache.id = existing ? existing.id : await createNotionPage(rootPageId, 'Conflicts', '');
  return cache.id;
}

function findParentPageId(notionTree, relPath, rootPageId) {
  const parentRel = relPath.split('/').slice(0, -1).join('/');
  if (!parentRel) return rootPageId;
  return notionTree[parentRel]?.pageId || rootPageId;
}

// ---------- Sync one pair ----------

async function syncPair(pair, state, totals, seedOnly) {
  const { name, notionRootPageId, obsidianRootFolder } = pair;
  console.log(`\n== ${name} ==`);

  console.log('Reading Obsidian side...');
  const obsidianRoot = path.join(OBSIDIAN_VAULT_PATH, obsidianRootFolder);
  const obsidianTree = await walkObsidian(obsidianRoot);

  console.log('Reading Notion side...');
  const notionTree = await walkNotion(notionRootPageId);

  // The "Conflicts" folder/page is a holding area for both-sides-changed
  // copies, not regular content — exclude it from the normal diff entirely.
  for (const key of Object.keys(obsidianTree)) {
    if (key === 'Conflicts' || key.startsWith('Conflicts/')) delete obsidianTree[key];
  }
  for (const key of Object.keys(notionTree)) {
    if (key === 'Conflicts' || key.startsWith('Conflicts/')) delete notionTree[key];
  }

  if (!state[name]) state[name] = { items: {} };
  const pairState = state[name];
  const allKeys = new Set([...Object.keys(obsidianTree), ...Object.keys(notionTree)]);
  const conflictsPageCache = {};

  for (const key of allKeys) {
    const ob = obsidianTree[key];
    const no = notionTree[key];

    if (ob?.type === 'folder' || no?.type === 'folder') continue;

    const prev = pairState.items[key];

    if (seedOnly) {
      // Only record a baseline for items that already exist on both sides.
      // Never create, push, or overwrite anything.
      if (ob && no) {
        pairState.items[key] = {
          obsidianHash: hash(ob.content),
          notionHash: hash(no.content),
          notionPageId: no.pageId,
        };
        console.log(`Seeded baseline: ${key}`);
      }
      continue;
    }

    if (ob && !no) {
      const parentId = findParentPageId(notionTree, key, notionRootPageId);
      const title = key.split('/').pop();
      const newPageId = await createNotionPage(parentId, title, ob.content);
      pairState.items[key] = { obsidianHash: hash(ob.content), notionHash: hash(ob.content), notionPageId: newPageId };
      totals.created++;
      console.log(`Created in Notion: ${key}`);
      continue;
    }

    if (no && !ob) {
      await writeObsidianFile(obsidianRootFolder, key, no.content);
      pairState.items[key] = { obsidianHash: hash(no.content), notionHash: hash(no.content), notionPageId: no.pageId };
      totals.created++;
      console.log(`Created in Obsidian: ${key}`);
      continue;
    }

    if (ob && no) {
      const obHash = hash(ob.content);
      const noHash = hash(no.content);
      const obChanged = !prev || prev.obsidianHash !== obHash;
      const noChanged = !prev || prev.notionHash !== noHash;

      if (!obChanged && !noChanged) continue;

      if (obChanged && !noChanged) {
        await writeNotionPage(no.pageId, ob.content);
        pairState.items[key] = { obsidianHash: obHash, notionHash: obHash, notionPageId: no.pageId };
        totals.updated++;
        console.log(`Pushed Obsidian -> Notion: ${key}`);
      } else if (noChanged && !obChanged) {
        await writeObsidianFile(obsidianRootFolder, key, no.content);
        pairState.items[key] = { obsidianHash: noHash, notionHash: noHash, notionPageId: no.pageId };
        totals.updated++;
        console.log(`Pulled Notion -> Obsidian: ${key}`);
      } else {
        const title = key.split('/').pop();
        const conflictsPageId = await getOrCreateConflictsPage(notionRootPageId, conflictsPageCache);

        await createNotionPage(conflictsPageId, title, ob.content);
        await writeObsidianFile(obsidianRootFolder, `Conflicts/${title}`, no.content);

        await logConflict(
          name,
          `${key}: both sides changed. Obsidian version saved to Notion under "Conflicts/${title}". ` +
            `Notion version saved to Obsidian at "Conflicts/${title}.md". Originals on both sides left untouched. ` +
            `Note: if this exact item conflicts again later, its Conflicts copy will be overwritten (no suffix is added).`
        );

        pairState.items[key] = { obsidianHash: obHash, notionHash: noHash, notionPageId: no.pageId };
        totals.conflicts++;
      }
    }
  }
}

// ---------- Main ----------

async function main() {
  const args = process.argv.slice(2);
  const seedIndex = args.indexOf('--seed');
  const seedPairName = seedIndex !== -1 ? args[seedIndex + 1] : null;

  const pairs = await loadPairs();
  const state = await loadState();
  const totals = { created: 0, updated: 0, conflicts: 0 };

  const pairsToRun = seedPairName ? pairs.filter((p) => p.name === seedPairName) : pairs;
  if (seedPairName && pairsToRun.length === 0) {
    console.error(`No pair named "${seedPairName}" in sync-pairs.json`);
    process.exit(1);
  }

  for (const pair of pairsToRun) {
    await syncPair(pair, state, totals, Boolean(seedPairName));
  }

  await saveState(state);

  if (seedPairName) {
    console.log(`\nSeeded baseline for "${seedPairName}". Nothing was created, changed, or pushed.`);
  } else {
    console.log(`\nDone. Created: ${totals.created}, Updated: ${totals.updated}, Conflicts: ${totals.conflicts}.`);
    if (totals.conflicts > 0) console.log('See conflicts.log for details.');
  }
}

main().catch((err) => {
  console.error('Sync failed:', err);
  process.exit(1);
});
