import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    environment: "node",
    include: ["tools/course-quality-lab/**/*.{test,spec}.ts"],
  },
});

