/**
 * Operator-language error messages — the translation layer between what a
 * connector throws and what a control-room user should read.
 *
 * The problem being solved: `client.ts` builds messages like
 * `[UC3] /marine/calls → HTTP 502 Bad Gateway — {"detail":"upstream_timeout"}`,
 * `useAdapterQuery` stores `err.message` verbatim, and ~24 panels render it. A
 * path, an HTTP code and a JSON blob tell an operator nothing about what to do,
 * and on a projector they read as a broken app rather than a known state.
 *
 * Design constraints that shaped this:
 *
 *  • **Input is a plain string**, not an Error or a status code. That is all
 *    `useAdapterQuery` has, and keeping the signature string-shaped means the
 *    adapters, the hook and every call site stay untouched — the whole change
 *    lands in `PanelError`.
 *  • **The technical detail is never discarded**, only demoted. `detail` always
 *    carries the original verbatim, and `PanelError` puts it behind a collapsed
 *    "Technical details" toggle so an engineer can still read the real cause.
 *  • **Pure.** Same convention as `httpErrorMessage` / `uc3Url` in
 *    `src/data/uc3/client.ts`: exported separately so it is testable with no I/O.
 *
 * Deliberately NOT a lookup keyed on status alone: several distinct conditions
 * share a status (a disabled integration never reaches the network at all), and
 * the connector prefix carries information the status does not.
 */

export type ErrorCode =
  | 'DISABLED'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'TIMEOUT'
  | 'RATE_LIMITED'
  | 'UPSTREAM'
  | 'SERVER'
  | 'OFFLINE'
  | 'BAD_PAYLOAD'
  | 'PLAIN'
  | 'UNKNOWN';

export interface FriendlyError {
  code: ErrorCode;
  /** What happened, in operator language. Becomes the notice title. */
  title: string;
  /** What to do next. Empty for PLAIN, where the message IS the guidance. */
  action: string;
  /** The original string, verbatim. Never dropped. */
  detail: string;
  /** False for PLAIN — no "Technical details" affordance is worth rendering. */
  technical: boolean;
}

/** Longest message we will treat as already-human. Beyond this it is a dump. */
const PLAIN_MAX_LEN = 90;

/**
 * True when a message was already written for a human and should pass through
 * untouched — e.g. `'Enter a container number'` from the LDB track validator.
 *
 * The markers are the things a hand-written operator message never contains: a
 * bracketed connector prefix (`[UC3]`, `[LDB]`), an HTTP status line, a thrown
 * Error's `name:` prefix, JSON, or a URL path. Exported for direct testing —
 * this predicate is what keeps the ContainerTrackPanel's validation messages
 * from being buried under a generic "Couldn't load".
 */
