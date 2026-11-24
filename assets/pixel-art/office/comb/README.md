# The comb's sprites

The art the 2D office uses only when it is laid out as a comb (`?layout=comb`). Everything else
it draws comes from `../established/`.

All of it was generated with [PixelLab](https://www.pixellab.ai/) on 2026-11-25, one generation
per image with `create_image_pixflux`, and is committed exactly as it came back, so nothing here
has to be generated twice. Where a palette reference is named, that sprite from `../established/`
was uploaded so the colours would match the office's own.

| File | Size | Prompt | Palette from | Used as |
|---|---|---|---|---|
| `comb-floor.png` | 96×96 | top-down view of a floor made of hexagonal honey-coloured tiles, honeycomb pattern, warm amber and light brown tiles with dark brown grout, pixel art texture | none | the comb rooms' floor, tiled and stained like the oak; also faded into the back wall as wallpaper |
| `comb-arch.png` | 40×56 | open doorway in a wall with no door, warm oak wooden frame around a dark passage, front view, pixel art game sprite | `door.png` | the doorway in a back wall to the room behind |
| `hex-rug.png` | 72×40 | hexagon-shaped woven rug, honey yellow and cream with a darker brown border, lying flat on the floor, pixel art game sprite | `armchair.png` | the rug in a comb room |
| `beanbag.png` | 40×36 | soft round beanbag chair, mustard yellow fabric, cozy office furniture, pixel art game sprite | `armchair.png` | a prop a comb room may have |
| `whiteboard.png` | 40×52 | small standing whiteboard on a wooden easel with colourful sticky notes, office furniture, pixel art game sprite | `desk-idle.png` | a prop a comb room may have |
| `unused/floor-hex-first-try.png` | 132×90 | seamless tileable floor texture, warm honey-coloured hexagonal ceramic tiles with thin dark grout lines, cozy office floor, pixel art | `floor.png` | nothing: the first floor attempt, kept so it is not paid for again |

Two attempts at a wallpaper strip came back blank and were not charged. Six generations were
spent in all.

`sprites.json` gives each sprite's size, in the same form as `../established/sprites.json`.
Provenance and licence: [visual assets](../../../../docs/developer/visual-assets.md) §7, and the
`pixellab-comb-art` row of `third-party/components.json`.
