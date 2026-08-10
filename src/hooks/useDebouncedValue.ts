/**
 * useDebouncedValue — mirror a value, but only after it has stopped changing for
 * `delayMs`. The immediate value stays the source of truth for a controlled input
 * (so typing is always visible); a debounced copy is what drives an expensive
 * dependency such as a server-side query key, so a burst of keystrokes collapses
 * into one downstream update instead of one per character.
 */

import { useEffect, useState } from 'react';

export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);

  return debounced;
}
