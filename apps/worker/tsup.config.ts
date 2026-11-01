import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  clean: true,
  noExternal: [/.*/],
  external: ["pg-native"],
  banner: { js: "import { createRequire as __nocon_createRequire } from 'module'; const require = __nocon_createRequire(import.meta.url);" },
});
