/**
 * SimplCAD — Main Entry Point
 * Phase 4: Geometry Operations (Boolean, Extrude, Revolve, Primitives)
 */

import { initViewer } from "./core/viewer.js";
import { importFile, exportShape, exportMeshAsSTL, booleanOperation, extrudeShape, revolveShape, createPrimitive } from "./worker/worker-bridge.js";
import { STLLoader } from "three/addons/loaders/STLLoader.js";

// ---- State ----
const state = {
  viewer: null,
  shapes: [],
  isLoading: false,
  history: [],      // undo stack: [{meshName, pos, rot, scale}]
  historyIndex: -1,
};

// ---- Boot ----
document.addEventListener("DOMContentLoaded", async () => {
  await buildUI();
  state.viewer = initViewer(document.getElementById("viewport"));

  // Wire selection/transform callbacks
  state.viewer.onSelectionChange(onSelectionChanged);
  state.viewer.onTransformChange(onTransformChanged);
  state.viewer.onDragEnd(() => saveState());

  setupKeyboardShortcuts();
  saveState(); // Initial empty state
  updateStatus("Ready — drag & drop or click Import to load a CAD file");
  console.log("[SimplCAD] Initialized — Phase 4");
});

// ---------------------------------------------------------------------------
// UI Construction
// ---------------------------------------------------------------------------

async function buildUI() {
  const root = document.getElementById("app");
  try {
    const res = await fetch("/UI.html");
    if (res.ok) {
      root.innerHTML = await res.text();
    } else {
      root.innerHTML = `<p style="color:red; padding: 20px;">Failed to load UI layout. Please check if public/UI.html exists.</p>`;
    }
  } catch (err) {
    console.error("Error loading UI:", err);
    root.innerHTML = `<p style="color:red; padding: 20px;">Error loading UI layout.</p>`;
  }

  wireEvents();
}

function wireEvents() {
  // Import
  document.getElementById("btn-import").addEventListener("click", () => {
    document.getElementById("file-input").click();
  });
  document.getElementById("file-input").addEventListener("change", async (e) => {
    const files = Array.from(e.target.files);
    if (files.length) await handleImportFiles(files);
    e.target.value = "";
  });

  // Export dropdown
  const exportBtn = document.getElementById("btn-export");
  const exportMenu = document.getElementById("export-menu");
  exportBtn.addEventListener("click", (e) => { e.stopPropagation(); exportMenu.classList.toggle("show"); });
  document.addEventListener("click", () => exportMenu.classList.remove("show"));
  exportMenu.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation(); exportMenu.classList.remove("show");
      await handleExport(btn.dataset.format);
    });
  });

  // Clear, wireframe, fit
  document.getElementById("btn-clear").addEventListener("click", handleClear);
  document.getElementById("btn-wireframe").addEventListener("click", handleToggleWireframe);
  document.getElementById("btn-fit").addEventListener("click", () => { if (state.viewer) state.viewer.fitAll(); });

  // Undo/Redo
  document.getElementById("btn-undo").addEventListener("click", handleUndo);
  document.getElementById("btn-redo").addEventListener("click", handleRedo);

  // Transform mode buttons
  document.querySelectorAll(".mode-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".mode-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      if (state.viewer) state.viewer.setTransformMode(btn.dataset.mode);
    });
  });

  // Transform input fields — apply on change
  ["pos-x","pos-y","pos-z"].forEach(id => {
    document.getElementById(id).addEventListener("input", () => applyInputTransform("position"));
    document.getElementById(id).addEventListener("change", () => saveState());
  });
  ["rot-x","rot-y","rot-z"].forEach(id => {
    document.getElementById(id).addEventListener("input", () => applyInputTransform("rotation"));
    document.getElementById(id).addEventListener("change", () => saveState());
  });
  ["scl-x","scl-y","scl-z"].forEach(id => {
    document.getElementById(id).addEventListener("input", () => applyInputTransform("scale"));
    document.getElementById(id).addEventListener("change", () => saveState());
  });

  // Reset transform
  document.getElementById("btn-reset-transform").addEventListener("click", () => {
    if (state.viewer) {
      state.viewer.resetTransform();
      syncTransformInputs();
      saveState();
    }
  });

  // Drag & Drop
  const vc = document.getElementById("viewport-container");
  const overlay = document.getElementById("drop-overlay");
  let dragCounter = 0;
  vc.addEventListener("dragenter", (e) => { e.preventDefault(); dragCounter++; overlay.classList.remove("hidden"); });
  vc.addEventListener("dragleave", (e) => { e.preventDefault(); dragCounter--; if (dragCounter <= 0) { dragCounter = 0; overlay.classList.add("hidden"); } });
  vc.addEventListener("dragover", (e) => e.preventDefault());
  vc.addEventListener("drop", async (e) => {
    e.preventDefault(); dragCounter = 0; overlay.classList.add("hidden");
    const files = Array.from(e.dataTransfer.files);
    if (files.length) await handleImportFiles(files);
  });

  // ---- Phase 4: Primitives ----
  document.querySelectorAll(".prim-btn").forEach((btn) => {
    btn.addEventListener("click", () => showPrimitiveParams(btn.dataset.primitive));
  });
  document.getElementById("prim-cancel-btn").addEventListener("click", hidePrimitiveParams);
  document.getElementById("prim-create-btn").addEventListener("click", handleCreatePrimitive);

  // ---- Phase 4: Boolean ----
  document.getElementById("btn-bool-union").addEventListener("click", () => handleBooleanOp("union"));
  document.getElementById("btn-bool-difference").addEventListener("click", () => handleBooleanOp("difference"));
  document.getElementById("btn-bool-intersection").addEventListener("click", () => handleBooleanOp("intersection"));

  // ---- Phase 4: Extrude / Revolve ----
  document.getElementById("btn-extrude").addEventListener("click", () => {
    document.getElementById("extrude-params").classList.toggle("hidden");
    document.getElementById("revolve-params").classList.add("hidden");
  });
  document.getElementById("btn-revolve").addEventListener("click", () => {
    document.getElementById("revolve-params").classList.toggle("hidden");
    document.getElementById("extrude-params").classList.add("hidden");
  });
  document.getElementById("btn-extrude-apply").addEventListener("click", handleExtrude);
  document.getElementById("btn-revolve-apply").addEventListener("click", handleRevolve);
}

