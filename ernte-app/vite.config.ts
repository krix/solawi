import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import pkg from "./package.json" with { type: "json" };

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  // Make the app version from package.json available at build/runtime
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,

  // Split large vendor libraries into separate chunks to reduce the main bundle
  // size and improve caching (recharts and its d3 deps are the biggest offenders).
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules")) {
            if (id.includes("recharts") || id.includes("/d3-") || id.includes("victory-vendor")) {
              return "charts";
            }
            if (id.includes("react-dom") || id.includes("/react/") || id.includes("scheduler")) {
              return "react-vendor";
            }
          }
        },
      },
    },
  },

  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri` and history files
      ignored: ["**/src-tauri/**", "**/src/historie.json", "**/HISTORIE.MD"],
    },
  },
}));
