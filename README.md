# notion-obsidian-sync

Manual, two-way sync between one or more Notion page trees and matching
Obsidian folders ("pairs"), defined in `sync-pairs.json`.

- Trigger: manual. Nothing runs automatically or in the background.
- Conflict policy: if a file changed in Obsidian AND its matching page changed
  in Notion since the last sync, both versions are kept as separate copies,
  under a "Conflicts" folder (Obsidian) / page (Notion) at the root of the
  synced tree, with the same plain name as the original — no suffix.
  Originals on both sides are left untouched.
  Note: names in Conflicts are not de-duplicated. If the exact same essay
  conflicts a second time later, its Conflicts copy is overwritten by the
  newer one. Move anything out of Conflicts you want to keep.
- Deletions are never propagated — if you delete a file or page, the other
  side keeps its copy untouched.

## Setup (one time)

1. Install Node.js if you don't have it: `brew install node`

2. Install dependencies:
   ```
   cd notion-obsidian-sync
   npm install
   ```

3. Create a Notion integration:
   - Go to https://www.notion.so/my-integrations
   - New integration → give it a name → copy the "Internal Integration Secret"

4. For **each** root page you want to sync (e.g. "Personal Essays", "Letters
   to self"), share it with that integration:
   - Open the page in Notion → "..." menu (top right) → Connections → add
     your integration. Without this the API cannot see the page.

5. Configure:
   ```
   cp .env.example .env
   cp sync-pairs.example.json sync-pairs.json
   ```
   Edit `.env`:
   - `NOTION_API_KEY` — the secret from step 3
   - `OBSIDIAN_VAULT_PATH` — full path to your vault, e.g.
     `/Users/pranamya/Documents/YourVault`

   Edit `sync-pairs.json` — one entry per root you want synced:
   - `name` — any short label, used in logs and to key `sync-state.json`
   - `notionRootPageId` — the page ID from its Notion URL
   - `obsidianRootFolder` — the matching top-level folder name in your vault

   Adding a new pair whose two sides already have matching content? Seed its
   baseline first so the first real run doesn't treat "no prior state" as
   "everything just changed" (which would duplicate everything into
   Conflicts):
   ```
   node sync.js --seed <pair-name>
   ```
   This only reads both sides and records their current hashes — it never
   creates, pushes, or overwrites anything.

6. Make the double-click launcher executable (one time):
   ```
   chmod +x sync.command
   ```

## Running a sync

Either:
- Double-click `sync.command` in Finder, or
- Run `npm run sync` from the terminal.

One run syncs every pair in `sync-pairs.json` and prints one combined total
of what it created, updated, or flagged as a conflict, across all of them.

## Files this creates next to the script

- `sync-state.json` — tracks what was last synced, per pair. This is how the
  script knows what changed since last time. Don't delete it casually —
  deleting a pair's entry makes every one of its files look "new" on the
  next run.
- `conflicts.log` — a running log of every conflict and how it was resolved
  (both versions kept, with filenames).

## Known limits

- Plain text, headings, lists, quotes, and bold/italic round-trip cleanly.
  Exotic Notion content (databases, synced blocks, complex embeds) will not
  convert perfectly — this tool is built for essay-style writing, not
  arbitrary Notion structures.
- New folders: create the folder on either side (as a Notion sub-page or an
  Obsidian sub-folder) and it gets picked up automatically as long as it
  contains at least one file/page, since folders are detected by whether they
  have children.
- Renaming a file/page is treated as delete + create on the next sync (the
  old name won't auto-update — you'll get a new item on the other side and
  the old one will sit unsynced under its original name until you clean it
  up manually).
