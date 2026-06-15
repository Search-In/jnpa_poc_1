import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

// Calcite design system (light theme set via the html.calcite-mode-light class).
// Calcite 3 / ArcGIS 4.34 use @arcgis/lumina: defineCustomElements({ resourcesUrl }).
import '@esri/calcite-components/calcite/calcite.css';
import { defineCustomElements as defineCalcite } from '@esri/calcite-components/loader';

// ArcGIS map web components (used by AISMap later; registering here is harmless).
import { defineCustomElements as defineMapComponents } from '@arcgis/map-components/loader';

import { tokens } from './theme/tokens';
import { App } from './App';
import './index.css';

/** Seed CSS custom properties from the token file so CSS has no colour literals. */
function applyTheme(): void {
  const r = document.documentElement.style;
  r.setProperty('--app-bg', tokens.bg);
  r.setProperty('--app-panel', tokens.panel);
  r.setProperty('--app-panel-alt', tokens.panelAlt);
  r.setProperty('--app-border', tokens.border);
  r.setProperty('--app-text', tokens.text);
  r.setProperty('--app-text-muted', tokens.textMuted);
  r.setProperty('--app-accent', tokens.accent);
}

// Calcite + ArcGIS components lazy-load their assets from a CDN.
defineCalcite({ resourcesUrl: 'https://js.arcgis.com/calcite-components/3.3.3/assets' });
defineMapComponents({ resourcesUrl: 'https://js.arcgis.com/4.34/map-components/' });
applyTheme();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
