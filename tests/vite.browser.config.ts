import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vite";
import appConfig from "../vite.config.ts";

export default mergeConfig(appConfig, defineConfig({
  base: "/",
  build: {
    outDir: ".browser-check",
    rollupOptions: { input: fileURLToPath(new URL("./browser-smoke.html", import.meta.url)) },
  },
}));
