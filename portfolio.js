import * as THREE from "three";
import { products } from "/data/products.js";

const grid = document.querySelector("#portfolio-grid");
const yearNode = document.querySelector("#year");
const canvas = document.querySelector("#bg-canvas");

if (yearNode) {
  yearNode.textContent = String(new Date().getFullYear());
}

if (grid) {
  grid.innerHTML = products
    .map(
      (product) => `
      <a class="card" href="/product.html?id=${product.id}">
        <span class="tag">${product.category}</span>
        <h3>${product.name}</h3>
        <p>${product.description}</p>
      </a>
    `
    )
    .join("");
}

if (canvas) {
  const scene = new THREE.Scene();
  // Portfolio scene fog tuned for light, minimal depth.
  scene.fog = new THREE.Fog(0xf4f6fb, 8, 18);
  // Camera framing for centered torus-knot composition.
  const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 100);
  camera.position.z = 5;

  // Transparent renderer lets CSS background remain visible.
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);

  // Lighting settings for a clean metallic look.
  const light = new THREE.PointLight(0x5f77ff, 1, 20);
  light.position.set(1.5, 2.2, 5);
  scene.add(light);

  scene.add(new THREE.AmbientLight(0xffffff, 1));

  const knot = new THREE.Mesh(
    new THREE.TorusKnotGeometry(1.1, 0.28, 120, 16),
    // Material settings balanced for soft highlights.
    new THREE.MeshStandardMaterial({ color: 0x6f82ff, roughness: 0.45, metalness: 0.35 })
  );
  scene.add(knot);

  function animate() {
    // Rotation speed settings kept intentionally subtle.
    knot.rotation.x += 0.0011;
    knot.rotation.y += 0.0013;
    renderer.render(scene, camera);
    requestAnimationFrame(animate);
  }

  function onResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  }

  window.addEventListener("resize", onResize);
  animate();
}
