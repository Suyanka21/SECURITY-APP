import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";

// Login is impossible without the Supabase browser config, and the app has
// no runtime fallback in production (the legacy VITE_DEV_JWT path is dev-only).
// A production build without it is a deploy artifact that cannot sign anyone
// in, so the build fails here instead. CI compile checks that are never
// deployed opt out explicitly with GATEPASS_ALLOW_UNCONFIGURED_BUILD=1.
// Every VITE_ value is inlined into the public bundle, so any build refuses a
// Supabase secret key (sb_secret_…) in one.
// Source: Vite — loadEnv https://vitejs.dev/guide/api-javascript#loadenv
function assertBrowserConfig(mode: string): void {
  const env = { ...loadEnv(mode, process.cwd(), "VITE_"), ...process.env };
  const leaked = Object.keys(env).filter(
    (name) => name.startsWith("VITE_") && /sb_secret_/.test(env[name] ?? ""),
  );
  if (leaked.length > 0) {
    throw new Error(
      `[FATAL] Build refused: ${leaked.join(", ")} holds a Supabase secret key ` +
        "(sb_secret_…). VITE_ values are public; the secret key is server-only.",
    );
  }

  if (mode !== "production") return;
  if (process.env.GATEPASS_ALLOW_UNCONFIGURED_BUILD === "1") return;

  const missing = ["VITE_SUPABASE_URL", "VITE_SUPABASE_PUBLISHABLE_KEY"].filter(
    (name) => !env[name] || /<[^>]+>/.test(env[name] as string),
  );
  const key = env.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (key && !missing.includes("VITE_SUPABASE_PUBLISHABLE_KEY") && !key.startsWith("sb_publishable_")) {
    throw new Error(
      "[FATAL] Production build refused: VITE_SUPABASE_PUBLISHABLE_KEY must be " +
        "a Supabase publishable key (sb_publishable_…).",
    );
  }
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
  assertBrowserConfig(mode);
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
