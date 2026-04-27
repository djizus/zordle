import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import mkcert from "vite-plugin-mkcert";

export default defineConfig({
  plugins: [react(), mkcert()],
  envDir: ".",
  envPrefix: "VITE_PUBLIC_",
  server: {
    port: 5173,
    host: true,
  },
});
