import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { CrashBoundary, LooseErrorBanner, installGlobalErrorReporting } from "./crashScreen";
import "./styles.css";

const host = document.getElementById("root");
if (!host) throw new Error("#root is missing from index.html");

// Before the first render, because a rejection can land before it — see `installGlobalErrorReporting`.
installGlobalErrorReporting();

createRoot(host).render(
  <StrictMode>
    {/* Outside the boundary on purpose: a banner about a failure must not be inside the thing that
        can fail, or the report goes down with what it was reporting. */}
    <LooseErrorBanner />
    <CrashBoundary>
      <App />
    </CrashBoundary>
  </StrictMode>,
);
