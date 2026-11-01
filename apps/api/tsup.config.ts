import { cpSync } from "node:fs";
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node22",
  platform: "node",
  clean: true,
  splitting: false,
  sourcemap: false,
  noExternal: [/.*/],
  external: ["pg-native"],
  banner: { js: "import { createRequire as __nocon_createRequire } from 'module'; const require = __nocon_createRequire(import.meta.url);" },
  async onSuccess() {
    // runMigrations looks for ./drizzle next to the bundle
    cpSync("../../packages/database/drizzle", "dist/drizzle", { recursive: true });
  },
});
