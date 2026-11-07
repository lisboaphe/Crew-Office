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
NOOK="$SHEETS/office-break-nook-props.png"
SCENE="$SHEETS/office-scene-refined.png"

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
  magick "${4:-$PROPS}" -crop "$2" +repage -alpha set -fuzz 14% -fill none \
    -draw 'alpha 0,0 floodfill' -draw 'alpha %[fx:w-1],0 floodfill' \
    -draw 'alpha 0,%[fx:h-1] floodfill' -draw 'alpha %[fx:w-1],%[fx:h-1] floodfill' \
    -channel A -threshold 50% +channel -filter box -resize "$3" \
    -channel A -threshold 50% +channel -colors 48 -trim +repage "PNG32:$CUT/$1.png"
}
prop plant 260x320+5+700 17.5%

# A longer bookshelf, at the sheet's own size so nothing is smeared by the reduction. A whole bay of
# books goes in where the books end, and all that lies right of it moves along and down by as much
# as the shelf falls away over that distance, so its planks stay straight. The plank on top has
# nothing to repeat under the globe, so it carries on from its one clear stretch.
long_shelf() {
  SRC="$CUT/shelf-sheet.png"
  magick "$PROPS" -crop 300x350+1205+5 +repage "$SRC"
  BG=$(magick "$SRC" -format '%[pixel:p{2,2}]' info:)
  magick -size 400x365 "xc:$BG" \
    \( "$SRC" -crop 165x105+0+0 +repage \) -geometry +0+0 -composite \
    \( "$SRC" -crop 135x105+165+0 +repage \) -geometry +265+11 -composite \
    \( "$SRC" -crop 137x245+0+105 +repage \) -geometry +0+105 -composite \
    \( "$SRC" -crop 163x245+137+105 +repage \) -geometry +237+116 -composite \
    \( "$SRC" -crop 100x170+37+155 +repage -fill "$BG" -draw 'rectangle 0,152 11,170' \) -geometry +137+166 -composite \
    \( "$SRC" -crop 1x60+137+105 +repage -filter point -resize '100x60!' -background none \
       -virtual-pixel transparent -define distort:viewport=100x71+0+0 -filter point +distort Affine '0,0 0,0  100,0 100,11  0,60 0,60' +repage \) -geometry +137+105 -composite \
    "PNG32:$CUT/shelf-long.png"
  prop shelf 400x365+0+0 17.5% "$CUT/shelf-long.png"
  rm -f "$SRC" "$CUT/shelf-long.png"
}
long_shelf
prop lamp 130x300+985+705 17.5%
prop sofa 420x270+285+735 17.5%
prop cooler 170x300+1240+380 17.5%

# The break area's cabinet and appliances, which are already on a clear background.
nook() {
  magick "$NOOK" -crop "$2" +repage -channel A -threshold 50% +channel -filter box -resize "$3" \
    -channel A -threshold 50% +channel -colors 48 -trim +repage "PNG32:$CUT/$1.png"
}
nook coffee 652x600+54+100 12%
nook fridge 404x667+1140+23 11.5%
nook microwave 405x303+1605+364 10%

# Things that stand in a picture rather than on a clear background, cut along their outlines, which
# are given in the picture's own coordinates.
outlined() { # name, picture, crop, x, y, scale, outline
  magick "$2" -crop "$3x$4+$5" +repage -alpha transparent -alpha off \
    \( -clone 0 -fill black -colorize 100 -fill white -draw "translate -${5%%+*},-${5##*+} polygon $7" \) \
    -delete 0 "$CUT/$1-mask.png"
  magick "$2" -crop "$3x$4+$5" +repage "$CUT/$1-mask.png" -alpha off -compose CopyOpacity -composite \
    -channel A -threshold 50% +channel -filter box -resize "$6" -channel A -threshold 50% +channel \
    -unsharp 0x0.6 -colors 48 -trim +repage "PNG32:$CUT/$1.png"
  rm -f "$CUT/$1-mask.png"
}
outlined cabinet "$SCENE" 110 100 1275+130 45% '1309,136 1364,136 1367,143 1379,145 1379,202 1362,220 1362,224 1289,224 1286,217 1286,167 1306,149'
outlined bin "$SCENE" 60 75 1512+155 51% '1528,162 1561,162 1566,169 1566,184 1562,187 1561,219 1558,224 1528,224 1525,217 1523,187 1519,184 1519,168'
outlined side-table "$SCENE" 70 75 1345+685 80% '1367,692 1392,692 1406,693 1406,708 1404,741 1395,741 1395,754 1384,754 1384,725 1376,725 1376,741 1366,741 1366,754 1354,754 1354,723 1350,721 1350,709 1361,696'

# Whole rectangles on the wall.
magick "$SCENE" -crop 155x97+1416+64 +repage -filter box -resize 37.5% -unsharp 0x0.6 -colors 48 "PNG32:$CUT/noticeboard.png"
magick "$SCENE" -crop 77x117+251+62 +repage -filter box -resize 48% -unsharp 0x0.6 -colors 48 "PNG32:$CUT/door.png"

# Boxes for a corner of a room: the wicker basket and storage box from the shelf, one on the other.
outlined basket "$PROPS" 95 75 1340+250 45% '1342,263 1355,253 1423,257 1425,310 1415,317 1350,310 1345,295'
outlined box "$PROPS" 85 65 1345+178 45% '1348,195 1365,183 1422,185 1424,230 1405,237 1350,227'
magick -size 40x46 xc:none "$CUT/basket.png" -geometry +0+20 -composite "$CUT/box.png" -geometry +2+0 -composite -trim +repage "PNG32:$CUT/boxes.png"
rm -f "$CUT/basket.png" "$CUT/box.png"
prop fax 270x265+398+405 17.5%
prop armchair 230x250+722+752 17.5%
prop rug 410x220+1118+772 17.5%

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

# Aseprite writes PNGs quickly rather than small. This changes no pixel.
for png in "$OUT"/*.png; do
  magick "$png" -strip -define png:compression-level=9 -define png:compression-strategy=1 "PNG32:$png"
done