export function isPlainMessage(raw: string): boolean {
  const s = raw.trim();
  if (s === '' || s.length > PLAIN_MAX_LEN) return false;
  if (/^\[/.test(s)) return false; // connector prefix
  if (/HTTP\s+\d{3}/i.test(s)) return false; // status line
  if (/^[A-Z]\w*Error\b|^Error:/.test(s)) return false; // raw thrown Error
  if (/[{}]|https?:\/\//.test(s)) return false; // JSON / URL
  return true;
}

function make(
  code: ErrorCode,
  title: string,
  action: string,
  detail: string,
): FriendlyError {
  return { code, title, action, detail, technical: true };
}

/**
 * Classify a raw error message. First match wins, so order is meaningful:
 * the disabled-integration check runs before any status check because that
 * message is generated locally and never involved a response at all.
 *
 * @param raw whatever the panel captured — typically `err.message`
 */
export function friendlyError(raw: string): FriendlyError {
  const s = (raw ?? '').trim();

  if (s === '') {
    return make(
      'UNKNOWN',
      'Couldn’t load this panel',
      'Retry. If it keeps happening, reload the page.',
      s,
    );
  }

  // --- AI/ML model service --------------------------------------------------
  // MUST precede every status branch below. Those branches all say "gateway",
  // and the model service is a DIFFERENT system (:8100 / `/ml-api`).
  if (/^\[ML\]/.test(s)) {
    if (/is not reachable/i.test(s)) {
      return make(
        'OFFLINE',
        'The AI/ML model service isn’t running',
        'Predictions come from the UC-1 Gen-2 pack: `cd ml && JNPA_PORT=8100 python run.py serve`. ' +
          'The UC-3 gateway on :8000 is separate and unaffected.',
        s,
      );
    }
    if (/did not answer within|AbortError/i.test(s)) {
      return make(
        'TIMEOUT',
        'The models took too long to answer',
        'Retry; if it keeps timing out, raise VITE_ML_TIMEOUT_MS.',
        s,
      );
    }
    if (/is disabled|VITE_ML_ENABLED=false/i.test(s)) {
      return make(
        'DISABLED',
        'AI/ML predictions are switched off in this build',
        'This build was made with VITE_ML_ENABLED=false. Ask the deployment owner to enable it and redeploy.',
        s,
      );
    }
    return make(
      'SERVER',
      'The model service couldn’t complete this request',
      'The service answered, but the run failed. Retry; if it persists, share the technical detail below.',
      s,
    );
  }

  // Locally generated — the app declined to call out at all. LDB is not listed
  // here: its connector emits operator language at the source and its panel
  // renders that directly, so a disabled LDB never reaches this classifier.
  if (/integration is disabled|VITE_UC3_ENABLED=false/i.test(s)) {
    return make(
      'DISABLED',
      'Gateway data is switched off in this build',
      'This panel reads from the shared JNPA gateway, which is disabled in the running build. Ask the deployment owner to enable it.',
      s,
    );
  }

  if (/HTTP\s+401/.test(s)) {
    return make(
      'UNAUTHORIZED',
      'Sign-in to the JNPA gateway was rejected',
      'The demo credentials were not accepted. Reload the page; if it persists, the gateway password has been rotated.',
      s,
    );
  }

  if (/HTTP\s+403/.test(s)) {
    return make(
      'FORBIDDEN',
      'Your role can’t see this data',
      'Switch to a role with access, or ask the control room to widen the permission.',
      s,
    );
  }

  if (/HTTP\s+404/.test(s)) {
    return make(
      'NOT_FOUND',
      'The gateway has no records for this view yet',
      'Nothing has been loaded for it. Check the date window, or confirm the source file has been imported.',
      s,
    );
  }

  if (/HTTP\s+(408|504)/.test(s)) {
    return make(
      'TIMEOUT',
      'The gateway took too long to answer',
      'Retry in a moment. If every panel is slow, the gateway is under load.',
      s,
    );
  }

  if (/HTTP\s+429/.test(s)) {
    return make(
      'RATE_LIMITED',
      'Too many requests — the gateway is throttling',
      'Wait a minute before retrying.',
      s,
    );
  }

  if (/HTTP\s+(502|503)/.test(s)) {
    return make(
      'UPSTREAM',
      'The gateway can’t reach its upstream source',
      'The system behind the gateway is down. Retry shortly; other panels may still work.',
      s,
    );
  }

  if (/HTTP\s+5\d\d/.test(s)) {
    return make(
      'SERVER',
      'The JNPA gateway hit an internal error',
      'Retry. If it persists, share the technical detail below with the gateway team.',
      s,
    );
  }

  // Fetch rejects (rather than resolving non-2xx) — no response at all.
  if (/failed to fetch|networkerror|err_network|err_internet|err_connection/i.test(s)) {
    return make(
      'OFFLINE',
      'Can’t reach the server',
      'Check the network connection, then retry.',
      s,
    );
  }

  if (/non-json|unexpected token|no container payload|invalid json/i.test(s)) {
    return make(
      'BAD_PAYLOAD',
      'The server’s reply wasn’t in the expected format',
      'Usually a proxy or a login page answering instead of the API. Share the technical detail below.',
      s,
    );
  }

  // Already human — pass through, and offer no "details" toggle to expand.
  if (isPlainMessage(s)) {
    return { code: 'PLAIN', title: s, action: '', detail: s, technical: false };
  }

  return make(
    'UNKNOWN',
    'Couldn’t load this panel',
    'Retry. If it persists, share the technical detail below.',
    s,
  );
}
