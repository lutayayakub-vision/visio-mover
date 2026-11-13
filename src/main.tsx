import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, MemoryRouter } from "react-router-dom";
import App from "./App";
import { AuthProvider } from "./auth/AuthContext";
import { ToastProvider } from "./components/ui/Toast";
import "./styles/tokens.css";
import "./styles/global.css";
import "./styles/landing.css";
import "./styles/auth.css";

declare const __PREVIEW__: boolean;
// The embedded preview has no real URL bar, so it routes in memory.
const Router = __PREVIEW__ ? MemoryRouter : BrowserRouter;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Router>
      <ToastProvider>
        <AuthProvider>
          <App />
        </AuthProvider>
      </ToastProvider>
    </Router>
  </StrictMode>
);
