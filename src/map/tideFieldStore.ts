/**
 * Shared UI state for the tide/sea-state raster field: which variable the heatmap
 * shows, and the current value range (so the colorbar and the map stay in sync).
 * The map layers write the range after each render; the dropdown writes the var.
 */
import { create } from 'zustand';
import type { FieldVar } from './tideField';

interface TideFieldState {
  /** Whether the raster field overlay is shown on the map(s). */
  visible: boolean;
  variable: FieldVar;
  /** [min,max] of the last-rendered field, for the colorbar ticks (null = none). */
  range: [number, number] | null;
  setVisible: (v: boolean) => void;
  toggleVisible: () => void;
  setVariable: (v: FieldVar) => void;
  setRange: (r: [number, number] | null) => void;
}

export const useTideFieldStore = create<TideFieldState>((set) => ({
  visible: false,
  variable: 'seaStateM',
  range: null,
  setVisible: (visible) => set({ visible }),
  toggleVisible: () => set((s) => ({ visible: !s.visible })),
  setVariable: (variable) => set({ variable }),
  setRange: (range) => set({ range }),
}));
