// ─── Stella Protocol — App Router ─────────────────────────────
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import ErrorBoundary  from './components/ErrorBoundary';
import { ToastProvider } from './components/Toast';
import AdminLayout    from './components/AdminLayout';
import Home           from './pages/Home';
import Dashboard      from './pages/Dashboard';
import RouteFinder    from './pages/RouteFinder';
import GraphExplorer  from './pages/GraphExplorer';
import Anchors        from './pages/Anchors';
import Assets         from './pages/Assets';
import NotFound       from './pages/NotFound';

export default function App() {
  return (
    <ErrorBoundary>
      <ToastProvider>
        <BrowserRouter>
          <Routes>
            {/* Public Home — Swap Widget */}
            <Route index element={<Home />} />

            {/* Admin Console — Sidebar Layout */}
            <Route path="admin" element={<AdminLayout />}>
              <Route index          element={<Dashboard />} />
              <Route path="routes"  element={<RouteFinder />} />
              <Route path="graph"   element={<GraphExplorer />} />
              <Route path="anchors" element={<Anchors />} />
              <Route path="assets"  element={<Assets />} />
            </Route>

            <Route path="*" element={<NotFound />} />
          </Routes>
        </BrowserRouter>
      </ToastProvider>
    </ErrorBoundary>
  );
}
