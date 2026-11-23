const { isMainThread, parentPort, Worker, workerData } = require("node:worker_threads");

if (!isMainThread) {
  const { autoTune } = require("./converter");
  const { image, params, area } = workerData;
  autoTune(Buffer.from(image), params, area).then(
    (result) => parentPort.postMessage({ result }),
    (error) => parentPort.postMessage({ error: error.message }),
  );
}

let active = false;

async function tuneInWorker(image, params, area, res) {
  if (active) throw Object.assign(new Error("Máy chủ đang tìm cấu hình cho ảnh khác. Thử lại sau vài giây."), { status: 429 });
  active = true;
  let worker, timeout, onClose;
  try {
    return await new Promise((resolve, reject) => {
      worker = new Worker(__filename, { workerData: { image, params, area } });
      timeout = setTimeout(() => {
        reject(Object.assign(new Error("Tìm cấu hình quá thời gian. Thử lại với ảnh đơn giản hơn."), { status: 503 }));
      }, 9500);
      onClose = () => resolve(null);
      res.once("close", onClose);
      worker.once("message", ({ result, error }) => {
        if (error) reject(new Error(error));
        else resolve(result);
      });
      worker.once("error", reject);
      worker.once("exit", () => reject(new Error("Tiến trình tìm cấu hình dừng trước khi trả kết quả.")));
    });
  } finally {
    clearTimeout(timeout);
    if (onClose) res.off("close", onClose);
    try { await worker?.terminate(); }
    finally { active = false; }
  }
}

module.exports = { tuneInWorker };
