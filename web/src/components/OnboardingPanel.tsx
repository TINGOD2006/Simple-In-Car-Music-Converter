/**
 * Empty state / onboarding.
 *
 * The shell renders this whenever nothing is loaded — on EVERY tab, not behind
 * one — because a blank window with no explanation is exactly the failure the
 * user reported (「打開後無任何反饋」).
 *
 * It offers the three intake paths side by side:
 *   1. the engine-side NATIVE dialog for files (`POST /api/pick`);
 *   2. the native dialog for a folder, then `GET /api/library`;
 *   3. drag & drop / browser upload (`POST /api/upload`) as the fallback for
 *      platforms where the native dialog answers 501.
 */

import { useApp } from '../app-context.ts';
import { AUDIO_EXTENSIONS } from '../file-intake.ts';

const EXT_HINT = AUDIO_EXTENSIONS.slice(0, 10)
  .map((e) => `.${e}`)
  .join(' ');

export default function OnboardingPanel(): JSX.Element {
  const { state, dispatch, actions } = useApp();

  const busy = actions.pickBusy || actions.uploadBusy || actions.probeBusy;
  const busyLabel = actions.pickBusy
    ? '等待系統對話框…'
    : actions.uploadBusy
      ? '上傳到引擎中…'
      : actions.probeBusy
        ? '讀取檔案資訊與波形…'
        : '';

  /** The manual path box lives in the 編輯器 → 來源 panel; take the user there. */
  const goToManualPath = (): void => {
    dispatch({ type: 'tab', tab: 'editor' });
    window.setTimeout(() => {
      const el = document.getElementById('manual-path-input');
      if (el instanceof HTMLInputElement) {
        el.focus();
        el.scrollIntoView({ block: 'center' });
      }
    }, 60);
  };

  return (
    <section className={`panel onboarding ${actions.dragActive ? 'armed' : ''}`} aria-label="開始使用">
      <h2>開始使用</h2>

      <p className="onb-lead">
        這個介面本身不做音訊處理：檔案要交給本機的 Node 引擎讀取，載入後才會出現波形、編輯與匯出。
        選擇下列任一方式即可開始，<strong>不需要輸入任何路徑</strong>。
      </p>

      <div className="onb-actions">
        <button
          type="button"
          className="big-btn primary"
          disabled={busy}
          onClick={() => void actions.pickAndLoad('files')}
        >
          <span className="big-title">{actions.pickBusy ? '對話框中…' : '選擇音訊檔案'}</span>
          <span className="sub">開啟系統原生檔案對話框（可多選，直接使用引擎端檔案）</span>
        </button>

        <button
          type="button"
          className="big-btn primary"
          disabled={busy}
          onClick={() => void actions.pickAndLoad('folder')}
        >
          <span className="big-title">選擇資料夾</span>
          <span className="sub">掃描整個資料夾，載入第一個音訊檔並列出其餘</span>
        </button>

        <label className={`big-btn dropzone ${actions.dragActive ? 'armed' : ''}`}>
          <span className="big-title">{actions.uploadBusy ? '上傳中…' : '拖放檔案到這裡'}</span>
          <span className="sub">或按這裡用瀏覽器選擇檔案上傳（原生對話框不可用時的後備方案）</span>
          <input
            type="file"
            multiple
            accept="audio/*"
            disabled={busy}
            onChange={(e) => {
              // Copy out of the live FileList BEFORE clearing the input, so the
              // same file can be chosen twice in a row.
              const files = Array.from(e.target.files ?? []);
              e.target.value = '';
              if (files.length > 0) void actions.uploadFiles(files);
            }}
          />
        </label>
      </div>

      {busy ? (
        <p className="onb-busy">
          <span className="spinner" aria-hidden="true" /> {busyLabel}
        </p>
      ) : null}

      {state.engineOk === false ? (
        <p className="onb-warn">
          ⚠ 引擎未連線：以上任何方式都會失敗。請確認 AudioUsbStudio 應用程式已啟動，再按右上角「重新檢查」。
        </p>
      ) : null}

      <p className="hint">
        支援格式：{EXT_HINT} 等 ffmpeg 可解碼的檔案。原生對話框由引擎開啟，因此讀到的是引擎端路徑、不需要上傳；
        若系統回報 <span className="mono">HTTP 501</span>（此平台沒有原生對話框），請改用拖放或瀏覽器上傳。
      </p>

      <details className="onb-manual">
        <summary>進階：直接輸入引擎端絕對路徑</summary>
        <p className="hint">
          在「編輯器 → 來源」面板的<span className="mono"> 檔案路徑（引擎端絕對路徑）</span> 欄位輸入例如{' '}
          <span className="mono">C:\Music\track.mp3</span>，再按「載入並取代時間軸」。批次與資料夾掃描也可在
          「批次 USB」分頁指定路徑。
        </p>
        <button type="button" onClick={goToManualPath}>
          帶我到那個欄位
        </button>
      </details>
    </section>
  );
}