// ---------------------------------------------------------------------------
// Selection & Transform Callbacks
// ---------------------------------------------------------------------------

function onSelectionChanged(selected) {
  const inputs = document.getElementById("transform-inputs");
  const noSel = document.getElementById("no-selection-msg");
  if (selected.length > 0) {
    inputs.classList.remove("hidden");
    noSel.classList.add("hidden");
    syncTransformInputs();
    updateStatus(`Selected: ${selected.map(m => m.name).join(", ")}`);
  } else {
    inputs.classList.add("hidden");
    noSel.classList.remove("hidden");
    updateStatus("Ready");
  }
  // Phase 4: update button states
  updateGeomOpButtons(selected.length);
}

function onTransformChanged(_meshes) {
  syncTransformInputs();
}

function syncTransformInputs() {
  const t = state.viewer?.getSelectedTransform();
  if (!t) return;
  
  const updateIfUnfocused = (id, val) => {
    const el = document.getElementById(id);
    if (document.activeElement !== el) {
      el.value = val;
    }
  };

  updateIfUnfocused("pos-x", t.position.x.toFixed(2));
  updateIfUnfocused("pos-y", t.position.y.toFixed(2));
  updateIfUnfocused("pos-z", t.position.z.toFixed(2));
  
  updateIfUnfocused("rot-x", t.rotation.x.toFixed(1));
  updateIfUnfocused("rot-y", t.rotation.y.toFixed(1));
  updateIfUnfocused("rot-z", t.rotation.z.toFixed(1));
  
  updateIfUnfocused("scl-x", t.scale.x.toFixed(3));
  updateIfUnfocused("scl-y", t.scale.y.toFixed(3));
  updateIfUnfocused("scl-z", t.scale.z.toFixed(3));
}

function applyInputTransform(type) {
  if (!state.viewer || state.viewer.getSelected().length === 0) return;
  const v = (id) => parseFloat(document.getElementById(id).value) || 0;
  if (type === "position") {
    state.viewer.applyTransform("position", { x: v("pos-x"), y: v("pos-y"), z: v("pos-z") });
  } else if (type === "rotation") {
    state.viewer.applyTransform("rotation", { x: v("rot-x"), y: v("rot-y"), z: v("rot-z") });
  } else if (type === "scale") {
    state.viewer.applyTransform("scale", { x: v("scl-x") || 1, y: v("scl-y") || 1, z: v("scl-z") || 1 });
  }
}

