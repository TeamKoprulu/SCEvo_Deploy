# SCEvo_Deploy

Packages SC Evo content from the SC2 install and publishes it to Cloudflare R2 for the launcher.

Five packages ship from here, each deployable on its own:

| Package | Manifest | Payload folder (= R2 prefix) | Installed by the launcher |
|---|---|---|---|
| **Campaign** | `update-manifest.json` (public), `beta-manifest.json` (beta), `news-feed.json` | `payload/`, `betapayload/`, `assets/` | under the SC2 folder |
| **Melee vs AI** | `melee-manifest.json` | `meleepayload/` | mods under the SC2 folder; maps in `%APPDATA%\sc-evo-launcher\melee\` |
| **Melee beta** | `melee-beta-manifest.json` | `betameleepayload/` | mods under `Mods\SC Evolution Complete Beta\`, only after the player enters the beta code |
| **Launcher** | `launcher-version.json` | `launcher/`, `installer/` (copied from the launcher repo's `dist-electron/` at deploy time) | the launcher's self-updater |
| **Launcher assets** | none | `assets/` only: replay icons, hero backgrounds, news images (a campaign deploy uploads it too) | streamed by the launcher, never installed |

## Setup (once per machine)

1. Node 18+, [rclone](https://rclone.org) with a remote named `cf` that can write the `evo-campaign` bucket (`rclone config`).
2. Copy `deploy-config.example.json` to `deploy-config.json` and set `sc2InstallPath` (and `launcherRepoPath` when shipping a new launcher build).
3. `run.cmd init` creates `deploy-catalog.json` from what is deployed today, if it doesn't exist yet.
4. **CDN address:** `cdnBase` (Settings → CDN address) is currently `https://scevo.download`, a custom domain on the bucket.
   - It goes into the manifests, `launcher-version.json` (launchers learn it from there) and news images.
   - r2.dev stays the fallback, and postflight checks both.
   - Before changing it, check the new address: **Check** button, or `run.cmd cdn-check https://…`.
   - Setup steps: the launcher repo's `docs/cdn-custom-domain.md`.

## Everyday use

- **GUI:** `run.cmd` opens the tool in your browser.
- **Command line:** `run.cmd help` lists the commands.
- **Release handbook:** open `docs/index.html` in a browser. It covers every push (asset splitting, mod packaging, Cloudflare, launcher, blog posts, website).
- **Pre-push checks:** `run.cmd check <blog [post-id]|site|launcher|assets|mods|cdn|all> [--quick]`. Read-only; exits 1 when something must be fixed first (`docs/checks.html`).

Typical release:

1. **Catalog tab** (or `run.cmd status`): decide on anything listed as *new*, and set each item's channel.
2. **Catalog tab → Build campaign / Build melee** (or `run.cmd build --package campaign|melee`): only changed sources are repackaged, and the manifests are regenerated. To ship only some files, tick them first (or **Select changed**) and click **Build N selected** (or `--only <source>`); every other built file stays byte-identical, so players re-download only what you ticked.
3. **Manifest tab:** set versions, the critical-update notice or the beta settings, then **Write manifest**.
4. **Deploy tab** (`run.cmd deploy --package … [--dry-run]`): dry run first, then live. The tab compares each package with the live CDN, shows what isn't deployed yet (e.g. "decals added", "launcher 1.3.0 → 1.3.1") and ticks those packages. `run.cmd status` prints the same summary.
   - **Launcher only:** bump `version` in the launcher repo's `package.json`, build it, then deploy just the **Launcher** package (`run.cmd deploy --package launcher`). A rebuilt exe under the same version is flagged, because players are only offered a new version number.
   - **Launcher art without a campaign deploy:** the **Launcher assets** package uploads `assets/` and nothing else. Ship it with a launcher release that needs new art: `run.cmd deploy --package launcher,assets`. The Deploy tab and `run.cmd status` compare `assets/` with R2 by hash and show what isn't there yet.
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

