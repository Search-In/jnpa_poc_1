/**
 * Why the LDB container track fell back to the bundled sample.
 *
 * `trackContainerById` catches failures and — for the one container the sample
 * actually describes — answers with that sample. Without a reason, a dead proxy,
 * an empty record and a switched-off integration all render as the same
 * successful-looking demo track, which is precisely what makes a live
 * switch-over impossible to verify. Classifying the reason lets the UI say WHICH
 * happened, so "we are on the sample" becomes actionable rather than merely
 * visible.
 *
 * Pure — no I/O, so it is unit-testable against the literal strings the LDB
 * connector throws.
 *
 * ⚠ These patterns are COUPLED to the messages in `track.ts`. They were rewritten
 * when LDB auth moved to the OTP/searate-token flow, which replaced every
 * `[LDB] … HTTP 4xx` string with operator language. If a message there is
 * reworded again, `failure.test.ts` fails — that is the point of pinning the
 * tests to the literal strings rather than to paraphrases.
 */

export type LdbFallbackReason =
  /** VITE_LDB_ENABLED=false — no request was made. */
  | 'disabled'
  /** No / expired OTP session. Normally re-thrown before the fallback, not seen here. */
  | 'unauthorized'
  /** The call was made but did not come back usable — proxy, network, WAF, non-JSON. */
  | 'lookup-failed'
  /** LDB answered, but carried no record for this container. */
  | 'empty'
  /** Anything else. */
  | 'error';

export interface LdbFailure {
  reason: LdbFallbackReason;
  /** The original message, verbatim, for the "Technical details" disclosure. */
  detail: string;
}

/**
 * True for `LdbAuthRequiredError` without importing it.
 *
 * Duck-typed on the class's own `needsAuth` marker so this module stays free of
 * a runtime dependency on `token.ts` — `types.ts` imports the reason type from
 * here, and a class import would put a cycle through the LDB module graph.
 */
function isAuthRequired(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { needsAuth?: unknown; name?: unknown };
  return e.needsAuth === true || e.name === 'LdbAuthRequiredError';
}

/** Classify a thrown value from the LDB track path. Pure. */
export function classifyLdbFailure(err: unknown): LdbFailure {
  const detail = err instanceof Error ? err.message : String(err);

  // Checked first, and structurally rather than by message: the auth path has
  // several different sentences and they must never be mistaken for a lookup
  // failure.
  if (isAuthRequired(err)) return { reason: 'unauthorized', detail };

  if (/tracking is currently unavailable/i.test(detail)) {
    return { reason: 'disabled', detail };
  }
  if (/no tracking details found/i.test(detail)) {
    return { reason: 'empty', detail };
  }
  // Covers the non-JSON body and the non-2xx branches, which share one message.
  // Matched on the distinctive middle of the sentence so the typographic
  // apostrophe in "Couldn’t" cannot break the pattern.
  if (/look ?up this container|failed to fetch|networkerror|err_network|err_connection/i.test(detail)) {
    return { reason: 'lookup-failed', detail };
  }
  return { reason: 'error', detail };
}

/** Operator-language sentence for each reason. Pure; used by the panel notice. */
export function ldbFallbackMessage(reason: LdbFallbackReason): string {
  switch (reason) {
    case 'disabled':
      return 'Container tracking is switched off in this build (VITE_LDB_ENABLED=false).';
    case 'unauthorized':
      return 'The tracking session has expired or was never verified.';
    case 'lookup-failed':
      return 'LDB could not be reached, or replied with something unusable.';
    case 'empty':
      return 'LDB returned no record for this container.';
    case 'error':
      return 'The live LDB call failed.';
  }
}
