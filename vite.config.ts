import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// SnapFence (P030) — Vite config. T001 scaffold only; UI/worker wiring lands in T008/T010.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx", "src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
