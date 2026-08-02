import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { fileURLToPath, URL } from 'node:url';

/**
 * Dev proxy for LDB. Azure App Gateway WAF 403s when the browser's
 * Origin/Referer/Accept (localhost, text/html) are forwarded. A custom
 * middleware re-fetches with clean same-site headers — more reliable than
 * http-proxy header overrides.
 */
function ldbDevProxy(): Plugin {
  return {
    name: 'ldb-dev-proxy',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith('/ldb-proxy')) {
          next();
          return;
        }
        const targetPath = req.url.replace(/^\/ldb-proxy/, '') || '/';
        const targetUrl = `https://ldb.co.in${targetPath}`;
        try {
          const chunks: Buffer[] = [];
          for await (const chunk of req) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
          const method = (req.method ?? 'GET').toUpperCase();
          const headers: Record<string, string> = {
            Accept: 'application/json',
            Origin: 'https://ldb.co.in',
            Referer: 'https://ldb.co.in/ldb/searate/',
            'User-Agent':
              'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          };
          if (req.headers.authorization) {
            headers.Authorization = String(req.headers.authorization);
          }
          if (req.headers['content-type']) {
            headers['Content-Type'] = String(req.headers['content-type']);
          } else if (method !== 'GET' && method !== 'HEAD') {
            headers['Content-Type'] = 'application/json';
          }
          const upstream = await fetch(targetUrl, {
            method,
            headers,
            body: method === 'GET' || method === 'HEAD' ? undefined : Buffer.concat(chunks),
          });
          const buf = Buffer.from(await upstream.arrayBuffer());
          res.statusCode = upstream.status;
          const ct = upstream.headers.get('content-type');
          if (ct) res.setHeader('Content-Type', ct);
          res.end(buf);
        } catch (err) {
          res.statusCode = 502;
          res.setHeader('Content-Type', 'application/json');
          res.end(
            JSON.stringify({
              error: 'LDB proxy failed',
              detail: err instanceof Error ? err.message : String(err),
            }),
          );
        }
      });
    },
  };
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  // ArcGIS OAuth app registration rejects http:// redirect URIs. Set
  // VITE_DEV_HTTPS=true to serve the dev server over https://localhost:5173
  // (self-signed cert; accept the one-time browser warning).
  const useHttps = env.VITE_DEV_HTTPS === 'true';

  return {
    plugins: [react(), ldbDevProxy(), ...(useHttps ? [basicSsl()] : [])],
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
        // LDB is handled by ldbDevProxy() plugin (WAF-safe header rewrite).
      },
    },
  };
});
