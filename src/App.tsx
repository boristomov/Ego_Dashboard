import { Routes, Route, Navigate } from "react-router-dom";
import { Layout } from "./components/Layout";
import { DashboardPage } from "./pages/DashboardPage";
import { CataloguePage } from "./pages/CataloguePage";
import { PostprocessingPage } from "./pages/PostprocessingPage";
import { MaintenancePage } from "./pages/MaintenancePage";
import { AccessProvider } from "./context/AccessGate";
import { AuthProvider, useAuth } from "./context/Auth";

export default function App() {
  return (
    <AuthProvider>
      <AccessProvider>
        <AppRoutes />
      </AccessProvider>
    </AuthProvider>
  );
}

function AppRoutes() {
  const { role, isTeam } = useAuth();

  // Client access is parked in maintenance for now.
  if (role === "client") {
    return (
      <Routes>
        <Route element={<Layout />}>
          <Route path="*" element={<MaintenancePage />} />
        </Route>
      </Routes>
    );
  }

  // Admin + R&D see the full platform.
  if (isTeam) {
    return (
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/catalogue" element={<CataloguePage />} />
          <Route path="/postprocessing" element={<PostprocessingPage />} />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Route>
      </Routes>
    );
  }

  // Public (anonymous): only the demo catalogue. Any other path redirects in.
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Navigate to="/catalogue" replace />} />
        <Route path="/catalogue" element={<CataloguePage />} />
        <Route path="*" element={<Navigate to="/catalogue" replace />} />
      </Route>
    </Routes>
  );
}
