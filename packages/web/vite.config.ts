import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    rolldownOptions: {
      output: {
        // Vela is only ever reached through a dynamic import (the session
        // view), so it lands in its own lazy chunk; name it so the build
        // output shows the dashboard bundle did not absorb it.
        advancedChunks: {
          groups: [{ name: "vela", test: /node_modules[\\/]@luxalgo[\\/]vela[\\/]/ }],
        },
      },
    },
  },
  server: {
    proxy: {
      // `edgestats serve` hosts the API; vite dev proxies to it.
      "/api": "http://127.0.0.1:3343",
    },
  },
});
