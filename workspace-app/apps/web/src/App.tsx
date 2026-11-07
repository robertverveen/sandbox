import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router';
import { AuthRequiredError } from './lib/api';
import { useServerEvents, useSession } from './lib/queries';
import { UiProvider } from './lib/ui';
import { Shell } from './components/Shell';
import { Dagstart } from './views/Dagstart';
import { Agenda, Chat, PartnerPage, Planning, Tracker, Zoeken } from './views/Placeholders';
import { Login } from './views/Login';
import { Onboarding } from './views/Onboarding';
import { Settings } from './views/Settings';

function Gate() {
  const s = useSession();
  const loc = useLocation();
  useServerEvents(s.isSuccess);
  if (loc.pathname === '/login') return s.isSuccess ? <Navigate to="/" replace /> : <Login />;
  if (s.error instanceof AuthRequiredError) return <Login />;
  return (
    <Shell>
      <Routes>
        <Route path="/" element={<Navigate to="/dagstart" replace />} />
        <Route path="/dagstart" element={<Dagstart />} />
        <Route path="/planning" element={<Planning />} />
        <Route path="/agenda" element={<Agenda />} />
        <Route path="/tracker" element={<Tracker />} />
        <Route path="/chat" element={<Chat />} />
        <Route path="/zoeken" element={<Zoeken />} />
        <Route path="/o/:slug" element={<PartnerPage />} />
        <Route path="/welkom" element={<Onboarding />} />
        <Route path="/instellingen" element={<Settings />} />
        <Route path="/instellingen/:tab" element={<Settings />} />
        <Route path="*" element={<Navigate to="/dagstart" replace />} />
      </Routes>
    </Shell>
  );
}

export function App({ client }: { client: QueryClient }) {
  return (
    <QueryClientProvider client={client}>
      <UiProvider>
        <BrowserRouter>
          <Gate />
        </BrowserRouter>
      </UiProvider>
    </QueryClientProvider>
  );
}
