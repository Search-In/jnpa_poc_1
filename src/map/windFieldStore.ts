/**
 * Shared UI state for the Zoom Earth–style wind particle overlay: visibility
 * (drives 2D + 3D MediaLayers) and the colour-scale max for the legend.
 */
import { create } from 'zustand';

interface WindFieldState {
  visible: boolean;
  /** Peak speed (kn) from the last fetched grid; null until loaded. */
  speedMax: number | null;
  setVisible: (v: boolean) => void;
  toggleVisible: () => void;
  setSpeedMax: (n: number | null) => void;
}

export const useWindFieldStore = create<WindFieldState>((set) => ({
  visible: false,
  speedMax: null,
  setVisible: (visible) => set({ visible }),
  toggleVisible: () => set((s) => ({ visible: !s.visible })),
  setSpeedMax: (speedMax) => set({ speedMax }),
}));
