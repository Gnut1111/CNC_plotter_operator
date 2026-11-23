const assert = require("node:assert/strict");
const test = require("node:test");
const { traceSkeleton } = require("../src/trace-paths");

function fixture(lines) {
  return {
    width: lines[0].length,
    height: lines.length,
    binary: Uint8Array.from(lines.join(""), (pixel) => Number(pixel === "#")),
  };
}

test("centerline closes a ring and keeps nearby, disconnected strokes separate", () => {
  const paths = traceSkeleton(fixture([
    "..........",
    ".####.###.",
    ".#..#.....",
    ".#..#.....",
    ".####.....",
    "..........",
  ]));
  assert.equal(paths.length, 2);
  const ring = paths.find((path) => path.closed);
  assert.deepEqual(ring.points.at(0), ring.points.at(-1));
  assert.equal(ring.points.length, 13);
});

test("centerline visits each branch at a junction and follows true diagonals", () => {
  const branches = traceSkeleton(fixture([
    ".......",
    ".#####.",
    "...#...",
    "...#...",
    ".......",
  ]));
  assert.equal(branches.length, 3);
  for (const path of branches) {
    assert.ok([path.points.at(0), path.points.at(-1)].some(({ x, y }) => x === 3.5 && y === 1.5));
  }
  const diagonals = traceSkeleton(fixture(["#..", ".#.", "..#"]));
  assert.equal(diagonals.length, 1);
  assert.equal(diagonals[0].points.length, 3);
});

test("conversion closes the O in the bundled line-art sample", async () => {
  const { readFile } = require("node:fs/promises");
  const { join } = require("node:path");
  const { convert } = require("../src/converter");
  const image = await readFile(join(__dirname, "../../docs/samples/lineart.png"));
  const { gcode, params } = await convert(image, {}, { width: 120, height: 80 });
  const xy = (line) => line.match(/X[\d.]+ Y[\d.]+/)?.[0];
  const paths = gcode.split(`\n${params.penUp}\n`).slice(1).map((chunk) =>
    chunk.split("\n").map(xy).filter(Boolean));
  assert.ok(paths.some((points) => points.length > 8 && points[0] === points.at(-1)));
});
