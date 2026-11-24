import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";

// T010: the application shell is src/app/App.tsx — Scenario -> Strategy ->
// Web Worker -> BFS -> Timeline -> JSON/HTML export. T008's TimelineApp
// is superseded (kept only for its UI tests) and the macrotask-deferred
// runSearchAsync is deprecated; every search now runs in the Worker.
const rootElement = document.getElementById("root");
if (rootElement === null) {
  throw new Error("SnapFence: #root element missing");
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
