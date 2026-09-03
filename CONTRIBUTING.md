# Contributing to Steam Hub

This guide covers the thing that needs the most help right now, adding the "Show
installed games" profile for Elgato devices other than the original Stream Deck/MK2,
which is the only one that works today.

## 1. Why it only works on the original Stream Deck / MK2

[`manifest.json`](com.unai-gonzalez.steam-hub.sdPlugin/manifest.json) declares the
plugin's bundled profiles under `"Profiles"`. Right now there's only one entry, for
`DeviceType: 0` (the original Stream Deck and the MK2, which share the same 5x3 grid).
It points at
[`Steam Hub.streamDeckProfile`](com.unai-gonzalez.steam-hub.sdPlugin/Steam%20Hub.streamDeckProfile).
No other device has an entry, so no other device gets a ready-to-use profile.

## 2. Why you can't just write the profile file by hand

A `.streamDeckProfile` is a zip file that the Stream Deck app generates when you export
a profile from its UI. It stores the device it was made on, plus the exact layout of
every key. It isn't meant to be edited by hand or copied from the MK2 one for a
different key grid.

So, to add a device, you need that device connected to the Stream Deck app, and you
build the profile through the app itself, the same way the MK2 one was made.

## 3. How "Show installed games" works

Look at [`src/actions/show-installed.ts`](src/actions/show-installed.ts). Each key only
stores one setting, `index`, the 1-based position it shows from the sorted library.

- No artwork needed per device. Each game's cover is drawn on the fly.
- Key order doesn't have to match the index order. Number them however makes sense for
  that device's layout.
- A key with no `index` set jumps to the `"Steam Hub"` profile when pressed. Leave one
  of these on the user's main profile as the entry point into the list.
- If a device has fewer keys than a user's library has games, use Stream Deck's own
  `Create Folder` / `Page` actions to add more pages, like the MK2 profile does.

## 4. Devices and their status

Grid sizes below come straight from the installed SDK
(`node_modules/@elgato/schemas/dist/streamdeck/plugins/index.d.ts`).

| `DeviceType` | Device | Keys / layout | Status |
|---|---|---|---|
| `0` | Stream Deck (original / MK2) | 15 keys, 5x3 | Has a profile |
| `1` | Stream Deck Mini | 6 keys, 3x2 | Missing, high priority |
| `2` | Stream Deck XL | 32 keys, 8x4 | Missing, high priority |
| `9` | Stream Deck Neo | 8 keys (4x2) + touch strip | Missing, high priority |
| `7` | Stream Deck + | 8 keys (4x2) + 4 dials + touch strip | Missing the 8 keys, see note |
| `10` | Stream Deck Studio | 32 keys, 16x2, + 2 dials | Missing, optional |
| `13` | Stream Deck + XL | 36 keys, 9x4, + 6 dials + touch strip | Missing the keys, see note |
| `12` | Galleon 100 SD (gaming keyboard) | 12 keys, 3x4, + screen + 2 dials | Missing, low priority |
| `3` | Stream Deck Mobile | iOS/Android app, no fixed grid | See "Mobile and Virtual" note |
| `11` | Virtual Stream Deck | configurable canvas, up to 8x8 | See "Mobile and Virtual" note |
| `5` | Stream Deck Pedal | 3 pedals, no screen | Not applicable |
| `4`, `6`, `8` | Corsair G Keys, Corsair Voyager, SCUF Controller | third-party keys, no per-key LCD | Not applicable |

**Dials and touch strip devices (`+`, Studio, `+ XL`, Galleon):** every action in this
plugin declares `"Controllers": ["Keypad"]` in the manifest, so it can only sit on the
regular LCD keys. A Stream Deck + profile can only use its 8 keys.

**Mobile and Virtual Stream Deck:** their grid isn't fixed, it depends on how the user
sets it up. A single bundled profile can't cover every layout the way it can for fixed
hardware. Open an issue first if you want to tackle one of these.

**Pedal, G Keys, Voyager, SCUF:** no per-key screen, so there's nowhere to show a game's
cover. Skip these.

## 5. Requirements

- The physical device you're building a profile for.
- Node.js 24 and npm.
- The Stream Deck app, version 7.1 or later.

