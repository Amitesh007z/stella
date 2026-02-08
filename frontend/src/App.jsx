// ─── Stella Protocol — App Router ─────────────────────────────
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import ErrorBoundary  from './components/ErrorBoundary';
import { ToastProvider } from './components/Toast';
import Layout         from './components/Layout';
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
            <Route element={<Layout />}>
              <Route index          element={<Dashboard />} />
              <Route path="routes"  element={<RouteFinder />} />
              <Route path="graph"   element={<GraphExplorer />} />
              <Route path="anchors" element={<Anchors />} />
              <Route path="assets"  element={<Assets />} />
              <Route path="*"       element={<NotFound />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </ToastProvider>
    </ErrorBoundary>
  );
}
