import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "edge-runtime",
    setupFiles: ["./tests/setup.ts"],
    // convex-test relies on `import.meta.glob` to lazily load Convex function
    // modules; it must run through Vite's own transform pipeline rather than
    // being pre-bundled/externalized as a plain Node dependency.
    server: {
      deps: {
        inline: ["convex-test"],
      },
    },
  },
});
