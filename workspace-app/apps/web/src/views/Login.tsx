/**
 * Inlogscherm (HZW-010): Google (OIDC via de server), met een nette weigerpagina per reden. De dev-login-stub
 * verschijnt alleen als de server hem aanbiedt (development of test, nooit productie).
 */
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { LoginRefusal, REFUSAL_TEXT } from '@hz/shared';
import logo from '../assets/logo.svg';
import { useAuthConfig } from '../lib/e1';

/** Google-inloggen start met een POST (CSRF-token van Auth.js), als gewone navigatie zodat de cookies meegaan. */
async function startGoogle(callbackUrl: string) {
  const r = await fetch('/api/auth/csrf', { credentials: 'same-origin' });
  const { csrfToken } = (await r.json()) as { csrfToken: string };
  const f = document.createElement('form');
  f.method = 'POST';
  f.action = '/api/auth/signin/google';
  for (const [k, v] of Object.entries({ csrfToken, callbackUrl })) {
    const i = document.createElement('input');
    i.type = 'hidden';
    i.name = k;
    i.value = v;
    f.appendChild(i);
  }
  document.body.appendChild(f);
  f.submit();
}

function GoogleMark() {
  return (
    <svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M17.6 9.2c0-.6-.1-1.2-.2-1.7H9v3.3h4.8a4.1 4.1 0 0 1-1.8 2.7v2.2h2.9c1.7-1.6 2.7-3.9 2.7-6.5z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.4 0 4.5-.8 6-2.2l-2.9-2.2c-.8.5-1.8.9-3.1.9-2.4 0-4.4-1.6-5.1-3.8H.9v2.3A9 9 0 0 0 9 18z"
      />
      <path fill="#FBBC05" d="M3.9 10.7a5.4 5.4 0 0 1 0-3.4V5H.9a9 9 0 0 0 0 8z" />
      <path fill="#EA4335" d="M9 3.6c1.3 0 2.5.5 3.5 1.4l2.6-2.6A9 9 0 0 0 .9 5l3 2.3C4.6 5.2 6.6 3.6 9 3.6z" />
    </svg>
  );
}

export function Login() {
  const [sp] = useSearchParams();
  const cfg = useAuthConfig().data;
  const [busy, setBusy] = useState(false);
  const parsed = LoginRefusal.safeParse(sp.get('fout') ?? (sp.get('error') ? 'fout' : undefined));
  const refusal = parsed.success ? parsed.data : null;
  const out = sp.get('uit') === '1';
  const domain = cfg?.domain ?? 'homezero.nl';
  const google = () => {
    setBusy(true);
    startGoogle('/').catch(() => setBusy(false));
  };
  const dev = async () => {
    setBusy(true);
    const r = await fetch('/api/auth/dev-login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    if (r.ok) window.location.assign('/dagstart');
    else setBusy(false);
  };
  return (
    <main className="login" id="main">
      <div className={`login-card card${refusal ? ' refused' : ''}`}>
        <header className="login-head felt plane-yellow-light">
          <div className="shapes" aria-hidden="true">
            <svg viewBox="0 0 300 300" style={{ right: 0, top: 0, width: 150, height: 150 }}>
              <path d="M300 0V210A210 210 0 0 1 90 0Z" fill="#0022c4" />
            </svg>
            <svg viewBox="0 0 300 300" style={{ right: 0, bottom: 0, width: 110, height: 110 }}>
              <circle cx="300" cy="300" r="120" fill="none" stroke="#f9b20b" strokeWidth="34" />
            </svg>
          </div>
          <img className="brand-logo" src={logo} alt="HomeZero" />
          <h1>{refusal ? REFUSAL_TEXT[refusal].title : 'Workspace'}</h1>
          <p>{refusal ? REFUSAL_TEXT[refusal].body : `Log in met je @${domain}-account.`}</p>
        </header>
        <div className="card-body">
          {out && !refusal && (
            <p className="note" role="status">
              Je bent uitgelogd.
            </p>
          )}
          {refusal && (
            <p className="note err" role="alert">
              {refusal === 'domein'
                ? `Kies bij Google je @${domain}-account.`
                : refusal === 'niet-uitgenodigd' || refusal === 'geblokkeerd'
                  ? 'Een beheerder kan je toevoegen in Instellingen → Team.'
                  : 'Probeer het nog eens of kies een ander account.'}
            </p>
          )}
          {cfg?.google !== false && (
            <button type="button" className="btn big google-btn" onClick={google} disabled={busy || !cfg}>
              <GoogleMark />
              {refusal ? 'Ander account kiezen' : 'Inloggen met Google'}
            </button>
          )}
          {cfg && !cfg.google && !cfg.devLogin && (
            <p className="note err">Google-inloggen is nog niet ingericht op deze server.</p>
          )}
          {cfg?.devLogin && (
            <button type="button" className="btn" onClick={dev} disabled={busy} data-action="dev-login">
              Inloggen als testgebruiker (alleen lokaal)
            </button>
          )}
          <p className="hint sub">
            We vragen Google alleen je naam en e-mailadres. Koppelingen (Taken, Agenda, Slack, Jira, GitHub) kies je
            daarna zelf, elk met een eigen toestemming.
          </p>
        </div>
      </div>
    </main>
  );
}
