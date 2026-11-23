const assert = require("node:assert/strict");
const test = require("node:test");
const { readFile } = require("node:fs/promises");
const { join } = require("node:path");
const sharp = require("sharp");
const { autoTune, convert } = require("../src/converter");

const area = { width: 120, height: 80 };

test("auto-tune ranks two reproducible setups while preserving machine settings", async () => {
  const image = await readFile(join(__dirname, "../../docs/samples/lineart.png"));
  const machine = { widthMm: 105, heightMm: 70, penWidthMm: 0.5, drawFeed: 1250, travelFeed: 2500, penUp: "M5", penDown: "M3 S85" };
  const result = await autoTune(image, machine, area);
  assert.deepEqual(result.candidates.map((candidate) => candidate.id), ["detail", "fast"]);
  const [detailed, fast] = result.candidates.map((candidate) => candidate.metrics);
  assert.ok(result.tried > 36);
  assert.ok(detailed.score >= fast.score && detailed.score - fast.score <= 6);
  assert.ok(detailed.coverage - fast.coverage <= 8 && detailed.precision - fast.precision <= 8);
  assert.ok(fast.seconds <= detailed.seconds);

  for (const candidate of result.candidates) {
    const { params, stats, gcode } = await convert(image, candidate.params, area);
    for (const [key, value] of Object.entries(machine)) assert.equal(params[key], value, key);
    for (const [key, value] of Object.entries(candidate.metrics)) assert.equal(stats[key], value, key);
    assert.match(gcode, /\nG21\nG90\nM5\nG0 F2500\n/);
    assert.ok(gcode.endsWith("G0 X0 Y0\nM2\n"));
    let penDown = false;
    for (const line of gcode.trim().split("\n")) {
      if (line === "M3 S85") penDown = true;
      else if (line === "M5") penDown = false;
      else if (line.startsWith("G0 X") || line.startsWith("G1 X")) {
        const match = /^G([01]) X([\d.]+) Y([\d.]+)(?: F(\d+))?$/.exec(line);
        assert.ok(match, line);
        const [, mode, x, y, feed] = match;
        assert.equal(penDown, mode === "1");
        assert.ok(+x >= 0 && +x <= area.width && +y >= 0 && +y <= area.height);
        if (penDown) assert.equal(+feed, machine.drawFeed);
      } else {
        assert.match(line, /^(?:;.*|G21|G90|G0 F2500|M2)$/);
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

test("automatic settings reject movement commands used as pen commands", async () => {
  await assert.rejects(autoTune(Buffer.alloc(0), { penDown: "G0 X100" }, area), /M3/);
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
