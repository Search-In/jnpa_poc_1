/**
 * <HeaderAsOfDatePicker> — header control pinning the dashboard's data anchor
 * to a specific corpus date (UC1-004). The corpus is historical (May-Jul 2026)
 * with no rows for the live demo window, so picking a date re-anchors every
 * UC-3 read (vessels, berths, KPIs, plan) to that day's "latest actual"
 * instead of wall-clock now (spec UI-001/UI-002: one authoritative clock,
 * no screen reads browser time). Clearing the field returns to the backend's
 * own live anchor. Backed by `asOfDate.ts`; `Uc3Adapter` reads the pin on
 * every fetch, so this updates the dashboard in place — no reload.
 */
import { useSyncExternalStore } from 'react';
import { CalciteChip, CalciteInputDatePicker } from '@esri/calcite-components-react';
import { getAsOfDate, setAsOfDate, subscribeAsOfDate } from '@/data/asOfDate';

// The shared UC-3 corpus only carries berthing-report rows for this window;
// bounding the picker to it keeps the operator from landing on an empty day.
const CORPUS_MIN = '2026-05-01';
const CORPUS_MAX = '2026-07-31';

export function HeaderAsOfDatePicker() {
  const date = useSyncExternalStore(subscribeAsOfDate, getAsOfDate, getAsOfDate);

  return (
    <span
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
      title={
        date
          ? `Pinned to ${date} — vessels, berths and KPIs are anchored to this corpus day. Clear the field to return to the live anchor.`
          : 'Pin the dashboard to a corpus date — vessels, berths and KPIs will re-anchor to that day.'
      }
    >
      <CalciteInputDatePicker
        scale="s"
        value={date}
        min={CORPUS_MIN}
        max={CORPUS_MAX}
        aria-label="Dashboard as-of date"
        onCalciteInputDatePickerChange={(e) => {
          const target = e.target as unknown as { value: string | string[] };
          const value = Array.isArray(target.value) ? target.value[0] ?? '' : target.value;
          setAsOfDate(value ?? '');
        }}
      />
      <CalciteChip scale="s" kind={date ? 'brand' : 'neutral'} icon="clock" aria-label={date ? `Pinned to ${date}` : 'Live anchor'}>
        {date ? `Pinned · ${date}` : 'Live anchor'}
      </CalciteChip>
    </span>
  );
}
