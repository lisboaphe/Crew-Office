# Office art

What the office shows, in the project's established style: warm, dimensional 16-bit pixel art in honey oak, cream, muted teal and sage. `src/office2d/view.js` places it, and `src/office2d/allocation.js` decides who sits where.

## The sprites

Everything is in `established/`. `sprites.json` gives each one's size, and a PNG with more than one frame is a strip of them, left to right.

| Sprite | What it is | Animation |
|---|---|---|
| `worker` | Two characters and four more heads of hair, six in all, each with sixteen poses: standing, breathing and striding, and from behind for typing, walking away, glancing around, leaning in, thinking, stretching, sipping and scratching their head. Tops take the bot's colour when drawn | Breathing, quicker while working, and two steps of a walk |
| `desk-active-*` | A workstation in use, with one of six programs: `code`, `dashboard`, `chart`, `chat`, `terminal` or `landscape`. A bot keeps its own | Each program runs on the screen |
| `desk-idle` | Its bot is resting, screen dimmed | None |
| `desk-standby` | Free for the next bot, drawn faded | None |
| `chair-back` | The back of the desk's chair alone, drawn over somebody sitting in it | None |
| `floor` | The oak tile, repeated as far as the room needs and stained dark brown as the office draws it | None |
| `window-day`, `-dawn`, `-dusk`, `-night` | One per room, on the back wall, picked by the host's time. Weather is painted over the glass as the office draws | Clouds, or stars and lit windows after dark |
| `wall-clock` | A slim digital display in each room and the break area. Its digits are drawn from the host's time | Digits, and a colon ticking each second |
| `plant` | Beside the lounge and between columns | Swaying |
| `cooler` | Against the back wall | Bubbles rising |
| `shelf`, `lamp` | The office's furniture | None |
| `sofa` | Not drawn at present, since the break area lost its sofa | None |
| `lamp-arc`, `rug-round` | The cozy corner at the top left of the player's first room: an arc lamp with a yellow shade leaning over the armchair, on a round rug | None |
| `door` | In the back wall, between rooms one behind the other | None |
| `coffee` | The break area's cabinet, with the coffee machine and mugs on it | Steam |
| `fridge`, `side-table`, `microwave` | Cut from the break nook and scene sheets | The microwave glows while somebody uses it |
| `break-table` | A round table with four chairs, in the break area | None |
| `noticeboard` | On the break area's wall | None |
| `fax`, `armchair`, `rug`, `cabinet`, `boxes`, `bin`, `picture-*` | Chosen per room from its name, so rooms differ but each stays the same | None |

## How the room is put together

From the bottom: tiled floor, walls and window, furniture, the player at the top middle of their first room, a workstation per bot, and one worker at each active workstation. Every room is one size and holds four bots, two down each side of an aisle. Rooms share walls and are joined by doors, on to a break area on each floor.

Idle agents sometimes visit the break area, and two there may show a small bubble of dots. That is `src/office2d/ambient.js`, and it is only a picture: it reads whether an agent is idle and nothing more, it changes nothing about them, and real work brings them straight back.
 A room view takes the largest whole-number scale that fits, so pixels stay square. A floor view shows all its rooms, smaller if it must be, as an overview.

## Changing them

The art comes from the reference sheets the project's owner made in Aseprite: `office-modular-sprites-established-style.png`, `office-props-sheet.png`, `office-floor-oak.png`, `office-break-nook-props.png` and `office-scene-refined.png`. To rebuild it, from this folder:

```bash
sh source/build-established-art.sh <folder holding those sheets>
```

ImageMagick cuts each sprite and reduces it to a pixel grid, then Aseprite finishes it with `source/finish-established-art.lua`. `established/source/` holds an editable `.aseprite` for each sprite. Rebuilding overwrites both those and the PNGs, so hand edits made in Aseprite are lost unless they also go in the script.

Some are no longer what the rebuild makes. `door`, `fax`, `lamp-arc`, `rug-round` and `break-table` were drawn pixel by pixel in Aseprite, and the rebuild does not make the last three at all, so it would also drop them from `sprites.json`. `worker` had the shadow under its shoes and the stray specks in its recoloured hair cleaned off afterwards, and `armchair` was recoloured from sage to cognac leather. After a rebuild, put those back from version control, or redo them.
