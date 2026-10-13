/**
 * Clip blocks laid out proportionally on a timeline track.
 *
 * Drag a block onto another to reorder (pure array move in the store). Rendering
 * only — the component receives start times computed from clip durations.
 */

import { useRef, useState } from 'react';
import type { Clip } from '../api-types.ts';

export interface TimelineTrackProps {
  clips: Clip[];
  starts: Map<string, number>;
  durationSec: number;
  selectedClipId: string | null;
  onSelect: (id: string) => void;
  onReorder: (id: string, toIndex: number) => void;
}

export default function TimelineTrack({
  clips,
  starts,
  durationSec,
  selectedClipId,
  onSelect,
  onReorder,
}: TimelineTrackProps) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);

  const pct = (sec: number): number => (durationSec > 0 ? (sec / durationSec) * 100 : 0);

  if (clips.length === 0) {
    return (
      <div className="panel" style={{ textAlign: 'center', color: 'var(--muted)', fontSize: 12 }}>
        時間軸是空的 — 先載入一個音訊檔。
      </div>
    );
  }

  return (
    <div>
      <div
        ref={trackRef}
        style={{
          position: 'relative',
          height: 62,
          background: '#0f1116',
          border: '1px solid var(--line)',
          borderRadius: 6,
          overflow: 'hidden',
        }}
      >
        {clips.map((c, i) => {
          const start = starts.get(c.id) ?? 0;
          const dur = Math.max(0, c.srcOut - c.srcIn);
          const left = pct(start);
          const width = Math.max(0.4, pct(dur));
          const selected = c.id === selectedClipId;
          return (
            <div
              key={c.id}
              draggable
              onDragStart={(e) => {
                setDragId(c.id);
                e.dataTransfer.effectAllowed = 'move';
                // Some browsers refuse to start a drag without payload.
                e.dataTransfer.setData('text/plain', c.id);
              }}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                setOverIndex(i);
              }}
              onDragLeave={() => setOverIndex((v) => (v === i ? null : v))}
              onDrop={(e) => {
                e.preventDefault();
                if (dragId) onReorder(dragId, i);
                setDragId(null);
                setOverIndex(null);
              }}
              onDragEnd={() => {
                setDragId(null);
                setOverIndex(null);
              }}
              onClick={() => onSelect(c.id)}
              title={`${c.label ?? c.id} — ${start.toFixed(2)}s → ${(start + dur).toFixed(2)}s`}
              style={{
                position: 'absolute',
                left: `${left}%`,
                width: `${width}%`,
                top: 6,
                bottom: 6,
                background: selected ? 'var(--clip-sel)' : 'var(--clip)',
                border: `1px solid ${selected ? 'var(--accent)' : '#3d5878'}`,
                borderRadius: 4,
                cursor: 'grab',
                overflow: 'hidden',
                opacity: dragId === c.id ? 0.5 : 1,
                outline: overIndex === i && dragId && dragId !== c.id ? '2px dashed var(--accent)' : 'none',
                outlineOffset: -2,
                padding: '2px 4px',
              }}
            >
              <div
                style={{
                  fontSize: 11,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {i + 1}. {c.label ?? c.sourceId}
              </div>
              <div className="tiny muted">{dur.toFixed(2)}s</div>
              {c.effects.length > 0 ? (
                <div className="tiny" style={{ color: 'var(--warn)' }}>
                  fx×{c.effects.length}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      <div className="legend" style={{ marginTop: 4 }}>
        <span>
          <span className="swatch" style={{ background: 'var(--clip)' }} />
          clip
        </span>
        <span>
          <span className="swatch" style={{ background: 'var(--clip-sel)' }} />
          選取中
        </span>
        <span>拖曳 clip 區塊可重排；拖曳波形可設定播放頭／選取範圍。</span>
      </div>
    </div>
  );
}
