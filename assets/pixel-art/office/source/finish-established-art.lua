-- Finishes the sprites cut by build-established-art.sh: makes variants and animation frames, and
-- writes an editable .aseprite and a PNG strip for each, with established/sprites.json listing them.

local root = app.params.root
assert(root, 'Pass --script-param root=<folder>')
local out = app.fs.joinPath(root, 'established')
local sources = app.fs.joinPath(out, 'source')
app.fs.makeAllDirectories(sources)

local pc = app.pixelColor
local CLEAR = pc.rgba(0, 0, 0, 0)

local function load(name) return Image{ fromFile = app.fs.joinPath(out, 'cut', name .. '.png') } end

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

local manifest = {}

local function save(name, frames, fps)
  local w, h = frames[1].width, frames[1].height
  local sprite = Sprite(w, h, ColorMode.RGB)
  sprite.layers[1].name = 'art'
  local strip = Image(w * #frames, h, ColorMode.RGB)
  for i, image in ipairs(frames) do
    if i > 1 then sprite:newEmptyFrame(i) end
    sprite:newCel(sprite.layers[1], i, image, Point(0, 0))
    strip:drawImage(image, Point(w * (i - 1), 0))
  end
  if fps > 0 then for _, f in ipairs(sprite.frames) do f.duration = 1 / fps end end
  sprite:saveAs(app.fs.joinPath(sources, name .. '.aseprite'))
  sprite:close()
  strip:saveAs(app.fs.joinPath(out, name .. '.png'))
  manifest[#manifest + 1] = string.format('  "%s": { "width": %d, "height": %d, "frames": %d, "fps": %s }', name, w, h, #frames, fps)
end

--- The rows above `limit` moved by `dy`, so a body breathes or a plant leans without losing detail.
local function shifted(image, limit, dx, dy)
  local copy = Image(image.width, image.height, ColorMode.RGB)
  each(image, function(x, y, p)
    if y >= limit then copy:drawPixel(x, y, p)
    else
      local tx, ty = x + dx, y + dy
      if tx >= 0 and ty >= 0 and tx < copy.width and ty < copy.height and pc.rgbaA(p) > 0 then copy:drawPixel(tx, ty, p) end
    end
  end)
  -- Where the rows part, the row below shows through rather than leaving a gap.
  if dy > 0 then
    each(image, function(x, y, p)
      if y == limit and pc.rgbaA(copy:getPixel(x, y)) == 0 then copy:drawPixel(x, y, p) end
    end)
  end
  return copy
end

-- Workers: both of ours, with more heads of hair so a team is not a row of twins. ---------------

local function rehaired(image, ramp)
  local copy = Image(image)
  local rows = math.floor(image.height * 0.42)
  each(image, function(x, y, p)
    if y < rows and pc.rgbaA(p) > 0 then
      local h, s, l = hsl(p)
      -- Hair is the dark or brown part of the head; skin is lighter, and outlines are darker still.
      if l > 0.1 and l < 0.5 and not (h > 15 and h < 40 and l > 0.42) then
        local i = math.max(1, math.min(#ramp, math.floor(l / 0.5 * #ramp) + 1))
        local c = ramp[i]
        copy:drawPixel(x, y, pc.rgba(c[1], c[2], c[3], 255))
      end
    end
  end)
  return copy
end

local RAMPS = {
  blonde = { { 122, 82, 32 }, { 186, 136, 54 }, { 226, 184, 88 }, { 244, 218, 138 } },
  navy = { { 18, 24, 58 }, { 32, 44, 96 }, { 54, 72, 136 }, { 88, 108, 170 } },
  auburn = { { 88, 34, 20 }, { 140, 58, 30 }, { 180, 84, 44 }, { 214, 122, 70 } },
  silver = { { 96, 100, 112 }, { 142, 146, 158 }, { 186, 190, 200 }, { 226, 228, 234 } },
}

local a, b = load('worker-a'), load('worker-b')
local variants = { a, b, rehaired(a, RAMPS.blonde), rehaired(b, RAMPS.navy), rehaired(a, RAMPS.auburn), rehaired(a, RAMPS.silver) }
local workerFrames = {}
--- A stride, facing right: the legs part from the hips, the back heel lifts, the body rises a pixel
--- at the top of the step, and the arms swing against the legs.
local function stepping(image, leftForward)
  local frame = Image(image.width, image.height, ColorMode.RGB)
  local hip = image.height - 14
  local middle = image.width // 2
  local lead = leftForward and -1 or 1
  each(image, function(x, y, p)
    if pc.rgbaA(p) == 0 then return end
    local dx, dy = 0, 0
    if y >= hip then
      local side = x < middle and -1 or 1
      local reach = math.floor((y - hip) / (image.height - hip) * 4 + 0.5)
      dx = side * reach
      if side ~= lead and y >= image.height - 6 then dy = -2 end
    else
      dy = -1
      local arm = y >= hip - 9 and (x < middle - 6 or x >= middle + 6)
      -- The arm on the side of the back leg comes forward, which in this view means up a little.
      if arm and (x < middle and -1 or 1) ~= lead then dy = -2 elseif arm then dy = 0 end
    end
    local tx, ty = x + dx, y + dy
    if tx >= 0 and ty >= 0 and tx < image.width and ty < image.height then frame:drawPixel(tx, ty, p) end
    -- The row the body rose away from stays filled, so the waist does not come apart.
    if y == hip then frame:drawPixel(x, y - 1, p) end
  end)
  return frame
end

-- Each cut moved by a rule per pixel, for the small movements below.
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

--- The same person from behind: the face and ears become hair, shaded from the hair's own colours
--- with a soft light on the crown and a few strands falling down it.
local function fromBehind(cell)
  local copy = Image(cell)
  local FACE_TOP, FACE_BOTTOM = 3, 22
  local middle = cell.width // 2
  -- The hair's colours are what lies just under the top outline of the head, darkest to lightest.
  local samples = {}
  for x = middle - 5, middle + 5 do
    local y = 0
    while y < cell.height - 1 and pc.rgbaA(cell:getPixel(x, y)) == 0 do y = y + 1 end
    for row = y + 1, y + 4 do
      local p = cell:getPixel(x, row)
      if pc.rgbaA(p) > 0 then
        local _, _, l = hsl(p)
        samples[#samples + 1] = { l = l, p = p }
      end
    end
  end
  table.sort(samples, function(a, b) return a.l < b.l end)
  local tone = function(share) return samples[math.max(1, math.floor(#samples * share))].p end
  local dark, mid, light = tone(0.3), tone(0.55), tone(0.85)
  each(cell, function(x, y, p)
    if y < FACE_TOP or y > FACE_BOTTOM or pc.rgbaA(p) == 0 then return end
    -- The silhouette keeps its outline.
    if x == 0 or x == cell.width - 1 or y == 0 then return end
    for _, n in ipairs({ { -1, 0 }, { 1, 0 }, { 0, -1 }, { 0, 1 } }) do
      if pc.rgbaA(cell:getPixel(x + n[1], y + n[2])) == 0 then return end
    end
    local colour = mid
    if y >= FACE_BOTTOM - 4 or x >= cell.width - 6 then colour = dark end
    if y <= FACE_TOP + 7 and x >= middle - 6 and x <= middle + 1 then colour = light end
    -- Strands, a few pixels long, so it is hair rather than a flat cap.
    if (x + (y // 4) * 3) % 6 == 0 and y > FACE_TOP + 3 then colour = dark end
    copy:drawPixel(x, y, colour)
  end)
  return copy
end

--- Tidies a silhouette: fills notches a pixel wide, and takes off single pixels sticking out of it.
local function tidied(frame)
  local copy = Image(frame)
  local opaque = function(x, y)
    return x >= 0 and y >= 0 and x < frame.width and y < frame.height and pc.rgbaA(frame:getPixel(x, y)) > 0
  end
  local NEAR = { { 1, 0 }, { -1, 0 }, { 0, 1 }, { 0, -1 } }
  for y = 0, frame.height - 1 do
    for x = 0, frame.width - 1 do
      local count, darkest, darkestL = 0, nil, 2
      for _, n in ipairs(NEAR) do
        if opaque(x + n[1], y + n[2]) then
          count = count + 1
          local p = frame:getPixel(x + n[1], y + n[2])
          local _, _, l = hsl(p)
          if l < darkestL then darkest, darkestL = p, l end
        end
      end
      if not opaque(x, y) and count >= 3 then copy:drawPixel(x, y, darkest) end
      -- The feet keep their shadow, which is meant to be soft at the edge.
      if opaque(x, y) and count <= 1 and y < frame.height - 4 then copy:drawPixel(x, y, CLEAR) end
    end
  end
  return copy
end

--- At the keyboard, from behind: one arm reaches forward at a time, and the head nods to it.
local function typing(back, leftHand)
  local middle = back.width // 2
  return moved(back, function(x, y)
    if y < 23 then return 0, 1 end
    local arm = y <= 33 and ((leftHand and x < middle - 5) or (not leftHand and x >= middle + 5))
    return 0, arm and -1 or 0
  end)
end

-- Both cuts are padded to one size, feet on the bottom row, so frames line up. Each person has:
-- standing, breathing, two strides, from behind, two of typing, glancing aside, two strides away.
local WW, WH = 26, 44
for _, v in ipairs(variants) do
  local cell = Image(WW, WH, ColorMode.RGB)
  cell:drawImage(v, Point(math.floor((WW - v.width) / 2), WH - v.height))
  local back = fromBehind(cell)
  local middle = WW // 2
  local HEAD, ARMS_TOP, ARMS_BOTTOM = 23, 24, 33
  local armOf = function(x, y)
    if y < ARMS_TOP or y > ARMS_BOTTOM then return nil end
    if x < middle - 5 then return 'left' elseif x >= middle + 5 then return 'right' end
    return nil
  end
  --- An arm lifted, and the head moved by as much as the pose wants.
  local posed = function(hx, hy, rule)
    local frame = moved(back, function(x, y)
      if y < HEAD then return hx, hy end
      local arm = armOf(x, y)
      if arm then return 0, rule and rule(arm) or 0 end
      return 0, 0
    end)
    -- A head lifted leaves its chin where it was, so it stays joined to the neck.
    if hy < 0 then
      each(back, function(x, y, p)
        if y == HEAD - 1 and pc.rgbaA(p) > 0 then frame:drawPixel(x, y, p) end
      end)
    end
    return frame
  end
  local sipping = posed(1, 0, function(arm) return arm == 'right' and -8 or 0 end)
  -- The mug, in the raised hand.
  for my = 19, 23 do
    for mx = 19, 23 do
      local edge = my == 19 or my == 23 or mx == 19 or mx == 23
      sipping:drawPixel(mx, my, edge and pc.rgba(58, 34, 18, 255) or pc.rgba(244, 234, 214, 255))
    end
  end
  local list = {
    cell,
    shifted(cell, math.floor(WH * 0.68), 0, 1),
    stepping(cell, true),
    stepping(cell, false),
    back,
    typing(back, true),
    typing(back, false),
    posed(1, 0), -- glancing to one side
    stepping(back, true),
    stepping(back, false),
    posed(-1, 0), -- and to the other
    posed(0, 2, function() return -1 end), -- leaning in to the screen
    posed(0, -1), -- looking up, thinking
    posed(0, 1, function() return -10 end), -- stretching, hands behind the head
    sipping,
    posed(-1, 1, function(arm) return arm == 'left' and -9 or 0 end), -- scratching their head
  }
  for _, frame in ipairs(list) do workerFrames[#workerFrames + 1] = tidied(tidied(frame)) end
end
save('worker', workerFrames, 0)

-- Workstations. The screen tilts: its top and bottom edges rise a little to the right. Measured on
-- the sheet, where the active and standby desks differ only in the screen, then divided by eight.
local on, off = load('desk-on'), load('desk-off')
local SCREEN_LEFT, SCREEN_RIGHT = 29, 52
local function screenTop(x) return math.ceil(6 - (x - 28.25) * 0.127) end
local function screenBottom(x) return math.floor(20.2 - (x - 28.25) * 0.127) end

local function c(r, g, bl) return pc.rgba(r, g, bl, 255) end
local function dimmed(p) return c(pc.rgbaR(p) * 0.55 // 1, pc.rgbaG(p) * 0.6 // 1, pc.rgbaB(p) * 0.68 // 1) end

-- A program is a function from a screen position and a frame to a colour. u runs left to right from
-- 0 and v from 0 down each column, in whole pixels, so what it draws leans with the screen.
local PROGRAMS = {}

function PROGRAMS.code(u, v, t)
  local rows = { { 1, 6, c(126, 214, 200) }, { 3, 9, c(236, 228, 208) }, { 3, 5, c(236, 164, 112) }, { 5, 7, c(160, 208, 130) }, { 3, 11, c(236, 228, 208) }, { 1, 4, c(126, 214, 200) }, { 3, 7, c(226, 190, 96) }, { 5, 8, c(236, 228, 208) } }
  if v % 2 == 1 then
    local r = rows[(v // 2 + t) % #rows + 1]
    if u >= r[1] and u < r[1] + r[2] then return r[3] end
  end
  return c(18, 32, 42)
end

function PROGRAMS.dashboard(u, v, t)
  -- Four busy bars down the left, and a stack of cards on the right that fill as they work.
  local bg = c(22, 38, 46)
  if u < 14 then
    if v % 2 == 1 then
      local row = v // 2
      local length = 3 + (row * 3 + t * (row % 2 == 0 and 1 or 2)) % 10
      if u == 1 then return row % 3 == 2 and c(236, 164, 112) or c(143, 208, 127) end
      if u >= 3 and u < 3 + length then return c(86, 176, 164) end
    end
    return bg
  end
  local height = 2 + (u * 5 + t * 3) % 6
  if v >= 12 - height and v < 12 and u % 2 == 0 then return u % 4 == 0 and c(226, 190, 96) or c(126, 214, 200) end
  return bg
end

function PROGRAMS.chart(u, v, t)
  -- A line chart scrolling past over a faint grid, its peak moving along with it.
  local x = u + t * 2
  local level = 7 + math.floor(math.sin(x * 0.7) * 2 + math.sin(x * 0.23) * 2 + 0.5)
  if v == level then return c(246, 214, 120) end
  if v > level then return c(40, 96, 102) end
  if v % 4 == 3 or u % 6 == 5 then return c(26, 58, 68) end
  return c(16, 42, 52)
end

function PROGRAMS.chat(u, v, t)
  -- The team talking: messages from each side, with the newest arriving as the frames go by.
  local shown = t // 2 + 1
  local messages = { { 0, 1, 12, c(120, 196, 186) }, { 1, 4, 10, c(246, 214, 150) }, { 0, 7, 14, c(120, 196, 186) }, { 1, 10, 8, c(246, 214, 150) } }
  for i = 1, math.min(shown, #messages) do
    local m = messages[i]
    if v >= m[2] and v < m[2] + 2 then
      local left = m[1] == 0 and 1 or 23 - m[3]
      if u >= left and u < left + m[3] then return m[4] end
    end
  end
  return c(238, 243, 238)
end

function PROGRAMS.terminal(u, v, t)
  -- Lines of output, a progress bar filling, and a cursor that blinks.
  local bg = c(10, 20, 16)
  local green = c(116, 222, 132)
  if v == 1 or v == 3 or v == 9 or v == 11 then
    if u >= 1 and u < ((v == 1 or v == 11) and 12 or 18) and (u + v) % 4 ~= 0 then return c(70, 150, 92) end
  elseif v == 5 then
    if u >= 1 and u <= 2 + t * 2 then return green end
    if u >= 1 and u <= 22 then return c(30, 62, 44) end
  elseif v == 7 then
    if u >= 1 and u < 3 then return green end
    if u == 4 and t % 2 == 0 then return c(226, 250, 226) end
  end
  return bg
end

function PROGRAMS.landscape(u, v, t)
  -- Hills, and a cloud crossing above them.
  local hill = 10 - math.floor(math.sin((u + 3) * 0.4) * 1.5 + 0.5)
  local far = 7 - math.floor(math.sin((u + 11) * 0.25) * 1.5 + 0.5)
  if v >= hill then return v > hill + 2 and c(42, 96, 96) or c(64, 122, 116) end
  if v >= far then return c(118, 166, 158) end
  local x = (u + 26 - t * 3) % 26
  if (v == 2 and x >= 4 and x < 11) or (v == 1 and x >= 6 and x < 9) then return c(252, 250, 240) end
  if v == 3 and x >= 5 and x < 10 then return c(214, 230, 228) end
  return v < 2 and c(142, 204, 222) or c(176, 220, 228)
end

local function paint(program, frame, dim)
  local image = Image(on)
  for x = SCREEN_LEFT, SCREEN_RIGHT do
    local top = screenTop(x)
    for y = top, screenBottom(x) do
      local p = program(x - SCREEN_LEFT, y - top, frame)
      image:drawPixel(x, y, dim and dimmed(p) or p)
    end
  end
  return image
end

for _, name in ipairs({ 'code', 'dashboard', 'chart', 'chat', 'terminal', 'landscape' }) do
  local frames = {}
  for t = 0, 7 do frames[#frames + 1] = paint(PROGRAMS[name], t) end
  save('desk-active-' .. name, frames, name == 'chat' and 1.2 or name == 'landscape' and 1 or 3)
end
save('desk-idle', { paint(PROGRAMS.landscape, 0, true) }, 0)
save('desk-standby', { off }, 0)

-- The back of the desk's chair on its own, to draw over somebody sitting in it.
local chairBack = Image(off.width, off.height, ColorMode.RGB)
local function isTeal(x, y)
  local p = off:getPixel(x, y)
  if pc.rgbaA(p) == 0 then return false end
  local h, s = hsl(p)
  return h > 130 and h < 215 and s > 0.06
end
each(off, function(x, y, p)
  if x < 38 or x > 59 or y < 32 or y > 53 or pc.rgbaA(p) == 0 then return end
  -- The teal, and the dark outline right next to it.
  local _, _, l = hsl(p)
  if isTeal(x, y) or (l < 0.3 and (isTeal(x - 1, y) or isTeal(x + 1, y) or isTeal(x, y - 1) or isTeal(x, y + 1))) then chairBack:drawPixel(x, y, p) end
end)
save('chair-back', { chairBack }, 0)

-- The room. --------------------------------------------------------------------------------

save('floor', { load('floor') }, 0)

local plant = load('plant')
save('plant', { plant, shifted(plant, plant.height - 12, 1, 0), plant, shifted(plant, plant.height - 12, -1, 0) }, 1)
-- The extra bay of a longer shelf has the same books as the one beside it, so they swap colours.
local function otherBooks(shelf)
  local copy = Image(shelf)
  local FROM, TO = 22, 39
  each(shelf, function(x, y, p)
    if x < FROM or x > TO or pc.rgbaA(p) == 0 then return end
    local h, s = hsl(p)
    local r, g, b = pc.rgbaR(p), pc.rgbaG(p), pc.rgbaB(p)
    if h > 140 and h < 210 and s > 0.08 then copy:drawPixel(x, y, pc.rgba(g, r, b, 255))
    elseif h > 55 and h < 110 and s > 0.08 then copy:drawPixel(x, y, pc.rgba(b, g, r, 255)) end
  end)
  return copy
end
save('shelf', { otherBooks(load('shelf')) }, 0)
save('sofa', { load('sofa') }, 0)

local cooler = load('cooler')
local bubbles = {}
for i = 0, 3 do
  local f = Image(cooler)
  for n = 0, 1 do
    local y = 12 - (i * 2 + n * 5) % 10
    local x = 10 + n * 6
    if pc.rgbaA(f:getPixel(x, y)) > 0 then f:drawPixel(x, y, pc.rgba(232, 248, 252, 255)) end
  end
  bubbles[#bubbles + 1] = f
end
save('cooler', bubbles, 3)

local lamp = load('lamp')
save('lamp', { lamp }, 0)

-- A window for the back wall: three panes in a honey oak frame, looking out over a city and trees,
-- with a version for each part of the day. Weather is painted over them as the office draws.
local PHASES = {
  day = {
    skies = { c(136, 196, 224), c(158, 210, 232), c(182, 224, 238), c(208, 236, 240) },
    cloud = { c(250, 250, 244), c(255, 255, 250), c(214, 232, 238) },
    towers = { c(128, 154, 182), c(146, 170, 194), c(100, 124, 154), c(178, 198, 214) },
    glass = c(222, 236, 238),
    greens = { c(58, 112, 44), c(84, 142, 56), c(118, 172, 72), c(72, 128, 52) },
  },
  dawn = {
    skies = { c(120, 134, 186), c(196, 150, 176), c(240, 180, 150), c(252, 216, 158) },
    cloud = { c(252, 214, 190), c(255, 232, 210), c(214, 160, 164) },
    towers = { c(102, 104, 146), c(120, 118, 158), c(78, 80, 122), c(176, 146, 164) },
    glass = c(250, 222, 150),
    greens = { c(44, 78, 54), c(60, 100, 62), c(84, 124, 70), c(52, 90, 58) },
  },
  dusk = {
    skies = { c(70, 76, 140), c(150, 92, 142), c(226, 122, 104), c(248, 178, 104) },
    cloud = { c(232, 150, 124), c(248, 186, 146), c(150, 96, 130) },
    towers = { c(66, 66, 108), c(82, 78, 120), c(48, 48, 88), c(120, 92, 128) },
    glass = c(250, 206, 110),
    greens = { c(34, 56, 48), c(44, 72, 54), c(60, 92, 60), c(38, 62, 50) },
  },
  night = {
    skies = { c(16, 22, 56), c(22, 30, 70), c(30, 40, 84), c(40, 52, 98) },
    cloud = { c(56, 66, 106), c(72, 82, 122), c(40, 50, 88) },
    towers = { c(34, 38, 68), c(44, 48, 80), c(24, 28, 54), c(58, 62, 96) },
    glass = c(250, 212, 120),
    greens = { c(16, 34, 34), c(22, 44, 38), c(30, 56, 44), c(18, 38, 36) },
  },
}

local function windowFrame(step, name)
  local look = PHASES[name]
  local W, H = 104, 50
  local w = Image(W, H, ColorMode.RGB)
  local function fill(x, y, cw, ch, p)
    for j = y, y + ch - 1 do for i = x, x + cw - 1 do
      if i >= 0 and j >= 0 and i < W and j < H then w:drawPixel(i, j, p) end
    end end
  end
  for y = 3, 45 do
    for x = 3, W - 4 do
      local band = math.min(4, (y - 3) // 11 + 1)
      local near = (y - 3) % 11 > 7 and (x + y) % 2 == 0
      w:drawPixel(x, y, look.skies[near and math.min(4, band + 1) or band])
    end
  end
  if name == 'night' then
    -- Stars, and a moon that keeps still while the stars twinkle.
    for n = 0, 15 do
      local sx, sy = 5 + (n * 37) % 92, 5 + (n * 23) % 20
      if (n + step) % 5 ~= 0 then w:drawPixel(sx, sy, n % 3 == 0 and c(255, 250, 220) or c(190, 198, 230)) end
    end
    fill(80, 7, 7, 7, c(244, 238, 208)); fill(79, 8, 9, 5, c(244, 238, 208)); fill(83, 8, 3, 3, c(212, 206, 186))
  else
    for _, cloud in ipairs({ { 6, 9, 16 }, { 44, 6, 13 }, { 28, 15, 11 } }) do
      local x = 3 + (cloud[1] + step * 3) % 82
      fill(x, cloud[2], cloud[3], 2, look.cloud[1])
      fill(x + 3, cloud[2] - 2, cloud[3] - 6, 2, look.cloud[2])
      fill(x + 1, cloud[2] + 2, cloud[3] - 2, 1, look.cloud[3])
    end
  end
  local towers = { { 6, 28, 9 }, { 17, 22, 8 }, { 27, 31, 10 }, { 39, 24, 8 }, { 50, 30, 9 }, { 61, 20, 10 }, { 74, 29, 8 }, { 85, 24, 10 } }
  for n, tower in ipairs(towers) do
    fill(tower[1], tower[2], tower[3], 46 - tower[2], look.towers[n % 2 + 1])
    fill(tower[1] + tower[3] - 1, tower[2], 1, 46 - tower[2], look.towers[3])
    fill(tower[1], tower[2], tower[3], 1, look.towers[4])
    for j = tower[2] + 2, 42, 3 do
      for i = tower[1] + 1, tower[1] + tower[3] - 2, 2 do
        -- By day every window catches the light. After dark only some are lit, and they change.
        if name == 'day' or (i * 3 + j * 5 + n + step // 2) % 3 == 0 then w:drawPixel(i, j, look.glass) end
      end
    end
  end
  for x = 3, W - 4 do
    local top = 39 + (x * 5 // 7 + x // 3) % 4
    for y = top, 45 do w:drawPixel(x, y, look.greens[(x * 7 + y * 3 + x // 4) % 4 + 1]) end
  end
  local hi, mid, lo = c(238, 181, 101), c(201, 138, 69), c(140, 84, 32)
  fill(0, 0, W, 3, mid); fill(0, 0, W, 1, hi); fill(0, 2, W, 1, lo)
  fill(0, 0, 3, 46, mid); fill(0, 0, 1, 46, hi); fill(2, 3, 1, 43, lo)
  fill(W - 3, 0, 3, 46, mid); fill(W - 3, 0, 1, 46, hi); fill(W - 1, 0, 1, 46, lo)
  for _, x in ipairs({ 34, 67 }) do fill(x, 3, 3, 43, mid); fill(x, 3, 1, 43, hi); fill(x + 2, 3, 1, 43, lo) end
  fill(0, 46, W, 4, mid); fill(0, 46, W, 1, hi); fill(0, 49, W, 1, lo)
  return w
end
for _, name in ipairs({ 'day', 'dawn', 'dusk', 'night' }) do
  save('window-' .. name, { windowFrame(0, name), windowFrame(1, name), windowFrame(2, name), windowFrame(3, name) }, 0.25)
end

-- A modern wall clock: a slim dark display, its digits drawn by the office from the host's time.
local function wallClockSprite()
  local image = Image(48, 20, ColorMode.RGB)
  local function fill(x, y, w, h, p)
    for j = y, y + h - 1 do for i = x, x + w - 1 do image:drawPixel(i, j, p) end end
  end
  fill(1, 0, 46, 20, c(26, 30, 36)); fill(0, 1, 48, 18, c(26, 30, 36))
  fill(1, 1, 46, 1, c(92, 100, 112)); fill(1, 1, 1, 17, c(62, 68, 78))
  fill(46, 2, 1, 16, c(14, 16, 20)); fill(2, 18, 45, 1, c(14, 16, 20))
  fill(3, 3, 42, 14, c(10, 18, 22))
  -- A soft line of light across the glass.
  fill(4, 3, 40, 1, c(24, 38, 44))
  return image
end
save('wall-clock', { wallClockSprite() }, 0)

-- The break area's other furniture, drawn to match: dark outline, a lit edge and a shaded one, and
-- clusters of tone rather than flat fills. -----------------------------------------------------

local function canvas(w, h)
  local image = Image(w, h, ColorMode.RGB)
  local paint = {}
  function paint.rect(x, y, cw, ch, p)
    for j = y, y + ch - 1 do for i = x, x + cw - 1 do
      if i >= 0 and j >= 0 and i < w and j < h then image:drawPixel(i, j, p) end
    end end
  end
  function paint.outline(p)
    local marks = {}
    each(image, function(x, y, q)
      if pc.rgbaA(q) == 0 then
        for _, n in ipairs({ { 1, 0 }, { -1, 0 }, { 0, 1 }, { 0, -1 } }) do
          local i, j = x + n[1], y + n[2]
          if i >= 0 and j >= 0 and i < w and j < h and pc.rgbaA(image:getPixel(i, j)) > 0 then marks[#marks + 1] = { x, y }; break end
        end
      end
    end)
    for _, m in ipairs(marks) do image:drawPixel(m[1], m[2], p) end
  end
  return image, paint
end

local INK = c(58, 34, 18)
local OAK_HI, OAK_TOP, OAK_MID, OAK_LOW = c(238, 181, 101), c(213, 148, 72), c(178, 112, 48), c(128, 78, 34)
local CREAM_HI, CREAM_TOP, CREAM_MID, CREAM_LOW = c(250, 243, 228), c(234, 222, 200), c(208, 192, 166), c(168, 150, 126)
local STEEL_HI, STEEL, STEEL_LOW = c(112, 110, 114), c(78, 76, 82), c(48, 46, 52)

--- Pictures for the wall, in oak frames.
local function pictureSprite(kind)
  local image, p = canvas(30, 24)
  p.rect(1, 1, 28, 22, OAK_MID); p.rect(1, 1, 28, 1, OAK_HI); p.rect(1, 1, 1, 22, OAK_HI); p.rect(28, 2, 1, 21, OAK_LOW); p.rect(2, 22, 27, 1, OAK_LOW)
  p.rect(4, 4, 22, 16, CREAM_HI)
  if kind == 'hills' then
    p.rect(5, 5, 20, 8, c(160, 208, 226))
    for x = 5, 24 do
      local top = 11 + math.floor(math.sin(x * 0.5) * 2 + 0.5)
      p.rect(x, top, 1, 19 - top, x % 5 == 0 and c(84, 142, 56) or c(70, 120, 72))
    end
    p.rect(19, 6, 3, 3, c(246, 214, 136))
  elseif kind == 'chart' then
    for n, h in ipairs({ 4, 7, 5, 10, 8, 12 }) do p.rect(4 + n * 3, 19 - h, 2, h, n % 2 == 0 and c(79, 143, 134) or c(192, 100, 60)) end
    p.rect(5, 19, 20, 1, INK)
  else
    p.rect(5, 5, 20, 14, c(46, 62, 84))
    for n = 0, 9 do image:drawPixel(6 + (n * 7) % 18, 6 + (n * 5) % 12, c(246, 240, 214)) end
    p.rect(17, 7, 4, 4, c(246, 214, 136)); p.rect(18, 7, 4, 3, c(46, 62, 84))
  end
  p.outline(INK)
  return image
end

--- A bare bulb in a brass fitting, off and then lit.
local function bulbSprite(lit)
  local image, p = canvas(20, 32)
  p.rect(7, 1, 6, 8, c(150, 112, 48)); p.rect(7, 1, 2, 8, c(226, 176, 78)); p.rect(12, 1, 1, 8, c(98, 70, 30))
  for _, y in ipairs({ 3, 6 }) do p.rect(7, y, 6, 1, c(98, 70, 30)) end
  local glass = lit and { c(255, 246, 196), c(255, 228, 130), c(246, 190, 84), c(255, 255, 236) }
    or { c(150, 150, 140), c(116, 116, 110), c(84, 84, 82), c(198, 198, 186) }
  local rows = { { 7, 6 }, { 6, 8 }, { 5, 10 }, { 4, 12 }, { 3, 14 }, { 3, 14 }, { 3, 14 }, { 3, 14 }, { 3, 14 }, { 3, 14 }, { 3, 14 }, { 4, 12 }, { 4, 12 }, { 5, 10 }, { 6, 8 }, { 7, 6 } }
  for n, row in ipairs(rows) do
    local y = 8 + n
    p.rect(row[1], y, row[2], 1, glass[1])
    p.rect(row[1] + row[2] - 3, y, 3, 1, glass[2])
    p.rect(row[1] + row[2] - 1, y, 1, 1, glass[3])
  end
  p.rect(6, 12, 2, 5, glass[4]); p.rect(8, 11, 2, 1, glass[4])
  -- The filament.
  local wire = lit and c(255, 255, 255) or c(70, 66, 60)
  p.rect(8, 16, 1, 3, wire); p.rect(11, 16, 1, 3, wire); p.rect(9, 19, 2, 1, wire)
  p.outline(INK)
  return image
end
save('bulb', { bulbSprite(false), bulbSprite(true) }, 0)

save('cabinet', { load('cabinet') }, 0)
save('boxes', { load('boxes') }, 0)
save('bin', { load('bin') }, 0)
save('picture-hills', { pictureSprite('hills') }, 0)
save('picture-chart', { pictureSprite('chart') }, 0)
save('picture-night', { pictureSprite('night') }, 0)
save('fax', { load('fax') }, 0)
save('armchair', { load('armchair') }, 0)
save('rug', { load('rug') }, 0)
save('fridge', { load('fridge') }, 0)
-- While it runs, a light moves across inside its dark window.
local microwave = load('microwave')
local waves = {}
for i = 0, 3 do
  local f = Image(microwave)
  each(microwave, function(x, y, p)
    if pc.rgbaA(p) == 0 or x < 2 or x > microwave.width * 0.68 or y < microwave.height * 0.3 then return end
    local _, _, l = hsl(p)
    if l < 0.3 and (x + i * 3) % 12 < 4 then
      f:drawPixel(x, y, pc.rgba(math.min(255, pc.rgbaR(p) + 90), math.min(255, pc.rgbaG(p) + 70), math.min(255, pc.rgbaB(p) + 30), 255))
    end
  end)
  waves[#waves + 1] = f
end
save('microwave', waves, 2)
-- Shorter in the leg, so what stands on it stays clear of the window or noticeboard behind.
local function shortLegs(table, from, rows)
  local short = Image(table.width, table.height - rows, ColorMode.RGB)
  each(table, function(x, y, p)
    if pc.rgbaA(p) == 0 or (y >= from and y < from + rows) then return end
    short:drawPixel(x, y < from and y or y - rows, p)
  end)
  return short
end
save('side-table', { shortLegs(load('side-table'), 28, 16) }, 0)
save('noticeboard', { load('noticeboard') }, 0)
save('door', { load('door') }, 0)

local coffee = load('coffee')
local steam = {}
for i = 0, 3 do
  local f = Image(coffee)
  for n = 0, 1 do
    -- Rising from the mug on the cabinet.
    local y = 18 - (i * 2 + n * 4) % 8
    local x = 57 + n * 2 + (i + n) % 2
    if y >= 0 then f:drawPixel(x, y, c(236, 232, 224)) end
  end
  steam[#steam + 1] = f
end
save('coffee', steam, 3)

local f = io.open(app.fs.joinPath(out, 'sprites.json'), 'w')
f:write('{\n', table.concat(manifest, ',\n'), '\n}\n')
f:close()
