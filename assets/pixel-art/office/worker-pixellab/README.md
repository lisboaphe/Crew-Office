# The worker, as a PixelLab character

What `../established/worker.png` is built from: the office's worker, recreated and animated with
[PixelLab](https://www.pixellab.ai/) on 2026-11-25, and committed exactly as PixelLab returned it
(its download, unzipped), so nothing here has to be generated twice.

- **The character** (`Idle/rotations/`): `create_character` in v3 mode with the earlier worker's
  front frame as the reference, so the look is kept as it was. 1 generation.
- **`Idle/animations/walk-full/south`** and **`walk-away-full/north`**: walking towards us and
  away, 4 frames each, custom v3 animations. 1 generation each.
- **`Idle/animations/typing/north`**: typing at a keyboard, seen from behind, 4 frames. 1 generation.
- **`Idle/animations/walk/`**: PixelLab's template walk, both ways. Not used: it drew him about a
  tenth smaller than he stands, so he shrank as he set off. 2 generations.

`metadata.json` is PixelLab's own record of the files. The east and west rotations are unused.

## Building the sheet

```bash
aseprite -b --script-param root=assets/pixel-art/office --script assets/pixel-art/office/source/build-pixellab-worker.lua
```

`source/build-pixellab-worker.lua` fits each frame into the 26 by 44 cell, puts the sixteen poses
in the order the 2D view reads them, and makes six people out of one by recolouring hair and
skin. Standing, the strides and the typing are PixelLab's; breathing, glancing, leaning, looking
up, stretching, sipping and scratching are the back view moved a little by a rule. It writes
`established/worker.png` and `established/source/worker.aseprite`; the sheet's size, and so
`established/sprites.json`, is unchanged.

Before this, the worker was cut from the owner's reference sheets with the rest of the office by
`source/build-established-art.sh`; running that again would put the old worker back.

Provenance and licence: [visual assets](../../../../docs/developer/visual-assets.md) §7, and the
`pixellab-worker-art` row of `third-party/components.json`.
