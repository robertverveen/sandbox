import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { AuthRequiredError } from './lib/api';
import { useServerEvents, useSession } from './lib/queries';
import { UiProvider } from './lib/ui';
import { Shell } from './components/Shell';
import { Dagstart } from './views/Dagstart';
import { Agenda, Chat, PartnerPage, Planning, Tracker, Zoeken } from './views/Placeholders';

function Gate() {
  const s = useSession();
  useServerEvents(s.isSuccess);
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
        <Route path="*" element={<Navigate to="/dagstart" replace />} />
      </Routes>
    </Shell>
  );
}

/** Inlogscherm (tot het auth-stuk er is: alleen uitleg; Google-inloggen volgt in HZW-010). */
function Login() {
  return (
    <main className="login">
      <div className="card login-card">
        <div className="card-body">
          <h1>HomeZero Workspace</h1>
          <p className="sub">Log in met je @homezero.nl-account.</p>
          <button type="button" className="btn primary big" disabled>
            Inloggen met Google
          </button>
          <p className="hint">
            Google-inloggen komt in het stuk Inloggen. Lokaal logt de app automatisch in als testgebruiker.
          </p>
        </div>
      </div>
    </main>
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
