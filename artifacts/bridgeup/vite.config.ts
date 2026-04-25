import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

export default defineConfig({
  base: "/",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
    dedupe: ["react", "react-dom"],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: {
          vendor:  ["react", "react-dom"],
          routing: ["wouter"],
          query:   ["@tanstack/react-query"],
        },
      },
    },
  },
  server: {
    port: 5173,
    host: "0.0.0.0",
    proxy: {
      "/api": { target: "http://localhost:3000", changeOrigin: true },
      "/voice": { target: "http://localhost:3000", changeOrigin: true },
      "/sms":   { target: "http://localhost:3000", changeOrigin: true },
    },
  },
});
