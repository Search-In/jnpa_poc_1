/**
 * useHashRoute — a minimal hash router (PoC_1 has no router dependency). It
 * returns the current `location.hash` path (without the leading `#`, defaulting
 * to `/`) and re-renders on `hashchange`. `navigate` sets the hash. This is all
 * we need to split the app into the dashboard (`#/`) and the standalone
 * Simulator control room (`#/simulator`), matching PoC_2's approach.
 */
import { useEffect, useState } from 'react';

function currentPath(): string {
  const h = window.location.hash.replace(/^#/, '');
  return h || '/';
}

export function useHashRoute(): string {
  const [path, setPath] = useState(currentPath);
  useEffect(() => {
    const onChange = () => setPath(currentPath());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return path;
}

export function navigate(path: string): void {
  window.location.hash = path;
}
