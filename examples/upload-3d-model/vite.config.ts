import { reactRouter } from "@react-router/dev/vite";
import type { PluginOption } from "vite";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    sourcemap: false,
    rolldownOptions: {
      onwarn(warning, defaultHandler) {
        if (warning.code === "SOURCEMAP_ERROR") {
          return;
        }

        defaultHandler(warning);
      }
    }
  },
  define: {
    global: "globalThis"
  },
  optimizeDeps: {
    extensions: [".css", ".scss", ".sass"] // explicitly include CSS extensions if needed
  },
  ssr: {
    noExternal: ["react-dropzone", "react-icons", "tailwind-merge"]
  },
  server: {
    port: 5000
  },
  resolve: {
    tsconfigPaths: true
  },
  plugins: [reactRouter()] as PluginOption[]
});
