const { test } = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");
const { convert } = require("../src/converter");
const { validateGcode } = require("../src/machine-profile");

const editor = import("../../web/path-edits.mjs");
const point = (x, y) => ({ x, y });
const area = { width: 120, height: 80 };

test("crop clips crossing segments and retains the bed coordinates", async () => {
  const { applyEdits } = await editor;
  const source = [[point(0, 10), point(100, 10)], [point(0, 20), point(100, 20)]];
  const crop = { type: "crop", min: point(20, 5), max: point(70, 18) };
  assert.deepEqual(applyEdits(source, [crop]), [[point(20, 10), point(70, 10)]]);
  assert.equal(source[0][0].x, 0);
});

test("a fast eraser sweep cuts all the way between sampled pointer positions", async () => {
  const { applyEdits } = await editor;
  const source = [[point(0, 10), point(100, 10)], [point(0, 20), point(100, 20)]];
  const erase = { type: "erase", radius: 2, points: [point(50, 0), point(50, 15)] };
  assert.deepEqual(applyEdits(source, [erase]), [
    [point(0, 10), point(48, 10)],
    [point(52, 10), point(100, 10)],
    source[1],
  ]);
  assert.deepEqual(applyEdits(source, [{ type: "stroke", point: point(50, 20) }]), [source[0]]);
});

test("the converter lifts the pen over an erased gap and validates the edit coordinates", async () => {
  const image = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160">
    <rect width="240" height="160" fill="white"/>
    <path d="M30 80 H210" stroke="black" stroke-width="6"/>
  </svg>`)).png().toBuffer();
  const { stats } = await convert(image, {}, area);
  assert.equal(stats.paths, 1);
  const edit = { type: "erase", radius: 2, points: [point(60, 30), point(60, 50)] };
  const edited = await convert(image, {}, area, { edits: [edit], includePaths: true });
  assert.equal(edited.stats.paths, 2);
  assert.equal(edited.sourcePaths.length, 1);
  const gap = new RegExp(`G0 Z5\\nG0 X(?:58|62) Y[^\\n]+\\nG1 Z0 F300`);
  assert.match(edited.gcode, gap);
  assert.equal(validateGcode(edited.gcode, area), null);
  await assert.rejects(convert(image, {}, area, { edits: [{ ...edit, points: [point(-2, 0)] }] }), /ngoài bàn vẽ/);
});
