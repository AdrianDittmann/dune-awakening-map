# Dune: Awakening Map

Interactive map of Dune: Awakening built from the game's own files: the Hagga Basin, the Deep Desert in all twelve weekly layouts, and the Overland map.

![Hagga Basin, Deep Desert and Overland](docs/maps.webp)

## Features

- Base maps rendered from the game's terrain and art meshes. A 3D view of the Hagga Basin and the Deep Desert with the game's rocks, buildings and wrecks.
- Outposts, camps, caves, shipwrecks, testing stations, trading posts, taxis and travel gates, with the game's icons and names.
- Resource zones and node spots. Shared spots show the chance of each resource, including Titanium and Stravidium for each Deep Desert layout.
- Spawn sites and rules for crashed ships and spice fields.
- The game's sector grid with grid references. Search by place, resource, grid reference or metres.
- The Deep Desert layout that is live this week is marked. Searching for sectors lists the layouts with a testing station, wreck or cave there.
- A tracker for the 10,000-of-each harvesting achievement, saved in the browser.

## Run

**Windows:** download `Dune-Awakening-Map-windows.zip` from [Releases](../../releases), extract it and run `Dune Awakening Map.exe`. It serves the map on `127.0.0.1:47816` and opens it in the default browser. It stops 10 minutes after the map tab is closed.

**Other systems:** serve the `app` folder from the zip with any static web server and open the address in a browser:

```
python3 -m http.server 47816 --bind 127.0.0.1 --directory app
```

## Build

Requires Node.js 20 or later, pnpm and Rust.

The map data (`app/public/data`, `app/public/tiles`) is generated from the game files and is not part of the repository. Copy `app/data` and `app/tiles` from a release zip into `app/public/`, then:

```
cd app
pnpm install
pnpm dev
```

`scripts/package.ps1` builds the web app and the launcher and writes `release/Dune-Awakening-Map-windows.zip`.

## Weekly layout

`live.json` names the Deep Desert layout of the current week (`layout` 0-11 is button 1-12 in the app) and the time it went live. The app reads it at start.

## Data

Extracted read-only from the installed game files. The game process is never read or modified.

Unofficial fan project, not affiliated with or endorsed by Funcom. Dune: Awakening is a trademark of Funcom. Dune is a trademark of Herbert Properties LLC. The game content shown on the map belongs to its owners. The code is released under the MIT License.
