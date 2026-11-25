-- Builds established/worker.png from the PixelLab character in worker-pixellab/: one person drawn
-- and animated by PixelLab, made into six by recolouring hair and skin, sixteen poses each.
--
--   aseprite -b --script-param root=<assets/pixel-art/office> --script source/build-pixellab-worker.lua
--
-- The poses are in the order the 2D view reads them (src/office2d/view.js and desk-poses.js):
-- standing, breathing, two strides towards us, from behind, two of typing, glancing aside, two
-- strides away, glancing the other way, leaning in, looking up, stretching, sipping, scratching.
-- Standing, the strides and the typing are PixelLab's frames; the rest are the back view moved a
-- little by a rule, as the earlier art's were.
local root = app.params.root
assert(root, 'Pass --script-param root=<assets/pixel-art/office>')
local src = app.fs.joinPath(root, 'worker-pixellab', 'Idle')
local out = app.fs.joinPath(root, 'established')
local pc = app.pixelColor
local W, H = 26, 44

local function load(rel) return Image{ fromFile = app.fs.joinPath(src, rel .. '.png') } end
local function each(image, fn)
  for y = 0, image.height - 1 do
    for x = 0, image.width - 1 do fn(x, y, image:getPixel(x, y)) end
  end
end
local function hsl(p)
  local r, g, b = pc.rgbaR(p) / 255, pc.rgbaG(p) / 255, pc.rgbaB(p) / 255
  local hi, lo = math.max(r, g, b), math.min(r, g, b)
  local l, d = (hi + lo) / 2, hi - lo
  if d == 0 then return 0, 0, l end
  local s = d / (1 - math.abs(2 * l - 1))
  local h
  if hi == r then h = ((g - b) / d) % 6 elseif hi == g then h = (b - r) / d + 2 else h = (r - g) / d + 4 end
  return h * 60, s, l
end

--- Where the drawn part of an image is.
local function bounds(image)
  local x0, y0, x1, y1 = image.width, image.height, -1, -1
  each(image, function(x, y, p)
    if pc.rgbaA(p) > 0 then
      x0, y0, x1, y1 = math.min(x0, x), math.min(y0, y), math.max(x1, x), math.max(y1, y)
    end
  end)
  return x0, y0, x1, y1
end

