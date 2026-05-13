import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react-swc";
import path from "path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    // Server tests live under src/server and have their own vitest config
    // (vitest.server.config.ts) because they require node env + a database.
    // Excluding them keeps `npm test` focused on the frontend suite.
    exclude: ["node_modules/**", "dist/**", "src/server/**"],
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});
