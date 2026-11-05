import { defineConfig } from "vite"
import solid from "vite-plugin-solid"

export default defineConfig({
  plugins: [solid()],
  clearScreen: false,
  server: { host: "localhost", port: 1420, strictPort: true },
  build: { outDir: "dist", target: "es2022" },
})
