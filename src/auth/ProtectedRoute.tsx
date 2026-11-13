import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "./AuthContext";
import Spinner from "../components/ui/Spinner";

/** Blocks protected pages until a verified session exists. Re-evaluated on every render, so browser Back after logout redirects too. */
export function ProtectedRoute() {
  const { session, loading, sessionEnded } = useAuth();
  const location = useLocation();

  if (loading) return <div className="boot"><Spinner size={36} label="Checking your session" /></div>;
  if (!session) {
    return <Navigate to="/login" replace state={{ from: location.pathname, reason: sessionEnded ? "expired" : "required" }} />;
  }
  return <Outlet />;
}

/** Login/register pages bounce signed-in users to the dashboard. */
export function GuestRoute() {
  const { session, loading } = useAuth();
  if (loading) return <div className="boot"><Spinner size={36} label="Loading" /></div>;
  if (session) return <Navigate to="/dashboard" replace />;
  return <Outlet />;
}
