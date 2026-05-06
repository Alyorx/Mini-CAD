/**
 * OpenCASCADE Web Worker
 * Handles STEP/IGES/STL import and export off the main thread.
 * Uses opencascade.js (WASM build of OCCT) for all geometry operations.
 */

import initOpenCascade from "../../node_modules/opencascade.js/dist/opencascade.wasm.js";

let oc = null;
let ocReady = null;

// Initialize OpenCASCADE once
ocReady = initOpenCascade({
  locateFile: (file) => `/${file}`,
}).then((instance) => {
  oc = instance;
  console.log("[OCCT Worker] OpenCASCADE initialized");
  
  // Initialize IGES controller just in case it's required for this build
  if (oc.IGESControl_Controller && typeof oc.IGESControl_Controller.Init === 'function') {
    oc.IGESControl_Controller.Init();
  }
  
  if (oc.STEPControl_Controller && typeof oc.STEPControl_Controller.Init === 'function') {
    oc.STEPControl_Controller.Init();
  }
  
  return instance;
});

// Map of loaded shapes (id -> TopoDS_Shape) for export support
const shapeStore = new Map();
let shapeIdCounter = 0;

self.onmessage = async (e) => {
  try {
    await ocReady;
    const { type, payload, id } = e.data;

    switch (type) {
      case "import":
        await handleImport(payload, id);
        break;
      case "export":
        await handleExport(payload, id);
        break;
      case "boolean":
        await handleBoolean(payload, id);
        break;
      case "extrude":
        await handleExtrude(payload, id);
        break;
      case "revolve":
        await handleRevolve(payload, id);
        break;
      case "createPrimitive":
        await handleCreatePrimitive(payload, id);
        break;
      default:
        // Legacy fallback: raw file data (backward compat with old main.js)
        await handleLegacyImport(e.data);
    }
  } catch (err) {
    console.error("[OCCT Worker] Error:", err);
    self.postMessage({
      id: e.data?.id,
      type: "error",
      error: err.message || String(err),
    });
  }
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getExtension(fileName) {
  const parts = fileName.toLowerCase().split(".");
  return parts.length > 1 ? parts[parts.length - 1] : "";
}

/**
 * Write file to Emscripten FS, cleaning up any existing file first.
 */
function writeToFS(path, data) {
  try { oc.FS.unlink(path); } catch (_) { /* ignore */ }
  oc.FS.writeFile(path, data);
}

/**
 * Read and remove file from Emscripten FS.
 */
function readFromFS(path) {
  const content = oc.FS.readFile(path);
  try { oc.FS.unlink(path); } catch (_) { /* ignore */ }
  return content;
}

// ---------------------------------------------------------------------------
// IMPORT
// ---------------------------------------------------------------------------

async function handleImport(payload, msgId) {
  const { fileName, fileData } = payload;
  const ext = getExtension(fileName);
  const data = new Uint8Array(fileData);
  const fsPath = "model." + (ext || "tmp");

  console.log(`[OCCT Worker] Importing ${fileName} (${data.length} bytes)`);
  
  // Debug print first 50 chars to check encoding/validity
  const headBytes = data.slice(0, 50);
  const headStr = String.fromCharCode(...headBytes);
  console.log(`[OCCT Worker] File Head: ${headStr}`);

  writeToFS(fsPath, data);

  let shape;

  try {
    if (ext === "step" || ext === "stp") {
      shape = readSTEP(fsPath);
    } else if (ext === "iges" || ext === "igs") {
      shape = readIGES(fsPath);
    } else if (ext === "stl") {
      shape = readSTL(fsPath);
    } else {
      throw new Error(`Unsupported format: .${ext}`);
    }
  } finally {
    try { oc.FS.unlink(fsPath); } catch (_) { /* ignore */ }
  }

  if (!shape || shape.IsNull()) {
    throw new Error(`Failed to read geometry from ${fileName}`);
  }

  // Store the shape for potential export later
  const shapeId = `shape_${shapeIdCounter++}`;
  shapeStore.set(shapeId, shape);

  // Tessellate and extract mesh
  const meshData = tessellateShape(shape);

  console.log(
    `[OCCT Worker] Extracted ${meshData.vertices.length / 3} vertices, ` +
    `${meshData.indices.length / 3} triangles`
  );

  self.postMessage({
    id: msgId,
    type: "import-result",
    shapeId,
    fileName,
    vertices: meshData.vertices,
    normals: meshData.normals,
    indices: meshData.indices,
  });
}

// Legacy handler for backward compat
async function handleLegacyImport(fileData) {
  const data = new Uint8Array(fileData);
  const fsPath = "/model.step";

  writeToFS(fsPath, data);

  let shape;
  try {
    shape = readSTEP(fsPath);
  } catch (err) {
    console.error("[OCCT Worker] Legacy import failed:", err);
    // Fallback triangle
    self.postMessage({
      vertices: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      indices: new Uint32Array([0, 1, 2]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    });
    return;
  } finally {
    try { oc.FS.unlink(fsPath); } catch (_) { /* ignore */ }
  }

  if (!shape || shape.IsNull()) {
    self.postMessage({
      vertices: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      indices: new Uint32Array([0, 1, 2]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    });
    return;
  }

  const meshData = tessellateShape(shape);
  self.postMessage({
    vertices: meshData.vertices,
    indices: meshData.indices,
    normals: meshData.normals,
  });
}

// ---------------------------------------------------------------------------
// READERS
// ---------------------------------------------------------------------------

function readSTEP(filePath) {
  const reader = new oc.STEPControl_Reader_1();
  const status = reader.ReadFile(filePath);

  // Check status — might be an enum object or raw number
  const statusVal = (typeof status === "object" && status !== null && "value" in status)
    ? status.value
    : status;

  // IFSelect_RetDone = 1, IFSelect_RetVoid = 0, IFSelect_RetError = 2
  if (statusVal === 2) {
    console.warn(`STEP read completed with errors (status 2). Attempting to extract shape anyway.`);
  } else if (statusVal !== 1 && statusVal !== 0) {
    const msg = `STEP read failed with status ${statusVal}`;
    reader.delete();
    throw new Error(msg);
  }

  const numRoots = reader.TransferRoots();
  console.log(`[STEP] TransferRoots returned: ${numRoots}`);
  const shape = reader.OneShape();
  
  if (shape && !shape.IsNull()) {
    console.log(`[STEP] Successfully extracted shape of type: ${shape.ShapeType()}`);
  } else {
    console.error(`[STEP] Shape is null after TransferRoots! Check if file has valid Brep data.`);
  }
  
  reader.delete();
  return shape;
}

function readIGES(filePath) {
  const reader = new oc.IGESControl_Reader_1();
  const status = reader.ReadFile(filePath);

  const statusVal = (typeof status === "object" && status !== null && "value" in status)
    ? status.value
    : status;

  // IFSelect_RetDone = 1, IFSelect_RetVoid = 0, IFSelect_RetError = 2
  if (statusVal === 2) {
    console.warn(`IGES read completed with errors (status 2). Attempting to extract shape anyway.`);
  } else if (statusVal !== 1 && statusVal !== 0) {
    const msg = `IGES read failed with status ${statusVal}`;
    reader.delete();
    throw new Error(msg);
  }

  const numRoots = reader.TransferRoots();
  console.log(`[IGES] TransferRoots returned: ${numRoots}`);
  const shape = reader.OneShape();
  
  if (shape && !shape.IsNull()) {
    console.log(`[IGES] Successfully extracted shape of type: ${shape.ShapeType()}`);
  } else {
    console.error(`[IGES] Shape is null after TransferRoots!`);
  }
  
  reader.delete();
  return shape;
}

function readSTL(filePath) {
  const shape = new oc.TopoDS_Shape();
  const reader = new oc.StlAPI_Reader();
  const ok = reader.Read(shape, filePath);
  reader.delete();
  if (!ok) {
    shape.delete();
    throw new Error("STL read failed");
  }
  return shape;
}

// ---------------------------------------------------------------------------
// TESSELLATION (Shape -> vertices/normals/indices)
// ---------------------------------------------------------------------------

function tessellateShape(shape) {
  // Run BRepMesh to generate triangulation on all faces
  const linearDeflection = 0.1;
  const angularDeflection = 0.5;

  // BRepMesh_IncrementalMesh_2 signature:
  // (shape, theLinDeflection, isRelative, theAngDeflection, isInParallel)
  const meshAlgo = new oc.BRepMesh_IncrementalMesh_2(
    shape,
    linearDeflection,
    false,  // isRelative
    angularDeflection,
    false   // isInParallel
  );
  // Perform() may or may not need args in this build
  try {
    meshAlgo.Perform();
  } catch (_) {
    // Some builds auto-perform in constructor; ignore
  }
  meshAlgo.delete();

  // Now traverse all faces and extract triangulation
  const allVertices = [];
  const allIndices = [];
  let vertexOffset = 0;

  const explorer = new oc.TopExp_Explorer_2(
    shape,
    oc.TopAbs_ShapeEnum.TopAbs_FACE,
    oc.TopAbs_ShapeEnum.TopAbs_SHAPE
  );

  while (explorer.More()) {
    const face = oc.TopoDS.Face_1(explorer.Current());
    const location = new oc.TopLoc_Location_1();
    const handleTriangulation = oc.BRep_Tool.Triangulation(face, location);

    if (!handleTriangulation.IsNull()) {
      const triangulation = handleTriangulation.get();
      const nbNodes = triangulation.NbNodes();
      const nbTriangles = triangulation.NbTriangles();

      // Get transformation matrix from location
      const trsf = location.Transformation();

      // Check face orientation for correct normal winding
      const faceOri = face.Orientation_1();
      const isReversed =
        (typeof oc.TopAbs_Orientation !== "undefined")
          ? faceOri === oc.TopAbs_Orientation.TopAbs_REVERSED
          : faceOri === 1; // TopAbs_REVERSED = 1

      // Extract vertices (1-indexed in OCCT)
      for (let i = 1; i <= nbNodes; i++) {
        const node = triangulation.Node(i);
        // Apply transformation
        const transformed = node.Transformed(trsf);
        allVertices.push(transformed.X(), transformed.Y(), transformed.Z());
        transformed.delete();
        node.delete();
      }

      // Extract triangles (1-indexed in OCCT)
      for (let i = 1; i <= nbTriangles; i++) {
        const tri = triangulation.Triangle(i);
        let n1 = tri.Value(1) - 1 + vertexOffset;
        let n2 = tri.Value(2) - 1 + vertexOffset;
        let n3 = tri.Value(3) - 1 + vertexOffset;

        if (isReversed) {
          allIndices.push(n1, n3, n2);
        } else {
          allIndices.push(n1, n2, n3);
        }

        tri.delete();
      }

      vertexOffset += nbNodes;
    }

    handleTriangulation.delete();
    location.delete();
    face.delete();
    explorer.Next();
  }

  explorer.delete();

  // Convert to typed arrays
  const vertices = new Float32Array(allVertices);
  const indices = new Uint32Array(allIndices);

  // Compute smooth vertex normals from triangle geometry
  const normals = computeNormals(vertices, indices);

  return { vertices, normals, indices };
}

function computeNormals(vertices, indices) {
  const normals = new Float32Array(vertices.length);

  for (let i = 0; i < indices.length; i += 3) {
    const i0 = indices[i];
    const i1 = indices[i + 1];
    const i2 = indices[i + 2];

    const ax = vertices[i0 * 3], ay = vertices[i0 * 3 + 1], az = vertices[i0 * 3 + 2];
    const bx = vertices[i1 * 3], by = vertices[i1 * 3 + 1], bz = vertices[i1 * 3 + 2];
    const cx = vertices[i2 * 3], cy = vertices[i2 * 3 + 1], cz = vertices[i2 * 3 + 2];

    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;

    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;

    normals[i0 * 3] += nx; normals[i0 * 3 + 1] += ny; normals[i0 * 3 + 2] += nz;
    normals[i1 * 3] += nx; normals[i1 * 3 + 1] += ny; normals[i1 * 3 + 2] += nz;
    normals[i2 * 3] += nx; normals[i2 * 3 + 1] += ny; normals[i2 * 3 + 2] += nz;
  }

  // Normalize
  for (let i = 0; i < normals.length; i += 3) {
    const len = Math.sqrt(
      normals[i] * normals[i] +
      normals[i + 1] * normals[i + 1] +
      normals[i + 2] * normals[i + 2]
    );
    if (len > 0) {
      normals[i] /= len;
      normals[i + 1] /= len;
      normals[i + 2] /= len;
    }
  }

  return normals;
}

// ---------------------------------------------------------------------------
// EXPORT
// ---------------------------------------------------------------------------

async function handleExport(payload, msgId) {
  const { format, shapeId, matrix, meshData } = payload;

  console.log(`[OCCT Worker] Exporting to ${format}`);

  let fileContent;
  let shapeToExport = null;

  if (shapeId && shapeStore.has(shapeId)) {
    shapeToExport = shapeStore.get(shapeId);
  } else if (meshData && format !== "stl") {
    shapeToExport = buildShapeFromMesh(meshData);
  } else if (meshData && format === "stl") {
    fileContent = buildBinarySTL(meshData).fileContent;
  } else {
    throw new Error("No shape data available for export");
  }

  if (shapeToExport) {
    fileContent = exportShapeToFormat(shapeToExport, format, matrix);
    if (!shapeId) {
      // If we temporarily built it from meshData, clean it up
      shapeToExport.delete();
    }
  }

  self.postMessage({
    id: msgId,
    type: "export-result",
    format,
    fileContent,
  });
}

function exportShapeToFormat(shape, format, matrix) {
  // Use an absolute path so it forces writing to the virtual root FS
  const fileName = "/export_output." + format;

  // Validate shape before attempting export
  if (!shape || shape.IsNull()) {
    throw new Error("Cannot export: shape is null or invalid");
  }
  console.log(`[Export] Shape type: ${shape.ShapeType()}, format: ${format}`);

  // Check CWD and FS state
  let cwd = "/";
  try { cwd = oc.FS.cwd(); } catch (_) { /* ignore */ }
  console.log(`[Export] CWD: ${cwd}`);

  // Clean up any previous export file
  const possiblePaths = [fileName, "/" + fileName, cwd + "/" + fileName];
  for (const p of possiblePaths) {
    try { oc.FS.unlink(p); } catch (_) { /* ignore */ }
  }

  let shapeToExport = applyTransformToShape(shape, matrix);

  if (format === "step" || format === "stp") {
    writeSTEP(shapeToExport, fileName);
  } else if (format === "iges" || format === "igs") {
    writeIGES(shapeToExport, fileName);
  } else if (format === "stl") {
    return exportShapeToSTLViaMesh(shapeToExport);
  } else {
    throw new Error(`Unsupported export format: ${format}`);
  }

  // Search for the file — it might be at CWD or root
  const content = findAndReadExportFile(fileName, cwd);
  if (!content) {
    throw new Error(
      `Export failed: could not find "${fileName}" anywhere in the virtual FS.`
    );
  }

  console.log(`[Export] Successfully read ${content.length} bytes`);
  return content;
}

/**
 * Search for an exported file in multiple locations in the Emscripten FS.
 */
function findAndReadExportFile(fileName, cwd) {
  // Try exact path matches first
  const searchPaths = [
    fileName,
    "/" + fileName,
    cwd + "/" + fileName,
  ];

  const unique = [...new Set(searchPaths)];

  for (const p of unique) {
    try {
      const stat = oc.FS.stat(p);
      if (stat && stat.size > 0 && !oc.FS.isDir(stat.mode)) {
        console.log(`[Export] Found file at "${p}" (${stat.size} bytes)`);
        const content = oc.FS.readFile(p);
        try { oc.FS.unlink(p); } catch (_) { /* ignore */ }
        return content;
      }
    } catch (_) {
      // File not at this path
    }
  }

  // Fallback: The WebAssembly C++ bindings for Standard_CString often mangle JavaScript strings 
  // into garbage characters (like 𯃁), meaning the file was created but with a junk name.
  // We can just scan the root directory and read any file that isn't a standard system directory.
  try {
    const rootFiles = oc.FS.readdir("/");
    const systemNames = [".", "..", "tmp", "home", "dev", "proc"];
    for (const file of rootFiles) {
      if (!systemNames.includes(file)) {
        const fullPath = "/" + file;
        const stat = oc.FS.stat(fullPath);
        if (!oc.FS.isDir(stat.mode) && stat.size > 0) {
          console.log(`[Export] Found mangled file at "${fullPath}" (${stat.size} bytes). Assuming this is our export.`);
          const content = oc.FS.readFile(fullPath);
          try { oc.FS.unlink(fullPath); } catch (_) { /* ignore */ }
          return content;
        }
      }
    }
  } catch (err) {
    console.warn("[Export] Fallback directory scan failed:", err);
  }

  // Debug: dump entire FS listing if still not found
  console.error(`[Export] File not found. Dumping FS...`);
  dumpFS("/", 0);

  return null;
}

/**
 * Recursively list Emscripten FS for debugging.
 */
function dumpFS(path, depth) {
  if (depth > 3) return; // limit recursion
  try {
    const entries = oc.FS.readdir(path);
    for (const entry of entries) {
      if (entry === "." || entry === "..") continue;
      const fullPath = path === "/" ? "/" + entry : path + "/" + entry;
      try {
        const stat = oc.FS.stat(fullPath);
        const isDir = oc.FS.isDir(stat.mode);
        const indent = "  ".repeat(depth);
        console.log(
          `[FS] ${indent}${entry} ${isDir ? "[DIR]" : `[FILE ${stat.size}b]`} (${fullPath})`
        );
        if (isDir) {
          dumpFS(fullPath, depth + 1);
        }
      } catch (_) {
        console.log(`[FS] ${"  ".repeat(depth)}${entry} [STAT FAILED]`);
      }
    }
  } catch (_) {
    // Not a directory or can't read
  }
}

function callMethod(obj, baseName, ...args) {
  const suffixes = ['', '_1', '_2', '_3', '_4', '_5'];
  let lastErr;
  for (const suffix of suffixes) {
    const fnName = `${baseName}${suffix}`;
    const fn = obj[fnName];
    if (typeof fn === 'function') {
      try {
        return fn.call(obj, ...args);
      } catch (err) {
        lastErr = err;
      }
    }
  }
  throw new Error(`Method ${baseName} failed or not found. Last error: ${lastErr ? lastErr.message : 'Not a function'}`);
}

function writeSTEP(shape, outputPath) {
  const writer = instantiateClass("STEPControl_Writer");
  try {
    const mode = oc.STEPControl_StepModelType.STEPControl_AsIs;
    console.log("[STEP Export] Transferring shape...");
    const transferResult = callMethod(writer, "Transfer", shape, mode, true);
    const transferVal = typeof transferResult === "object" && transferResult !== null && "value" in transferResult ? transferResult.value : transferResult;
    console.log(`[STEP Export] Transfer result: ${transferVal}`);

    console.log(`[STEP Export] Writing to "${outputPath}"...`);
    const writeResult = callMethod(writer, "Write", outputPath);
    const statusVal = typeof writeResult === "object" && writeResult !== null && "value" in writeResult ? writeResult.value : writeResult;
    console.log(`[STEP Export] Write result: ${statusVal}`);
    
    if (statusVal !== 1) {
      throw new Error(`STEP Writer failed with IFSelect_ReturnStatus = ${statusVal}`);
    }
  } finally {
    writer.delete();
  }
}

function writeIGES(shape, outputPath) {
  const writer = instantiateClass("IGESControl_Writer");
  try {
    console.log("[IGES Export] Adding shape...");
    const added = callMethod(writer, "AddShape", shape);
    const addedVal = typeof added === "object" && "value" in added ? added.value : added;
    console.log(`[IGES Export] AddShape result: ${addedVal}`);
    
    if (!addedVal) {
      throw new Error("IGES Writer failed to add shape. Shape may be unsupported or invalid.");
    }
    
    callMethod(writer, "ComputeModel");

    console.log("[IGES Export] Writing to \"${outputPath}\"...");
    const writeResult = callMethod(writer, "Write", outputPath);
    console.log(`[IGES Export] Write result: ${writeResult}`);
    
    if (!writeResult) {
      throw new Error("IGES Writer failed to write file.");
    }
  } finally {
    writer.delete();
  }
}

/**
 * Export shape to STL by re-tessellating and building binary STL from mesh data.
 * The OCCT StlAPI_Writer doesn't work in this WASM build, so we extract the
 * mesh and build the binary STL ourselves.
 */
function exportShapeToSTLViaMesh(shape) {
  console.log("[STL Export] Using mesh-based export (OCCT writer unavailable)");
  const meshData = tessellateShape(shape);

  if (!meshData.vertices.length || !meshData.indices.length) {
    throw new Error("STL export failed: no mesh data from shape");
  }

  return buildBinarySTL(meshData);
}

/**
 * Build binary STL from mesh data (vertices, indices, normals).
 */
function buildBinarySTL(meshData) {
  const { vertices, indices, normals } = meshData;
  const triCount = indices.length / 3;

  // Binary STL: 80 byte header + 4 byte count + 50 bytes per triangle
  const bufferSize = 84 + triCount * 50;
  const buffer = new ArrayBuffer(bufferSize);
  const view = new DataView(buffer);

  // Header (80 bytes)
  const header = "Binary STL exported from SimplCAD";
  const encoder = new TextEncoder();
  const headerBytes = encoder.encode(header);
  for (let i = 0; i < Math.min(80, headerBytes.length); i++) {
    view.setUint8(i, headerBytes[i]);
  }

  // Triangle count
  view.setUint32(80, triCount, true);

  let offset = 84;
  for (let t = 0; t < indices.length; t += 3) {
    const i0 = indices[t], i1 = indices[t + 1], i2 = indices[t + 2];

    const nx = normals ? normals[i0 * 3] : 0;
    const ny = normals ? normals[i0 * 3 + 1] : 0;
    const nz = normals ? normals[i0 * 3 + 2] : 1;

    view.setFloat32(offset, nx, true);
    view.setFloat32(offset + 4, ny, true);
    view.setFloat32(offset + 8, nz, true);

    for (let v = 0; v < 3; v++) {
      const idx = indices[t + v];
      view.setFloat32(offset + 12 + v * 12, vertices[idx * 3], true);
      view.setFloat32(offset + 16 + v * 12, vertices[idx * 3 + 1], true);
      view.setFloat32(offset + 20 + v * 12, vertices[idx * 3 + 2], true);
    }

    view.setUint16(offset + 48, 0, true);
    offset += 50;
  }

  return { format: "stl", fileContent: new Uint8Array(buffer) };
}

/**
 * Builds an OpenCASCADE TopoDS_Compound shape from raw triangulated mesh data.
 * Used when exporting STL files (which were loaded without OCCT) to STEP/IGES.
 */
function buildShapeFromMesh(meshData) {
  console.log("[OCCT Worker] Building shape from raw mesh data (this may take a while for large meshes)...");
  const { vertices, indices } = meshData;
  
  const BRepBuilder = instantiateClass("BRep_Builder");
  const compound = instantiateClass("TopoDS_Compound");
  callMethod(BRepBuilder, "MakeCompound", compound);
  
  // For each triangle, create a Face
  for (let i = 0; i < indices.length; i += 3) {
    const idx0 = indices[i] * 3;
    const idx1 = indices[i+1] * 3;
    const idx2 = indices[i+2] * 3;

    const p1 = instantiateClass("gp_Pnt", vertices[idx0], vertices[idx0+1], vertices[idx0+2]);
    const p2 = instantiateClass("gp_Pnt", vertices[idx1], vertices[idx1+1], vertices[idx1+2]);
    const p3 = instantiateClass("gp_Pnt", vertices[idx2], vertices[idx2+1], vertices[idx2+2]);

    const makePolygon = instantiateClass("BRepBuilderAPI_MakePolygon", p1, p2, p3, true);
    try { callMethod(makePolygon, "Build"); } catch(_) {}
    
    if (callMethod(makePolygon, "IsDone")) {
      const wire = callMethod(makePolygon, "Wire");
      let downcastedWire;
      try { downcastedWire = callMethod(oc.TopoDS, "Wire", wire); } catch(e) { downcastedWire = wire; }
      
      let makeFace = null;
      
      try { makeFace = instantiateClass("BRepBuilderAPI_MakeFace", downcastedWire); } catch(e) { }
      
      if (!makeFace) {
        try { makeFace = instantiateClass("BRepBuilderAPI_MakeFace", downcastedWire, false); } catch(e) { }
      }
      
      if (!makeFace) {
        const v1x = vertices[idx1] - vertices[idx0], v1y = vertices[idx1+1] - vertices[idx0+1], v1z = vertices[idx1+2] - vertices[idx0+2];
        const v2x = vertices[idx2] - vertices[idx0], v2y = vertices[idx2+1] - vertices[idx0+1], v2z = vertices[idx2+2] - vertices[idx0+2];
        let nx = v1y*v2z - v1z*v2y, ny = v1z*v2x - v1x*v2z, nz = v1x*v2y - v1y*v2x;
        const len = Math.sqrt(nx*nx + ny*ny + nz*nz);
        if (len > 0) { nx/=len; ny/=len; nz/=len; } else { nz=1; }
        
        const gpDir = instantiateClass("gp_Dir", nx, ny, nz);
        const gpPln = instantiateClass("gp_Pln", p1, gpDir);
        
        try { makeFace = instantiateClass("BRepBuilderAPI_MakeFace", gpPln, downcastedWire); } catch(e) { }
        if (!makeFace) { try { makeFace = instantiateClass("BRepBuilderAPI_MakeFace", gpPln, downcastedWire, true); } catch(e) { } }
        
        gpPln.delete();
        gpDir.delete();
      }
      
      if (!makeFace) {
        throw new Error("Could not construct BRepBuilderAPI_MakeFace with any known signature");
      }
      try { callMethod(makeFace, "Build"); } catch(_) {}
      
      if (callMethod(makeFace, "IsDone")) {
        const face = callMethod(makeFace, "Face");
        callMethod(BRepBuilder, "Add", compound, face);
        face.delete();
      }
      makeFace.delete();
      wire.delete();
    }
    makePolygon.delete();
    p1.delete(); p2.delete(); p3.delete();
  }

  BRepBuilder.delete();
  console.log(`[OCCT Worker] Built compound shape with ${indices.length / 3} faces.`);
  return compound;
}

// ---------------------------------------------------------------------------
// Phase 4: Modifiers and PrimitivesERATIONS (Boolean, Extrude, Revolve, Primitives)
// ---------------------------------------------------------------------------

/**
 * Dynamically instantiate an OpenCASCADE class by trying common suffixes.
 */
function instantiateClass(className, ...args) {
  let obj;
  let lastErr;
  const suffixes = ['_1', '_2', '_3', '_4', '_5', '_6', ''];
  for (const suffix of suffixes) {
    const OpClass = oc[`${className}${suffix}`];
    if (typeof OpClass === 'function') {
      try {
        obj = new OpClass(...args);
        break; // Success!
      } catch (err) {
        lastErr = err;
      }
    }
  }
  if (!obj) {
    throw new Error(`No matching constructor found for ${className}. Last error: ` + (lastErr ? lastErr.message : 'none'));
  }
  return obj;
}

/**
 * Helper to apply a 4x4 matrix to a shape. Returns a new transformed shape or the original if failed.
 */
function applyTransformToShape(shape, matrix) {
  if (!matrix || matrix.length !== 16) return shape;

  let transformedShape = shape;
  try {
    const trsf = instantiateClass("gp_Trsf");
    trsf.SetValues(
      matrix[0], matrix[4], matrix[8],  matrix[12],
      matrix[1], matrix[5], matrix[9],  matrix[13],
      matrix[2], matrix[6], matrix[10], matrix[14]
    );
    const transform = instantiateClass("BRepBuilderAPI_Transform", shape, trsf, true);
    transformedShape = transform.Shape();
    transform.delete();
    trsf.delete();
  } catch (e) {
    try {
      const mat = instantiateClass("gp_Mat",
        matrix[0], matrix[4], matrix[8],
        matrix[1], matrix[5], matrix[9],
        matrix[2], matrix[6], matrix[10]
      );
      const xyz = instantiateClass("gp_XYZ", matrix[12], matrix[13], matrix[14]);
      const gtrsf = instantiateClass("gp_GTrsf");
      gtrsf.SetVectorialPart(mat);
      gtrsf.SetTranslationPart(xyz);
      
      const gTransform = instantiateClass("BRepBuilderAPI_GTransform", shape, gtrsf, true);
      transformedShape = gTransform.Shape();
      gTransform.delete();
      gtrsf.delete();
      mat.delete();
      xyz.delete();
    } catch (err) {
      console.error("[Transform] GTransform failed", err);
    }
  }
  return transformedShape;
}

/**
 * Boolean operation (union, difference, intersection) on two shapes.
 */
async function handleBoolean(payload, msgId) {
  const { operation, shapeIdA, shapeIdB, matrixA, matrixB } = payload;

  const rawShapeA = shapeStore.get(shapeIdA);
  const rawShapeB = shapeStore.get(shapeIdB);

  if (!rawShapeA || rawShapeA.IsNull()) throw new Error("Boolean: first shape is null or missing");
  if (!rawShapeB || rawShapeB.IsNull()) throw new Error("Boolean: second shape is null or missing");

  // Apply user transforms before computing boolean operation
  const shapeA = applyTransformToShape(rawShapeA, matrixA);
  const shapeB = applyTransformToShape(rawShapeB, matrixB);

  console.log(`[OCCT Worker] Boolean ${operation} on ${shapeIdA} and ${shapeIdB}`);

  let result;

  function doBoolOp(opPrefix, a, b) {
    const op = instantiateClass(opPrefix, a, b);
    try { op.Build(); } catch (_) { /* some builds auto-build in ctor */ }
    if (!op.IsDone()) { 
      op.delete(); 
      throw new Error('Boolean operation failed — shapes may be incompatible'); 
    }
    const res = op.Shape();
    op.delete();
    return res;
  }

  try {
    switch (operation) {
      case "union":
        result = doBoolOp("BRepAlgoAPI_Fuse", shapeA, shapeB);
        break;
      case "difference":
        result = doBoolOp("BRepAlgoAPI_Cut", shapeA, shapeB);
        break;
      case "intersection":
        result = doBoolOp("BRepAlgoAPI_Common", shapeA, shapeB);
        break;
      default:
        throw new Error(`Unknown boolean operation: ${operation}`);
    }
  } catch (err) {
    throw new Error(`Boolean ${operation} failed: ${err.message}`);
  }

  if (!result || result.IsNull()) {
    throw new Error(`Boolean ${operation} produced an empty/null result`);
  }

  // Store result
  const shapeId = `shape_${shapeIdCounter++}`;
  shapeStore.set(shapeId, result);

  // Tessellate
  const meshData = tessellateShape(result);

  console.log(`[OCCT Worker] Boolean ${operation} result: ${meshData.vertices.length / 3} vertices, ${meshData.indices.length / 3} triangles`);

  self.postMessage({
    id: msgId,
    type: "boolean-result",
    shapeId,
    operation,
    vertices: meshData.vertices,
    normals: meshData.normals,
    indices: meshData.indices,
  });
}

/**
 * Extrude a shape along a direction vector by a given height.
 */
async function handleExtrude(payload, msgId) {
  const { shapeId: srcShapeId, direction, height, matrix } = payload;

  const rawShape = shapeStore.get(srcShapeId);
  if (!rawShape || rawShape.IsNull()) throw new Error("Extrude: source shape is null or missing");

  const shape = applyTransformToShape(rawShape, matrix);

  console.log(`[OCCT Worker] Extruding ${srcShapeId} by height=${height} along [${direction.x}, ${direction.y}, ${direction.z}]`);

  // Normalize direction and multiply by height
  const len = Math.sqrt(direction.x ** 2 + direction.y ** 2 + direction.z ** 2);
  const dx = (direction.x / len) * height;
  const dy = (direction.y / len) * height;
  const dz = (direction.z / len) * height;

  const vec = instantiateClass("gp_Vec", dx, dy, dz);

  let result;
  try {
    // Try to extract a face from the shape for extrusion
    let extrudeBase = shape;

    // If the shape is a solid or compound, try to get the first face
    const shapeType = shape.ShapeType();
    // TopAbs_ShapeEnum: COMPOUND=0, COMPSOLID=1, SOLID=2, SHELL=3, FACE=4, WIRE=5, EDGE=6, VERTEX=7
    const typeVal = (typeof shapeType === "object" && shapeType !== null && "value" in shapeType) ? shapeType.value : shapeType;

    if (typeVal <= 3) {
      // For solids/compounds, extract the first face
      const explorer = instantiateClass("TopExp_Explorer", shape, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
      if (explorer.More()) {
        extrudeBase = explorer.Current();
      }
      explorer.delete();
    }

    const prism = instantiateClass("BRepPrimAPI_MakePrism", extrudeBase, vec, false, true);
    try { prism.Build(); } catch (_) { /* auto-built in ctor */ }
    if (!prism.IsDone()) throw new Error("Extrude (MakePrism) failed");
    result = prism.Shape();
    prism.delete();
  } catch (err) {
    vec.delete();
    throw new Error(`Extrude failed: ${err.message}`);
  }

  vec.delete();

  if (!result || result.IsNull()) {
    throw new Error("Extrude produced an empty/null result");
  }

  const shapeId = `shape_${shapeIdCounter++}`;
  shapeStore.set(shapeId, result);

  const meshData = tessellateShape(result);
  console.log(`[OCCT Worker] Extrude result: ${meshData.vertices.length / 3} vertices`);

  self.postMessage({
    id: msgId,
    type: "extrude-result",
    shapeId,
    vertices: meshData.vertices,
    normals: meshData.normals,
    indices: meshData.indices,
  });
}

/**
 * Revolve a shape around an axis by a given angle (degrees).
 */
async function handleRevolve(payload, msgId) {
  const { shapeId: srcShapeId, axisOrigin, axisDirection, angle, matrix } = payload;

  const rawShape = shapeStore.get(srcShapeId);
  if (!rawShape || rawShape.IsNull()) throw new Error("Revolve: source shape is null or missing");

  const shape = applyTransformToShape(rawShape, matrix);

  const angleDeg = angle || 360;
  const angleRad = (angleDeg * Math.PI) / 180;

  console.log(`[OCCT Worker] Revolving ${srcShapeId} by ${angleDeg}° around [${axisDirection.x}, ${axisDirection.y}, ${axisDirection.z}]`);

  // Build the rotation axis
  const origin = instantiateClass("gp_Pnt", axisOrigin.x, axisOrigin.y, axisOrigin.z);
  const dir = instantiateClass("gp_Dir", axisDirection.x, axisDirection.y, axisDirection.z);
  const axis = instantiateClass("gp_Ax1", origin, dir);

  let result;
  try {
    // Try to get a face for revolving
    let revolveBase = shape;
    const shapeType = shape.ShapeType();
    const typeVal = (typeof shapeType === "object" && shapeType !== null && "value" in shapeType) ? shapeType.value : shapeType;

    if (typeVal <= 3) {
      const explorer = instantiateClass("TopExp_Explorer", shape, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
      if (explorer.More()) {
        revolveBase = explorer.Current();
      }
      explorer.delete();
    }

    const revol = instantiateClass("BRepPrimAPI_MakeRevol", revolveBase, axis, angleRad, true);
    try { revol.Build(); } catch (_) { /* auto-built in ctor */ }
    if (!revol.IsDone()) throw new Error("Revolve (MakeRevol) failed");
    result = revol.Shape();
    revol.delete();
  } catch (err) {
    origin.delete();
    dir.delete();
    axis.delete();
    throw new Error(`Revolve failed: ${err.message}`);
  }

  origin.delete();
  dir.delete();
  axis.delete();

  if (!result || result.IsNull()) {
    throw new Error("Revolve produced an empty/null result");
  }

  const shapeId = `shape_${shapeIdCounter++}`;
  shapeStore.set(shapeId, result);

  const meshData = tessellateShape(result);
  console.log(`[OCCT Worker] Revolve result: ${meshData.vertices.length / 3} vertices`);

  self.postMessage({
    id: msgId,
    type: "revolve-result",
    shapeId,
    vertices: meshData.vertices,
    normals: meshData.normals,
    indices: meshData.indices,
  });
}

/**
 * Create a primitive shape (box, cylinder, sphere, cone).
 */
async function handleCreatePrimitive(payload, msgId) {
  const { primitive, params } = payload;

  console.log(`[OCCT Worker] Creating primitive: ${primitive}`, params);

  let shape;

  try {
    switch (primitive) {
      case "box": {
        const origin = instantiateClass("gp_Pnt", 0, 0, 0);
        const makeBox = instantiateClass("BRepPrimAPI_MakeBox",
          origin,
          params.width || 10,
          params.depth || 10,
          params.height || 10
        );
        shape = makeBox.Shape();
        makeBox.delete();
        origin.delete();
        break;
      }
      case "cylinder": {
        const makeCyl = instantiateClass("BRepPrimAPI_MakeCylinder",
          params.radius || 5,
          params.height || 10
        );
        shape = makeCyl.Shape();
        makeCyl.delete();
        break;
      }
      case "sphere": {
        const makeSphere = instantiateClass("BRepPrimAPI_MakeSphere",
          params.radius || 5
        );
        shape = makeSphere.Shape();
        makeSphere.delete();
        break;
      }
      case "cone": {
        const makeCone = instantiateClass("BRepPrimAPI_MakeCone",
          params.radiusBottom || 5,
          params.radiusTop || 0.01,
          params.height || 10
        );
        shape = makeCone.Shape();
        makeCone.delete();
        break;
      }
      default:
        throw new Error(`Unknown primitive type: ${primitive}`);
    }
  } catch (err) {
    throw new Error(`Failed to create ${primitive}: ${err.message}`);
  }

  if (!shape || shape.IsNull()) {
    throw new Error(`Primitive ${primitive} produced null shape`);
  }

  const shapeId = `shape_${shapeIdCounter++}`;
  shapeStore.set(shapeId, shape);

  const meshData = tessellateShape(shape);
  console.log(`[OCCT Worker] Primitive ${primitive}: ${meshData.vertices.length / 3} vertices`);

  self.postMessage({
    id: msgId,
    type: "primitive-result",
    shapeId,
    primitive,
    vertices: meshData.vertices,
    normals: meshData.normals,
    indices: meshData.indices,
  });
}