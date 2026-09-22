// Canvas waveform renderer with zoom/pan and pick interaction.
//
// One StationPanel draws all channels of a station, sharing a single time
// window. Interactions:
//   wheel                 -> zoom at cursor
//   drag empty area       -> pan
//   click empty area      -> place a new pick (in P/S mode)
//   double-click a pick   -> select it
//   drag pick line        -> move pick time
//   drag band edge        -> resize +/- uncertainty window
//   Escape                -> cancel placement mode

import type {
  Channel,
  GroupConsensus,
  Phase,
  Pick,
  PickStatus,
} from "./types.js";
import { fmtOffset, tickStep, toEpoch } from "./timeutil.js";

const ROW_H = 58;
const AXIS_H = 26;
const LABEL_W = 48;
const PICK_LINE_W = 2;
const HIT_PX = 7;

type DragKind =
  | { kind: "pan"; startX: number; startT0: number; startT1: number }
  | { kind: "move"; pickId: number; tOffset: number }
  | { kind: "edge-left" | "edge-right"; pickId: number };

export type PanelCallbacks = {
  onSelect: (pickId: number) => void;
  onCreate: (timeEpoch: number) => void;
  onViewChange?: () => void;
};

const PHASE_COLOR: Record<Phase, string> = { P: "#ff8a3d", S: "#53c6ff" };
const STATUS_DASH: Record<PickStatus, number[]> = {
  pending: [],
  accepted: [],
  rejected: [5, 4],
};

function pickColor(p: Pick, conflicted: boolean): string {
  if (p.status === "rejected") return "#7d8696";
  return conflicted ? "#ff5470" : PHASE_COLOR[p.phase];
}

export class StationPanel {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private channels: Channel[];
  private picks: Pick[];
  private consensus: GroupConsensus[];
  private conflictIds: Set<number>;

  // view window in epoch seconds (shared between station panels via link)
  t0: number;
  t1: number;

  private selectedId: number | null = null;
  private placePhase: Phase | null = null;
  private drag: DragKind | null = null;
  private downX: number | null = null;
  private moved = false;
  private ro: ResizeObserver;
  private trackBounds: { min: number; max: number }[];

  constructor(
    container: HTMLElement,
    channels: Channel[],
    picks: Pick[],
    consensus: GroupConsensus[],
    conflictIds: Set<number>,
    t0: number,
    t1: number,
    private cb: PanelCallbacks,
  ) {
    this.channels = channels;
    this.picks = picks;
    this.consensus = consensus;
    this.conflictIds = conflictIds;
    this.t0 = t0;
    this.t1 = t1;

    this.canvas = document.createElement("canvas");
    this.canvas.className = "wave-canvas";
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d")!;

    const starts = channels.map((c) => toEpoch(c.startTime));
    const ends = channels.map(
      (c) => toEpoch(c.startTime) + (c.nSamples - 1) / c.sampleRate,
    );
    this.trackBounds = starts.map((s, i) => ({ min: s, max: ends[i] }));

    this.canvas.addEventListener("wheel", this.onWheel, { passive: false });
    this.canvas.addEventListener("pointerdown", this.onDown);
    window.addEventListener("pointermove", this.onMove);
    window.addEventListener("pointerup", this.onUp);
    this.canvas.addEventListener("dblclick", this.onDblClick);

    this.ro = new ResizeObserver(() => this.render());
    this.ro.observe(this.canvas);
    this.render();
  }

  destroy() {
    this.ro.disconnect();
    this.canvas.removeEventListener("wheel", this.onWheel);
    this.canvas.removeEventListener("pointerdown", this.onDown);
    window.removeEventListener("pointermove", this.onMove);
    window.removeEventListener("pointerup", this.onUp);
    this.canvas.removeEventListener("dblclick", this.onDblClick);
    this.canvas.remove();
  }

  update(picks: Pick[], consensus: GroupConsensus[], conflictIds: Set<number>) {
    this.picks = picks;
    this.consensus = consensus;
    this.conflictIds = conflictIds;
    this.render();
  }

  setWindow(t0: number, t1: number) {
    this.t0 = t0;
    this.t1 = t1;
    this.render();
  }

  setSelected(id: number | null) {
    this.selectedId = id;
    this.render();
  }

  setPlacePhase(phase: Phase | null) {
    this.placePhase = phase;
    this.canvas.style.cursor = phase ? "crosshair" : "";
  }

  zoom(factor: number) {
    const center = (this.t0 + this.t1) / 2;
    const half = ((this.t1 - this.t0) / 2) * factor;
    this.applyZoom(center, half);
  }

  resetWindow(fullT0: number, fullT1: number) {
    this.t0 = fullT0;
    this.t1 = fullT1;
    this.render();
    this.cb.onViewChange?.();
  }

