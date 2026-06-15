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
      sourcemap: true,
    },
    server: {
      port: 5173,
      // basicSsl() sets https; this is a no-op when the plugin isn't loaded.
    },
  };
});
