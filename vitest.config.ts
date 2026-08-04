import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    environment: "node",
    // Redirects the shared base root away from the developer's real `~/.jaira` — see test/setup.ts.
    setupFiles: ["./test/setup.ts"],
  },
});
