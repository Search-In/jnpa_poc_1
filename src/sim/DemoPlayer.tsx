/**
 * DemoPlayer — camera bookmarks + scripted opening choreography (spec §B3.13,
 * §A6 "60-second first impression"). A compact control bar over the 3D scene:
 *   • named camera bookmarks (the demo beats: Overview, Approach & anchorage,
 *     Channel & DUKC, Berth line-up, Pilot station) that fly the SceneView;
 *   • a "Play opening" button that runs the 60-second choreography — a timed
 *     sweep through the beats with presenter captions — fully offline.
 *
 * Drives the scene through the PortSceneHandle passed in; presenter notes render
 * as a transient caption. Respects prefers-reduced-motion (no auto-advance).
 */
import { useEffect, useRef, useState } from 'react';
import { CalciteButton } from '@esri/calcite-components-react';
import type { CameraPreset, PortSceneHandle } from '@/map/PortScene';
import { tokens } from '@/theme/tokens';

const REDUCED_MOTION =
  typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

interface Beat {
  preset: CameraPreset;
  label: string;
  icon: string;
  /** Presenter note shown during the opening choreography. */
  note: string;
  /** Dwell time (ms) in the opening sweep. */
  dwellMs: number;
}

const BEATS: Beat[] = [
  { preset: 'overview', label: 'Overview', icon: 'extent', note: 'JNPA / Nhava Sheva — the living twin: channel, anchorages, terminals, live (simulated) traffic.', dwellMs: 11000 },
  { preset: 'anchorage', label: 'Approach & anchorage', icon: 'anchor', note: 'Outer & waiting anchorages and the pilot boarding ground — where arrivals hold.', dwellMs: 11000 },
  { preset: 'channel', label: 'Channel & DUKC', icon: 'water', note: 'The depth-graded approach channel — the DUKC corridor that gates deep-draft transits on the tide.', dwellMs: 12000 },
  { preset: 'berths', label: 'Berth line-up', icon: 'urban-model', note: 'The quay line — NSICT, NSIGT, GTI/APMT, NSFT and BMCT — with status-coloured berths.', dwellMs: 12000 },
  { preset: 'pilot', label: 'Pilot station', icon: 'pin', note: 'The pilot boarding ground — finite pilots/tugs sequence every movement.', dwellMs: 10000 },
];

export function DemoPlayer({ scene }: { scene: PortSceneHandle | null }) {
  const [playing, setPlaying] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => () => { if (timerRef.current != null) window.clearTimeout(timerRef.current); }, []);

  function stop() {
    if (timerRef.current != null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    setPlaying(false);
    setNote(null);
  }

  function playOpening() {
    if (!scene || REDUCED_MOTION) {
      // Reduced motion / no scene: just jump to the overview, no timed sweep.
      scene?.goToPreset('overview');
      return;
    }
    setPlaying(true);
    let i = 0;
    const run = () => {
      if (i >= BEATS.length) { stop(); return; }
      const beat = BEATS[i];
      scene.goToPreset(beat.preset);
      setNote(beat.note);
      i += 1;
      timerRef.current = window.setTimeout(run, beat.dwellMs);
    };
    run();
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'center' }}>
      <div
        style={{
          display: 'flex',
          gap: 4,
          background: tokens.panel,
          border: `1px solid ${tokens.border}`,
          borderRadius: 6,
          padding: 4,
          boxShadow: '0 2px 8px rgba(0,0,0,.35)',
        }}
      >
        {BEATS.map((b) => (
          <CalciteButton
            key={b.preset}
            scale="s"
            appearance="outline"
            iconStart={b.icon}
            onClick={() => scene?.goToPreset(b.preset)}
            title={`Fly to ${b.label}`}
          >
            {b.label}
          </CalciteButton>
        ))}
        <CalciteButton
          scale="s"
          appearance={playing ? 'solid' : 'outline'}
          kind="brand"
          iconStart={playing ? 'pause' : 'play'}
          onClick={() => (playing ? stop() : playOpening())}
          title="Play the 60-second opening choreography"
        >
          {playing ? 'Stop' : 'Play opening'}
        </CalciteButton>
      </div>
      {note && (
        <div
          role="status"
          aria-live="polite"
          style={{
            maxWidth: 640,
            textAlign: 'center',
            fontSize: 13,
            color: tokens.text,
            background: tokens.panel,
            border: `1px solid ${tokens.accent}`,
            borderRadius: 6,
            padding: '6px 12px',
          }}
        >
          {note}
        </div>
      )}
    </div>
  );
}
