import { fileURLToPath } from "node:url";
import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Loads .env, .env.local, .env.test, .env.test.local from this project only.
    env: loadEnv("test", process.cwd(), ""),
    // Sandbox round-trips are slow; keep scenarios sequential and independent.
    testTimeout: 60_000,
    fileParallelism: false,
  },
});
