/**
 * Development-only affordances in the guard console.
 *
 * Controls that fake a device or network state ("Simulate offline",
 * "Camera failed") exist so the offline queue and camera-fallback paths
 * can be exercised without unplugging hardware. They must never ship
 * unmarked: a guard cannot be allowed to mistake a simulated state for a
 * real one. Call sites pair this flag with the literal `import.meta.env.DEV`
 * so Vite drops the controls from the production bundle entirely; the flag
 * itself exists so tests can mock the production shape.
 */
export const DEV_TOOLS_ENABLED: boolean = import.meta.env.DEV;

export const DEV_TOOLS_LABEL = "DEV ONLY";
