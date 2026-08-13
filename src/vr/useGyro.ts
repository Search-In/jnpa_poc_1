/**
 * Device-orientation ("gyro") look-around for cardboard VR.
 *
 * Getting this right on real phones needs four things the naive
 * `addEventListener('deviceorientation')` does not do:
 *
 *  1. **A secure context.** Browsers only expose motion sensors on HTTPS (or
 *     localhost). Served over `http://192.168.x.x:5173` — the obvious way to
 *     open the app on a phone — the event simply never fires, with no error.
 *     That silence is the single most common reason "the gyro does not work",
 *     so it is detected up front and reported.
 *
 *  2. **Absolute orientation where available.** Plain `deviceorientation` on
 *     Android is frequently RELATIVE: `alpha` drifts and is not referenced to
 *     north, so the port slowly rotates away under you. Chrome fires
 *     `deviceorientationabsolute` for the compass-referenced feed; prefer it
 *     and fall back only if it never arrives.
 *
 *  3. **iOS's compass.** Safari does not put true north in `alpha`; it supplies
 *     `webkitCompassHeading` (degrees clockwise from north) instead. When that
 *     is present it overrides the derived heading.
 *
 *  4. **A permission gesture.** iOS 13+ gates the sensors behind
 *     `DeviceOrientationEvent.requestPermission()`, which must be called from a
 *     user gesture — hence `request()` rather than auto-starting.
 *
 *  5. **Rate-independent smoothing.** The sensor is noisy at rest and the event
 *     rate varies by handset, so a fixed blend weight is either jittery or
 *     laggy and is never the same twice. `HeadTracker` applies a 1€ filter over
 *     the MEASURED interval instead — see `headTracking.ts`.
 *
 * A watchdog covers the remaining case: permission granted, listener attached,
 * and still no events (some desktop browsers, some locked-down devices).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { HeadTracker, type Look } from './headTracking';
import { coalesceToFrame } from './frameCoalesce';

export type GyroStatus =
  /** Not requested yet. */
  | 'idle'
  /** No `DeviceOrientationEvent` at all. */
  | 'unsupported'
  /** Page is not a secure context — the sensor is blocked by the browser. */
  | 'insecure'
  /** iOS permission prompt was declined. */
  | 'denied'
  /** Listening, but no reading has arrived yet. */
  | 'waiting'
  /** Readings are flowing. */
  | 'live';

interface DeviceOrientationEventStatic {
  requestPermission?: () => Promise<'granted' | 'denied'>;
}

/** iOS adds a true-north compass heading that `alpha` does not carry. */
interface CompassEvent extends DeviceOrientationEvent {
  webkitCompassHeading?: number;
  webkitCompassAccuracy?: number;
}

export interface GyroFeed {
  status: GyroStatus;
  /** Operator-facing explanation when `status` is not 'live'. */
  message: string | null;
  /** True once at least one reading has been delivered. */
  live: boolean;
  /** Ask for permission and start listening. Must be called from a gesture. */
  request: () => Promise<void>;
  stop: () => void;
}

const MESSAGES: Record<Exclude<GyroStatus, 'live' | 'idle'>, string> = {
  unsupported: 'This device reports no orientation sensor, so look-around is unavailable.',
  insecure:
    'Motion sensors are blocked because this page is not served over HTTPS. ' +
    'Start the dev server with VITE_DEV_HTTPS=true and open the https:// address on the phone.',
  denied: 'Motion access was declined. Reload and allow it to look around.',
  waiting:
    'Waiting for the orientation sensor… if nothing happens, the device may not expose one.',
};

/**
 * @param enabled  only listen while this is true (VR mode)
 * @param onLook   called with a smoothed heading/tilt on every reading
 */
export function useGyro(enabled: boolean, onLook: (heading: number, tilt: number) => void): GyroFeed {
  const [status, setStatus] = useState<GyroStatus>('idle');
  const [armed, setArmed] = useState(false);
  const onLookRef = useRef(onLook);
  onLookRef.current = onLook;

  const request = useCallback(async () => {
    if (typeof window === 'undefined' || !window.DeviceOrientationEvent) {
      setStatus('unsupported');
      return;
    }
    // Checked BEFORE the permission prompt: on an insecure origin iOS grants
    // permission and then never fires an event, which is maximally confusing.
    if (window.isSecureContext === false) {
      setStatus('insecure');
      return;
    }
    const DOE = window.DeviceOrientationEvent as unknown as DeviceOrientationEventStatic;
    try {
      if (typeof DOE.requestPermission === 'function') {
        if ((await DOE.requestPermission()) !== 'granted') {
          setStatus('denied');
          return;
        }
      }
      setStatus('waiting');
      setArmed(true);
    } catch {
      setStatus('denied');
    }
  }, []);

  const stop = useCallback(() => {
    setArmed(false);
    setStatus('idle');
  }, []);

  useEffect(() => {
    if (!enabled || !armed) return;

    const tracker = new HeadTracker();
    let gotAbsolute = false;
    let gotAny = false;

    /**
     * The sensor fires up to 60 times a second; the scene renders at 20–30 in
     * stereo on a phone. Writing a camera per EVENT queued two or three pose
     * changes for every frame the renderer actually drew — work that could only
     * ever be discarded, taken out of the same main-thread budget the renderer
     * was already short of. So readings are filtered as they arrive (the filter
     * wants every sample it can get) and only the newest is published, once per
     * animation frame.
     */
    let pending: Look | null = null;
    const publisher = coalesceToFrame(() => {
      if (!pending) return;
      const { heading, tilt } = pending;
      pending = null;
      onLookRef.current(heading, tilt);
    });

    const handle = (e: DeviceOrientationEvent, absolute: boolean) => {
      // Once the absolute feed is alive, ignore the relative one so the two
      // cannot fight over the heading.
      if (absolute) gotAbsolute = true;
      else if (gotAbsolute) return;

      const look = tracker.update({
        alpha: e.alpha,
        beta: e.beta,
        gamma: e.gamma,
        compassHeading: (e as CompassEvent).webkitCompassHeading,
        timeStampMs: e.timeStamp,
      });
      if (!look) return;

      if (!gotAny) {
        gotAny = true;
        setStatus('live');
      }

      pending = look;
      publisher.schedule();
    };

    const onAbs = (e: DeviceOrientationEvent) => handle(e, true);
    const onRel = (e: DeviceOrientationEvent) => handle(e, false);

    window.addEventListener('deviceorientationabsolute', onAbs, true);
    window.addEventListener('deviceorientation', onRel, true);

    // If nothing has arrived after a couple of seconds, say so rather than
    // leaving the viewer staring at a frozen horizon wondering why.
    const watchdog = window.setTimeout(() => {
      if (!gotAny) setStatus('waiting');
    }, 2000);

    return () => {
      window.clearTimeout(watchdog);
      publisher.cancel();
      window.removeEventListener('deviceorientationabsolute', onAbs, true);
      window.removeEventListener('deviceorientation', onRel, true);
      tracker.reset();
    };
  }, [enabled, armed]);

  // Dropping out of VR disarms the sensor so it is re-requested on re-entry.
  useEffect(() => {
    if (!enabled && armed) {
      setArmed(false);
      setStatus('idle');
    }
  }, [enabled, armed]);

  return {
    status,
    message: status === 'live' || status === 'idle' ? null : MESSAGES[status],
    live: status === 'live',
    request,
    stop,
  };
}
