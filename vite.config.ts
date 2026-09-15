import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";

// Login is impossible without the Supabase browser config, and the app has
// no runtime fallback in production (the legacy VITE_DEV_JWT path is dev-only).
// A production build without it is a deploy artifact that cannot sign anyone
// in, so the build fails here instead. CI compile checks that are never
// deployed opt out explicitly with GATEPASS_ALLOW_UNCONFIGURED_BUILD=1.
// Source: Vite — loadEnv https://vitejs.dev/guide/api-javascript#loadenv
function assertProductionBrowserConfig(mode: string): void {
  if (mode !== "production") return;
  if (process.env.GATEPASS_ALLOW_UNCONFIGURED_BUILD === "1") return;

  const env = { ...loadEnv(mode, process.cwd(), "VITE_"), ...process.env };
  const missing = ["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY"].filter(
    (name) => !env[name] || /<[^>]+>/.test(env[name] as string),
  );
  if (missing.length > 0) {
    throw new Error(
      `[FATAL] Production build refused: ${missing.join(", ")} not set. ` +
        "The built app could not sign anyone in. Set them, or set " +
        "GATEPASS_ALLOW_UNCONFIGURED_BUILD=1 for a compile-only check.",
    );
  }
}

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  assertProductionBrowserConfig(mode);
  return {
  server: {
    host: "::",
    port: 5173,
    hmr: {
      overlay: false,
    },
  },
  plugins: [react(), mode === "development" && componentTagger()].filter(Boolean),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
    dedupe: ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime", "@tanstack/react-query", "@tanstack/query-core"],
  },
  };
});
