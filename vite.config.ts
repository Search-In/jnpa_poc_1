import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { fileURLToPath, URL } from 'node:url';

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  // ArcGIS OAuth app registration rejects http:// redirect URIs. Set
  // VITE_DEV_HTTPS=true to serve the dev server over https://localhost:5173
  // (self-signed cert; accept the one-time browser warning).
  const useHttps = env.VITE_DEV_HTTPS === 'true';

  return {
    plugins: [react(), ...(useHttps ? [basicSsl()] : [])],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    // Base is "./" so the production build works when embedded under an
    // arbitrary path inside ArcGIS Dashboards "Embedded Content".
    base: './',
    build: {
      target: 'es2022',
      sourcemap: false,
    },
    server: {
      port: 5173,
      // basicSsl() sets https; this is a no-op when the plugin isn't loaded.
      proxy: {
        // AISHub's public station map.json (used by the hybrid live overlay) sends
        // no CORS header and gates data behind an aishub.net-origin request, so a
        // direct browser fetch fails. In dev we proxy through the Vite server:
        // /aishub-proxy/station/2387/map.json → https://www.aishub.net/station/2387/map.json
        // with the Origin/Referer the endpoint expects. Production needs an
        // equivalent server-side proxy (documented in docs/AISHUB.md).
        '/aishub-proxy': {
          target: 'https://www.aishub.net',
          changeOrigin: true,
          secure: true,
          rewrite: (p) => p.replace(/^\/aishub-proxy/, ''),
          headers: {
            Referer: 'https://www.aishub.net/stations/2387',
            'X-Requested-With': 'XMLHttpRequest',
          },
        },
        // INCOIS Ocean State Forecast (tide + sea state). INCOIS exposes no
        // free, public, CORS-enabled tide/OSF API (its open ERDDAP carries only
        // satellite winds/SST and sends no CORS header), so a real INCOIS feed
        // must be proxied server-side. This dev stub is wired for the day an
        // INCOIS OSF endpoint + data agreement land — point `target` at it and
        // switch src/data/tide.ts to fetch /incois-osf-proxy/… . Until then the
        // Tide & Sea State feature runs on the interim Open-Meteo source and this
        // proxy is dormant. Production needs an equivalent server-side proxy
        // (documented in docs/INCOIS.md).
        '/incois-osf-proxy': {
          target: 'https://samudra.incois.gov.in',
          changeOrigin: true,
          secure: true,
          rewrite: (p) => p.replace(/^\/incois-osf-proxy/, ''),
        },
        // UC-3 shared backend gateway (the common /api surface: /api/auth/*,
        // /api/shipping-lines/*). UC-1 and UC-3 are served from DIFFERENT origins
        // in production, so a direct browser call would be cross-origin and need
        // CORS. Instead BOTH tiers proxy /api to the gateway, so the app always
        // fetches a RELATIVE /api path and stays same-origin — no CORS, no
        // preflight, and no CORS_ALLOW_ORIGINS change on the gateway. This is the
        // dev half; production needs the equivalent nginx block in
        // deploy/nginx.conf (mirroring UC-3's own web/nginx/default.conf).
        // No `rewrite`: the gateway's routes already live under /api, so the
        // prefix is forwarded as-is (unlike the two proxies above, which strip it).
        '/api': {
          target: env.VITE_GATEWAY_URL || 'http://localhost:8000',
          changeOrigin: true,
          // Dev-only: allows pointing at an internal gateway with a self-signed
          // cert. Production terminates TLS at nginx, which never uses this file.
          secure: false,
        },
      },
    },
  };
});
