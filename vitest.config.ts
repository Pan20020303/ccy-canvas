import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Keep the root test command scoped to this checkout. Developer worktrees
    // contain independent dependency graphs and must run their own suites.
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    exclude: [".worktrees/**", "node_modules/**", "dist/**"],
  },
});
