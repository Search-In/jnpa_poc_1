/**
 * Minimal JSX typing for the ArcGIS map web components we use directly
 * (no official React wrapper package is published). We only declare the
 * attributes the app sets; everything else is allowed via index signature.
 */

import type { DetailedHTMLProps, HTMLAttributes } from 'react';

type ArcgisMapAttributes = DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & {
  'item-id'?: string;
  center?: string;
  zoom?: string | number;
  basemap?: string;
};

declare global {
  namespace JSX {
    interface IntrinsicElements {
      'arcgis-map': ArcgisMapAttributes;
      'arcgis-scene': ArcgisMapAttributes;
    }
  }
}

export {};
