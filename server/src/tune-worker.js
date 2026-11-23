const { isMainThread, parentPort, Worker, workerData } = require("node:worker_threads");
const { autoTune, TUNE_TIMEOUT_MS } = require("./converter");

if (!isMainThread) {
  const { image, params, area, profile } = workerData;
  autoTune(Buffer.from(image), params, area, profile, (partial) => parentPort.postMessage({ partial })).then(
    (result) => parentPort.postMessage({ result }),
    (error) => parentPort.postMessage({ error: error.message }),
  );
}

let active = false;

async function tuneInWorker(image, params, area, res, profile) {
  if (!Object.hasOwn(TUNE_TIMEOUT_MS, profile)) {
    throw Object.assign(new Error("Chế độ tìm cấu hình không hợp lệ."), { status: 400 });
  }
  if (active) throw Object.assign(new Error("Máy chủ đang tìm cấu hình cho ảnh khác. Thử lại sau vài giây."), { status: 429 });
  active = true;
  const start = performance.now();
  let worker, timeout, onClose, best;
  try {
    return await new Promise((resolve, reject) => {
      worker = new Worker(__filename, { workerData: { image, params, area, profile } });
      timeout = setTimeout(() => {
        if (best) resolve({ ...best, ms: Math.round(performance.now() - start), timeLimited: true });
        else reject(Object.assign(new Error("Hết thời gian trước khi kiểm tra được cấu hình. Thử lại với ảnh đơn giản hơn."), { status: 503 }));
      }, TUNE_TIMEOUT_MS[profile]);
      onClose = () => resolve(null);
      res.once("close", onClose);
      worker.on("message", ({ result, error, partial }) => {
        if (partial) best = partial;
        else if (error) reject(new Error(error));
        else resolve(result);
      });
      worker.once("error", reject);
      worker.once("exit", () => reject(new Error("Tiến trình tìm cấu hình dừng trước khi trả kết quả.")));
    });
  } finally {
    clearTimeout(timeout);
    if (onClose) res.off("close", onClose);
    if (worker) void worker.terminate().finally(() => { active = false; }).catch(console.error);
    else active = false;
  }
}

module.exports = { tuneInWorker };
