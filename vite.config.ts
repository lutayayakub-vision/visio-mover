import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

export default defineConfig(({ mode }) => ({
  plugins: [react(), ...(mode === "preview" ? [viteSingleFile()] : [])],
  define: { __PREVIEW__: JSON.stringify(mode === "preview") },
  build: mode === "preview" ? { outDir: "dist-preview" } : undefined,
  // ffmpeg.wasm starts its own worker with new URL(...); pre-bundling would break that
  optimizeDeps: { exclude: ["@ffmpeg/ffmpeg", "@ffmpeg/util"] },
  worker: { format: "es" },
  server: { port: 5173 },
}));
