# Contributing to Steam Hub

This guide covers the thing that needs the most help right now, adding the "Show
installed games" profile for Elgato devices that don't have one yet. See the table in
section 4 for which devices are covered today.

## 1. Why a device needs its own profile

[`manifest.json`](com.unai-gonzalez.steam-hub.sdPlugin/manifest.json) declares the
plugin's bundled profiles under `"Profiles"`, one entry per `DeviceType`. There's an
entry for `DeviceType: 0` (the original Stream Deck and the MK2, which share the same 5x3
grid), pointing at
[`Steam Hub.streamDeckProfile`](com.unai-gonzalez.steam-hub.sdPlugin/Steam%20Hub.streamDeckProfile),
and one for `DeviceType: 13` (the Stream Deck + XL, 9x4). A device with no entry gets no
ready-to-use profile, because a profile is built around one specific grid and can't be
reused across devices of different shapes.

## 2. Why you can't just write the profile file by hand

A `.streamDeckProfile` is a zip file that the Stream Deck app generates when you export
a profile from its UI. It stores the device it was made on, plus the exact layout of
every key. It isn't meant to be edited by hand or copied from the MK2 one for a
different key grid.

So, to add a device, you need that device connected to the Stream Deck app, and you
build the profile through the app itself, the same way the MK2 one was made.

## 3. How "Show installed games" works

Look at [`src/actions/show-installed.ts`](src/actions/show-installed.ts). Each key stores
`mode`, what it does, plus `index` for a fixed slot and optionally `collection`, the Steam
collection it numbers into (empty for the whole library):

| `mode` | Inspector label | What the key does |
|---|---|---|
| `auto` | Game, automatic | Takes the next free slot in grid order, left to right, top to bottom, from the key's `coordinates`. |
| `fixed` | Game, fixed slot | Takes the slot in `index`. Automatic keys skip it. |
| `entry` | Open Steam Hub profile | Shows no game; jumps to the `"Steam Hub"` profile when pressed. |
| absent | (shown as one of the above) | Keys from before `mode` existed: `fixed` with an `index`, `entry` without. A freshly dragged key is `entry` too. |

- No artwork needed per device. Each game's cover is drawn on the fly.
- Use `auto` for every game key in a bundled profile, so nothing needs numbering and the
  layout adapts to the grid. Reserve `fixed` for users who want their own order.
- Leave an `entry` key on the user's main profile as the entry point into the list.
- **A profile is a single page.** Don't use Stream Deck's own `Page` actions to fit a big
  library. The **Library page** action
  ([`src/actions/page-turn.ts`](src/actions/page-turn.ts)) shifts every game key on the
  device by a whole page, with no limit on the number of pages. The page size is the
  highest slot on the device, so it adapts to any grid without configuration. The page
  itself lives in [`src/actions/paging.ts`](src/actions/paging.ts), per device and in
  memory only.
- **Previous** on the first page returns to the profile the user came from (it shows a
  back arrow there), so it doubles as the profile's "Back" key.

## 4. Devices and their status

Grid sizes below come straight from the installed SDK
(`node_modules/@elgato/schemas/dist/streamdeck/plugins/index.d.ts`).

| `DeviceType` | Device | Keys / layout | Status |
|---|---|---|---|
| `0` | Stream Deck (original / MK2) | 15 keys, 5x3 | ✅ Has a profile |
| `1` | Stream Deck Mini | 6 keys, 3x2 | ❌ Missing, high priority |
| `2` | Stream Deck XL | 32 keys, 8x4 | ✅ Has a profile |
| `9` | Stream Deck Neo | 8 keys (4x2) + touch strip | ❌ Missing, high priority |
| `7` | Stream Deck + | 8 keys (4x2) + 4 dials + touch strip | ✅ Has a profile |
| `10` | Stream Deck Studio | 32 keys, 16x2, + 2 dials | ❌ Missing, optional |
| `13` | Stream Deck + XL | 36 keys, 9x4, + 6 dials + touch strip | ✅ Has a profile |
| `12` | Galleon 100 SD (gaming keyboard) | 12 keys, 3x4, + screen + 2 dials | ❌ Missing, low priority |
| `3` | Stream Deck Mobile | iOS/Android app, no fixed grid | See "Mobile and Virtual" note |
| `11` | Virtual Stream Deck | configurable canvas, up to 8x8 | See "Mobile and Virtual" note |
| `5` | Stream Deck Pedal | 3 pedals, no screen | Not applicable |
| `4`, `6`, `8` | Corsair G Keys, Corsair Voyager, SCUF Controller | third-party keys, no per-key LCD | Not applicable |

**Dials and touch strip devices (`+`, Studio, `+ XL`, Galleon):** the actions that show a
game on a key all declare `"Controllers": ["Keypad"]` in the manifest, so a profile fills
the regular LCD keys with those. The dials are covered separately by **Library dial**,
which declares `"Controllers": ["Encoder"]` and scrolls the library on the touch display,
so a profile for one of these devices can use its keys and its dials.

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
3. Use the same layout on every device, so they all feel consistent:
   - First key, a **Library page** action set to **Previous page**. On the first page it
     returns to the profile the user came from, so it also serves as "Back".
   - Second key, a **Create Folder** action (Stream Deck's own), holding whatever
     shortcuts you want handy, Steam status, Now playing, Random game, and other Steam
     shortcut destinations like Library or Big Picture.
   - Last key, a **Library page** action set to **Next page**.
   - Every remaining key, a **Show installed games** action. Set one to **Game,
     automatic** and press **Use on every key of this page**; the rest follow and number
     themselves in grid order. Leave their collection empty, so the bundled profile shows
     the whole library.
4. Keep it to a single page. The Library page keys reach the rest of the library.
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
- Press **Next** until it wraps back to `1 / N`, and confirm **Previous** on the first
  page shows a back arrow and returns to the profile you came from. Holding either key
  should jump back to `1 / N`.
- Test a key set to **Open Steam Hub profile**, or the "gamesprofile" shortcut, and confirm it opens the
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
