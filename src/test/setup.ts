import '@testing-library/jest-dom/vitest';
import { beforeEach } from 'vitest';
import { setSession } from '../auth/sessionStore';

/**
 * Seed a signed-in session before every test.
 *
 * The UC-3 data layer used to authenticate itself: `getAuthToken()` submitted
 * the build-time VITE_UC3_USERNAME / VITE_UC3_PASSWORD on first use, so a suite
 * that stubbed `fetch` got a bearer for free. The credential now comes from the
 * user signing in, and `getAuthToken()` never performs a login — so without a
 * stored session every `fetch*` test would fail with "not signed in" rather than
 * exercising the endpoint it is actually about.
 *
 * Seeding here keeps those suites testing what they were written to test. The
 * sign-in flow itself is covered directly in src/data/uc3/token.test.ts, which
 * clears the session and asserts both the authenticated and unauthenticated
 * paths explicitly.
 */
beforeEach(() => {
  setSession('test.jwt.token', 'DTCCC_ADMIN', 'test-user');
});
