import path from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: path.resolve(import.meta.dirname, "admin-v2.5"),
  base: "/admin-v2.5/",
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5175,
    proxy: {
      "/api": "http://127.0.0.1:3000",
      "/css": "http://127.0.0.1:3000",
      "/font": "http://127.0.0.1:3000",
      "/img": "http://127.0.0.1:3000",
    },
  },
  build: {
    outDir: path.resolve(import.meta.dirname, "public/admin-v2.5"),
    emptyOutDir: true,
  },
});
