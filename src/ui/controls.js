import { readFile } from "../utils/fileLoader.js";

export function setupUI(worker) {
  const input = document.getElementById("fileInput");

  input.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    const data = await readFile(file);
    console.log(data);

    worker.postMessage(data);
  });
}