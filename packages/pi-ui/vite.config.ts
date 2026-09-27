import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

const uiSource = fileURLToPath(new URL("../ui/src/", import.meta.url));
const webPublic = fileURLToPath(new URL("../web/public/", import.meta.url));
export default defineConfig({
  // The host serves this bundle beneath a per-session capability path. Relative URLs keep
  // both Vite chunks and public assets inside that scope instead of resolving from `/`.
  base: "./",
  // Reuse the existing material-icon set so file extensions beyond this repro resolve too.
  publicDir: webPublic,
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": uiSource } },
  build: { outDir: "dist/client", emptyOutDir: true },
});
