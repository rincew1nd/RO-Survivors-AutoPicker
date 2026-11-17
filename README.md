# RO Survivors Auto Picker

A browser extension for [RO Survivors](https://ro-survivors.com/) that picks
skill/item cards, rolls on party loot, manages builds and keeps the hero
moving.

Fan-made, not affiliated with RO Survivors or Ragnarok Online.

## Why it's made

The main reason is to show the developer how fragile bot detection is at the moment, and to show ways to bypass it.
At the same time, I hate the direction the game is going with FOMO events and a lack of real gameplay.
I wish the focus could shift from making FOMO content to making gameplay more exciting, because right now it's "press a button and stand AFK for 15 minutes".

## What it does

- Picks the best card from a level-up or chest offer, including rerolls and
  banishes within a per-build budget.
- Suggests only, if you prefer to click yourself, and logs why each choice was
  made in the Activity tab.
- Manages builds: priority cards, upgrade limits, skill and item rerolls,
  talent and equipment sets, loot rules.
- Rolls on party loot using the game's own roll button.
- Auto-moves the hero (Circle, Random, Back and forth), picks up ground loot
  and zooms the minimap for chest/magnet detection.
- Reads live game data, so new skills, items and classes are picked up without
  an addon update.
- Backs up all settings (export/import, undo, reset).

## Controls

| Key | Action |
| --- | --- |
| `F8` | Auto-move on / off |
| `F9` | Open / close the settings panel |

The settings also open from the gear on the map title or from **Customize** in
the game's Options menu.

## Installation

### 1. Build a release

Requires a POSIX shell and Python 3:

```sh
./build-dist.sh
```

The version comes from `src/manifest.json`. Pass one to override it:

```sh
./build-dist.sh 4.2.1
```

Output (gitignored):

```
dist/v<version>/chrome/                           Chrome/Edge unpacked build
dist/v<version>/ro-survivors-autopick-v<version>-chrome.zip
```

### 2. CloakBrowser

The launchers use [CloakBrowser](https://www.npmjs.com/package/cloakbrowser),
a Chromium build. Install it once with Node.js:

```sh
npx -y cloakbrowser install
```

CloakBrowser requires a free license key. Set it as described by the
CloakBrowser installer (`CLOAKBROWSER_LICENSE_KEY` or the installer prompt).

### 3. Launch

Windows:

```bat
play-ro.cmd
```

Linux:

```sh
./play-ro.sh
```

Both scripts start CloakBrowser with its own profile (`.cloak-profile` on
Windows, `.cloak-profile-linux` on Linux), load the unpacked addon from `src`
and open the game. Your normal browser profile is not touched.

If CloakBrowser is already running, launching again only opens another window
in that process and keeps the old extension loaded. After updating the addon,
quit every CloakBrowser window and start it again; the Activity log must say
`Input worker 4.2.0 ready.`

### 4. Manual install (Chrome / Edge / Firefox)

Chrome or Edge:

1. Open `chrome://extensions` and enable **Developer mode**.
2. Choose **Load unpacked** and select the `src` folder.

Firefox:

1. Open `about:debugging` → **This Firefox** → **Load Temporary Add-on**.
2. Pick `src/manifest.json`.
3. Temporary add-ons are removed when Firefox restarts. To keep it, sign the
   `.xpi` on addons.mozilla.org (unlisted, automated signing) and install the
   signed file, or set `xpinstall.signatures.required` to `false` in
   `about:config` on ESR/Developer Edition/Nightly.

## How input works

Game keys and clicks are replayed through the browser's `debugger` API, so the
page receives them as trusted hardware input. Chrome and Edge show a
"started debugging this browser" bar while the addon is active; the launchers
hide it with `--silent-debugger-extension-api`.

The debugger cannot be used in Firefox, in browsers without the API, or while
DevTools is open on the game tab. In that case movement, picks and rolls stay
idle until the debugger is free again.

## Repository layout

```
src/            extension source (load this folder)
build-dist.sh   release builder
dist/           generated Chrome build (ignored)
play-ro.cmd     Windows launcher
play-ro.sh      Linux launcher
```

## Notes

- Saved data from 1.0.0 and 2.x is kept and used as is.
- The local browser profiles are not part of the extension.
