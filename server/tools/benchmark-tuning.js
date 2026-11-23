#!/usr/bin/env node
// node tools/benchmark-tuning.js /path/to/old/converter.js image.png [image.jpg ...]
const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");
const { autoTune, convert, assessGcode } = require("../src/converter");

const [, , baselinePath, ...images] = process.argv;
if (!baselinePath || !images.length) {
  console.error("Usage: node benchmark-tuning.js BASELINE_CONVERTER IMAGE [IMAGE ...]");
  process.exit(1);
}
const old = require(path.resolve(baselinePath));
const workArea = { width: 120, height: 80 };
const params = { penWidthMm: 0.5 };

async function main() {
  for (const filename of images) {
    const image = await fs.readFile(filename);
    const baseline = await old.autoTune(image, params, workArea);
    const row = { file: path.basename(filename) };
    for (const c of baseline.candidates) {
      const drawing = await old.convert(image, c.params, workArea);
      row[`old-${c.id}`] = {
        ms: baseline.ms, ...await assessGcode(image, drawing.gcode, drawing.params, workArea),
        minutes: drawing.stats.minutes, lines: drawing.stats.lines,
      };
    }
    for (const profile of ["fast", "detail"]) {
      const result = await autoTune(image, params, workArea, profile);
      const [candidate] = result.candidates;
      assert.ok(candidate, filename);
      const drawing = await convert(image, candidate.params, workArea);
      assert.equal(drawing.stats.iou, candidate.metrics.iou);
      row[profile] = {
        ms: result.ms, tried: result.tried, verified: result.verified, limited: result.timeLimited,
        ...candidate.metrics, lines: drawing.stats.lines,
        strategy: candidate.params.mode === "fill" ? candidate.params.fillStrategy : candidate.params.mode,
      };
    }
    console.log(JSON.stringify(row));
  }
}
main().catch((err) => { console.error(err); process.exitCode = 1; });
