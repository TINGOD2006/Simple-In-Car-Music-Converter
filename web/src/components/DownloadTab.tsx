/**
 * 下載 tab: paste a link, choose what to take, watch it land.
 *
 * The engine owns the whole pipeline — resolution, the download, the tag write
 * and the conversion into the USB preset — so this page never touches a file.
 * It has three jobs: turn a URL into a track list the user can edit, hand the
 * chosen subset to `/api/download/start`, and then poll one snapshot per second
 * until every track is terminal.
 *
 * Two deliberate honesty rules:
 *   - The Spotify cookie is paste-only. The stored value is never rendered back
 *     (the engine does not even return it), so the field always starts empty and
 *     saving it means typing it again.
 *   - YouTube audio arrives as webm/Opus, and webm cannot carry attached cover
 *     art. The page therefore says the cover is unavailable instead of showing a
 *     placeholder that never fills.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api } from '../api.ts';
import type {
  DownloadRecord,
  DownloadResolvedSource,
  DownloadRoute,
  TrackState,
} from '../api-types.ts';
import { useApp } from '../app-context.ts';
import { defaultDestinationFor, describeProgress, looksLikeYoutubeUrl, statusPill } from '../download-helpers.ts';
import { DEFAULT_PRESET_ID, PRESETS, type PresetChoice } from '../presets.ts';

/** How often to pull a status snapshot while a download is running. */
const POLL_MS = 1000;

/**
 * Why a track stopped, in the user's words.
 *
 * These mirror the engine's reason vocabulary. An unknown reason still renders —
 * a failed track with no explanation is worse than one with a raw token.
 */
const REASON_TEXT: Record<string, string> = {
  timeout: '下載逾時',
  cancelled: '已取消',
  'cookie-expired': 'Spotify 登入已過期，請重新貼上 cookie',
  'rate-limit': '來源暫時限制流量，稍後會自動重試一次',
  'no-confident-match': '找不到夠接近的 YouTube 版本',
  'io-error': '讀寫或網路錯誤',
  'unsupported-url': '不支援的連結',
  'ytdlp-missing': '找不到 yt-dlp.exe，請執行 node tools/fetch-ytdlp.mjs',
  'video-unavailable': '這部影片無法下載（私人、地區限制或已移除）',
  'live-unsupported': '直播無法下載',
  'no-audio-format': '這個來源沒有可用的音訊格式',
};

function reasonText(reason: string | undefined): string {
  if (!reason) return '';
  return REASON_TEXT[reason] ?? reason;
}

interface TrackRow {
  meta: DownloadResolvedSource['tracks'][number];
  index: number;
  state: TrackState;
  reason?: string;
  rawKbps?: number;
  outputPath?: string;
}

/** The sorted, always-complete view of what the start button will use. */
function routeOptions(platform: DownloadResolvedSource['platform']): DownloadRoute[] {
  return platform === 'youtube'
    ? ['youtube-direct']
    : ['youtube-match', 'spotify-direct'];
}

const ROUTE_LABEL: Record<DownloadRoute, string> = {
  'spotify-direct': '路線 A：直接從 Spotify 下載（需要帳號 cookie）',
  'youtube-match': '路線 B：用 Spotify 的資料到 YouTube 找對應版本（免帳號）',
  'youtube-direct': '直接下載這個 YouTube 來源',
};

