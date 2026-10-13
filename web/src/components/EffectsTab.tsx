/**
 * Effects panel.
 *
 * Lists the 14 engine effects, lets the user attach them to the selected clip and
 * tune parameters. The output of every interaction is an `EffectInstance` — pure
 * data. The engine is the only thing that turns it into an ffmpeg filter chain.
 */

import { useApp } from '../app-context.ts';
import {
  EFFECT_META,
  EFFECT_ORDER,
  getParam,
} from '../effects-meta.ts';
import {
  editAddEffect,
  editRemoveEffect,
  editToggleEffect,
  editUpdateEffect,
} from '../store.ts';
import type { EffectInstance, EffectType, EqBand } from '../api-types.ts';

export default function EffectsTab(): JSX.Element {
  const { state, dispatch } = useApp();

  const clip = state.timeline.clips.find((c) => c.id === state.selectedClipId) ?? null;

  const apply = (r: { label: string; next: typeof state.timeline } | null): void => {
    if (!r) return;
    dispatch({ type: 'edit', label: r.label, next: r.next });
  };

  return (
    <div className="row" style={{ alignItems: 'flex-start' }}>
      {/* ---------------- Available effects ---------------- */}
      <div className="panel" style={{ flex: '0 0 300px' }}>
        <h2>可用效果（{EFFECT_ORDER.length}）</h2>
        <p className="hint">
          依引擎處理順序排列：修復 → 降噪 → 等化 → 動態 → 空間 → 增益 → 速度。
        </p>
        <div className="col" style={{ marginTop: 8 }}>
          {EFFECT_ORDER.map((t) => {
            const meta = EFFECT_META[t];
            return (
              <div key={t} className="cliprow" style={{ cursor: 'default' }}>
                <span className="grow">
                  {meta.label}
                  <span className="mono tiny muted"> ({t})</span>
                </span>
                <span className="pill">stage {meta.stage}</span>
                <button
                  className="primary"
                  disabled={!clip}
                  onClick={() => clip && apply(editAddEffect(state, clip.id, t))}
                >
                  加入
                </button>
              </div>
            );
          })}
        </div>
        {!clip ? <p className="hint">先在「編輯器」選取一個 clip。</p> : null}
      </div>

      {/* ---------------- Chain on the selected clip ---------------- */}
      <div className="panel" style={{ flex: 1 }}>
        <h2>目前 clip 的效果鏈{clip ? ` — ${clip.label ?? clip.id}` : ''}</h2>

        {!clip ? (
          <p className="hint">未選取 clip。</p>
        ) : clip.effects.length === 0 ? (
          <p className="hint">這個 clip 還沒有任何效果。從左側「加入」。</p>
        ) : (
          <div className="col">
            {clip.effects.map((e) => (
              <EffectCard
                key={e.id}
                effect={e}
                onToggle={() => apply(editToggleEffect(state, clip.id, e.id))}
                onRemove={() => apply(editRemoveEffect(state, clip.id, e.id))}
                onPatch={(patch) => apply(editUpdateEffect(state, clip.id, e.id, patch))}
              />
            ))}
          </div>
        )}

        <details style={{ marginTop: 14 }}>
          <summary className="hint">預覽送給引擎的 Timeline JSON（純資料，UI 未做任何 DSP）</summary>
          <pre className="mono" style={{ maxHeight: 300, overflow: 'auto', fontSize: 11 }}>
            {JSON.stringify(state.timeline, null, 2)}
          </pre>
        </details>
      </div>
    </div>
  );
}

interface CardProps {
  effect: EffectInstance;
  onToggle: () => void;
  onRemove: () => void;
  onPatch: (patch: Record<string, unknown>) => void;
}

function EffectCard({ effect, onToggle, onRemove, onPatch }: CardProps): JSX.Element {
  const meta = EFFECT_META[effect.type as EffectType];

  return (
    <div className={`effectcard ${effect.enabled ? '' : 'disabled'}`}>
      <div className="head">
        <strong>{meta.label}</strong>
        <span className="pill">{effect.type}</span>
        <span className="spacer" style={{ flex: 1 }} />
        <label className="tiny muted" style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <input type="checkbox" checked={effect.enabled} onChange={onToggle} />
          啟用
        </label>
        <button className="danger" onClick={onRemove}>
          移除
        </button>
      </div>

      {meta.params.length > 0 ? (
        <div className="params">
          {meta.params.map((p) => {
            if (p.kind === 'bands' && effect.type === 'eq') {
              return (
                <EqBandsEditor
                  key={p.key}
                  bands={effect.bands}
                  onChange={(bands) => onPatch({ bands })}
                />
              );
            }
            const value = getParam(effect, p.key);
            if (p.kind === 'select') {
              return (
                <label key={p.key} className="field">
                  {p.label}
                  <select value={String(value ?? '')} onChange={(e) => onPatch({ [p.key]: e.target.value })}>
                    {(p.options ?? []).map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>
              );
            }
            return (
              <label key={p.key} className="field">
                {p.label}
                {p.unit ? <span className="tiny muted"> ({p.unit})</span> : null}
                <input
                  type="number"
                  min={p.min}
                  max={p.max}
                  step={p.step}
                  value={typeof value === 'number' ? value : 0}
                  onChange={(e) => onPatch({ [p.key]: Number(e.target.value) })}
                  style={{ minWidth: 90 }}
                />
              </label>
            );
          })}
        </div>
      ) : (
        <p className="hint tiny" style={{ margin: '6px 0 0' }}>
          此效果沒有可調參數。
        </p>
      )}
    </div>
  );
}

interface BandsProps {
  bands: EqBand[];
  onChange: (bands: EqBand[]) => void;
}

function EqBandsEditor({ bands, onChange }: BandsProps): JSX.Element {
  const set = (i: number, patch: Partial<EqBand>): void => {
    onChange(bands.map((b, j) => (j === i ? { ...b, ...patch } : b)));
  };

  return (
    <div style={{ flexBasis: '100%' }}>
      <div className="tiny muted">EQ 頻帶（每個頻帶在引擎端是一個 equalizer 濾鏡）</div>
      {bands.map((b, i) => (
        <div className="band" key={i}>
          <label className="tiny muted">
            Hz
            <input
              type="number"
              min={20}
              max={20000}
              step={10}
              value={b.freq}
              onChange={(e) => set(i, { freq: Number(e.target.value) })}
            />
          </label>
          <label className="tiny muted">
            dB
            <input
              type="number"
              min={-24}
              max={24}
              step={0.5}
              value={b.gainDb}
              onChange={(e) => set(i, { gainDb: Number(e.target.value) })}
            />
          </label>
          <label className="tiny muted">
            oct
            <input
              type="number"
              min={0.1}
              max={6}
              step={0.1}
              value={b.widthOctaves}
              onChange={(e) => set(i, { widthOctaves: Number(e.target.value) })}
            />
          </label>
          <button
            className="danger"
            onClick={() => onChange(bands.filter((_, j) => j !== i))}
            disabled={bands.length <= 1}
          >
            移除
          </button>
        </div>
      ))}
      <button
        style={{ marginTop: 4 }}
        onClick={() => onChange([...bands, { freq: 4000, gainDb: 0, widthOctaves: 1 }])}
      >
        + 新增頻帶
      </button>
    </div>
  );
}
