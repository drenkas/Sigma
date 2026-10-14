import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import pkg from "./package.json" with { type: "json" };

export default defineConfig({
  plugins: [solid()],
  define: { __PI_SDK_VERSION__: JSON.stringify(pkg.dependencies["@earendil-works/pi-coding-agent"]) },
  root: "apps/web",
  build: { outDir: "../../dist/web", emptyOutDir: true },
  server: { strictPort: true, proxy: { "/api": "http://127.0.0.1:4318" } },
});