  // ------------------------------------------------------------------ #
  private get cssW(): number {
    return this.canvas.clientWidth || 600;
  }
  private get cssH(): number {
    return AXIS_H + this.channels.length * ROW_H;
  }

  private xOf(t: number): number {
    return LABEL_W + ((t - this.t0) / (this.t1 - this.t0)) * (this.cssW - LABEL_W);
  }
  private tOf(x: number): number {
    return this.t0 + ((x - LABEL_W) / (this.cssW - LABEL_W)) * (this.t1 - this.t0);
  }
  private rowY(i: number): number {
    return AXIS_H + i * ROW_H;
  }

  private pickHit(x: number, y: number): { pick: Pick; edge: "left" | "right" | "line" } | null {
    if (x < LABEL_W) return null;
    const row = Math.floor((y - AXIS_H) / ROW_H);
    // Picks apply to every row of the station; keep vertical tolerance,
    // but prefer a hit on the matching channel if the row is exact.
    const inRow = row >= 0 && row < this.channels.length;
    let best: { pick: Pick; edge: "left" | "right" | "line"; d: number } | null = null;
    for (const p of this.picks) {
      if (p.status === "rejected") continue;
      const t = toEpoch(p.time);
      const dLine = Math.abs(x - this.xOf(t));
      const dL = Math.abs(x - this.xOf(t - p.uncertainty));
      const dR = Math.abs(x - this.xOf(t + p.uncertainty));
      let edge: "left" | "right" | "line" = "line";
      let d = dLine;
      if (dL < d && dL <= HIT_PX) {
        edge = "left";
        d = dL;
      } else if (dR < d && dR <= HIT_PX) {
        edge = "right";
        d = dR;
      }
      if (d <= HIT_PX) {
        const rowOk = inRow && (!p.channel || p.channel === this.channels[row].channel);
        // Tiny preference for a hit on the pick's own channel row.
        const score = d - (rowOk ? 0.5 : 0);
        if (!best || score < best.d) {
          best = { pick: p, edge, d: score };
        }
      }
    }
    return best;
  }

