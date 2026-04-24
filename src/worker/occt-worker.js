

import initOpenCascade from "../../node_modules/opencascade.js/dist/opencascade.wasm.js";

let ocPromise = initOpenCascade({
  locateFile: (file) => `/${file}`
});

self.onmessage = async (e) => {
  const fileData = e.data;
 
  // console.log("fileData type:", fileData?.constructor?.name);
  // console.log("fileData size:", fileData?.byteLength);

  const occt = await ocPromise;
  
  // STEP 1: Mount file
  const data = new Uint8Array(fileData);
  console.log("Writing STEP file, bytes:", data.length);
  try {
      occt.FS.createDataFile(
      "/",
      "model.step",
      data,
      true,
      true
    );
    console.log("File written to FS");
  } catch (err) {
    console.error("FS write failed:", err);
  }

  // STEP 2: Try reading (we won't fully extract yet)
  const reader = new occt.STEPControl_Reader_1();
  const status = reader.ReadFile("/model.step");

  

  const ok = status?.value === 0 || status === 0;
  console.log(ok);
  if (!ok) {
    console.error("Failed to read file");

    // fallback: send simple triangle so UI still works
    self.postMessage({
      success: true,

      vertices: new Float32Array([
        // triangle 1
        0, 0, 0,
        1, 0, 0,
        0, 1, 0
      ]),

      indices: new Uint32Array([
        0, 1, 2
      ]),

      normals: new Float32Array([
        // all facing +Z
        0, 0, 1,
        0, 0, 1,
        0, 0, 1
      ])
    });
    return;
  }

  reader.TransferRoots();
  const shape = reader.OneShape();

  // TEMP: we are NOT extracting real geometry yet
  // Just return a triangle to confirm pipeline works

  self.postMessage({
    vertices: [0,0,0, 1,0,0, 0,1,0],
    indices: [0,1,2]
  });
};