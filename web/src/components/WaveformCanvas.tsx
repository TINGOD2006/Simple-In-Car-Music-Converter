/**
 * Canvas waveform + time ruler, with client-side zoom.
 *
 * Pure rendering: it draws whatever `peaks` the engine returned and reports
 * pointer positions back as seconds. It never computes audio and never asks the
 * engine for anything — zooming only changes which slice of the already-fetched
 * `peaks` array is drawn, so a wheel tick costs one canvas repaint, not an HTTP
 * request.
 *
 * TIME BASE: every second-valued prop is in the SOURCE's own time base (the same
 * base as `peaks`), not timeline seconds. The parent translates with
 * `timelineToSource` / `sourceToTimelineForSource`. Keeping the canvas in one
 * base is what makes a trimmed clip's playhead land on the right sample.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export interface WaveformCanvasProps {
  peaks: number[];
  /** Duration of the source the peaks belong to, in seconds. */
  durationSec: number;
  playheadSec: number;
  selection: { from: number; to: number } | null;
  /** Clip boundaries drawn as vertical markers, in source seconds. */
  markers?: { at: number; label?: string }[];
  height?: number;
  /** Extra hint shown under the ruler (e.g. the source path). */
  hint?: string;
  onSeek: (sec: number) => void;
  onSelect: (range: { from: number; to: number } | null) => void;
  /** Nudge the selection by `deltaSec` (positive = later). Keyboard/buttons. */
  onNudgeSelection?: (deltaSec: number) => void;
  /** Resize the selection's `to` edge by `deltaSec` (the keyboard extend). */
  onExtendSelection?: (deltaSec: number) => void;
}

const COLORS = {
  bg: '#0f1116',
  wave: '#4c8dff',
  waveDim: '#2f4a6e',
  axis: '#333a45',
  playhead: '#ff6b5e',
  selection: 'rgba(76,141,255,0.22)',
  marker: '#e0a33c',
  ruler: '#98a2b3',
  rulerLine: '#2a3038',
  viewport: 'rgba(76,141,255,0.35)',
};

/** Nice ruler steps in seconds, coarse enough to stay readable at any zoom. */
const TICK_STEPS = [
  0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800,
];

const RULER_H = 18;
const MIN_TICK_PX = 64;