  // ------------------------------------------------------------------ #
  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    if (x < LABEL_W) return;
    const factor = e.deltaY > 0 ? 1.2 : 1 / 1.2;
    const center = this.tOf(x);
    const left = center - this.t0;
    const right = this.t1 - center;
    this.applyZoomAbs(center - left * factor, center + right * factor);
  };

  private applyZoom(center: number, half: number) {
    this.applyZoomAbs(center - half, center + half);
  }

  private applyZoomAbs(n0: number, n1: number) {
    const span = Math.max(n1 - n0, 0.0005);
    // Keep global timeline bounds sane.
    this.t0 = n0;
    this.t1 = n0 + span;
    this.render();
    this.cb.onViewChange?.();
  }

  private onDown = (e: PointerEvent) => {
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    this.downX = x;
    this.moved = false;

    const hit = this.placePhase ? null : this.pickHit(x, y);
    if (hit) {
      if (e.shiftKey || e.button === 2) {
        return; // context menu handles deletion
      }
      this.canvas.setPointerCapture(e.pointerId);
      const t = toEpoch(hit.pick.time);
      if (hit.edge === "left") {
        this.drag = { kind: "edge-left", pickId: hit.pick.id };
      } else if (hit.edge === "right") {
        this.drag = { kind: "edge-right", pickId: hit.pick.id };
      } else {
        this.drag = { kind: "move", pickId: hit.pick.id, tOffset: this.tOf(x) - t };
      }
      return;
    }

    if (x >= LABEL_W && y >= AXIS_H) {
      this.canvas.setPointerCapture(e.pointerId);
      this.drag = { kind: "pan", startX: x, startT0: this.t0, startT1: this.t1 };
    }
  };

  private onMove = (e: PointerEvent) => {
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    if (!this.drag) {
      if (x >= 0 && y >= 0 && x <= this.cssW && y <= this.cssH) {
        const hit = this.pickHit(x, y);
        if (this.placePhase) {
          this.canvas.style.cursor = "crosshair";
        } else if (hit) {
          this.canvas.style.cursor =
            hit.edge === "line" ? "ew-resize" : "col-resize";
        } else {
          this.canvas.style.cursor = y >= AXIS_H && x >= LABEL_W ? "grab" : "";
        }
      }
      return;
    }

    const dx = x - (this.downX ?? x);
    if (Math.abs(e.movementX) + Math.abs(e.movementY) > 0) this.moved = true;

    if (this.drag.kind === "pan") {
      const span = this.drag.startT1 - this.drag.startT0;
      const dt = (-dx / (this.cssW - LABEL_W)) * span;
      this.t0 = this.drag.startT0 + dt;
      this.t1 = this.drag.startT1 + dt;
      this.render();
      this.cb.onViewChange?.();
      return;
    }

    const pick = this.picks.find((p) => p.id === this.draggedPickId());
    if (!pick) return;
    const t = toEpoch(pick.time);

    if (this.drag.kind === "move") {
      const nt = this.tOf(x) - this.drag.tOffset;
      pick.time = new Date(nt * 1000).toISOString();
      this.render();
    } else {
      const nt = this.tOf(x);
      const nu = Math.max(0, this.drag.kind === "edge-left" ? t - nt : nt - t);
      pick.uncertainty = Math.round(nu * 1000) / 1000;
      this.render();
    }
  };

  private draggedPickId(): number | null {
    const d = this.drag;
    return d && d.kind !== "pan" ? d.pickId : null;
  }

  private onUp = (e: PointerEvent) => {
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const wasDrag = this.drag;
    const wasMoved = this.moved;

    const dragPickId = this.draggedPickId();
    if (wasDrag && dragPickId != null && wasMoved) {
      const pick = this.picks.find((p) => p.id === dragPickId);
      if (pick) {
        // Persist the drag result, then let main refresh state.
        window.dispatchEvent(
          new CustomEvent("pick-dragged", {
            detail: { pickId: pick.id, time: pick.time, uncertainty: pick.uncertainty },
          }),
        );
      }
    }

    if (
      wasDrag?.kind === "pan" &&
      !wasMoved &&
      this.placePhase &&
      x >= LABEL_W &&
      y >= AXIS_H &&
      y <= this.cssH
    ) {
      this.cb.onCreate(this.tOf(x));
    }

    this.drag = null;
  };

  private onDblClick = (e: MouseEvent) => {
    const rect = this.canvas.getBoundingClientRect();
    const hit = this.pickHit(e.clientX - rect.left, e.clientY - rect.top);
    if (hit) this.cb.onSelect(hit.pick.id);
  };

  // ------------------------------------------------------------------ #
  render() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.cssW;
    const h = this.cssH;
    this.canvas.style.height = `${h}px`;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // row backgrounds + labels
    this.channels.forEach((ch, i) => {
      const y = this.rowY(i);
      ctx.fillStyle = i % 2 === 0 ? "#171c27" : "#141924";
      ctx.fillRect(LABEL_W, y, w - LABEL_W, ROW_H);
      ctx.fillStyle = "#0d1118";
      ctx.fillRect(0, y, LABEL_W, ROW_H);
      ctx.fillStyle = "#aab4c4";
      ctx.font = "11px ui-monospace, monospace";
      ctx.textBaseline = "middle";
      ctx.fillText(ch.channel, 8, y + ROW_H / 2);
    });

    // gridlines from a shared time axis
    const span = this.t1 - this.t0;
    const step = tickStep(span);
    const first = Math.ceil(this.t0 / step) * step;
    ctx.strokeStyle = "#27303f";
    ctx.lineWidth = 1;
    ctx.font = "10px ui-monospace, monospace";
    ctx.textBaseline = "top";
    for (let t = first; t <= this.t1 + 1e-9; t += step) {
      const x = Math.round(this.xOf(t)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, AXIS_H);
      ctx.lineTo(x, h);
      ctx.stroke();
      ctx.fillStyle = "#7d8696";
      ctx.fillText(fmtOffset(t - toEpoch(this.channels[0].startTime)), x + 3, 2);
    }

    // waveforms
    this.channels.forEach((ch, i) => {
      const y = this.rowY(i);
      this.drawTrace(ch, i, y);
    });

    // pick uncertainty bands (behind lines), across the station height
    for (const p of this.picks) {
      const t = toEpoch(p.time);
      if (t + p.uncertainty < this.t0 || t - p.uncertainty > this.t1) continue;
      const xL = this.xOf(t - p.uncertainty);
      const xR = this.xOf(t + p.uncertainty);
      const color = pickColor(p, this.conflictIds.has(p.id));
      ctx.fillStyle = p.status === "rejected" ? "rgba(125,134,150,0.08)" : hexA(color, 0.13);
      ctx.fillRect(Math.max(LABEL_W, xL), AXIS_H, xR - xL, h - AXIS_H);
    }

    // consensus intervals + center ticks
    for (const g of this.consensus) {
      if (!g.time) continue;
      const t = toEpoch(g.time);
      if (t + (g.uncertainty ?? 0) < this.t0 || t - (g.uncertainty ?? 0) > this.t1) continue;
      const color = g.consistent ? "#9be07c" : "#ffd166";
      const xL = this.xOf(t - (g.uncertainty ?? 0));
      const xR = this.xOf(t + (g.uncertainty ?? 0));
      ctx.strokeStyle = hexA(color, 0.9);
      ctx.setLineDash([8, 3]);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(Math.max(LABEL_W, xL), AXIS_H + 2);
      ctx.lineTo(Math.max(LABEL_W, xL), h - 2);
      ctx.moveTo(Math.min(w, xR), AXIS_H + 2);
      ctx.lineTo(Math.min(w, xR), h - 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // pick lines + edge handles + labels
    for (const p of this.picks) {
      const t = toEpoch(p.time);
      if (t < this.t0 - 1 || t > this.t1 + 1) continue;
      const x = this.xOf(t);
      const color = pickColor(p, this.conflictIds.has(p.id));
      ctx.strokeStyle = color;
      ctx.lineWidth = p.id === this.selectedId ? 3 : PICK_LINE_W;
      ctx.setLineDash(STATUS_DASH[p.status]);
      ctx.beginPath();
      ctx.moveTo(x, AXIS_H);
      ctx.lineTo(x, h);
      ctx.stroke();
      ctx.setLineDash([]);

      // edge handles
      ctx.fillStyle = color;
      for (const s of [-1, 1]) {
        const xe = this.xOf(t + s * p.uncertainty);
        if (xe < LABEL_W || xe > w) continue;
        ctx.fillRect(xe - 1.5, AXIS_H + 2, 3, 7);
      }

      // phase chip at top
      ctx.fillStyle = color;
      const label = `${p.phase}${p.author ? " " + p.author : ""}`;
      ctx.font = "bold 10px ui-monospace, monospace";
      const tw = ctx.measureText(label).width;
      const lx = Math.min(Math.max(x - tw / 2 - 3, LABEL_W), w - tw - 6);
      ctx.fillRect(lx, AXIS_H - 1, tw + 6, 12);
      ctx.fillStyle = "#0d1118";
      ctx.textBaseline = "middle";
      ctx.fillText(label, lx + 3, AXIS_H + 5);
    }

    // placement-mode hint line follows nothing; just tint border
    this.canvas.classList.toggle("placing", this.placePhase !== null);
  }

  private drawTrace(ch: Channel, idx: number, yTop: number) {
    const ctx = this.ctx;
    const bounds = this.trackBounds[idx];
    const start = Math.max(this.t0, bounds.min);
    const end = Math.min(this.t1, bounds.max);
    if (end <= bounds.min || start >= bounds.max) {
      // off-track: flat baseline
      ctx.strokeStyle = "#3a4456";
      ctx.beginPath();
      ctx.moveTo(LABEL_W, yTop + ROW_H / 2);
      ctx.lineTo(this.cssW, yTop + ROW_H / 2);
      ctx.stroke();
      return;
    }

    const samples = ch.samples;
    const dt = 1 / ch.sampleRate;
    const iStart = Math.max(0, Math.floor((start - bounds.min) / dt));
    const iEnd = Math.min(samples.length - 1, Math.ceil((end - bounds.min) / dt));
    const plotW = this.cssW - LABEL_W;

    // normalise on the visible segment so zooming stays readable
    let vmax = 1e-9;
    for (let i = iStart; i <= iEnd; i++) vmax = Math.max(vmax, Math.abs(samples[i]));
    const mid = yTop + ROW_H / 2;
    const amp = (ROW_H / 2 - 5) / vmax;

    const pxPerSample = ((dt / (this.t1 - this.t0)) * plotW);
    ctx.strokeStyle = idx % 2 === 0 ? "#8fb8ff" : "#6fe3c9";
    ctx.lineWidth = 1;
    ctx.beginPath();

    if (pxPerSample < 1) {
      // min/max envelope: two samples per output pixel
      const stride = Math.max(1, Math.floor(1 / pxPerSample));
      let first = true;
      for (let i = iStart; i <= iEnd; i += stride) {
        let lo = Infinity;
        let hi = -Infinity;
        const jTo = Math.min(iEnd, i + stride - 1);
        for (let j = i; j <= jTo; j++) {
          const v = samples[j];
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
        const t = bounds.min + i * dt;
        const x = this.xOf(t);
        ctx.moveTo(x, mid + hi * amp);
        ctx.lineTo(x, mid + lo * amp);
        if (first) {
          first = false;
        }
      }
    } else {
      for (let i = iStart; i <= iEnd; i++) {
        const x = this.xOf(bounds.min + i * dt);
        const y = mid + samples[i] * amp;
        if (i === iStart) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
    }
    ctx.stroke();

    // zero line
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.beginPath();
    ctx.moveTo(LABEL_W, mid);
    ctx.lineTo(this.cssW, mid);
    ctx.stroke();
  }
}

function hexA(hex: string, alpha: number): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}