--- Frames of one animation into cells: centred as its first frame is, so nobody slides sideways,
--- and each frame's feet on the bottom row.
local function cells(frames)
  local x0, _, x1 = bounds(frames[1])
  local dx = W // 2 - (x0 + x1 + 1) // 2
  local list = {}
  for _, frame in ipairs(frames) do
    local _, _, _, bottom = bounds(frame)
    local cell = Image(W, H, ColorMode.RGB)
    cell:drawImage(frame, Point(dx, H - 1 - bottom))
    list[#list + 1] = cell
  end
  return list
end

local function moved(image, rule)
  local frame = Image(image.width, image.height, ColorMode.RGB)
  each(image, function(x, y, p)
    if pc.rgbaA(p) == 0 then return end
    local dx, dy = rule(x, y)
    local tx, ty = x + dx, y + dy
    if tx >= 0 and ty >= 0 and tx < image.width and ty < image.height then frame:drawPixel(tx, ty, p) end
  end)
  return frame
end

--- Breathing: the body above the hips a pixel lower, the gap filled from the row below.
local function breathing(image)
  local limit = math.floor(H * 0.68)
  local copy = moved(image, function(_, y) return 0, y < limit and 1 or 0 end)
  each(image, function(x, y, p)
    if y == limit and pc.rgbaA(copy:getPixel(x, y)) == 0 then copy:drawPixel(x, y, p) end
  end)
  return copy
end

local frames = function(name, dir, n)
  local list = {}
  for i = 0, n - 1 do list[#list + 1] = load(string.format('animations/%s/%s/frame_%03d', name, dir, i)) end
  return list
end
local front = cells({ load('rotations/south') })[1]
local back = cells({ load('rotations/north') })[1]
local towards = cells(frames('walk-full', 'south', 4))
local away = cells(frames('walk-away-full', 'north', 4))
local typing = cells(frames('typing', 'north', 4))

-- The head and the arms in the back view, for the small movements.
local HEAD, ARMS_TOP, ARMS_BOTTOM = 22, 23, 33
local middle = W // 2
local armOf = function(x, y)
  if y < ARMS_TOP or y > ARMS_BOTTOM then return nil end
  if x < middle - 5 then return 'left' elseif x >= middle + 5 then return 'right' end
  return nil
end
local posed = function(hx, hy, rule)
  local frame = moved(back, function(x, y)
    if y < HEAD then return hx, hy end
    local arm = armOf(x, y)
    if arm then return 0, rule and rule(arm) or 0 end
    return 0, 0
  end)
  if hy < 0 then
    each(back, function(x, y, p)
      if y == HEAD - 1 and pc.rgbaA(p) > 0 then frame:drawPixel(x, y, p) end
    end)
  end
  return frame
end
local sipping = posed(1, 0, function(arm) return arm == 'right' and -8 or 0 end)
for my = 18, 22 do
  for mx = 19, 23 do
    local edge = my == 18 or my == 22 or mx == 19 or mx == 23
    sipping:drawPixel(mx, my, edge and pc.rgba(58, 34, 18, 255) or pc.rgba(244, 234, 214, 255))
  end
end

local poses = {
  front,
  breathing(front),
  towards[2],
  towards[4],
  back,
  typing[1],
  typing[3],
  posed(1, 0),
  away[2],
  away[4],
  posed(-1, 0),
  posed(0, 2, function() return -1 end),
  posed(0, -1),
  posed(0, 1, function() return -10 end),
  sipping,
  posed(-1, 1, function(arm) return arm == 'left' and -9 or 0 end),
}

-- Six people from one: hair and skin recoloured. Hair is the warm brown of the head, highlights
-- and all; skin the warm, very light colour anywhere. Outlines, eyes, jacket and trainers stay.
local RAMPS = {
  brown = nil,
  blonde = { { 122, 82, 32 }, { 186, 136, 54 }, { 226, 184, 88 }, { 244, 218, 138 } },
  black = { { 20, 16, 18 }, { 38, 32, 34 }, { 60, 52, 54 }, { 88, 78, 80 } },
  auburn = { { 88, 34, 20 }, { 140, 58, 30 }, { 180, 84, 44 }, { 214, 122, 70 } },
  silver = { { 96, 100, 112 }, { 142, 146, 158 }, { 186, 190, 200 }, { 226, 228, 234 } },
  navy = { { 18, 24, 58 }, { 32, 44, 96 }, { 54, 72, 136 }, { 88, 108, 170 } },
}
local PEOPLE = {
  { hair = nil, skin = 1 },
  { hair = RAMPS.blonde, skin = 1 },
  { hair = RAMPS.black, skin = 0.78 },
  { hair = RAMPS.auburn, skin = 1 },
  { hair = RAMPS.black, skin = 0.55 },
  { hair = RAMPS.silver, skin = 0.85 },
}
local function person(image, look)
  local copy = Image(image)
  each(image, function(x, y, p)
    if pc.rgbaA(p) == 0 then return end
    local h, s, l = hsl(p)
    local warm = h < 45 or h > 340
    if look.hair and y < HEAD + 2 and warm and s > 0.2 and l > 0.08 and l < 0.62 then
      local ramp = look.hair
      local i = math.max(1, math.min(#ramp, math.floor((l - 0.08) / 0.54 * #ramp) + 1))
      local c = ramp[i]
      copy:drawPixel(x, y, pc.rgba(c[1], c[2], c[3], 255))
    elseif look.skin ~= 1 and warm and s > 0.3 and l >= 0.62 then
      local k = look.skin
      copy:drawPixel(x, y, pc.rgba(math.floor(pc.rgbaR(p) * k), math.floor(pc.rgbaG(p) * k * 0.96), math.floor(pc.rgbaB(p) * k * 0.92), 255))
    end
  end)
  return copy
end

local all = {}
for _, look in ipairs(PEOPLE) do
  for _, pose in ipairs(poses) do all[#all + 1] = person(pose, look) end
end

local sprite = Sprite(W, H, ColorMode.RGB)
sprite.layers[1].name = 'art'
local strip = Image(W * #all, H, ColorMode.RGB)
for i, image in ipairs(all) do
  if i > 1 then sprite:newEmptyFrame(i) end
  sprite:newCel(sprite.layers[1], i, image, Point(0, 0))
  strip:drawImage(image, Point(W * (i - 1), 0))
end
sprite:saveAs(app.fs.joinPath(out, 'source', 'worker.aseprite'))
sprite:close()
strip:saveAs(app.fs.joinPath(out, 'worker.png'))
print(string.format('worker: %d frames of %dx%d', #all, W, H))
