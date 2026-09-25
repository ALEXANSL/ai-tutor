import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const alias = {
  "@": fileURLToPath(new URL("./src", import.meta.url)),
  "@config": fileURLToPath(new URL("./config", import.meta.url)),
  // `server-only` throws outside the Next.js server bundle; tests run in Node.
  "server-only": fileURLToPath(new URL("./tests/stubs/server-only.ts", import.meta.url)),
};

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: "unit",
          environment: "node",
          include: ["src/**/*.test.ts", "src/**/*.test.tsx", "config/**/*.test.ts"],
        },
      },
      {
        resolve: { alias },
        test: {
          name: "db",
          environment: "node",
          include: ["tests/db/**/*.test.ts"],
          // One shared ephemeral database: run files sequentially.
          fileParallelism: false,
          testTimeout: 20000,
        },
      },
    ],
  },
});
