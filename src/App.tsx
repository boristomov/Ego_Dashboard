import { Routes, Route, Navigate } from "react-router-dom";
import { Layout } from "./components/Layout";
import { DashboardPage } from "./pages/DashboardPage";
import { CataloguePage } from "./pages/CataloguePage";
import { PostprocessingPage } from "./pages/PostprocessingPage";
import { ClientConnectionsPage } from "./pages/ClientConnectionsPage";
import { MaintenancePage } from "./pages/MaintenancePage";
import { WelcomePage } from "./pages/WelcomePage";
import { PrivacyPage } from "./pages/PrivacyPage";
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
  const { role, isTeam, isAdmin } = useAuth();

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
        {isAdmin && <Route path="/clients" element={<ClientConnectionsPage />} />}
        <Route path="/privacy" element={<PrivacyPage />} />
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Route>
      </Routes>
    );
  }

  // Public (anonymous): a welcome walkthrough + the demo catalogue. Any other
  // path redirects back to the welcome page.
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Navigate to="/welcome" replace />} />
        <Route path="/welcome" element={<WelcomePage />} />
        <Route path="/catalogue" element={<CataloguePage />} />
        <Route path="/privacy" element={<PrivacyPage />} />
        <Route path="*" element={<Navigate to="/welcome" replace />} />
      </Route>
    </Routes>
  );
}
