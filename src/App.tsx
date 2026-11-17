import { Suspense, lazy, useEffect } from "react";
import { Navigate, Outlet, Route, Routes, useLocation } from "react-router-dom";
import AnimatedBackground from "./components/layout/AnimatedBackground";
import Navbar from "./components/layout/Navbar";
import Footer from "./components/layout/Footer";
import AppLayout from "./components/app/AppLayout";
import { GuestRoute, ProtectedRoute } from "./auth/ProtectedRoute";
import Landing from "./pages/Landing";
import Placeholder from "./pages/Placeholder";
import Login from "./pages/auth/Login";
import Register from "./pages/auth/Register";
import ForgotPassword from "./pages/auth/ForgotPassword";
import ResetPassword from "./pages/auth/ResetPassword";
import AuthCallback from "./pages/auth/AuthCallback";
import Dashboard from "./pages/app/Dashboard";
import Projects from "./pages/app/Projects";
import Settings from "./pages/app/Settings";
import Workspace from "./pages/app/Workspace";
import EditorPlaceholder from "./pages/app/EditorPlaceholder";
const Studio = lazy(() => import("./pages/app/Studio"));

function ScrollManager() {
  const { pathname, hash } = useLocation();
  useEffect(() => {
    if (hash) {
      setTimeout(() => document.querySelector(hash)?.scrollIntoView({ behavior: "smooth" }), 50);
    } else {
      window.scrollTo(0, 0);
    }
  }, [pathname, hash]);
  return null;
}

function PublicLayout() {
  const location = useLocation();
  return (
    <>
      <Navbar />
      <main className="page" key={location.pathname}><Outlet /></main>
      <Footer />
    </>
  );
}

export default function App() {
  return (
    <>
      <AnimatedBackground />
      <ScrollManager />
      <Routes>
        <Route element={<PublicLayout />}>
          <Route path="/" element={<Landing />} />
          <Route element={<GuestRoute />}>
            <Route path="/login" element={<Login />} />
            <Route path="/register" element={<Register />} />
            <Route path="/forgot-password" element={<ForgotPassword />} />
          </Route>
          <Route path="/signup" element={<Navigate to="/register" replace />} />
          <Route path="/reset-password" element={<ResetPassword />} />
          <Route path="/auth/callback" element={<AuthCallback />} />
          <Route path="/about" element={<Placeholder title="About Us" stage="Content pending" />} />
          <Route path="/contact" element={<Placeholder title="Contact" stage="Content pending" />} />
          <Route path="/support" element={<Placeholder title="Support" stage="Content pending" />} />
          <Route path="/privacy" element={<Placeholder title="Privacy Policy" stage="Legal review pending" />} />
          <Route path="/terms" element={<Placeholder title="Terms of Service" stage="Legal review pending" />} />
        </Route>

        <Route element={<ProtectedRoute />}>
          <Route element={<AppLayout />}>
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/workspace" element={<Workspace />} />
            <Route element={<Suspense fallback={<div className="st-center" style={{ padding: 48 }}>Loading editor…</div>}><Studio /></Suspense>}>
              <Route path="/image-editor" element={null} />
              <Route path="/video-editor" element={null} />
            </Route>
            <Route path="/document-editor" element={<EditorPlaceholder title="Document Editor" stage="Stage 6" blurb="Clean PDF, DOCX and PPTX files while preserving their layout." />} />
            <Route path="/projects" element={<Projects />} />
            <Route path="/settings" element={<Settings />} />
          </Route>
        </Route>

        <Route element={<PublicLayout />}>
          <Route path="*" element={<Placeholder title="Page not found" stage="404" />} />
        </Route>
      </Routes>
    </>
  );
}
