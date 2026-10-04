# SCEvo_Deploy

Packages SC Evo content from the SC2 install and publishes it to Cloudflare R2 for the launcher.

Two packages ship from here:

| Package | Manifest | Payload folder (= R2 prefix) | Installed by the launcher |
|---|---|---|---|
| **Campaign** | `update-manifest.json` (public), `beta-manifest.json` (beta) | `payload/`, `betapayload/` | under the SC2 folder |
| **Melee vs AI** | `melee-manifest.json` | `meleepayload/` | mods under the SC2 folder; maps in `%APPDATA%\sc-evo-launcher\melee\` |

## Setup (once per machine)

1. Node 18+, [rclone](https://rclone.org) with a remote named `cf` that can write the `evo-campaign` bucket (`rclone config`).
2. Copy `deploy-config.example.json` to `deploy-config.json` and set `sc2InstallPath` (and `launcherRepoPath` when shipping a new launcher build).
3. `run.cmd init` creates `deploy-catalog.json` from what is deployed today, if it doesn't exist yet.

## Everyday use

- **GUI:** `run.cmd` opens the tool in your browser.
- **Command line:** `run.cmd help` lists the commands.

Typical release:

1. **Catalog tab** (or `run.cmd status`): decide on anything listed as *new*, and set each item's channel.
2. **Catalog tab → Build campaign / Build melee** (or `run.cmd build --package campaign|melee`): only changed sources are repackaged, and the manifests are regenerated. To ship only some files, tick them first (or **Select changed**) and click **Build N selected** (or `--only <source>`); every other built file stays byte-identical, so players re-download only what you ticked.
3. **Manifest tab:** set versions, the critical-update notice or the beta settings, then **Write manifest**.
4. **Deploy tab** (`run.cmd deploy --package … [--dry-run]`): dry run first, then live.
   - **Update website download links** (`--update-site`, campaign only): after the upload, points the website's launcher downloads (`assets\js\site-links.js` in the **Website repo path** from Settings) at the R2 copies, with `?v=<launcher version>`. The file is edited in place and left uncommitted, whatever else is uncommitted there; commit and push the site to publish it.

## The catalog: `deploy-catalog.json`

It is the one file that decides what ships. It is committed, so decisions survive sessions, machines and git operations. Edit it from the GUI or CLI; hand edits are fine too.

```json
{
  "roots":  [ { "rel": "Maps\\SCEvo_MPMaps", "kind": "map", "depth": 2 }, … ],
  "melee":  { "version": "1.0.0", "requires": ["Mods/SC Evolution Complete/SCEvo_Core.SC2Mod", …] },
  "items":  [ { "source": "Mods\\SC Evolution Complete\\SCEvo_Core.SC2Mod", "package": "campaign", "channel": "public", "module": { "type": "core" } },
              { "source": "Maps\\SCEvo_MPMaps\\SEL_1v1\\Golden Wall SEL.SC2Map", "package": "melee", "channel": "public", "mapId": "c31bddeb6a" } ],
  "ignore": [ "Mods\\SC Evolution Complete\\SCEvo_Extension.SC2Mod", … ]
}
```

- **`roots`** are the folders inside the SC2 install that are scanned. `depth` goes into subfolders; `single` is one file or folder.
  - Folder sources are packaged with MPQEditor.
  - Packed single-file `.SC2Map` / `.SC2Mod` sources are copied as they are.
- **`items`** are what is tracked.
  - `channel` for campaign items: `public`, `beta`, `both` or `off`. For melee items: `public` or `off`.
  - Optional fields:
    - `module` (`id` / `name` / `description` / `type`): the manifest module.
    - `name` / `description`: overrides for melee maps.
    - `downloadUrl(s)`: mirror URLs.
- **`ignore`** lists sources that never ship and are never shown as new again.
- **`melee.requires`** lists campaign mods the melee package relies on. The launcher checks them, but the melee package doesn't ship them.

**Moving between public and beta:** change the channel, then Build. The file is copied into the right payload folder, removed from the other, and both manifests are regenerated:

```
run.cmd promote "Loomings3Legacy.SC2Map" public
```

**Melee maps:**
- **Choosing which maps ship:** use **Add to pool** / **Remove from pool** on the map cards (or `run.cmd set "<map>" --package melee --channel public|off`).
- **Opaque names:** each map gets a random `mapId` once and ships as `meleepayload/maps/<mapId>.evm`, with its minimap as `thumbs/<mapId>.png`.
- **Metadata** (name, players, modes, size, tileset, and the SCEvo mods it needs) is read from the map itself.
- **Missing mods:** the build warns when a map needs a mod that ships in neither package.
- **Modes** on a map card come from the map's short description when it names a mode (`1v1`, `2v2`, `FFA`), otherwise from its start locations (2 → `1v1`, 4 → `2v2 · FFA`, …). Type in the card's Modes box to override it.
- **Previews before download:** the launcher shows each pool map's name, players, modes and minimap from `melee-manifest.json` and `thumbs/`, so they appear once the melee package is deployed.
- **On players' PCs:** downloaded maps live in `%APPDATA%\sc-evo-launcher\melee\`; each game is played from a modified copy in `%TEMP%\SCEvoLauncher\<game>`. Nothing goes into SC2's Maps folder.

## News: `manifests/news-feed.json`

Edit it on the **News** tab. The launcher shows the cards in `feed`, in order:

| Kind | What it shows |
|---|---|
| **Site post** | A post from `scevo.org/assets/data/postList.json`: the newest with a tag ("Which" 1), the one before (2), and so on, or the newest of any tag. **Skip posts shown above** stops two cards showing the same post. |
| **Patreon post** | A post from the Patreon page (`TeamKopruluSC2`; set `patreonVanity` in `deploy-config.json` to change it): the newest ("Which" 1), the one before (2), and so on. Locked posts show Patreon's preview image, blurred unless the post has a public preview. **Hide image** uses the text header instead. |
| **Image banner** | Only an image, the whole card is the link. |
| **Custom card** | A card you write yourself. |

- **Patreon cards are filled in when you save**, not live. Patreon's image links expire after a few weeks, so the preview image is copied to `assets/news/` and the card points at its R2 copy. **Deploy the campaign package** after saving, so the image is uploaded (Verify reports a card whose image is missing from `assets/`).
- **Text header:** a card without an image shows the launcher's text header. Set its **Header text**, **Header label**, **Header background** and **Header accent** on any site post, Patreon or custom card.
- **The launcher fills site posts live.** A new post on the site shows up without a deploy; it's in the player's language when the site has a translation (`posts/<slug>.<locale>.md`), otherwise English.
- **Overrides:** any field you fill replaces what the site post shows. **All languages** applies everywhere; a language tab applies only to the launcher in that language. The preview shows the result for the selected language.
- **Shown on** limits a card to the public or beta channel.
- **Older launchers** read `cards`. Saving writes it as an English snapshot of the feed (without banners), so they keep showing news.
- The announcement banner, `promo` and the locale strings are kept as they are on save.

## Offline package

For players who can't use the launcher: **Deploy tab → Build offline .zip** (or `run.cmd offline-zip`) writes `offline\SCEvo_Offline_Campaign-<campaign>_Evo-<version>.zip`.

- **Contents:** only the files currently **published** in the live `update-manifest.json` on R2 (the public campaign package), read from `payload/` and checked by hash. Anything built but not yet deployed, such as work in progress, makes it stop and name the file. The files are laid out like the StarCraft II folder, plus `Play SC Evo.cmd` (starts `EvoCompleteLauncher.SC2Map` the way the launcher does) and a README (edit `tools\offline-readme.txt`). No melee maps or melee mods.
- **To include new files,** deploy them first. It needs R2 to be reachable, and never falls back to local files.
- **Local only:** nothing is uploaded, and `offline\` is not committed.

## What Build and Deploy guarantee

- **Payload folders mirror the catalog.** Files no item claims any more are removed on Build.
- **Manifests are always generated.** They are only rewritten when their content changes; the previous version goes to `manifests/.history/` (not committed, never uploaded).
- **Deploy order:**
  1. regenerate
  2. preflight (manifest vs disk)
  3. upload payload
  4. HEAD-check every file on the CDN
  5. upload the manifests last
  6. read them back
- **Each deploy uploads only the chosen packages' folders and manifests.**
- **Remote orphans** (files on R2 that no manifest references) are listed on the Verify tab and only deleted when you confirm.

## Files

| Path | What |
|---|---|
| `run.cmd` | GUI with no arguments; CLI otherwise |
| `tools/cli.js`, `tools/app.js` | command line, local web server (127.0.0.1, per-run token) |
| `tools/lib/catalog.js` | catalog load/save/scan/edit |
| `tools/lib/build.js` | packaging, channel copies, pruning, build state (`tools/.cache/build-state.json`) |
| `tools/lib/generate.js` | the three manifests from the catalog |
| `tools/lib/mapmeta.js`, `tools/lib/sc2map/` | melee map metadata (`sc2map/` is copied from the launcher's reader; copy it again when the launcher's changes) |
| `tools/lib/deploy.js`, `r2.js`, `verify.js` | deploy sequence, rclone, checks |
| `tools/lib/news.js` | news feed resolution (copied from the launcher's `electron/news/posts.js`; copy it again when that changes) |
| `tools/lib/patreon.js` | Patreon posts for news cards, filled in and image re-hosted on save |
| `tools/test/` | `node --test "tools/test/*.test.js"` |
| `legacy/` | the old PowerShell scripts, kept for reference only |
