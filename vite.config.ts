import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

export default defineConfig({
  plugins: [solid()],
  root: "apps/web",
  build: { outDir: "../../dist/web", emptyOutDir: true },
  server: { strictPort: true, proxy: { "/api": "http://127.0.0.1:4318" } },
});