// ---------------------------------------------------------------------------
// Undo / Redo
// ---------------------------------------------------------------------------

function saveState() {
  state.history = state.history.slice(0, state.historyIndex + 1);

  // Deep clone shapes and transforms
  const snapshot = state.shapes.map(s => ({
    shapeId: s.shapeId,
    fileName: s.fileName,
    vertices: s.vertices,
    indices: s.indices,
    normals: s.normals,
    pos: s.mesh.position.clone(),
    rot: s.mesh.rotation.clone(),
    scl: s.mesh.scale.clone(),
  }));

  state.history.push(snapshot);
  state.historyIndex = state.history.length - 1;
}

function handleUndo() {
  if (state.historyIndex <= 0) { updateStatus("Nothing to undo"); return; }
  state.historyIndex--;
  restoreSnapshot(state.history[state.historyIndex]);
  updateStatus("Undo");
}

function handleRedo() {
  if (state.historyIndex >= state.history.length - 1) { updateStatus("Nothing to redo"); return; }
  state.historyIndex++;
  restoreSnapshot(state.history[state.historyIndex]);
  updateStatus("Redo");
}

function restoreSnapshot(snapshot) {
  // Clear scene
  state.viewer.clearModels();
  state.shapes = [];

  // Re-add shapes
  for (const s of snapshot) {
    const mesh = state.viewer.loadGeometry(s.vertices, s.indices, s.normals, s.fileName);
    mesh.position.copy(s.pos);
    mesh.rotation.copy(s.rot);
    mesh.scale.copy(s.scl);

    state.shapes.push({
      shapeId: s.shapeId,
      fileName: s.fileName,
      mesh,
      vertices: s.vertices,
      indices: s.indices,
      normals: s.normals,
    });
  }

  updateModelList();
  updateInfoPanel();
  syncTransformInputs();
}

// ---------------------------------------------------------------------------
// Keyboard Shortcuts
// ---------------------------------------------------------------------------

function setupKeyboardShortcuts() {
  document.addEventListener("keydown", (e) => {
    // Don't trigger when typing in inputs
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;

    if (e.key === "g" || e.key === "G") {
      setModeButton("translate");
    } else if (e.key === "r" && !e.ctrlKey) {
      setModeButton("rotate");
    } else if (e.key === "s" && !e.ctrlKey) {
      setModeButton("scale");
    } else if (e.key === "Delete" || e.key === "Backspace") {
      handleDeleteSelected();
    } else if (e.key === "z" && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
      e.preventDefault(); handleUndo();
    } else if ((e.key === "y" && (e.ctrlKey || e.metaKey)) || (e.key === "z" && (e.ctrlKey || e.metaKey) && e.shiftKey)) {
      e.preventDefault(); handleRedo();
    } else if (e.key === "Escape") {
      state.viewer?.clearSelection();
    } else if (e.key === "f" || e.key === "F") {
      state.viewer?.fitAll();
    }
  });
}

function setModeButton(mode) {
  document.querySelectorAll(".mode-btn").forEach((b) => b.classList.remove("active"));
  const btn = document.querySelector(`.mode-btn[data-mode="${mode}"]`);
  if (btn) btn.classList.add("active");
  if (state.viewer) state.viewer.setTransformMode(mode);
}

