import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["tests/gantt.test.ts", "tests/gantt-tools.test.ts"],
  outDir: ".test-build",
  fixedExtension: true,
});
