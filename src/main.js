import { initViewer } from "./core/viewer.js";
import { createWorkerBridge } from "./worker/worker-bridge.js";
import { readFile } from "./utils/fileLoader.js";


const viewer = initViewer(document.getElementById("canvas"));
const workerBridge = createWorkerBridge();
console.log("App initialized")

document.getElementById("fileInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  const data = await readFile(file);

  const result = await workerBridge.processFile(data);

  viewer.loadGeometry(result.vertices, result.indices);
});