function handleDeleteSelected() {
  if (!state.viewer) return;
  const removed = state.viewer.deleteSelected();
  if (removed.length === 0) return;
  // Also remove from state.shapes
  state.shapes = state.shapes.filter(s => !removed.includes(s.mesh));
  saveState();
  updateModelList();
  updateInfoPanel();
  updateStatus(`Deleted ${removed.length} model(s)`);
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

async function handleImportFiles(files) {
  if (state.isLoading) return;
  state.isLoading = true;
  showLoader(true);

  // Clear existing models before importing new ones
  if (state.shapes.length > 0) {
    state.viewer.clearModels();
    state.shapes.length = 0;
  }

  for (const file of files) {
    try {
      updateStatus(`Importing ${file.name}...`);
      
      if (file.name.toLowerCase().endsWith(".stl")) {
        // Pure Javascript STL parsing bypasses OpenCASCADE
        const buffer = await file.arrayBuffer();
        const loader = new STLLoader();
        const geometry = loader.parse(buffer);
        
        const vertices = geometry.attributes.position.array;
        let indices = geometry.index ? geometry.index.array : null;
        if (!indices) {
          indices = new Uint32Array(vertices.length / 3);
          for (let i = 0; i < indices.length; i++) indices[i] = i;
        }
        const normals = geometry.attributes.normal ? geometry.attributes.normal.array : new Float32Array(vertices.length);
        
        const mesh = state.viewer.loadGeometry(vertices, indices, normals, file.name.replace(/\.[^/.]+$/, ""));
        state.shapes.push({ 
          shapeId: null, 
          fileName: file.name, 
          mesh, 
          vertices, 
          indices, 
          normals 
        });
        updateStatus(`✓ Imported ${file.name} — ${(vertices.length / 3).toLocaleString()} vertices`);
      } else {
        const result = await importFile(file);
        const mesh = state.viewer.loadGeometry(result.vertices, result.indices, result.normals, file.name.replace(/\.[^/.]+$/, ""));
        state.shapes.push({ shapeId: result.shapeId, fileName: result.fileName, mesh, vertices: result.vertices, indices: result.indices, normals: result.normals });
        updateStatus(`✓ Imported ${file.name} — ${(result.vertices.length / 3).toLocaleString()} vertices`);
      }
    } catch (err) {
      console.error(`Failed to import ${file.name}:`, err);
      updateStatus(`✗ Failed to import ${file.name}: ${err.message}`);
    }
  }

  state.viewer.fitAll();
  saveState();
  updateModelList();
  updateInfoPanel();
  showLoader(false);
  state.isLoading = false;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

async function handleExport(format) {
  if (state.shapes.length === 0) { updateStatus("✗ No models to export"); return; }
  showLoader(true);
  updateStatus(`Exporting to ${format.toUpperCase()}...`);
  try {
    const lastShape = state.shapes[state.shapes.length - 1];
    let result;
    
    // Get the current world matrix of the mesh from the viewer
    const mesh = lastShape.mesh;
    mesh.updateMatrixWorld();
    const matrixArray = mesh.matrixWorld.elements; // Array of 16 floats

    if (format === "stl" && !lastShape.shapeId) {
      // For pure mesh export (STL), apply the transformation matrix to a copy of the geometry
      const geom = mesh.geometry.clone();
      geom.applyMatrix4(mesh.matrixWorld);
      
      result = await exportMeshAsSTL({ 
        vertices: geom.attributes.position.array, 
        indices: geom.index ? geom.index.array : null, 
        normals: geom.attributes.normal ? geom.attributes.normal.array : null 
      });
    } else {
      // For STEP/IGES (and STL if it's an OCCT shape), send to OCCT worker
      const meshDataPayload = lastShape.shapeId ? null : {
        vertices: lastShape.vertices,
        indices: lastShape.indices,
        normals: lastShape.normals
      };
      result = await exportShape(lastShape.shapeId, format, Array.from(matrixArray), meshDataPayload);
    }
    
    const ext = format === "iges" ? "iges" : format;
    const blob = new Blob([result.fileContent], { type: "application/octet-stream" });

    // Use native "Save As" dialog if supported by the browser
    if (window.showSaveFilePicker) {
      try {
        const fileHandle = await window.showSaveFilePicker({
          suggestedName: `export.${ext}`,
          types: [{
            description: `${format.toUpperCase()} File`,
            accept: { "application/octet-stream": [`.${ext}`] },
          }],
        });
        const writable = await fileHandle.createWritable();
        await writable.write(blob);
        await writable.close();
        updateStatus(`✓ Exported successfully to ${fileHandle.name}`);
      } catch (err) {
        // User cancelled the save dialog
        if (err.name === 'AbortError') {
          updateStatus("Export cancelled by user.");
          showLoader(false);
          return;
        }
        throw err;
      }
    } else {
      // Fallback for older browsers
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `export.${ext}`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
      updateStatus(`✓ Exported to ${format.toUpperCase()}`);
    }
  } catch (err) {
    console.error(`Export failed:`, err);
    updateStatus(`✗ Export failed: ${err.message}`);
  }
  showLoader(false);
}

// ---------------------------------------------------------------------------
// Other actions
// ---------------------------------------------------------------------------

function handleClear() {
  if (state.shapes.length === 0) return;
  state.viewer.clearModels();
  state.shapes.length = 0;
  saveState();
  updateModelList(); updateInfoPanel();
  updateStatus("All models cleared");
}

function handleToggleWireframe() {
  const isWireframe = state.viewer.toggleWireframe();
  document.getElementById("btn-wireframe").classList.toggle("active", isWireframe);
  updateStatus(isWireframe ? "Wireframe mode ON" : "Wireframe mode OFF");
}

// ---------------------------------------------------------------------------
// UI Helpers
// ---------------------------------------------------------------------------

function updateStatus(text) { const el = document.getElementById("status-text"); if (el) el.textContent = text; }
function showLoader(v) { const el = document.getElementById("status-loader"); if (el) el.classList.toggle("hidden", !v); }

function updateModelList() {
  const list = document.getElementById("model-list");
  if (!list) return;
  if (state.shapes.length === 0) {
    list.innerHTML = '<p class="model-list-empty">No models loaded</p>';
    return;
  }
  list.innerHTML = state.shapes.map((s, i) => `
    <div class="model-item" data-index="${i}">
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
        <polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>
      </svg>
      <span class="model-name">${s.fileName}</span>
      <button class="model-remove" data-index="${i}" title="Remove">×</button>
    </div>
  `).join("");
  list.querySelectorAll(".model-remove").forEach((btn) => {
    btn.addEventListener("click", (e) => { e.stopPropagation(); removeModel(parseInt(btn.dataset.index)); });
  });
  // Click model item to select
  list.querySelectorAll(".model-item").forEach((item) => {
    item.addEventListener("click", () => {
      const idx = parseInt(item.dataset.index);
      const s = state.shapes[idx];
      if (s && s.mesh && state.viewer) state.viewer.selectOnly(s.mesh);
    });
  });
}

function removeModel(index) {
  const s = state.shapes[index];
  if (!s) return;
  if (s.mesh) {
    state.viewer.scene.remove(s.mesh);
    if (s.mesh.geometry) s.mesh.geometry.dispose();
    if (s.mesh.material) s.mesh.material.dispose();
  }
  state.shapes.splice(index, 1);
  saveState();
  updateModelList(); updateInfoPanel();
  updateStatus("Removed model");
}

function updateInfoPanel() {
  let totalVerts = 0, totalTris = 0;
  for (const s of state.shapes) { totalVerts += s.vertices.length / 3; totalTris += s.indices.length / 3; }
  const el = (id) => document.getElementById(id);
  if (el("info-verts")) el("info-verts").textContent = totalVerts.toLocaleString();
  if (el("info-tris")) el("info-tris").textContent = totalTris.toLocaleString();
  if (el("info-models")) el("info-models").textContent = state.shapes.length.toString();
}

// ---------------------------------------------------------------------------
// Phase 4: Geometry Operations
// ---------------------------------------------------------------------------

let _pendingPrimitive = null;

const PRIM_FIELDS = {
  box: [
    { id: "prim-width", label: "Width", value: 10 },
    { id: "prim-depth", label: "Depth", value: 10 },
    { id: "prim-height", label: "Height", value: 10 },
  ],
  cylinder: [
    { id: "prim-radius", label: "Radius", value: 5 },
    { id: "prim-height", label: "Height", value: 10 },
  ],
  sphere: [
    { id: "prim-radius", label: "Radius", value: 5 },
  ],
  cone: [
    { id: "prim-rbottom", label: "Bottom Radius", value: 5 },
    { id: "prim-rtop", label: "Top Radius", value: 0 },
    { id: "prim-height", label: "Height", value: 10 },
  ],
};

function updateGeomOpButtons(selCount) {
  const has2 = selCount >= 2;
  const has1 = selCount >= 1;
  // Find shapes with OCCT shapeIds for the selected meshes
  const selectedMeshes = state.viewer ? state.viewer.getSelected() : [];
  const selectedWithShape = selectedMeshes.filter(m => state.shapes.find(s => s.mesh === m && s.shapeId));
  const has2shapes = selectedWithShape.length >= 2;
  const has1shape = selectedWithShape.length >= 1;

  document.getElementById("btn-bool-union").disabled = !has2shapes;
  document.getElementById("btn-bool-difference").disabled = !has2shapes;
  document.getElementById("btn-bool-intersection").disabled = !has2shapes;
  document.getElementById("btn-extrude").disabled = !has1shape;
  document.getElementById("btn-revolve").disabled = !has1shape;

  // Update hints
  const boolHint = document.getElementById("boolean-hint");
  const modHint = document.getElementById("modify-hint");
  if (has2shapes) {
    boolHint.textContent = `${selectedWithShape.length} shapes selected — ready`;
  } else if (has1shape) {
    boolHint.textContent = "Select 1 more model for boolean ops";
  } else {
    boolHint.textContent = "Select 2 models, then choose an operation";
  }
  modHint.textContent = has1shape ? "Ready to extrude or revolve" : "Select a model to extrude or revolve";
}

function showPrimitiveParams(type) {
  _pendingPrimitive = type;
  const fields = PRIM_FIELDS[type] || [];
  document.getElementById("prim-params-title").textContent = `${type.charAt(0).toUpperCase() + type.slice(1)} Parameters`;
  const container = document.getElementById("prim-params-fields");
  container.innerHTML = fields.map(f => `
    <div class="input-group">
      <label>${f.label}</label>
      <input type="number" id="${f.id}" step="0.5" value="${f.value}" min="0" class="full-input">
    </div>
  `).join("");
  document.getElementById("prim-params").classList.remove("hidden");
}

function hidePrimitiveParams() {
  document.getElementById("prim-params").classList.add("hidden");
  _pendingPrimitive = null;
}

async function handleCreatePrimitive() {
  if (!_pendingPrimitive) return;
  const type = _pendingPrimitive;
  const v = (id) => parseFloat(document.getElementById(id)?.value) || 0;

  let params;
  switch (type) {
    case "box": params = { width: v("prim-width"), depth: v("prim-depth"), height: v("prim-height") }; break;
    case "cylinder": params = { radius: v("prim-radius"), height: v("prim-height") }; break;
    case "sphere": params = { radius: v("prim-radius") }; break;
    case "cone": params = { radiusBottom: v("prim-rbottom"), radiusTop: v("prim-rtop"), height: v("prim-height") }; break;
    default: return;
  }

  hidePrimitiveParams();
  showLoader(true);
  updateStatus(`Creating ${type}...`);

  try {
    const result = await createPrimitive(type, params);
    const name = type.charAt(0).toUpperCase() + type.slice(1);
    const mesh = state.viewer.loadGeometry(result.vertices, result.indices, result.normals, name);
    state.shapes.push({ shapeId: result.shapeId, fileName: name, mesh, vertices: result.vertices, indices: result.indices, normals: result.normals });
    state.viewer.fitAll();
    saveState();
    updateModelList();
    updateInfoPanel();
    updateStatus(`✓ Created ${name}`);
  } catch (err) {
    console.error("Create primitive failed:", err);
    updateStatus(`✗ Failed to create ${type}: ${err.message}`);
  }
  showLoader(false);
}

async function handleBooleanOp(operation) {
  const selectedMeshes = state.viewer.getSelected();
  if (selectedMeshes.length < 2) { updateStatus("✗ Select exactly 2 models for boolean"); return; }

  const shapeA = state.shapes.find(s => s.mesh === selectedMeshes[0]);
  const shapeB = state.shapes.find(s => s.mesh === selectedMeshes[1]);
  if (!shapeA?.shapeId || !shapeB?.shapeId) { updateStatus("✗ Both shapes must have OCCT geometry (not pure STL mesh)"); return; }

  showLoader(true);
  updateStatus(`Boolean ${operation}...`);

  shapeA.mesh.updateMatrixWorld();
  shapeB.mesh.updateMatrixWorld();
  const matrixA = Array.from(shapeA.mesh.matrixWorld.elements);
  const matrixB = Array.from(shapeB.mesh.matrixWorld.elements);

  try {
    const result = await booleanOperation(operation, shapeA.shapeId, shapeB.shapeId, matrixA, matrixB);
    // Remove originals
    state.viewer.clearSelection();
    [shapeA, shapeB].forEach(s => {
      state.viewer.scene.children.forEach(c => { /* search in modelGroup */ });
      if (s.mesh.parent) s.mesh.parent.remove(s.mesh);
      if (s.mesh.geometry) s.mesh.geometry.dispose();
      if (s.mesh.material) s.mesh.material.dispose();
    });
    state.shapes = state.shapes.filter(s => s !== shapeA && s !== shapeB);

    // Add result
    const name = `${operation}(${shapeA.fileName}, ${shapeB.fileName})`;
    const mesh = state.viewer.loadGeometry(result.vertices, result.indices, result.normals, name);
    state.shapes.push({ shapeId: result.shapeId, fileName: name, mesh, vertices: result.vertices, indices: result.indices, normals: result.normals });
    state.viewer.fitAll();
    saveState();
    updateModelList();
    updateInfoPanel();
    updateStatus(`✓ Boolean ${operation} complete — ${(result.vertices.length / 3).toLocaleString()} vertices`);
  } catch (err) {
    console.error(`Boolean ${operation} failed:`, err);
    updateStatus(`✗ Boolean ${operation} failed: ${err.message}`);
  }
  showLoader(false);
}

async function handleExtrude() {
  const selectedMeshes = state.viewer.getSelected();
  if (selectedMeshes.length === 0) { updateStatus("✗ Select a model to extrude"); return; }
  const shape = state.shapes.find(s => s.mesh === selectedMeshes[0]);
  if (!shape?.shapeId) { updateStatus("✗ Shape must have OCCT geometry"); return; }

  const v = (id) => parseFloat(document.getElementById(id)?.value) || 0;
  const direction = { x: v("ext-dir-x"), y: v("ext-dir-y"), z: v("ext-dir-z") };
  const height = v("ext-height") || 10;

  if (direction.x === 0 && direction.y === 0 && direction.z === 0) {
    updateStatus("✗ Direction cannot be zero"); return;
  }

  showLoader(true);
  updateStatus("Extruding...");

  shape.mesh.updateMatrixWorld();
  const matrix = Array.from(shape.mesh.matrixWorld.elements);

  try {
    const result = await extrudeShape(shape.shapeId, direction, height, matrix);
    const name = `extrude(${shape.fileName})`;
    const mesh = state.viewer.loadGeometry(result.vertices, result.indices, result.normals, name);
    state.shapes.push({ shapeId: result.shapeId, fileName: name, mesh, vertices: result.vertices, indices: result.indices, normals: result.normals });
    state.viewer.fitAll();
    saveState();
    updateModelList();
    updateInfoPanel();
    updateStatus(`✓ Extruded — ${(result.vertices.length / 3).toLocaleString()} vertices`);
    document.getElementById("extrude-params").classList.add("hidden");
  } catch (err) {
    console.error("Extrude failed:", err);
    updateStatus(`✗ Extrude failed: ${err.message}`);
  }
  showLoader(false);
}

async function handleRevolve() {
  const selectedMeshes = state.viewer.getSelected();
  if (selectedMeshes.length === 0) { updateStatus("✗ Select a model to revolve"); return; }
  const shape = state.shapes.find(s => s.mesh === selectedMeshes[0]);
  if (!shape?.shapeId) { updateStatus("✗ Shape must have OCCT geometry"); return; }

  const v = (id) => parseFloat(document.getElementById(id)?.value) || 0;
  const axisOrigin = { x: v("rev-ox"), y: v("rev-oy"), z: v("rev-oz") };
  const axisDirection = { x: v("rev-dx"), y: v("rev-dy"), z: v("rev-dz") };
  const angle = v("rev-angle") || 360;

  if (axisDirection.x === 0 && axisDirection.y === 0 && axisDirection.z === 0) {
    updateStatus("✗ Axis direction cannot be zero"); return;
  }

  showLoader(true);
  updateStatus("Revolving...");

  shape.mesh.updateMatrixWorld();
  const matrix = Array.from(shape.mesh.matrixWorld.elements);

  try {
    const result = await revolveShape(shape.shapeId, axisOrigin, axisDirection, angle, matrix);
    const name = `revolve(${shape.fileName})`;
    const mesh = state.viewer.loadGeometry(result.vertices, result.indices, result.normals, name);
    state.shapes.push({ shapeId: result.shapeId, fileName: name, mesh, vertices: result.vertices, indices: result.indices, normals: result.normals });
    state.viewer.fitAll();
    saveState();
    updateModelList();
    updateInfoPanel();
    updateStatus(`✓ Revolved — ${(result.vertices.length / 3).toLocaleString()} vertices`);
    document.getElementById("revolve-params").classList.add("hidden");
  } catch (err) {
    console.error("Revolve failed:", err);
    updateStatus(`✗ Revolve failed: ${err.message}`);
  }
  showLoader(false);
}