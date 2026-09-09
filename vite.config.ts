import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Served from https://eazyhood.github.io/cookie-payouts/, so assets need that
// prefix. Building without it produces a page that loads a blank screen on
// Pages while working perfectly on localhost.
export default defineConfig({
  base: "/cookie-payouts/",
  plugins: [react()],
});
