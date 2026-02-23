export const products = [
  {
    id: "aether-lab",
    name: "Aether Lab",
    category: "Spatial Design",
    tagline: "Realtime concepting for immersive spaces",
    description:
      "Aether Lab helps teams prototype environments with live collaboration, balancing artistic freedom with technical precision.",
    impact: "Reduced iteration cycles by 42% across pilot teams."
  },
  {
    id: "nova-grid",
    name: "Nova Grid",
    category: "Creative AI",
    tagline: "Generative workflows for engineers and artists",
    description:
      "Nova Grid unifies prompts, assets, and engineering constraints so ideas move from sketch to execution without friction.",
    impact: "Enabled rapid launch of cross-disciplinary campaigns."
  },
  {
    id: "forge-one",
    name: "Forge One",
    category: "Product Systems",
    tagline: "Unified system for design-to-build operations",
    description:
      "Forge One streamlines the handoff from concept to production with modular workflows and measurable delivery checkpoints.",
    impact: "Improved release confidence through shared visibility."
  }
];

export function getProductById(id) {
  return products.find((product) => product.id === id);
}