**Player decals** (the launcher's decal picker):
- **Build melee rebuilds them every time,** into `meleepayload/decals/`:
  - one 64px atlas per race (`terran.png`, `zerg.png`, `protoss.png`), plus the Terran outline plates (`terran_bg.png`)
  - the list `decals.json` (id, race, name, hidden, colored)
- **They ship with the melee package,** in the manifest's `decals` section.
- **Sources** (Settings, or the defaults):
  - the textures from a CascView extraction: `D:\Casc Viewer\SC2\mods\liberty.sc2mod\base.sc2assets\assets\textures`
  - the reward list and English names from `D:\SCBW\SC2GameData`
  - re-extract both after a game patch that adds decals
- **Blank-looking decals** are reported by the build. `run.cmd decals` lists them, and `run.cmd decals exclude Decal_Zerg_0083_01` leaves one out (stored in the catalog under `melee.decalExclude`). `include` puts it back.
- **The textures stay untinted.** The launcher colours them with the player colour the way the game does.

## Campaign hero (Manifest → Public / Beta → Hero editor)

The launcher's campaign hero for each channel (launcher 1.4+; the manifest's `hero` section, see the launcher repo's `docs/manifest-spec.md`).

- **Video:** choose a `.webm` (under 40 MB; VP9 keeps transparency). A still is made from it with ffmpeg (needs `ffmpeg`/`ffprobe` on PATH); pick another point with **Still at … % → Make still**, or **Choose still…** for your own image. Players see the still until the video plays, and only the still with reduced motion, data saver or a 2G/3G connection. **Depth**: under the vignette (shaded like the background), over it behind the logo, or in front of the logo.
- **Placing:** drag the logo, emblem or video on the stage and scroll over one to resize it, or type x / y / scale. Units are launcher px: x from the hero's centre, y from its top; the hero is always 172 px tall and only gets wider, so check **Window width** up to ultrawide. **Reset** puts a piece back in the episode's own layout; untick **Shown** to hide the emblem.
- **Background:** the **Hero background** field above it.
- **Saving:** **Write manifest**. Media are saved in `assets/hero/` and upload with the campaign or assets package; preflight fails if one the manifest names is missing or changed.

## Melee beta (closed test)

A code-locked branch of the melee mods, for testing changes to Core, Legacy and so on without touching the public game or the campaign.

- **Tagging:** on the Catalog tab, click **Melee beta** on a mod (or `run.cmd beta-tag "<source>"`, and `run.cmd beta-tag "<source>" off` to untag). The tag sits beside the mod's own package and channel, so tagging Core leaves the campaign's Core alone. Only mods straight under `Mods\SC Evolution Complete` can be tagged.
- **Tag the whole chain:** a tagged mod loads its tagged dependencies from the beta folder. If an untagged melee mod (or campaign core mod such as Legacy) depends on a tagged one, the Catalog shows a warning and the build reports it, because that game would load the public copy too. Tag Core, and you tag Multi and Legacy with it.
- **Build:** **Build melee beta** on the Catalog tab (or `run.cmd build --package meleebeta`). Each tagged mod is packaged from its normal source folder into `betameleepayload/Mods/SC Evolution Complete Beta/`, and its `DocumentInfo` / `DocumentHeader` dependencies on other tagged mods are rewritten to `file:Mods\SC Evolution Complete Beta\<mod>.SC2Mod` (file-only, so the game can't swap in the published public mod). Packed mods are patched with MPQEditor.
- **Settings:** Manifest tab → **Melee beta** (or `run.cmd melee-beta --on|--off --name "<name>" --code <code> --version <v> --accent <#hex>`). The code is hashed the same way as the campaign beta's; setting a new code locks out players who entered the old one. While the beta is off, the manifest carries no mods and the launcher hides it.
- **Deploy:** tick **Melee beta** on the Deploy tab (or `run.cmd deploy --package meleebeta`).
- **On players' PCs:** the Melee tab shows a Public / Beta switch while the beta is on. Beta asks for the code once, then offers to install the beta mods; games started on Beta load the beta copies. Public games and the campaign are unchanged.

## News: `manifests/news-feed.json`

Edit it on the **News** tab. The launcher shows the cards in `feed`, in order:

| Kind | What it shows |
|---|---|
| **Site post** | A post from `scevo.org/assets/data/postList.json`: the newest with a tag ("Which" 1), the one before (2), and so on, or the newest of any tag. **Skip posts shown above** stops two cards showing the same post. |
| **Patreon post** | A post from the Patreon page (`TeamKopruluSC2`; set `patreonVanity` in `deploy-config.json` to change it): the newest ("Which" 1), the one before (2), and so on. Locked posts show Patreon's preview image, blurred unless the post has a public preview. **Hide image** uses the text header instead. |
| **Image banner** | Only an image, the whole card is the link. |
| **Custom card** | A card you write yourself. |

- **Patreon cards are filled in when you save**, not live. Patreon's image links expire after a few weeks, so the preview image is copied to `assets/news/` and the card points at its R2 copy. **Deploy the campaign package** after saving, so the image is uploaded (Verify reports a card whose image is missing from `assets/`).
- **Publish news only** uploads `news-feed.json` and `assets/news/` to the live CDN after the news checks pass, with nothing else. Use it for news changes between deploys, such as a banner swap or an announcement. It saves unsaved changes first, and its log shows on the Deploy tab.
- **Accent presets:** the swatches under **Accent (header + badge)** list the accents already used in the feed, then 24 presets. Picking an accent also sets **Header background** to a darker shade of it; edit the background afterwards to override it.
- **Card accent:** **Accent (header + badge)** colours the badge and the text header's glow and grid when there is no image. **Badge colour** overrides just the badge. Leave **Badge colour** empty to have the badge follow the accent; Save writes the accent into `badgeColor`, which is the only field the launcher reads for the badge.
- **Text header:** a card without an image shows the launcher's text header. Set its **Header text**, **Header label**, **Header background** and **Accent (header + badge)** on any site post, Patreon or custom card.
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
| `tools/lib/generate.js` | the manifests from the catalog |
| `tools/lib/meleebeta.js` | melee beta build: tagged mods, dependency rewrite, closure check, its manifest |
| `tools/lib/mapmeta.js`, `tools/lib/sc2map/` | melee map metadata (`sc2map/` is copied from the launcher's reader; copy it again when the launcher's changes) |
| `tools/lib/deploy.js`, `r2.js`, `verify.js` | deploy sequence, rclone, checks |
| `tools/lib/decals.js`, `tools/lib/img/` | player decal atlases for the melee package (DXT5 decode, PNG encode) |
| `tools/lib/news.js` | news feed resolution (copied from the launcher's `electron/news/posts.js`; copy it again when that changes) |
| `tools/lib/patreon.js` | Patreon posts for news cards, filled in and image re-hosted on save |
| `tools/check.js` | pre-push checks (`run.cmd check …`) |
| `docs/` | the release handbook (static HTML, never uploaded) |
| `tools/test/` | `node --test "tools/test/*.test.js"` |
| `legacy/` | the old PowerShell scripts, kept for reference only |