export default function DownloadTab(): JSX.Element {
  const { dispatch } = useApp();

  const [url, setUrl] = useState('');
  const [source, setSource] = useState<DownloadResolvedSource | null>(null);
  const [route, setRoute] = useState<DownloadRoute>('youtube-match');
  const [selected, setSelected] = useState<readonly number[]>([]);
  const [destination, setDestination] = useState('');
  const [presetId, setPresetId] = useState<PresetChoice['id']>(DEFAULT_PRESET_ID);

  const [download, setDownload] = useState<DownloadRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const [cookieInput, setCookieInput] = useState('');
  const [cookieSet, setCookieSet] = useState(false);
  const [cookieHint, setCookieHint] = useState<string | null>(null);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsNote, setSettingsNote] = useState('');

  /** The id being polled; a ref so the interval never depends on render order. */
  const pollId = useRef<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const settings = await api.getDownloadSettings();
        setCookieSet(settings.spotifyCookieSet);
        setCookieHint(settings.cookieHint);
        if (settings.destination) setDestination(settings.destination);
      } catch {
        // Settings are optional: the page still works with a folder the user picks.
      }
    })();
  }, []);

  /* ---------------------------------------------------------------- */
  /* Polling                                                           */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    if (!download || download.finished) return undefined;
    let cancelled = false;
    const timer = setInterval(() => {
      const id = pollId.current;
      if (!id) return;
      void (async () => {
        try {
          const next = await api.downloadStatus(id);
          if (!cancelled) setDownload(next.download);
        } catch {
          // A dropped poll is not a failure: the next tick asks again, and a
          // download that genuinely vanished is answered by the final snapshot.
        }
      })();
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [download]);

  /* ---------------------------------------------------------------- */
  /* Resolution                                                        */
  /* ---------------------------------------------------------------- */

  const resolve = useCallback(async () => {
    const target = url.trim();
    if (!target) {
      setError('請先貼上 Spotify 或 YouTube 連結');
      return;
    }
    setBusy(true);
    setError('');
    setDownload(null);
    pollId.current = null;
    try {
      const res = await api.resolveDownload(target);
      setSource(res.source);
      setSelected(res.source.tracks.map((_, i) => i));
      // The platform decides the route: a video id cannot be played by the
      // Spotify path, and a Spotify track has no YouTube video id to fetch.
      setRoute(routeOptions(res.source.platform)[0] ?? 'youtube-match');
    } catch (err) {
      setSource(null);
      setSelected([]);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [url]);

  /* ---------------------------------------------------------------- */
  /* Start / cancel / retry                                            */
  /* ---------------------------------------------------------------- */

  const start = useCallback(async () => {
    if (!source) return;
    if (!destination.trim()) {
      setError('請先選擇要存放下載檔案的資料夾');
      return;
    }
    const preset = PRESETS.find((p) => p.id === presetId);
    if (!preset) {
      setError('請選擇輸出格式');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const res = await api.startDownload({
        source,
        route,
        destination: destination.trim(),
        preset: preset.make(),
        trackIndices: [...selected].sort((a, b) => a - b),
      });
      pollId.current = res.downloadId;
      const snapshot = await api.downloadStatus(res.downloadId);
      setDownload(snapshot.download);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [destination, presetId, route, selected, source]);

  const activeDownloadId = download && !download.finished ? download.id : '';

  const cancel = useCallback(async () => {
    if (!activeDownloadId) return;
    try {
      await api.cancelDownload(activeDownloadId);
      const snapshot = await api.downloadStatus(activeDownloadId);
      setDownload(snapshot.download);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [activeDownloadId]);

  const retry = useCallback(
    async (indices: number[]) => {
      if (!download || indices.length === 0) return;
      try {
        await api.retryDownload(download.id, indices);
        const snapshot = await api.downloadStatus(download.id);
        setDownload(snapshot.download);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [download],
  );

  /* ---------------------------------------------------------------- */
  /* Destination                                                       */
  /* ---------------------------------------------------------------- */

  const chooseFolder = useCallback(async () => {
    try {
      const picked = await api.pick({ mode: 'folder', title: '選擇下載資料夾' });
      const first = picked.paths[0];
      if (!first) return;
      // Pick the parent the user wants the music to live under; the source gets
      // its own folder inside it so two downloads never share a directory.
      setDestination(defaultDestinationFor(first, source?.name ?? '下載'));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [source]);

  const saveCookie = useCallback(async () => {
    const value = cookieInput.trim();
    if (!value) {
      setError('請先貼上 cookie');
      return;
    }
    setSettingsBusy(true);
    setSettingsNote('');
    try {
      await api.putDownloadSettings({ spotifyCookie: value });
      const settings = await api.getDownloadSettings();
      setCookieSet(settings.spotifyCookieSet);
      setCookieHint(settings.cookieHint);
      // Clear the field: it is paste-only, and the value is never read back.
      setCookieInput('');
      setSettingsNote('已儲存。cookie 不會再顯示，只會保留提示。');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSettingsBusy(false);
    }
  }, [cookieInput]);

  /* ---------------------------------------------------------------- */
  /* Derived                                                           */
  /* ---------------------------------------------------------------- */

  const tracks: TrackRow[] = useMemo(() => {
    if (download) {
      return download.tracks.map((t) => ({
        meta: t.meta,
        index: t.index,
        state: t.state,
        reason: t.reason,
        rawKbps: t.rawKbps,
        outputPath: t.outputPath,
      }));
    }
    if (!source) return [];
    return source.tracks.map((meta, index) => ({ meta, index, state: 'queued' as TrackState }));
  }, [download, source]);

  const summary = describeProgress(tracks);
  const failed = download ? download.tracks.filter((t) => t.state === 'failed').map((t) => t.index) : [];
  const isYoutube = source?.platform === 'youtube';

  const toggle = (index: number): void => {
    setSelected((prev) =>
      prev.includes(index) ? prev.filter((i) => i !== index) : [...prev, index].sort((a, b) => a - b),
    );
  };

  return (
    <div className="panel">
      <div className="row">
        <h2>從其他平台下載音樂</h2>
        <span className="grow" />
        <span className="tiny muted">貼上連結 → 選曲 → 下載，完成後會依所選格式直接放進資料夾</span>
      </div>

      {/* 1. The link. */}
      <div className="toolbar">
        <input
          className="grow mono"
          placeholder="https://open.spotify.com/track/... 或 https://www.youtube.com/watch?v=..."
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void resolve();
          }}
        />
        <button className="big-btn" disabled={busy} onClick={() => void resolve()}>
          {busy ? '解析中…' : '解析'}
        </button>
      </div>
      {looksLikeYoutubeUrl(url) ? (
        <div className="hint">
          這是 YouTube 連結，會直接下載這個來源的音訊（webm/Opus）。webm 不支援內嵌封面，因此不會有專輯封面。
        </div>
      ) : null}

      {error ? <div className="banner usb-error">{error}</div> : null}

      {/* 2. What came back. */}
      {source ? (
        <>
          <div className="row">
            <strong>{source.name || '（未命名來源）'}</strong>
            <span className="pill">{source.platform === 'youtube' ? 'YouTube' : 'Spotify'}</span>
            <span className="pill">{source.kind}</span>
            <span className="tiny muted">{source.tracks.length} 首</span>
          </div>
          {source.partial ? (
            <div className="banner usb-warnline">
              Spotify 只回傳了降級的中介資料（可能清單過大或未登入）：名稱以外的曲目資訊會是空的。建議改用路線 B。
            </div>
          ) : null}
          {isYoutube ? (
            <div className="hint">
              {ROUTE_LABEL['youtube-direct']}。此路線不需要帳號，也不需要 cookie。
            </div>
          ) : (
            <div className="col">
              {routeOptions(source.platform).map((r) => (
                <label className="inline" key={r}>
                  <input type="radio" checked={route === r} onChange={() => setRoute(r)} />
                  <span>{ROUTE_LABEL[r]}</span>
                </label>
              ))}
              {route === 'spotify-direct' ? (
                <div className="banner usb-warnline">
                  路線 A 會用你自己的 Spotify 帳號直接取得音訊。這與 Spotify 的使用條款相抵觸，帳號有被停用的風險，請自行斟酌。
                </div>
              ) : null}
            </div>
          )}

          {/* 3. Where it goes. */}
          <div className="toolbar">
            <span className="tiny muted">存放位置</span>
            <input
              className="grow mono"
              value={destination}
              onChange={(e) => setDestination(e.target.value)}
              placeholder="尚未選擇資料夾"
            />
            <button onClick={() => void chooseFolder()}>變更</button>
          </div>

          {/* 4. Which tracks. */}
          <div className="usb-tablewrap">
            <table className="usb-table">
              <thead>
                <tr>
                  <th>
                    <input
                      type="checkbox"
                      checked={selected.length === source.tracks.length && source.tracks.length > 0}
                      onChange={(e) =>
                        setSelected(e.target.checked ? source.tracks.map((_, i) => i) : [])
                      }
                    />
                  </th>
                  <th>曲名</th>
                  <th>演出者</th>
                  <th>長度</th>
                  {download ? <th>狀態</th> : null}
                  {download ? <th>來源位元率</th> : null}
                  {download ? <th>結果</th> : null}
                </tr>
              </thead>
              <tbody>
                {tracks.map((track) => (
                  <tr key={track.index}>
                    <td>
                      <input
                        type="checkbox"
                        checked={selected.includes(track.index)}
                        disabled={download !== null}
                        onChange={() => toggle(track.index)}
                      />
                    </td>
                    <td className="usb-name">{track.meta.title || '（無標題）'}</td>
                    <td>{track.meta.artists}</td>
                    <td className="mono tiny">
                      {track.meta.durationSec > 0
                        ? `${Math.floor(track.meta.durationSec / 60)}:${String(
                            Math.round(track.meta.durationSec % 60),
                          ).padStart(2, '0')}`
                        : '—'}
                    </td>
                    {download ? (
                      <td>
                        <span className="pill">{statusPill(track.state)}</span>
                        {track.reason ? (
                          <span className="tiny muted"> {reasonText(track.reason)}</span>
                        ) : null}
                      </td>
                    ) : null}
                    {download ? (
                      <td className="mono tiny">
                        {track.rawKbps !== undefined && track.rawKbps > 0
                          ? `來源 ${track.rawKbps} kbps`
                          : '—'}
                      </td>
                    ) : null}
                    {download ? (
                      <td className="mono tiny">{track.outputPath ?? '—'}</td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* 5. The controls. */}
          <div className="toolbar usb-actions">
            <label className="field">
              輸出格式
              <select
                value={presetId}
                disabled={download !== null}
                onChange={(e) => setPresetId(e.target.value as PresetChoice['id'])}
              >
                {PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            <span className="grow" />
            {!download ? (
              <button
                className="big-btn"
                disabled={busy || selected.length === 0}
                onClick={() => void start()}
              >
                開始下載（{selected.length} 首）
              </button>
            ) : (
              <>
                <button disabled={download.finished} onClick={() => void cancel()}>
                  取消
                </button>
                <button
                  disabled={failed.length === 0}
                  onClick={() => void retry(failed)}
                >
                  全部重試
                </button>
                <button
                  disabled={failed.length === 0}
                  onClick={() => void retry(failed.slice(0, 1))}
                >
                  重試失敗的第一首
                </button>
              </>
            )}
          </div>

          {download ? (
            <div className="row">
              <span className="tiny muted">{summary}</span>
              <span className="grow" />
              <div className="progress" style={{ width: '40%' }}>
                <div
                  style={{
                    width: `${Math.round(
                      (download.tracks.filter((t) =>
                        ['done', 'failed', 'skipped', 'cancelled'].includes(t.state),
                      ).length /
                        Math.max(1, download.tracks.length)) *
                        100,
                    )}%`,
                  }}
                />
              </div>
              {download.finished ? (
                <button onClick={() => dispatch({ type: 'tab', tab: 'usb' })}>
                  前往 USB 轉換
                </button>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}

      {/* 6. Settings. The cookie is paste-only; the stored value never comes back. */}
      <div className="col">
        <h3>設定</h3>
        <div className="toolbar">
          <span className="tiny muted">
            {cookieSet ? `Spotify cookie：已設定（${cookieHint ?? '****'}）` : 'Spotify cookie：未設定'}
          </span>
          <input
            className="grow mono"
            type="password"
            autoComplete="off"
            placeholder="貼上 sp_dc=... （只會儲存，不會再顯示）"
            value={cookieInput}
            onChange={(e) => setCookieInput(e.target.value)}
          />
          <button disabled={settingsBusy || cookieInput.trim() === ''} onClick={() => void saveCookie()}>
            儲存
          </button>
        </div>
        <div className="hint">
          只有路線 A 需要 cookie。它會存放在本機設定檔，不會被記錄也不會透過 API 回傳；畫面上永遠只顯示末四碼提示。
        </div>
        {settingsNote ? <div className="hint">{settingsNote}</div> : null}
      </div>
    </div>
  );
}
