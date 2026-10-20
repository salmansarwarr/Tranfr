import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    // The SDK lives outside this package; without dedupe its "@ckb-ccc/core"
    // import would resolve to the repo root's copy, giving two sets of classes.
    dedupe: ["@ckb-ccc/core"],
  },
  server: {
    fs: { allow: [repoRoot] },
  },
});
