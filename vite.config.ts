import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const rootDir = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: `${rootDir}ui`,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": `${rootDir}ui/src`,
    },
  },
  server: {
    port: 5174,
    proxy: {
      "/api": "http://127.0.0.1:3131",
    },
  },
  build: {
    outDir: `${rootDir}ui-dist`,
    emptyOutDir: true,
  },
});
