const assert = require("node:assert/strict");
const test = require("node:test");
const { readFile } = require("node:fs/promises");
const { join } = require("node:path");
const sharp = require("sharp");
const { autoTune, convert, assessGcode } = require("../src/converter");
const { profile, validateGcode } = require("../src/machine-profile");

const area = { width: 120, height: 80 };

test("auto-tune ranks two reproducible setups while preserving machine settings", async () => {
  const image = await readFile(join(__dirname, "../../docs/samples/lineart.png"));
  const machine = { widthMm: 105, heightMm: 70, penWidthMm: 0.5 };
  const result = await autoTune(image, { ...machine, penUp: "M5", penDown: "M3 S90", drawFeed: 9500, travelFeed: 2400 }, area);
  assert.deepEqual(result.candidates.map((candidate) => candidate.id), ["detail", "fast"]);
  const [detailed, fast] = result.candidates.map((candidate) => candidate.metrics);
  assert.ok(result.tried > 36 && result.verified > 1);
  assert.ok(detailed.iou >= fast.iou && detailed.iou - fast.iou <= 4.001);
  assert.ok(detailed.inkRecall - fast.inkRecall <= 5.001 && detailed.inkPrecision - fast.inkPrecision <= 5.001);
  assert.ok(fast.seconds <= detailed.seconds);

  for (const candidate of result.candidates) {
    const { params, stats, gcode } = await convert(image, candidate.params, area);
    for (const [key, value] of Object.entries(machine)) assert.equal(params[key], value, key);
    for (const [key, value] of Object.entries(candidate.metrics)) assert.equal(stats[key], value, key);
    assert.equal(params.penUp, profile.penUp);
    assert.equal(params.penDown, profile.penDown);
    assert.equal(params.drawFeed, profile.drawFeed);
    assert.equal(params.travelFeed, profile.rapidFeed);
    assert.match(gcode, /\nG21\nG90\nG0 Z5\n/);
    assert.equal(validateGcode(gcode, area), null);
    assert.ok(gcode.endsWith("G0 X0 Y0\nM2\n"));
    let penDown = false;
    for (const line of gcode.trim().split("\n")) {
      if (line === profile.penDown) penDown = true;
      else if (line === profile.penUp) penDown = false;
      else if (line.startsWith("G0 X") || line.startsWith("G1 X")) {
        const match = /^G([01]) X([\d.]+) Y([\d.]+)(?: F(\d+))?$/.exec(line);
        assert.ok(match, line);
        const [, mode, x, y, feed] = match;
        assert.equal(penDown, mode === "1");
        assert.ok(+x >= 0 && +x <= area.width && +y >= 0 && +y <= area.height);
        if (penDown) assert.equal(+feed, profile.drawFeed);
      } else {
        assert.match(line, /^(?:;.*|G21|G90|M2)$/);
      }
    }
  }
});

test("blank images return no recommendation", async () => {
  const image = await sharp({ create: { width: 50, height: 50, channels: 3, background: "#fff" } }).png().toBuffer();
  const result = await autoTune(image, {}, area);
  assert.deepEqual(result.candidates, []);
  assert.equal(result.tried, 0);
});

test("the machine profile clamps oversized requests and rejects stale or oversized G-code", async () => {
  const image = await readFile(join(__dirname, "../../docs/samples/lineart.png"));
  const { params, gcode } = await convert(image, { widthMm: 999, heightMm: 999 }, { width: 200, height: 200 });
  assert.equal(params.widthMm, 120);
  assert.equal(params.heightMm, 80);
  assert.equal(validateGcode(gcode, area), null);
  assert.match(validateGcode(gcode.replaceAll(profile.penUp, "M5"), area), /cấu hình máy/);
  assert.match(validateGcode(gcode.replace("F900", "F1500"), area), /chuyển động/);
  assert.match(validateGcode(gcode.replace(/G0 X[\d.]+ Y[\d.]+/, "G0 X121 Y0"), area), /vượt vùng/);
  assert.match(validateGcode(gcode, { width: 1, height: 1 }), /vượt vùng/);
});

test("a crossing keeps the same four arms in two pen-down trails", async () => {
  const image = await sharp(Buffer.from(`<svg width="100" height="100">
    <rect width="100" height="100" fill="white"/>
    <path d="M10 50h80 M50 10v80" stroke="black" stroke-width="3"/>
  </svg>`)).png().toBuffer();
  const { stats, gcode } = await convert(image, { mode: "centerline", smoothing: 0 }, area);
  assert.equal(stats.paths, 2);
  const inkMoves = [...gcode.matchAll(/^G1 X([\d.]+) Y([\d.]+)/gm)].map(([, x, y]) => [+x, +y]);
  assert.ok(inkMoves.length >= 4);
  const distances = inkMoves.map(([x, y]) => Math.min(Math.abs(x - 60), Math.abs(y - 40)));
  assert.ok(distances.every((d) => d <= 1), "a pen-down move left the crossing axes");
  // The mask contains 2 × 80px of stroke, or about 128mm at the selected scale.
  assert.ok(stats.drawLengthMm >= 120 && stats.drawLengthMm <= 130);
});

test("strict score detects spilled ink that is close to the original", async () => {
  const image = await sharp(Buffer.from(`<svg width="100" height="100">
    <rect width="100" height="100" fill="white"/>
    <path d="M10 50h80" stroke="black" stroke-width="0.7"/>
  </svg>`)).png().toBuffer();
  const gcode = (y) => `${profile.penUp}\nG0 X30 Y${y}\n${profile.penDown}\nG1 X90 Y${y} F${profile.drawFeed}\n${profile.penUp}\n`;
  const exact = await assessGcode(image, gcode(40), { penWidthMm: 0.5 }, area);
  const shifted = await assessGcode(image, gcode(40.25), { penWidthMm: 0.5 }, area);
  assert.ok(exact.iou > shifted.iou + 10);
  assert.ok(exact.inkPrecision > shifted.inkPrecision);
  assert.ok(exact.score > shifted.score);
});

test("the fast profile only returns its own verified result", async () => {
  const image = await readFile(join(__dirname, "../../docs/samples/lineart.png"));
  const result = await autoTune(image, {}, area, "fast");
  assert.deepEqual(result.candidates.map(({ id }) => id), ["fast"]);
  assert.ok(result.verified > 0 && result.tried > result.verified);
});
