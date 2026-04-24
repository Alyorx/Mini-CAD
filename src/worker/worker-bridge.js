export function createWorkerBridge() {
  const worker = new Worker(
    new URL("./occt-worker.js", import.meta.url),
    { type: "module" }
  );
  function processFile(data) {
    return new Promise((resolve) => {
      worker.onmessage = (e) => resolve(e.data);
      worker.postMessage(data);
    });
  }
  return {
    processFile,
  };
}