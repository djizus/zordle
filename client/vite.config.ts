import { defineConfig } from "vite";

export default defineConfig({
  envDir: ".",
  envPrefix: "VITE_PUBLIC_",
  server: {
    port: 5173,
    host: true,
  },
});
