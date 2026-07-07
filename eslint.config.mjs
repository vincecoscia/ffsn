import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

const eslintConfig = [
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    rules: {
      "@next/next/no-img-element": "off",
      // The convex/ backend uses `any` for loosely-typed ESPN API blobs. This
      // was never linted before (the old `next lint` only covered src/); keep
      // it as a warning rather than blocking every lint run on ~160 pre-existing
      // hits. Worth burning down over time.
      "@typescript-eslint/no-explicit-any": "warn",
      // react-hooks v6 (new with Next 16) errors on patterns used throughout the
      // existing codebase (setState-in-effect syncs, imperative navigation).
      // Downgrade to warnings so lint is runnable; migrate incrementally.
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/immutability": "warn",
      "react-hooks/purity": "warn",
      "react-hooks/static-components": "warn",
    },
  },
];

export default eslintConfig;
