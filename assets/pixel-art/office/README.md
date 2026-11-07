# Office art

What the office shows, in the project's established style: warm, dimensional 16-bit pixel art in honey oak, cream, muted teal and sage. `src/office2d/view.js` places it, and `src/office2d/allocation.js` decides who sits where.

## The sprites

Everything is in `established/`. `sprites.json` gives each one's size, and a PNG with more than one frame is a strip of them, left to right.

| Sprite | What it is | Animation |
|---|---|---|
| `worker` | Two characters and four more heads of hair, six in all. Tops take the bot's colour when drawn | Breathing, quicker while working |
| `desk-active-*` | A workstation in use, with one of six programs: `code`, `dashboard`, `chart`, `chat`, `terminal` or `landscape`. A bot keeps its own | Each program runs on the screen |
| `desk-idle` | Its bot is resting, screen dimmed | None |
| `desk-standby` | Free for the next bot, drawn faded | None |
| `floor` | The oak tile, repeated as far as the room needs | None |
| `window` | Over each column, on the back wall | Clouds passing |
| `plant` | Beside the lounge and between columns | Swaying |
| `cooler` | Against the back wall | Bubbles rising |
| `shelf`, `sofa`, `lamp` | The room's furniture | None |

## How the room is put together

From the bottom: tiled floor, walls and window, furniture, one workstation per bot, and one worker at each active workstation. Every room is one size and holds four bots. A room view takes the largest whole-number scale that fits, so pixels stay square. A floor view shows all its rooms, smaller if it must be, as an overview.

## Changing them

The art comes from the project's reference sheets: `office-modular-sprites-established-style.png`, `office-props-sheet.png` and `office-floor-oak.png`. To rebuild it, from this folder:

```bash
sh source/build-established-art.sh <folder holding those sheets>
```

ImageMagick cuts each sprite and reduces it to a pixel grid, then Aseprite finishes it with `source/finish-established-art.lua`. `established/source/` holds an editable `.aseprite` for each sprite. Rebuilding overwrites both those and the PNGs, so hand edits made in Aseprite are lost unless they also go in the script.
