import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      // `edgestats serve` hosts the API; vite dev proxies to it.
      "/api": "http://127.0.0.1:3343",
    },
  },
});
