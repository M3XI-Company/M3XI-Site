import * as THREE from "three";
import { getProductById } from "/data/products.js";

const params = new URLSearchParams(window.location.search);
const productId = params.get("id");
const product = getProductById(productId);

const nameNode = document.querySelector("#product-name");
const taglineNode = document.querySelector("#product-tagline");
const descriptionNode = document.querySelector("#product-description");
const impactNode = document.querySelector("#product-impact");
const yearNode = document.querySelector("#year");
const canvas = document.querySelector("#bg-canvas");

if (yearNode) {
  yearNode.textContent = String(new Date().getFullYear());
}

if (product && nameNode && taglineNode && descriptionNode && impactNode) {
  nameNode.textContent = product.name;
  taglineNode.textContent = product.tagline;
  descriptionNode.textContent = product.description;
  impactNode.textContent = product.impact;
} else if (nameNode && taglineNode && descriptionNode && impactNode) {
  nameNode.textContent = "Product not found";
  taglineNode.textContent = "The requested product could not be loaded.";
  descriptionNode.textContent = "Please return to the portfolio and choose a valid product.";
  impactNode.textContent = "No metrics available.";
}

if (canvas) {
  const scene = new THREE.Scene();
  // Product page fog keeps background depth understated.
  scene.fog = new THREE.Fog(0xf4f6fb, 7, 16);
  // Camera settings for close-up geometric centerpiece.
  const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.1, 100);
  camera.position.z = 4.4;

  // Renderer settings maintain a transparent scene layer.
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);

  // Light settings for crisp but gentle form readability.
  scene.add(new THREE.AmbientLight(0xffffff, 1.05));

  const light = new THREE.DirectionalLight(0x6177ff, 1.1);
  light.position.set(2, 1, 3);
  scene.add(light);

  const mesh = new THREE.Mesh(
    new THREE.OctahedronGeometry(1.2, 0),
    // Material settings tuned for matte-metal balance.
    new THREE.MeshStandardMaterial({
      color: 0x6e82ff,
      metalness: 0.28,
      roughness: 0.45
    })
  );
  scene.add(mesh);

  function animate() {
    // Animation speed settings prioritize calm motion.
    mesh.rotation.x += 0.0011;
    mesh.rotation.y += 0.0016;
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
