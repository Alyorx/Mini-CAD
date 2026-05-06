/**
 * Worker Bridge — Promise-based communication with the OCCT Web Worker.
 * Supports import/export via structured message passing.
 */

let worker = null;
let messageId = 0;
const pending = new Map();

function getWorker() {
  if (!worker) {
    worker = new Worker(
      new URL("./occt-worker.js", import.meta.url),
      { type: "module" }
    );

    worker.onmessage = (e) => {
      const { id, type, error } = e.data;

      if (id !== undefined && pending.has(id)) {
        const { resolve, reject } = pending.get(id);
        pending.delete(id);

        if (type === "error") {
          reject(new Error(error));
        } else {
          resolve(e.data);
        }
      }
    };

    worker.onerror = (err) => {
      console.error("[WorkerBridge] Worker error:", err);
    };
  }
  return worker;
}

function sendMessage(type, payload) {
  const id = messageId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ type, payload, id });
  });
}

/**
 * Import a CAD file and return tessellated mesh data.
 * @param {File} file - The file from an <input type="file">
 * @returns {Promise<{shapeId: string, fileName: string, vertices: Float32Array, normals: Float32Array, indices: Uint32Array}>}
 */
export async function importFile(file) {
  const buffer = await file.arrayBuffer();
  const result = await sendMessage("import", {
    fileName: file.name,
    fileData: buffer,
  });
  return result;
}

/**
 * Export a shape by ID to the given format.
 * @param {string} shapeId - ID returned from importFile
 * @param {"step"|"iges"|"stl"} format - Output format
 * @returns {Promise<{format: string, fileContent: Uint8Array}>}
 */
export async function exportShape(shapeId, format, matrix = null, meshData = null) {
  const result = await sendMessage("export", {
    shapeId,
    format,
    matrix,
    meshData,
  });
  return result;
}

/**
 * Export mesh data directly to binary STL (no OCCT shape needed).
 * @param {{vertices: Float32Array, indices: Uint32Array, normals?: Float32Array}} meshData
 * @returns {Promise<{format: string, fileContent: Uint8Array}>}
 */
export async function exportMeshAsSTL(meshData) {
  const result = await sendMessage("export", {
    format: "stl",
    meshData,
  });
  return result;
}

/**
 * Legacy: backward compat with old processFile() call
 */
export function createWorkerBridge() {
  return {
    processFile: (data) => {
      return new Promise((resolve) => {
        const w = getWorker();
        const handler = (e) => {
          w.removeEventListener("message", handler);
          resolve(e.data);
        };
        w.addEventListener("message", handler);
        w.postMessage(data);
      });
    },
    importFile,
    exportShape,
    exportMeshAsSTL,
    booleanOperation,
    extrudeShape,
    revolveShape,
    createPrimitive,
  };
}

// ---------------------------------------------------------------------------
// Phase 4: Geometry Operation Bridges
// ---------------------------------------------------------------------------

/**
 * Perform a boolean operation on two shapes.
 * @param {"union"|"difference"|"intersection"} operation
 * @param {string} shapeIdA - First shape ID
 * @param {string} shapeIdB - Second shape ID
 * @returns {Promise<{shapeId: string, vertices: Float32Array, normals: Float32Array, indices: Uint32Array}>}
 */
export async function booleanOperation(operation, shapeIdA, shapeIdB, matrixA = null, matrixB = null) {
  const result = await sendMessage("boolean", {
    operation,
    shapeIdA,
    shapeIdB,
    matrixA,
    matrixB,
  });
  return result;
}

/**
 * Extrude a shape along a direction by a given height.
 * @param {string} shapeId - Source shape ID
 * @param {{x: number, y: number, z: number}} direction - Direction vector
 * @param {number} height - Extrusion distance
 * @returns {Promise<{shapeId: string, vertices: Float32Array, normals: Float32Array, indices: Uint32Array}>}
 */
export async function extrudeShape(shapeId, direction, height, matrix = null) {
  const result = await sendMessage("extrude", {
    shapeId,
    direction,
    height,
    matrix,
  });
  return result;
}

/**
 * Revolve a shape around an axis by a given angle.
 * @param {string} shapeId - Source shape ID
 * @param {{x: number, y: number, z: number}} axisOrigin - Axis origin point
 * @param {{x: number, y: number, z: number}} axisDirection - Axis direction
 * @param {number} angle - Angle in degrees (default: 360)
 * @returns {Promise<{shapeId: string, vertices: Float32Array, normals: Float32Array, indices: Uint32Array}>}
 */
export async function revolveShape(shapeId, axisOrigin, axisDirection, angle, matrix = null) {
  const result = await sendMessage("revolve", {
    shapeId,
    axisOrigin,
    axisDirection,
    angle,
    matrix,
  });
  return result;
}

/**
 * Create a primitive shape (box, cylinder, sphere, cone).
 * @param {"box"|"cylinder"|"sphere"|"cone"} primitive - Primitive type
 * @param {Object} params - Parameters for the primitive
 * @returns {Promise<{shapeId: string, vertices: Float32Array, normals: Float32Array, indices: Uint32Array}>}
 */
export async function createPrimitive(primitive, params) {
  const result = await sendMessage("createPrimitive", {
    primitive,
    params,
  });
  return result;
}