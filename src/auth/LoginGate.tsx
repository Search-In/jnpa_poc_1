/**
 * Sign-in gate — a port of UC-3's `web/src/components/auth/LoginGate.tsx`.
 *
 * Same flow, same copy, same states (idle → busy → "Invalid credentials"), same
 * single opaque error for every failure. The MARKUP differs for one reason
 * only: UC-3's console is a Tailwind app and UC-1 is not — UC-1 has no Tailwind
 * or PostCSS in its build, so UC-3's utility classes would render as an
 * unstyled form here. It is rebuilt with the Calcite components and theme
 * tokens UC-1 already uses everywhere else, so it looks native to this app.
 *
 * The behaviour that matters — the API call, the credentials, the token, the
 * session — is not reimplemented: it lives in ./session.ts, which itself reuses
 * UC-1's existing `login()` against the UC-3 gateway.
 */
import { useState } from 'react';
import { CalciteButton, CalciteInput, CalciteLabel, CalciteNotice } from '@esri/calcite-components-react';
import { login } from './session';
import { tokens } from '../theme/tokens';

export function LoginGate({ onAuthed }: { onAuthed: (role: string) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      onAuthed(await login(username, password));
    } catch {
      setErr('Invalid credentials');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        display: 'grid',
        placeItems: 'center',
        minHeight: '100vh',
        padding: 24,
        background: tokens.bg,
      }}
    >
      <form
        onSubmit={submit}
        style={{
          width: '100%',
          maxWidth: 380,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          padding: 24,
          borderRadius: 8,
          border: `1px solid ${tokens.border}`,
          background: tokens.panel,
        }}
      >
        <div>
          <h1 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: tokens.text }}>
            JNPA UC-1 — Sign in
          </h1>
          <p style={{ margin: '6px 0 0', fontSize: 12, color: tokens.textMuted }}>
            Uses your JNPA DTCCC account — the same credentials as UC-3. Accounts are issued by your
            DTCCC administrator.
          </p>
        </div>

        <CalciteLabel scale="s">
          Username
          <CalciteInput
            value={username}
            autocomplete="username"
            required
            onCalciteInputInput={(e) => setUsername((e.target as HTMLCalciteInputElement).value ?? '')}
          />
        </CalciteLabel>

        <CalciteLabel scale="s">
          Password
          <CalciteInput
            type="password"
            value={password}
            autocomplete="current-password"
            required
            onCalciteInputInput={(e) => setPassword((e.target as HTMLCalciteInputElement).value ?? '')}
          />
        </CalciteLabel>

        {err ? (
          <CalciteNotice open kind="danger" scale="s">
            <div slot="message">{err}</div>
          </CalciteNotice>
        ) : null}

        <CalciteButton width="full" scale="m" type="submit" loading={busy || undefined} disabled={busy || undefined}>
          {busy ? 'Signing in…' : 'Sign in'}
        </CalciteButton>
      </form>
    </div>
  );
}
