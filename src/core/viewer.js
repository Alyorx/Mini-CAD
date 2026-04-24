import * as THREE from "three";

export function initViewer(container) {
  const scene = new THREE.Scene();

  const camera = new THREE.PerspectiveCamera(75, window.innerWidth/window.innerHeight, 0.1, 1000);
  camera.position.z = 3;

  const renderer = new THREE.WebGLRenderer();
  renderer.setSize(window.innerWidth, window.innerHeight);
  container.appendChild(renderer.domElement);

  let mesh;

  function loadGeometry(vertices, indices) {
    if (mesh) {
      scene.remove(mesh);
      mesh.geometry.dispose();
      mesh.material.dispose();
    }

    const geometry = new THREE.BufferGeometry();

    const posArray = new Float32Array(vertices);
    geometry.setAttribute("position", new THREE.BufferAttribute(posArray, 3));

    if (indices && indices.length) {
      geometry.setIndex(indices);
    }

    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();

    const material = new THREE.MeshBasicMaterial({
      wireframe: true,
      color: 0xffffff
    });

    mesh = new THREE.Mesh(geometry, material);
    scene.add(mesh);
  }

  function animate() {
    requestAnimationFrame(animate);
    renderer.render(scene, camera);
  }
  animate();

  return { loadGeometry };
}