## 6. Set up the development environment

```bash
npm install
npm run build
npx streamdeck link com.unai-gonzalez.steam-hub.sdPlugin
npx streamdeck restart com.unai-gonzalez.steam-hub
```

`streamdeck link` is only needed once. After that, `npm run watch` rebuilds and
restarts the plugin on every change. To debug with breakpoints, use "Attach to Plugin"
in [`.vscode/launch.json`](.vscode/launch.json).

## 7. Build the profile in the Stream Deck app

1. Connect the target device.
2. Create a new profile for it. The name you give it in the app doesn't matter, what
   matters is the `Name` you'll set in `manifest.json` in step 9.
3. Use the same layout as the MK2 profile, so every device feels consistent:
   - First key, a **Steam shortcut** action set to "Back", so it returns to the
     profile the user came from.
   - Second key, a **Create Folder** action (Stream Deck's own), holding whatever
     shortcuts you want handy, Steam status, Now playing, Random game, and other Steam
     shortcut destinations like Library or Big Picture.
   - Every remaining key, a **Show installed games** action, numbered `1`, `2`, `3`,
     and so on, in whatever order makes sense for the grid.
4. If the library could exceed the number of remaining keys, add pages to keep
   numbering on the next one, and reserve a key on each page for "next page" (and
   "previous page" if there's room), like the MK2 profile does.
5. Save the profile.

## 8. Export the profile and add it to the plugin

Export the profile from the app's profile dropdown, then copy the `.streamDeckProfile`
file into `com.unai-gonzalez.steam-hub.sdPlugin/`, named for the device, for example:

```
com.unai-gonzalez.steam-hub.sdPlugin/Steam Hub XL.streamDeckProfile
```

## 9. Register it in `manifest.json`

Add a new entry to `Profiles`, with the `DeviceType` from the table above and a `Name`
matching the file's path, without the `.streamDeckProfile` extension:

```json
"Profiles": [
  {
    "Name": "Steam Hub",
    "DeviceType": 0,
    "Readonly": false,
    "DontAutoSwitchWhenInstalled": true,
    "AutoInstall": true
  },
  {
    "Name": "Steam Hub XL",
    "DeviceType": 2,
    "Readonly": false,
    "DontAutoSwitchWhenInstalled": true,
    "AutoInstall": true
  }
]
```

## 10. Register the device in the code, one line

`streamDeck.profiles.switchToProfile(deviceId, name)` only works if `name` matches the
`Name` declared for that device's `DeviceType` in the manifest. Since each device uses
its own file, and so its own `Name`, the plugin needs to know which name belongs to
which device.

That lookup is in [`src/actions/common.ts`](src/actions/common.ts):

```ts
const PROFILE_BY_DEVICE: Partial<Record<DeviceType, string>> = {
  [DeviceType.StreamDeck]: "Steam Hub",
};
```

Add one entry for the device you're adding, using the same `Name` from step 9:

```ts
const PROFILE_BY_DEVICE: Partial<Record<DeviceType, string>> = {
  [DeviceType.StreamDeck]: "Steam Hub",
  [DeviceType.StreamDeckXL]: "Steam Hub XL",
};
```

That's the only code change needed. `show-installed.ts` and `steam-shortcut.ts` already
use `profileFor(ev.action.device.type)` to pick the right profile.

## 11. Validate and test

```bash
npx streamdeck validate
```

Then, with the plugin linked (step 6):

- Install the new profile on your device and confirm the keys fill in with your real
  library.
- Test the key with no `index`, or the "gamesprofile" shortcut, and confirm it opens the
  right profile on that device.
- If you have another Elgato device too, confirm `DeviceType: 0` still works as before.

## 12. Before opening the PR

- Don't include `bin/`, `logs/`, or `cache/` from the `.sdPlugin` folder, they're
  already in [`.gitignore`](.gitignore).
- Say which device you tested, and on which version of the Stream Deck app.
- If the device has dials or a touch strip, mention that the profile only covers the
  LCD keys.
- A screenshot or short video of the profile working helps a lot for review.

---

Not sure how a device fits in, or have questions about step 10? Open an issue before
exporting the profile, so we don't redo work if the approach needs to change.
