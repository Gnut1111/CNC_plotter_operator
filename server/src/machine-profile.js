// CNC_Ploter @ 22c58c2: index.html defaults and pico_cnc.ino motion settings.
const profile = Object.freeze({
  workArea: Object.freeze({ width: 120, height: 80 }),
  drawFeed: 900,
  rapidFeed: 150 * 60, // Pico uses MAX_SPEED_MM_S for G0 regardless of F.
  accelMmS2: 400,
  stepsPerMm: Object.freeze({ x: 80, y: 79 }),
  penUp: "G0 Z5",
  penDown: "G1 Z0 F300",
  penTransitionSeconds: ((105 - 50) * 8 + 120) / 1000,
  maxLineBytes: 96,
});

function limitArea(area = profile.workArea) {
  return {
    width: Math.max(1, Math.min(profile.workArea.width, area.width)),
    height: Math.max(1, Math.min(profile.workArea.height, area.height)),
  };
}

function machineArea(machine) {
  return limitArea({ width: machine.work_width, height: machine.work_height });
}

function validateGcode(gcode, area) {
  const lines = gcode.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith(";"));
  const [units, mode, lift, ...body] = lines;
  if (units !== "G21" || mode !== "G90" || lift !== profile.penUp
    || body.pop() !== "M2" || body.at(-1) !== "G0 X0 Y0") {
    return "G-code chưa theo cấu hình máy HTrang. Tạo lại đường vẽ từ ảnh gốc.";
  }
  let down = false, drew = false, positioned = false;
  for (const line of body) {
    if (line === profile.penDown && !down && positioned) {
      down = true;
      continue;
    }
    if (line === profile.penUp && down) {
      down = false;
      positioned = false;
      continue;
    }
    const move = /^G([01]) X(\d+(?:\.\d{1,3})?) Y(\d+(?:\.\d{1,3})?)(?: F(\d+))?$/.exec(line);
    if (!move || line.length > profile.maxLineBytes
      || (down ? move[1] !== "1" || Number(move[4]) !== profile.drawFeed
        : move[1] !== "0" || move[4] !== undefined)) {
      return "Lệnh chuyển động không phù hợp cấu hình máy HTrang. Tạo lại đường vẽ.";
    }
    if (Number(move[2]) > area.width || Number(move[3]) > area.height) {
      return `Bản vẽ vượt vùng máy ${area.width} × ${area.height} mm. Chọn lại máy và tạo lại đường vẽ.`;
    }
    if (down) drew = true;
    else positioned = true;
  }
  return !down && drew ? null : "G-code chưa kết thúc nét an toàn hoặc không có nét vẽ.";
}

module.exports = { profile, limitArea, machineArea, validateGcode };