export default function WaveformCanvas({
  peaks,
  durationSec,
  playheadSec,
  selection,
  markers,
  height = 150,
  hint,
  onSeek,
  onSelect,
  onNudgeSelection,
  onExtendSelection,
}: WaveformCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(800);
  const [view, setView] = useState<{ startSec: number; endSec: number }>({
    startSec: 0,
    endSec: Math.max(0.001, durationSec),
  });
  const dragStart = useRef<number | null>(null);
  const panFrom = useRef<{ x: number; start: number; end: number } | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;

  const total = Math.max(0.001, durationSec);
  const minSpan = useMemo(
    () => Math.max(0.002, total / Math.max(1, peaks.length) / 4),
    [total, peaks.length],
  );

  /** Clamp a candidate viewport into `[0, total]` and never below `minSpan`. */
  const clampView = useCallback(
    (startSec: number, endSec: number): { startSec: number; endSec: number } => {
      let span = Math.min(total, Math.max(minSpan, endSec - startSec));
      let start = startSec;
      if (start + span > total) start = total - span;
      if (start < 0) start = 0;
      span = Math.min(span, total);
      return { startSec: start, endSec: start + span };
    },
    [total, minSpan],
  );

  // A new source (or a re-requested waveform) starts fully zoomed out.
  useEffect(() => {
    setView({ startSec: 0, endSec: total });
  }, [total]);

  // Keep the canvas crisp and responsive without a layout library.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 800;
      setWidth(Math.max(200, Math.floor(w)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const span = Math.max(minSpan, view.endSec - view.startSec);
  const start = view.startSec;

  const xToSec = useCallback(
    (x: number): number => start + (x / Math.max(1, width)) * span,
    [start, span, width],
  );
  const secToX = useCallback(
    (sec: number): number => ((sec - start) / span) * width,
    [start, span, width],
  );

  const zoomAt = useCallback(
    (factor: number, anchorSec: number): void => {
      const v = viewRef.current;
      const cur = Math.max(minSpan, v.endSec - v.startSec);
      const nextSpan = Math.min(total, Math.max(minSpan, cur / factor));
      const ratio = cur > 0 ? (anchorSec - v.startSec) / cur : 0.5;
      setView(clampView(anchorSec - ratio * nextSpan, anchorSec - ratio * nextSpan + nextSpan));
    },
    [clampView, minSpan, total],
  );

  const panBy = useCallback(
    (deltaSec: number): void => {
      const v = viewRef.current;
      setView(clampView(v.startSec + deltaSec, v.endSec + deltaSec));
    },
    [clampView],
  );

  const zoomToSelection = useCallback((): void => {
    if (!selection || selection.to - selection.from <= 0) return;
    const pad = (selection.to - selection.from) * 0.05;
    setView(clampView(selection.from - pad, selection.to + pad));
  }, [clampView, selection]);

  // Wheel zoom has to be a native non-passive listener: React's synthetic
  // `onWheel` cannot reliably `preventDefault()`, so the page would scroll while
  // zooming.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      if (e.shiftKey) {
        panBy((e.deltaY > 0 ? 1 : -1) * span * 0.15);
        return;
      }
      zoomAt(e.deltaY < 0 ? 1.25 : 0.8, xToSec(x));
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [panBy, span, xToSec, zoomAt]);

  /* ---------------------------------------------------------------- */
  /* Drawing                                                           */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const h = height + RULER_H;
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(h * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, h);

    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, width, h);

    const mid = RULER_H + height / 2;

    // Centre axis.
    ctx.strokeStyle = COLORS.axis;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, mid);
    ctx.lineTo(width, mid);
    ctx.stroke();

    // Waveform: one vertical bar per pixel column, taking the MAX peak inside
    // that column's time slice. Taking the max (instead of stretching one bucket
    // across several columns) is what makes zoomed-in detail real rather than a
    // blurred block, and it stays O(width + buckets).
    if (peaks.length > 0 && span > 0) {
      const bucketSec = total / peaks.length;
      for (let x = 0; x < width; x += 1) {
        const sec0 = start + (x / width) * span;
        const sec1 = start + ((x + 1) / width) * span;
        let i0 = Math.floor(sec0 / bucketSec);
        let i1 = Math.ceil(sec1 / bucketSec);
        if (i1 <= i0) i1 = i0 + 1;
        i0 = Math.max(0, i0);
        i1 = Math.min(peaks.length, i1);
        let p = 0;
        for (let i = i0; i < i1; i += 1) {
          const v = peaks[i] ?? 0;
          if (v > p) p = v;
        }
        if (p <= 0) continue;
        const hh = Math.max(1, Math.min(1, p) * (height / 2 - 6));
        ctx.fillStyle = p > 0.9 ? COLORS.playhead : COLORS.wave;
        ctx.fillRect(x, mid - hh, 1, hh * 2);
      }
    } else {
      ctx.fillStyle = COLORS.waveDim;
      ctx.font = '12px "Segoe UI", sans-serif';
      ctx.fillText('尚無波形資料（載入檔案或引擎未連線）', 10, mid - 8);
    }

    // Ruler: pick the coarsest nice step that keeps ticks at least MIN_TICK_PX
    // apart, then label each tick.
    const step = TICK_STEPS.find((s) => (s / span) * width >= MIN_TICK_PX) ?? TICK_STEPS[TICK_STEPS.length - 1]!;
    ctx.font = '10px Consolas, monospace';
    ctx.textBaseline = 'top';
    const first = Math.ceil(start / step) * step;
    for (let t = first; t <= view.endSec + 1e-9; t += step) {
      const x = Math.round(secToX(t)) + 0.5;
      ctx.strokeStyle = COLORS.rulerLine;
      ctx.beginPath();
      ctx.moveTo(x, RULER_H - 4);
      ctx.lineTo(x, h);
      ctx.stroke();
      ctx.fillStyle = COLORS.ruler;
      ctx.fillText(formatSec(t, step), x + 3, 2);
    }

    // Selection band.
    if (selection && selection.to > selection.from) {
      const x0 = secToX(selection.from);
      const x1 = secToX(selection.to);
      ctx.fillStyle = COLORS.selection;
      ctx.fillRect(x0, RULER_H, Math.max(1, x1 - x0), height);
      ctx.strokeStyle = COLORS.wave;
      ctx.strokeRect(x0 + 0.5, RULER_H + 0.5, Math.max(1, x1 - x0 - 1), height - 1);
      // Numeric readout on the band itself — the drag equivalent of the fields
      // under the canvas.
      const label = `${selection.from.toFixed(3)} → ${selection.to.toFixed(3)}s  (${(selection.to - selection.from).toFixed(3)}s)`;
      ctx.font = '11px Consolas, monospace';
      const tw = ctx.measureText(label).width;
      const lx = Math.min(Math.max(2, x0), Math.max(2, width - tw - 8));
      ctx.fillStyle = 'rgba(15,17,22,0.85)';
      ctx.fillRect(lx - 2, RULER_H + 2, tw + 6, 15);
      ctx.fillStyle = '#e6e9ef';
      ctx.fillText(label, lx + 1, RULER_H + 4);
    }

    // Clip boundary markers (source seconds).
    if (markers && markers.length > 0) {
      ctx.strokeStyle = COLORS.marker;
      ctx.setLineDash([3, 3]);
      for (const m of markers) {
        if (m.at < start - 1e-9 || m.at > view.endSec + 1e-9) continue;
        const x = secToX(m.at);
        ctx.beginPath();
        ctx.moveTo(x, RULER_H);
        ctx.lineTo(x, h);
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }

    // Playhead.
    if (playheadSec >= start - 1e-9 && playheadSec <= view.endSec + 1e-9) {
      const x = secToX(playheadSec);
      ctx.strokeStyle = COLORS.playhead;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, RULER_H);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
  }, [
    peaks,
    total,
    playheadSec,
    selection,
    markers,
    width,
    height,
    span,
    start,
    view.endSec,
    secToX,
  ]);

  const secAtEvent = (clientX: number): number => {
    const canvas = canvasRef.current;
    if (!canvas) return 0;
    const rect = canvas.getBoundingClientRect();
    const x = ((clientX - rect.left) / Math.max(1, rect.width)) * width;
    return Math.max(0, Math.min(total, xToSec(x)));
  };

  const zoomed = span < total - 1e-9;

  return (
    <div ref={wrapRef} style={{ width: '100%' }}>
      <canvas
        ref={canvasRef}
        style={{
          width: '100%',
          height: height + RULER_H,
          display: 'block',
          borderRadius: 6,
          cursor: 'crosshair',
          touchAction: 'none',
        }}
        onPointerDown={(e) => {
          const el = e.target as HTMLCanvasElement;
          el.setPointerCapture(e.pointerId);
          const sec = secAtEvent(e.clientX);
          // Alt (or middle button) pans the viewport instead of selecting.
          if (e.altKey || e.button === 1) {
            panFrom.current = { x: e.clientX, start: view.startSec, end: view.endSec };
            return;
          }
          dragStart.current = sec;
          onSeek(sec);
          onSelect(null);
        }}
        onPointerMove={(e) => {
          const pan = panFrom.current;
          if (pan) {
            const rect = e.currentTarget.getBoundingClientRect();
            const perPx = (pan.end - pan.start) / Math.max(1, rect.width);
            const dx = (e.clientX - pan.x) * perPx;
            setView(clampView(pan.start - dx, pan.end - dx));
            return;
          }
          if (dragStart.current === null) return;
          const sec = secAtEvent(e.clientX);
          const a = dragStart.current;
          if (Math.abs(sec - a) > minSpan / 20) {
            onSelect({ from: Math.min(a, sec), to: Math.max(a, sec) });
          }
        }}
        onPointerUp={(e) => {
          if (panFrom.current) {
            panFrom.current = null;
            return;
          }
          const a = dragStart.current;
          dragStart.current = null;
          if (a === null) return;
          const sec = secAtEvent(e.clientX);
          if (Math.abs(sec - a) <= minSpan / 20) {
            onSelect(null);
          } else {
            onSelect({ from: Math.min(a, sec), to: Math.max(a, sec) });
          }
        }}
        onDoubleClick={() => setView({ startSec: 0, endSec: total })}
      />

      {/* Zoom toolbar. Every button is a pure view transform. */}
      <div className="toolbar" style={{ marginTop: 6, fontSize: 12 }}>
        <button onClick={() => zoomAt(1.5, start + span / 2)} title="放大（滾輪向上）">
          ＋
        </button>
        <button onClick={() => zoomAt(1 / 1.5, start + span / 2)} title="縮小（滾輪向下）">
          －
        </button>
        <button onClick={() => setView({ startSec: 0, endSec: total })} disabled={!zoomed} title="雙擊波形亦可">
          全部
        </button>
        <button onClick={zoomToSelection} disabled={!selection} title="縮放至目前選取範圍">
          縮放至選取
        </button>
        <button onClick={() => panBy(-span * 0.5)} disabled={!zoomed} title="Shift+滾輪">
          ◀ 平移
        </button>
        <button onClick={() => panBy(span * 0.5)} disabled={!zoomed}>
          平移 ▶
        </button>
        <span className="mono tiny muted">
          檢視 {start.toFixed(3)}–{view.endSec.toFixed(3)}s / {total.toFixed(3)}s（
          {(total / span).toFixed(2)}×）
        </span>
        <span className="sep" />
        <button
          onClick={() => onNudgeSelection?.(-0.1)}
          disabled={!selection || !onNudgeSelection}
          title="Alt+←"
        >
          ← 選取
        </button>
        <button
          onClick={() => onNudgeSelection?.(0.1)}
          disabled={!selection || !onNudgeSelection}
          title="Alt+→"
        >
          選取 →
        </button>
        <button
          onClick={() => onExtendSelection?.(0.1)}
          disabled={!onExtendSelection}
          title="Shift+→"
        >
          延長 ▶
        </button>
        <button
          onClick={() => onExtendSelection?.(-0.1)}
          disabled={!onExtendSelection}
          title="Shift+←"
        >
          ◀ 縮短
        </button>
      </div>
      <p className="hint" style={{ marginTop: 4 }}>
        滾輪縮放（指標位置為錨點）、Shift+滾輪平移、Alt+拖曳平移、拖曳選取、雙擊回到全曲。
        {hint ? ` ${hint}` : ''}
      </p>
    </div>
  );
}

/** `1:23.450` for coarse steps, `12.345s` for fine ones. */
function formatSec(sec: number, step: number): string {
  if (step >= 1) {
    const m = Math.floor(sec / 60);
    const s = sec - m * 60;
    return `${m}:${s.toFixed(0).padStart(2, '0')}`;
  }
  const decimals = step >= 0.1 ? 1 : step >= 0.01 ? 2 : 3;
  return `${sec.toFixed(decimals)}s`;
}
