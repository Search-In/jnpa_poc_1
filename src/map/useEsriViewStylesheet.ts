/**
 * The Esri view stylesheet, added while any ArcGIS view is mounted and taken away again
 * when the last one unmounts.
 *
 * WHY THIS EXISTS AT ALL. Without it an ArcGIS view still *works* — the basemap draws,
 * layers render, clicks hit — but every piece of view UI is unstyled and falls into
 * normal document flow. The attribution becomes a full-width paragraph, widget buttons
 * become bare icons, and the POPUP renders as a block underneath the map instead of a
 * balloon anchored on it. That last one is easy to misread as a docking problem and
 * chase through `dockEnabled` / `dockOptions` — which cannot fix it, because the popup
 * was never docked, only unstyled.
 *
 * WHY A REF-COUNTED <link> RATHER THAN `import '…/main.css'`. A plain CSS import is
 * global and permanent: it would load on every route the bundle touches, including ones
 * with no map, and restyle them. Injecting on mount and removing on the last unmount
 * keeps the stylesheet's reach to exactly the screens that need it. The count matters
 * for the stereo VR case and for a 2D↔3D flip, where two views can briefly overlap.
 *
 * Originally private to VrScene, which was the only place a view was mounted with the
 * stylesheet handled deliberately; the dashboard maps mounted views with no stylesheet
 * at all. Shared here so all three behave the same.
 */
import { useEffect } from 'react';
import esriViewCssUrl from '@arcgis/core/assets/esri/themes/light/main.css?url';

const ESRI_CSS_ID = 'esri-view-css';

export function useEsriViewStylesheet(): void {
  useEffect(() => {
    let link = document.getElementById(ESRI_CSS_ID) as HTMLLinkElement | null;
    if (!link) {
      link = document.createElement('link');
      link.id = ESRI_CSS_ID;
      link.rel = 'stylesheet';
      link.href = esriViewCssUrl;
      link.dataset.refs = '0';
      document.head.appendChild(link);
    }
    link.dataset.refs = String(Number(link.dataset.refs ?? '0') + 1);
    return () => {
      const el = document.getElementById(ESRI_CSS_ID) as HTMLLinkElement | null;
      if (!el) return;
      const refs = Number(el.dataset.refs ?? '1') - 1;
      el.dataset.refs = String(refs);
      if (refs <= 0) el.remove();
    };
  }, []);
}
