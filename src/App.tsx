import { Routes, Route, Navigate } from "react-router-dom";
import { Layout } from "./components/Layout";
import { DashboardPage } from "./pages/DashboardPage";
import { CataloguePage } from "./pages/CataloguePage";
import { PostprocessingPage } from "./pages/PostprocessingPage";
import { AccessProvider } from "./context/AccessGate";

export default function App() {
  return (
    <AccessProvider>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/catalogue" element={<CataloguePage />} />
          <Route path="/postprocessing" element={<PostprocessingPage />} />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Route>
      </Routes>
    </AccessProvider>
  );
}
