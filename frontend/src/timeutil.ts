// Epoch-seconds conversion for ISO-8601 strings (both ...Z and +00:00 forms).

export function toEpoch(iso: string): number {
  return new Date(iso).getTime() / 1000;
}

export function toIso(epochSec: number): string {
  return new Date(epochSec * 1000).toISOString();
}

export function formatClock(epochSec: number): string {
  return new Date(epochSec * 1000).toISOString().replace("T", " ").replace("Z", "");
}

const TICK_STEPS = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 30, 60, 120, 300, 600];

/** Choose a 1/2/5-style tick interval yielding 6-12 ticks across the span. */
export function tickStep(spanSec: number, targetTicks = 8): number {
  for (const s of TICK_STEPS) {
    if (spanSec / s <= targetTicks) return s;
  }
  return 600;
}

export function fmtOffset(sec: number): string {
  const abs = Math.abs(sec);
  if (abs >= 1) return `${trim(sec, 3)} s`;
  if (abs >= 0.001) return `${trim(sec * 1000, 2)} ms`;
  return `${trim(sec * 1e6, 1)} µs`;
}

export function fmtSec(sec: number): string {
  return `${trim(sec, 3)} s`;
}

function trim(v: number, digits: number): string {
  const s = v.toFixed(digits);
  return s.replace(/\.?0+$/, "");
}
