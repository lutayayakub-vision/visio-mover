import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

export default defineConfig(({ mode }) => ({
  plugins: [react(), ...(mode === "preview" ? [viteSingleFile()] : [])],
  define: { __PREVIEW__: JSON.stringify(mode === "preview") },
  build: mode === "preview" ? { outDir: "dist-preview" } : undefined,
  server: { port: 5173 },
}));
