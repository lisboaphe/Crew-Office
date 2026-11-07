#!/bin/sh
# Builds the office's sprites from the project's established-style reference sheets:
#
#   sh source/build-established-art.sh <folder holding the sheets>      (run from assets/pixel-art/office)
#
# ImageMagick cuts each sprite out and reduces it to a true pixel grid. Aseprite then finishes them
# in finish-established-art.lua: variants, animation frames, editable sources and the manifest.
set -eu

SHEETS="$1"
OUT="$PWD/established"
CUT="$OUT/cut"
mkdir -p "$CUT"
MODULAR="$SHEETS/office-modular-sprites-established-style.png"
PROPS="$SHEETS/office-props-sheet.png"
FLOOR="$SHEETS/office-floor-oak.png"

# The modular sheet is already transparent. One art pixel is eight source pixels, sharpened a little
# afterwards, which keeps these as crisp as the props beside them.
modular() {
  magick "$MODULAR" -crop "$2" +repage -channel A -threshold 50% +channel \
    -filter box -resize 12.5% -channel A -threshold 50% +channel -unsharp 0x0.6+0.8+0 -colors 48 "PNG32:$CUT/$1.png"
}
modular worker-a 182x324+304+52
modular worker-b 166x317+1054+59
modular desk-on 658x547+76+431
modular desk-off 658x547+805+431

# The props sheet has a soft grey background, flooded away from each crop's corners.
prop() {
  magick "$PROPS" -crop "$2" +repage -alpha set -fuzz 14% -fill none \
    -draw 'alpha 0,0 floodfill' -draw 'alpha %[fx:w-1],0 floodfill' \
    -draw 'alpha 0,%[fx:h-1] floodfill' -draw 'alpha %[fx:w-1],%[fx:h-1] floodfill' \
    -channel A -threshold 50% +channel -filter box -resize "$3" \
    -channel A -threshold 50% +channel -colors 48 -trim +repage "PNG32:$CUT/$1.png"
}
prop plant 260x320+5+700 17.5%
prop shelf 300x350+1205+5 17.5%
prop lamp 130x300+985+705 17.5%
prop sofa 420x270+285+735 17.5%
prop cooler 170x300+1240+380 17.5%
prop coffee 345x270+760+405 17.5%

# The oak tile. The sheet cannot simply repeat: it has a groove on both its top and bottom edges and
# its planks narrow towards the bottom. So the tile is its six most even planks, each one lined up
# so its groove lands on a whole row.
set -- 149 148 297 147 444 144 588 145 733 144 877 140
: > "$CUT/planks.txt"
i=0
while [ $# -gt 0 ]; do
  top=$(( $1 - 6 )); height=$2; shift 2
  magick "$FLOOR" -crop "1254x$height+0+$top" +repage -filter point -resize 132x15! "$CUT/plank$i.png"
  i=$(( i + 1 ))
done
magick "$CUT"/plank0.png "$CUT"/plank1.png "$CUT"/plank2.png "$CUT"/plank3.png "$CUT"/plank4.png "$CUT"/plank5.png -append "PNG32:$CUT/floor.png"
rm -f "$CUT"/plank?.png "$CUT/planks.txt"

aseprite -b --script-param root="$PWD" --script source/finish-established-art.lua
rm -rf "$CUT"
