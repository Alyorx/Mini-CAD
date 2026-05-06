/**
 * Three.js Viewer — Manages the 3D viewport with orbit controls,
 * lighting, grid, and loaded geometry display.
 *
 * Phase 3: Adds selection (click, multi-select), transform controls
 * (move, rotate, scale gizmos), and highlighting.
 */

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";

export function initViewer(container) {
  // ---- Scene ----
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1a2e);

  // ---- Camera ----
  const camera = new THREE.PerspectiveCamera(
    60,
    container.clientWidth / container.clientHeight,
    0.01,
    10000
  );
  camera.position.set(50, 50, 80);
  camera.lookAt(0, 0, 0);

  // ---- Renderer ----
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.2;
  container.appendChild(renderer.domElement);

  // ---- Orbit Controls ----
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enablePan = true;
  controls.panSpeed = 0.8;
  controls.rotateSpeed = 0.6;
  controls.zoomSpeed = 1.2;
  controls.minDistance = 0.1;
  controls.maxDistance = 5000;

  // ---- Lighting ----
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
  scene.add(ambientLight);

  const dirLight1 = new THREE.DirectionalLight(0xffffff, 1.0);
  dirLight1.position.set(100, 200, 150);
  dirLight1.castShadow = true;
  dirLight1.shadow.mapSize.width = 2048;
  dirLight1.shadow.mapSize.height = 2048;
  scene.add(dirLight1);

  const dirLight2 = new THREE.DirectionalLight(0x8888ff, 0.3);
  dirLight2.position.set(-100, -50, -100);
  scene.add(dirLight2);

  const hemiLight = new THREE.HemisphereLight(0xddeeff, 0x0f0e0d, 0.3);
  scene.add(hemiLight);

  // ---- Grid ----
  // Minor grid (1 unit per square)
  const minorGrid = new THREE.GridHelper(200, 200, 0x333355, 0x222233);
  minorGrid.position.y = -0.01;
  scene.add(minorGrid);

  // Major grid (10 units per square)
  const majorGrid = new THREE.GridHelper(200, 20, 0x444466, 0x333355);
  majorGrid.position.y = -0.005;
  scene.add(majorGrid);

  // ---- Axes ----
  const axesHelper = new THREE.AxesHelper(30);
  scene.add(axesHelper);

  // ---- Model group ----
  const modelGroup = new THREE.Group();
  modelGroup.name = "Models";
  scene.add(modelGroup);

  // Track loaded meshes
  const loadedMeshes = [];

  // ---- Materials ----
  const defaultMaterial = new THREE.MeshStandardMaterial({
    color: 0x6699cc,
    metalness: 0.3,
    roughness: 0.5,
    side: THREE.DoubleSide,
  });

  const wireframeMaterial = new THREE.MeshBasicMaterial({
    color: 0x88ccff,
    wireframe: true,
  });

  let showWireframe = false;

  // ===========================================================================
  // SELECTION SYSTEM (Phase 3)
  // ===========================================================================

  const raycaster = new THREE.Raycaster();
  const pointerStart = new THREE.Vector2();
  const pointerEnd = new THREE.Vector2();
  let selectedMeshes = [];
  let outlineHelpers = new Map(); // mesh -> outline wireframe
  let _onSelectionChange = null;
  let _onTransformChange = null;
  let _onDragStart = null;
  let _onDragEnd = null;
  let isPointerDown = false;
  const CLICK_THRESHOLD = 4; // pixels — ignore drag as click

  // Selection highlight colors
  const HIGHLIGHT_COLOR = new THREE.Color(0x3a7eff);
  const HIGHLIGHT_EMISSIVE = new THREE.Color(0x1a3a6a);

  // ---- Transform Controls ----
  const transformControls = new TransformControls(camera, renderer.domElement);
  transformControls.setSize(1.2); // Increased size to make the center cube easier to grab
  scene.add(transformControls.getHelper());

  // Disable orbit while dragging gizmo
  transformControls.addEventListener("dragging-changed", (event) => {
    controls.enabled = !event.value;
    if (event.value && _onDragStart) {
      _onDragStart();
    } else if (!event.value && _onDragEnd) {
      _onDragEnd();
    }
  });

  // Emit transform changes for UI sync
  transformControls.addEventListener("objectChange", () => {
    if (_onTransformChange && selectedMeshes.length > 0) {
      _onTransformChange(selectedMeshes);
    }
  });

  // ---- Pointer events for selection ----

  renderer.domElement.addEventListener("pointerdown", (e) => {
    // Ignore if clicking on the gizmo
    if (transformControls.dragging || transformControls.axis !== null) return;
    isPointerDown = true;
    pointerStart.set(e.clientX, e.clientY);
  });

  renderer.domElement.addEventListener("pointerup", (e) => {
    if (!isPointerDown) return;
    isPointerDown = false;
    pointerEnd.set(e.clientX, e.clientY);

    // Only treat as click if pointer didn't move much (not a drag/orbit)
    const dx = pointerEnd.x - pointerStart.x;
    const dy = pointerEnd.y - pointerStart.y;
    if (Math.sqrt(dx * dx + dy * dy) > CLICK_THRESHOLD) return;

    handleClick(e);
  });

  function handleClick(event) {
    const rect = renderer.domElement.getBoundingClientRect();
    const mouse = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1
    );

    raycaster.setFromCamera(mouse, camera);
    const intersects = raycaster.intersectObjects(modelGroup.children, true);

    if (intersects.length > 0) {
      // Find the top-level mesh in modelGroup
      let target = intersects[0].object;
      while (target.parent && target.parent !== modelGroup) {
        target = target.parent;
      }

      if (event.ctrlKey || event.metaKey) {
        toggleSelection(target);
      } else {
        selectOnly(target);
      }
    } else if (!event.ctrlKey && !event.metaKey) {
      clearSelection();
    }
  }

  function selectOnly(mesh) {
    clearSelection();
    addToSelection(mesh);
  }

  function toggleSelection(mesh) {
    if (selectedMeshes.includes(mesh)) {
      removeFromSelection(mesh);
    } else {
      addToSelection(mesh);
    }
  }

  function addToSelection(mesh) {
    if (!selectedMeshes.includes(mesh)) {
      selectedMeshes.push(mesh);
      setHighlight(mesh, true);

      // Attach gizmo to the last selected
      transformControls.attach(mesh);

      if (_onSelectionChange) _onSelectionChange([...selectedMeshes]);
    }
  }

  function removeFromSelection(mesh) {
    const idx = selectedMeshes.indexOf(mesh);
    if (idx >= 0) {
      selectedMeshes.splice(idx, 1);
      setHighlight(mesh, false);

      if (selectedMeshes.length > 0) {
        transformControls.attach(selectedMeshes[selectedMeshes.length - 1]);
      } else {
        transformControls.detach();
      }

      if (_onSelectionChange) _onSelectionChange([...selectedMeshes]);
    }
  }

  function clearSelection() {
    for (const m of selectedMeshes) {
      setHighlight(m, false);
    }
    selectedMeshes = [];
    transformControls.detach();
    if (_onSelectionChange) _onSelectionChange([]);
  }

  function setHighlight(mesh, selected) {
    if (!(mesh instanceof THREE.Mesh)) return;

    if (selected) {
      // Store original material properties
      if (!mesh.userData._origEmissive) {
        mesh.userData._origEmissive = mesh.material.emissive
          ? mesh.material.emissive.clone()
          : new THREE.Color(0x000000);
        mesh.userData._origEmissiveIntensity = mesh.material.emissiveIntensity || 0;
      }
      mesh.material.emissive = HIGHLIGHT_EMISSIVE;
      mesh.material.emissiveIntensity = 0.6;

      // Add outline wireframe
      if (!outlineHelpers.has(mesh)) {
        const edges = new THREE.EdgesGeometry(mesh.geometry, 30);
        const line = new THREE.LineSegments(
          edges,
          new THREE.LineBasicMaterial({ color: HIGHLIGHT_COLOR, linewidth: 1, transparent: true, opacity: 0.6 })
        );
        mesh.add(line);
        outlineHelpers.set(mesh, line);
      }
    } else {
      // Restore original material
      if (mesh.userData._origEmissive) {
        mesh.material.emissive = mesh.userData._origEmissive;
        mesh.material.emissiveIntensity = mesh.userData._origEmissiveIntensity;
        delete mesh.userData._origEmissive;
        delete mesh.userData._origEmissiveIntensity;
      }

      // Remove outline
      const line = outlineHelpers.get(mesh);
      if (line) {
        mesh.remove(line);
        line.geometry.dispose();
        line.material.dispose();
        outlineHelpers.delete(mesh);
      }
    }
  }

  // ===========================================================================
  // TRANSFORM OPERATIONS (Phase 3)
  // ===========================================================================

  /**
   * Set the transform mode: 'translate', 'rotate', or 'scale'.
   */
  function setTransformMode(mode) {
    if (["translate", "rotate", "scale"].includes(mode)) {
      transformControls.setMode(mode);
    }
  }

  /**
   * Get current transform mode.
   */
  function getTransformMode() {
    return transformControls.mode;
  }

  /**
   * Apply a precise transform to the selected mesh(es).
   */
  function applyTransform(type, values) {
    for (const mesh of selectedMeshes) {
      switch (type) {
        case "position":
          mesh.position.set(values.x, values.y, values.z);
          break;
        case "rotation":
          // Values in degrees → convert to radians
          mesh.rotation.set(
            THREE.MathUtils.degToRad(values.x),
            THREE.MathUtils.degToRad(values.y),
            THREE.MathUtils.degToRad(values.z)
          );
          break;
        case "scale":
          mesh.scale.set(values.x, values.y, values.z);
          break;
      }
    }
    if (_onTransformChange && selectedMeshes.length > 0) {
      _onTransformChange(selectedMeshes);
    }
  }

  /**
   * Reset transform of selected meshes to identity.
   */
  function resetTransform() {
    for (const mesh of selectedMeshes) {
      mesh.position.set(0, 0, 0);
      mesh.rotation.set(0, 0, 0);
      mesh.scale.set(1, 1, 1);
    }
    if (_onTransformChange && selectedMeshes.length > 0) {
      _onTransformChange(selectedMeshes);
    }
  }

  /**
   * Get the transform of the first selected mesh.
   */
  function getSelectedTransform() {
    if (selectedMeshes.length === 0) return null;
    const m = selectedMeshes[0];
    return {
      position: { x: m.position.x, y: m.position.y, z: m.position.z },
      rotation: {
        x: THREE.MathUtils.radToDeg(m.rotation.x),
        y: THREE.MathUtils.radToDeg(m.rotation.y),
        z: THREE.MathUtils.radToDeg(m.rotation.z),
      },
      scale: { x: m.scale.x, y: m.scale.y, z: m.scale.z },
    };
  }

  /**
   * Delete selected meshes from the scene.
   */
  function deleteSelected() {
    const removed = [];
    for (const mesh of selectedMeshes) {
      setHighlight(mesh, false);
      modelGroup.remove(mesh);
      if (mesh.geometry) mesh.geometry.dispose();
      if (mesh.material) {
        if (Array.isArray(mesh.material)) {
          mesh.material.forEach((m) => m.dispose());
        } else {
          mesh.material.dispose();
        }
      }
      const idx = loadedMeshes.indexOf(mesh);
      if (idx >= 0) loadedMeshes.splice(idx, 1);
      removed.push(mesh);
    }
    selectedMeshes = [];
    transformControls.detach();
    if (_onSelectionChange) _onSelectionChange([]);
    return removed;
  }

  // ===========================================================================
  // EXISTING FUNCTIONALITY
  // ===========================================================================

  // ---- Render loop ----
  function animate() {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  }
  animate();

  // ---- Resize handler ----
  const resizeObserver = new ResizeObserver(() => {
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (w === 0 || h === 0) return;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  });
  resizeObserver.observe(container);

  /**
   * Load tessellated geometry into the viewport.
   */
  function loadGeometry(vertices, indices, normals, name = "Model") {
    const geometry = new THREE.BufferGeometry();

    const posArray = vertices instanceof Float32Array
      ? vertices
      : new Float32Array(vertices);
    geometry.setAttribute("position", new THREE.BufferAttribute(posArray, 3));

    if (indices && indices.length) {
      const idxArray = indices instanceof Uint32Array
        ? Array.from(indices)
        : indices;
      geometry.setIndex(idxArray);
    }

    if (normals && normals.length) {
      const normArray = normals instanceof Float32Array
        ? normals
        : new Float32Array(normals);
      geometry.setAttribute("normal", new THREE.BufferAttribute(normArray, 3));
    } else {
      geometry.computeVertexNormals();
    }

    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();

    const mat = showWireframe ? wireframeMaterial.clone() : defaultMaterial.clone();
    const mesh = new THREE.Mesh(geometry, mat);
    
    mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    modelGroup.add(mesh);
    loadedMeshes.push(mesh);

    return mesh;
  }

  /**
   * Fit the camera to show all loaded geometry.
   */
  function fitAll() {
    const box = new THREE.Box3().setFromObject(modelGroup);
    if (box.isEmpty()) return;

    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);

    if (maxDim === 0) return;

    const fov = camera.fov * (Math.PI / 180);
    const dist = (maxDim / 2) / Math.tan(fov / 2) * 1.5;

    camera.position.set(
      center.x + dist * 0.5,
      center.y + dist * 0.5,
      center.z + dist
    );
    camera.lookAt(center);
    controls.target.copy(center);
    controls.update();
  }

  /**
   * Clear all loaded models.
   */
  function clearModels() {
    clearSelection();
    while (modelGroup.children.length > 0) {
      const child = modelGroup.children[0];
      modelGroup.remove(child);
      if (child.geometry) child.geometry.dispose();
      if (child.material) {
        if (Array.isArray(child.material)) {
          child.material.forEach((m) => m.dispose());
        } else {
          child.material.dispose();
        }
      }
    }
    loadedMeshes.length = 0;
  }

  /**
   * Toggle wireframe rendering.
   */
  function toggleWireframe() {
    showWireframe = !showWireframe;
    loadedMeshes.forEach((mesh) => {
      if (mesh.material) {
        mesh.material.wireframe = showWireframe;
      }
    });
    return showWireframe;
  }

  /**
   * Get all currently loaded meshes.
   */
  function getMeshes() {
    return [...loadedMeshes];
  }

  // ---- Public API ----
  return {
    scene,
    camera,
    renderer,
    controls,

    // Geometry
    loadGeometry,
    fitAll,
    clearModels,
    toggleWireframe,
    getMeshes,

    // Selection (Phase 3)
    selectOnly,
    clearSelection,
    getSelected: () => [...selectedMeshes],
    deleteSelected,
    onSelectionChange: (cb) => { _onSelectionChange = cb; },
    onTransformChange: (cb) => { _onTransformChange = cb; },
    onDragStart: (cb) => { _onDragStart = cb; },
    onDragEnd: (cb) => { _onDragEnd = cb; },

    // Transforms (Phase 3)
    setTransformMode,
    getTransformMode,
    applyTransform,
    resetTransform,
    getSelectedTransform,
  };
}