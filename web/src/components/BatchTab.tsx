/**
 * Batch USB tab: point at folders, pick a preset, watch progress, read the report.
 *
 * The UI starts a job and then polls `GET /api/jobs/:id`; all scanning, tagging,
 * dedup, loudness planning and encoding happen inside the engine.
 */

import { useMemo, useState } from 'react';
import { useApp } from '../app-context.ts';
import { PRESETS } from '../presets.ts';
import type { BatchReport, BatchReportItem, DenoiseAvailabilityResponse } from '../api-types.ts';

interface Props {
  denoiseInfo: DenoiseAvailabilityResponse | null;
}

const FILENAME_PATTERNS = [
  '{track} {artist} - {title}',
  '{artist} - {title}',
  '{title}',
];

export default function BatchTab({ denoiseInfo }: Props): JSX.Element {
  const { state, dispatch, actions } = useApp();

  const [root, setRoot] = useState(state.libraryRoot || '');
  const [outputDir, setOutputDir] = useState('');
  const [pattern, setPattern] = useState(FILENAME_PATTERNS[0] ?? '{artist} - {title}');
  const [dedup, setDedup] = useState(true);
  const [capacityGb, setCapacityGb] = useState<string>('');
  const [loudnessEnabled, setLoudnessEnabled] = useState(true);
  const [lufs, setLufs] = useState(-14);
  const [tp, setTp] = useState(-1.0);

  const batch = state.batch;
  const report = batch.report;

  const pct = useMemo(() => {
    const p = batch.progress;
    if (!p || p.total <= 0) return 0;
    return Math.min(100, Math.round((p.done / p.total) * 100));
  }, [batch.progress]);

  const counts = useMemo(() => {
    if (!report) return { ok: 0, failed: 0, skipped: 0 };
    return report.items.reduce(
      (acc, it) => {
        if (it.status === 'ok') acc.ok += 1;
        else if (it.status === 'failed') acc.failed += 1;
        else acc.skipped += 1;
        return acc;
      },
      { ok: 0, failed: 0, skipped: 0 },
    );
  }, [report]);

  const start = (): void => {
    void actions.startBatch({
      roots: root ? [root] : [],
      outputDir,
      filenamePattern: pattern,
      dedup,
      targetCapacityGb: capacityGb.trim() === '' ? null : Number(capacityGb),
      loudnessEnabled,
      integratedLufs: lufs,
      truePeakDb: tp,
    });
  };

  return (
    <div className="col">
      {/* ---------------- Configuration ---------------- */}
      <div className="panel">
        <h2>批次設定</h2>
        <div className="inline">
          <label className="field">
            來源資料夾
            <input
              value={root}
              placeholder="D:\Music"
              onChange={(e) => setRoot(e.target.value)}
              style={{ minWidth: 280 }}
            />
          </label>
          <label className="field">
            輸出資料夾
            <input
              value={outputDir}
              placeholder="E:\USB_Music"
              onChange={(e) => setOutputDir(e.target.value)}
              style={{ minWidth: 280 }}
            />
          </label>
          <label className="field">
            檔名樣式
            <select value={pattern} onChange={(e) => setPattern(e.target.value)}>
              {FILENAME_PATTERNS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            目標容量 (GB，留空＝不限制)
            <input
              type="number"
              min="0"
              step="1"
              value={capacityGb}
              onChange={(e) => setCapacityGb(e.target.value)}
              style={{ minWidth: 120 }}
            />
          </label>
        </div>

        <div className="inline" style={{ marginTop: 10 }}>
          <label className="field">
            Preset
            <select
              value={state.presetId}
              onChange={(e) => {
                const id = e.target.value as 'usb' | 'flac' | 'wav';
                const found = PRESETS.find((p) => p.id === id);
                if (found) dispatch({ type: 'setPreset', presetId: id, preset: found.make() });
              }}
            >
              {PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <span className="field" style={{ maxWidth: 320 }}>
            說明
            <span className="hint">{PRESETS.find((p) => p.id === state.presetId)?.description}</span>
          </span>
        </div>

        <div className="inline" style={{ marginTop: 10 }}>
          <label className="field" style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={loudnessEnabled}
              onChange={(e) => setLoudnessEnabled(e.target.checked)}
            />
            響度正規化（兩遍 loudnorm）
          </label>
          <label className="field">
            目標 LUFS
            <input
              type="number"
              step="0.5"
              value={lufs}
              disabled={!loudnessEnabled}
              onChange={(e) => setLufs(Number(e.target.value))}
              style={{ minWidth: 100 }}
            />
          </label>
          <label className="field">
            真峰值 dBTP
            <input
              type="number"
              step="0.1"
              value={tp}
              disabled={!loudnessEnabled}
              onChange={(e) => setTp(Number(e.target.value))}
              style={{ minWidth: 100 }}
            />
          </label>
          <label className="field" style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
            <input type="checkbox" checked={dedup} onChange={(e) => setDedup(e.target.checked)} />
            指紋去重
          </label>
        </div>

        <p className="hint">
          預設 <span className="mono">-14 LUFS / -1.0 dBTP</span>（使用者拍板）。降噪使用批次安全的溫和
          afftdn+adeclick；AI 降噪（DeepFilterNet）**不會**進入批次預設。
        </p>

        <div className="inline" style={{ marginTop: 10 }}>
          <button className="primary" onClick={start} disabled={batch.running}>
            {batch.running ? '批次執行中…' : '開始批次'}
          </button>
          {batch.running && batch.jobId ? (
            <span className="mono tiny muted">job {batch.jobId}</span>
          ) : null}
          {report || batch.error ? (
            <button onClick={() => dispatch({ type: 'batchReset' })}>清除結果</button>
          ) : null}
        </div>
      </div>

      {/* ---------------- Progress ---------------- */}
      <div className="panel">
        <h2>進度</h2>
        {batch.state ? (
          <>
            <div className="inline">
              <span className="pill">狀態：{batch.state}</span>
              <span className="pill">階段：{batch.progress?.stage ?? '—'}</span>
              <span className="mono tiny muted">
                {batch.progress ? `${batch.progress.done}/${batch.progress.total}` : '—'}
              </span>
            </div>
            <div className="progress" style={{ marginTop: 8 }}>
              <div style={{ width: `${pct}%` }} />
            </div>
            {batch.progress?.path ? (
              <p className="mono tiny muted" style={{ marginTop: 4 }}>
                {batch.progress.path}
              </p>
            ) : null}
          </>
        ) : (
          <p className="hint">尚未啟動批次工作。</p>
        )}
        {batch.error ? <p className="mono" style={{ color: 'var(--err)' }}>{batch.error}</p> : null}
      </div>

      {/* ---------------- Report ---------------- */}
      <div className="panel">
        <h2>報告</h2>
        {!report ? (
          <p className="hint">完成後會顯示成功／失敗／略過、去重清單與總容量。</p>
        ) : (
          <ReportView report={report} counts={counts} />
        )}
      </div>

      {/* ---------------- Denoise availability ---------------- */}
      <div className="panel">
        <h2>AI 降噪（單曲手動 opt-in）</h2>
        {!denoiseInfo ? (
          <p className="hint">無法取得降噪可用性（引擎未連線？）。</p>
        ) : (
          <>
            <div className="inline">
              <span className={`pill ${denoiseInfo.available ? '' : 'muted'}`}>
                {denoiseInfo.available ? '可用' : '不可用'}
              </span>
              <span className="mono tiny muted">{denoiseInfo.exePath ?? '（找不到 exe）'}</span>
            </div>
            <table style={{ marginTop: 8 }}>
              <tbody>
                <tr>
                  <th style={{ width: 160 }}>批次預設</th>
                  <td className="mono">{denoiseInfo.policy.batchDefault}</td>
                </tr>
                <tr>
                  <th>僅單曲</th>
                  <td className="mono">{denoiseInfo.policy.singleTrackOnly}</td>
                </tr>
                <tr>
                  <th>理由</th>
                  <td>{denoiseInfo.policy.reason}</td>
                </tr>
              </tbody>
            </table>
          </>
        )}
      </div>
    </div>
  );
}

interface ReportProps {
  report: BatchReport;
  counts: { ok: number; failed: number; skipped: number };
}

function ReportView({ report, counts }: ReportProps): JSX.Element {
  const mb = (report.totalBytes / (1024 * 1024)).toFixed(1);
  return (
    <>
      <div className="inline">
        <span className="pill" style={{ color: 'var(--ok)' }}>
          成功 {counts.ok}
        </span>
        <span className="pill" style={{ color: 'var(--err)' }}>
          失敗 {counts.failed}
        </span>
        <span className="pill" style={{ color: 'var(--warn)' }}>
          略過 {counts.skipped}
        </span>
        <span className="pill">總容量 {mb} MB</span>
        <span className="pill">耗時 {(report.durationMs / 1000).toFixed(1)}s</span>
        <span className="pill">
          {report.preset.container} / {report.preset.codec} /{' '}
          {report.preset.bitrateKbps ?? '無損'} kbps
        </span>
      </div>

      <div style={{ maxHeight: 320, overflow: 'auto', marginTop: 8 }}>
        <table>
          <thead>
            <tr>
              <th>狀態</th>
              <th>來源</th>
              <th>輸出</th>
              <th>訊息</th>
            </tr>
          </thead>
          <tbody>
            {report.items.map((it: BatchReportItem, i: number) => (
              <tr key={`${it.id}-${i}`} className={it.status}>
                <td className="status">{it.status}</td>
                <td className="mono">{it.sourcePath}</td>
                <td className="mono">{it.outputPath ?? '—'}</td>
                <td>{it.message ?? (it.verify ? (it.verify.ok ? '驗證通過' : it.verify.problems.join('; ')) : '')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3>去重（{report.duplicates.length} 組）</h3>
      {report.duplicates.length === 0 ? (
        <p className="hint">未發現重複。</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>保留</th>
              <th>丟棄</th>
              <th>原因</th>
            </tr>
          </thead>
          <tbody>
            {report.duplicates.map((d, i) => (
              <tr key={i}>
                <td className="mono">{d.keep}</td>
                <td className="mono">
                  {d.drop.length === 0 ? '—' : d.drop.map((p) => <div key={p}>{p}</div>)}
                </td>
                <td>{d.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
