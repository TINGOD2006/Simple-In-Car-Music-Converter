# Audio USB Studio — 設計規格

> 本文件記錄**已由使用者拍板的決策**與**經實測驗證的技術事實**。
> 凡標記「實測」者，均為在本機實際執行過的結果，非推論。
> 環境限制的權威來源見 [`docs/ENVIRONMENT.md`](ENVIRONMENT.md)。

---

## 1. 目標與範圍

### 1.1 主要目標
把一個**混亂的音樂資料夾**（格式雜、標籤缺漏或亂碼、檔名不一致、音量差異大、含重複曲目）
變成一支**車機可直接播放的 USB 隨身碟內容**，並產出可稽核的報告。

### 1.2 次要目標
提供**非破壞式波形編輯器**，可對單曲做剪切、效果、修復後輸出。

### 1.3 已排除
- 即時多軌混音 / DAW 級功能（不做）
- 音訊運算放在瀏覽器（UI 只送意圖，**所有 DSP 由 ffmpeg 執行**）

### 1.4 已拍板決策（使用者確認）

| 項目 | 決策 | 出處 |
|---|---|---|
| 形態 | 本機網頁應用：Node 引擎 + 瀏覽器 UI | m00035 |
| 重心 | USB 批量製作為主，波形編輯器為輔 | m00039 |
| USB 目標規格 | MP3 320 kbps **CBR** / 44.1 kHz / 立體聲 / ID3v2.3 | m00043 |
| 來源音樂庫 | 混合，格式與標籤品質不可預期 | m00047 |
| 降噪 | 分層：批次用溫和降噪；DeepFilterNet 為單曲手動 opt-in | m00051 / m00159 |
| 響度目標 | **−14 LUFS / 真峰值 −1.0 dBTP**（可調） | m00159 |
| 專案位置 | `C:\Users\TINGOD\Desktop\CodeHome\AudioUsbStudio` | m00159 |
| 技術棧 | TypeScript + React + Vite | m00159 |
| 交付順序 | 先做 M1 原型再決定；範圍 M1+M2 | m00159 |

---

## 2. 架構

```
瀏覽器 UI (React + Vite)          ← 只做顯示與送意圖，零 DSP
        │  HTTP JSON (127.0.0.1)
        ▼
Node 引擎 (TypeScript, 無建置步驟)
  ├─ LibraryScanner  掃描 + ffprobe 探測
  ├─ TagService      標籤讀取 / 亂碼修復 / 檔名推導 / 淨化
  ├─ DedupService    指紋 + 相似度去重
  ├─ EdlModel        非破壞式時間軸（純資料）
  ├─ PipelineCompiler 編譯成 ffmpeg argv
  ├─ Renderer        執行 ffmpeg、驗證輸出
  ├─ JobQueue        背景任務 + 進度
  └─ ReportService   產出 manifest.json
        │
        ▼
ffmpeg / ffprobe  ← 唯一 DSP 真相來源
        └─ 外部程序階段：deep-filter.exe（AI 降噪，僅手動 opt-in）
```

### 2.1 為什麼 ffmpeg 是唯一 DSP 來源
- 實測 ffmpeg 8.1 full build 具備 372 demuxers / 183 muxers / 231 音訊解碼器 / 91 音訊編碼器。
- 所需濾鏡全部存在（見 §4）。
- 「試聽」與「輸出」走**同一條管線**，保證所聽即所得；自寫 DSP 會產生第二套真相，兩者必然漂移。

### 2.2 為什麼 AI 降噪是外部程序而非濾鏡
實測結論（詳見 ENVIRONMENT.md）：`arnndn` 引擎存在但無模型檔；LADSPA 路線不通
（`[Parsed_ladspa_0] Failed to load '=deep_filter_mono'`）。
因此設計為：**ffmpeg 輸出 WAV → 跑 `deep-filter.exe` → 回到 ffmpeg 鏈**。

### 2.3 為什麼 DeepFilterNet 絕不可進批次預設
DeepFilterNet 是**語音**降噪模型（訓練於人聲）。實測合成 440 Hz 正弦 + 白噪音：

| 頻段 | 輸入 | 輸出 | 結果 |
|---|---|---|---|
| 全頻 | −20.2 dB | −59.2 dB | 掉 39 dB |
| 4 kHz+（噪音） | −22.1 dB | −90.3 dB | ✅ 降噪有效 |
| 440 Hz（訊號） | −26.9 dB | −84.3 dB | ❌ **訊號被殺 57 dB** |

若放進批次預設，整批音樂會變成近乎無聲。因此：
- **批次預設**：`afftdn` + `adeclick`（溫和）
- **DeepFilterNet**：單曲手動 opt-in，UI 必須明確警示

---

## 3. 資料模型

### 3.1 時間軸（EDL）
```ts
interface Clip {
  id: string; sourceId: string;
  srcIn: number; srcOut: number;          // 來源內的秒數區間
  gainDb: number;
  fadeInSec: number; fadeOutSec: number; crossfadeInSec: number;
  effects: EffectInstance[];
  label?: string;
}
interface Timeline { clips: Clip[]; sampleRate: number; channels: ChannelCount; }
```

**關鍵設計**：clip 在時間軸上的**位置由前序 clip 時長隱含決定**，不儲存絕對位置。
這讓插入 / 刪除 / 重排成為純陣列操作，不可能產生「重疊」或「空隙」的不一致狀態。
復原 / 重做 = 快照堆疊（`HistoryEntry { label, timeline }`）。

### 3.2 匯出 preset
```ts
interface ExportPreset {
  container: string; codec: string; bitrateKbps: number | null;
  sampleRate: number; channels: ChannelCount;
  loudness: { enabled: boolean; integratedLufs: number; truePeakDb: number; lra: number };
  id3v2Version: 2 | 3 | 4;
  denoise: 'off' | 'gentle' | 'moderate' | 'strong';
}
```
USB 預設值（`edl.ts` 的 `usbPreset()`）：`mp3` / `libmp3lame` / 320 kbps / 44100 / 2 /
`{-14 LUFS, -1.0 dBTP, LRA 11}` / ID3v2.3 / `denoise: 'gentle'`。

---

## 4. 效果鏈

### 4.1 固定處理順序（與 UI 加入順序無關）
```
repair → denoise → eq → dynamics → space → gain → speed
```
以 `Stage` 常數排序（`Repair:10, Denoise:20, Eq:30, Dynamics:40, Space:50, Gain:60, Speed:70`）。
`Stage` 用 const object 而非 TS `enum`：Node 的 type-stripping loader 拒絕 enum
（`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`，enum 會產生執行期程式碼，非可抹除語法）。

### 4.2 已實作效果（14 種）
| 效果 | 階段 | ffmpeg 濾鏡 |
|---|---|---|
| De-clip | Repair | `adeclip` |
| De-click | Repair | `adeclick=threshold=` |
| Reverse | Repair | `areverse` |
| Noise reduction | Denoise | `afftdn=nr=:nf=:tn=1`（gentle 6/−40、moderate 12/−35、strong 24/−30） |
| Equalizer | Eq | 每段一個 `equalizer=f=:width_type=o:width=:g=` |
| High-pass | Eq | `highpass=f=` |
| Low-pass | Eq | `lowpass=f=` |
| Compressor | Dynamics | `acompressor=threshold=:ratio=:attack=20:release=250:makeup=1` |
| Limiter | Dynamics | `alimiter=limit=` |
| Echo | Space | `aecho=0.8:0.9:delay:decay` |
| Reverb | Space | `afir=gtype=0:ir=@@IR@@:mix=`（renderer 替換脈衝檔路徑） |
| Gain | Gain | `volume=` |
| Peak normalize | Gain | 需量測 pass，renderer 解析後告知 compiler |
| Speed | Speed | `atempo=` |

---

## 5. 渲染管線

### 5.1 兩遍響度正規化（必須）
1. **量測 pass**：`compileMeasurePass()` 對**同一個 program** 跑 `loudnorm` 分析，不寫音訊，取得 JSON 摘要。
2. **渲染 pass**：把量測值餵回 `loudnorm` 的第二遍參數。

單遍 loudnorm 會壓縮動態範圍，因此**兩遍是硬性要求**。

### 5.2 libmp3lame CBR 陷阱（實測）
`-b:a 320k` 搭配 `-abr 1` 會切成 **ABR 模式**，實測輸出只有 **158 kbps**。
正確寫法：
```
-c:a libmp3lame -b:a 320k -minrate 320k -maxrate 320k -bufsize 640k
```
（不帶 `-abr`。）

### 5.3 輸出驗證（`verify()`）
重新 probe 輸出檔並比對，容忍值：
- 時長 `DURATION_TOLERANCE_SEC = 0.35`
- 響度 `LUFS_TOLERANCE = 1.5`
- 真峰值 `TP_TOLERANCE_DB = 1.0`

---

## 6. 批次 USB 製作（六步）

1. **掃描**：走訪來源資料夾，對每個音檔跑 ffprobe。
2. **分析**：量測響度（loudnorm pass-1）。
3. **規劃**：去重、響度補償、檔名標準化、容量檢查。
4. **渲染**：平行處理，並行度 = CPU 核心數 − 1。
5. **驗證**：重新 probe 每個輸出。
6. **報告**：寫出 `manifest.json`。

硬性要求：
- 兩遍 loudnorm、−14 LUFS / −1.0 dBTP
- 溫和降噪**絕不含 DeepFilterNet**
- **單檔失敗不中斷整批**
- USB 容量由呼叫方傳入（引擎不自行讀磁碟）

---

## 7. 格式支援

- 宣稱支援 **50+ 格式**；ffmpeg 實測具備 231 音訊解碼器 / 91 音訊編碼器。
- 取樣率 **6 kHz – 192 kHz**。
- 192 kHz 現實限制：**MP3 最高 48 kHz**；96/192 kHz 須 FLAC/WAV/AIFF/AAC。
- 無專用 id3v2 muxer；ID3v2.3 用 mp3 muxer + `-id3v2_version 3`。
- 近似去重可用 `chromaprint` muxer（存在），相似度比對需自寫。

---

## 8. 沙箱硬限制（影響實作方式）

| 限制 | 對策 |
|---|---|
| piped stdio → `spawn EPERM` | 所有 ffmpeg/ffprobe 溝通走**檔案式 I/O**，`stdio:'ignore'` |
| ffprobe `-o` 絕對路徑失敗 | 用**相對路徑 + cwd** |
| `-report` 的 log 檔名只有秒級解析度 | 改用 `FFREPORT=file=<自選唯一名>:level=48`（同秒連呼不再撞名，12/12 解析成功） |
| node 無法新建目錄 | 啟動時 `mkdirSync(scratchRoot, {recursive:true})` |
| npm 預設快取 EPERM | `npm install --cache "<專案根>\.npm-cache"` |
| `node --test` 不可用 | 自寫 `test/run.ts` runner（自動探索 `*.test.ts`） |
| `enum` 被 Node 拒絕 | 改用 const object + `typeof` |

**踩坑記錄**：`spawn ... ENOENT` 指向 binary 名稱時，先懷疑 **cwd 不存在**，不要懷疑 binary 路徑。

---

## 9. HTTP API 契約

| 方法 | 路徑 | 說明 |
|---|---|---|
| GET | `/api/health` | ffmpeg/ffprobe 路徑、scratchRoot、node 版本 |
| GET | `/api/library?dir=&recursive=` | 掃描資料夾 |
| POST | `/api/probe` | 單檔探測 |
| GET | `/api/waveform?path=&buckets=` | 波形峰值 |
| POST | `/api/compile` | 回傳精確 argv + filterComplex（UI 顯示真正指令） |
| POST | `/api/render` | 渲染（可帶 `doVerify`） |
| POST | `/api/preview` | 效果試聽；**直接回傳 `audio/wav` 位元組**（不再回一個瀏覽器取不到的路徑） |
| POST | `/api/batch` | `dryRun:true` 同步回 plan；否則 202 + jobId |
| GET | `/api/jobs` / `/api/jobs/:id` | 任務列表 / 單一任務 |
| GET | `/api/denoise-availability` | DFN 是否可用 |
| POST | `/api/denoise` | 單曲 AI 降噪 |
| POST | `/api/pick` | 原生檔案／資料夾對話框；回 `{ok,paths}`，取消為空陣列，非 Windows 或無 PowerShell 回 **501**（UI 改走拖放／上傳） |
| POST | `/api/upload?name=` | 原始位元組（`application/octet-stream`）串流寫入 `<scratch>/uploads/`，回 `{ok,path,bytes}`；超過 512 MB 回 413 |
| GET | `/api/file?path=` | 串流播放引擎端檔案；支援單一 `Range` 回 206。只允許音訊副檔名（非音訊回 415），相對路徑回 400，不存在回 404 |

### 9.1 為什麼 `/api/file` 是白名單而非任意讀檔

`/api/file` 會照著傳入的路徑讀檔，等於把本機檔案系統的一角開給瀏覽器。雖然
server 只綁 `127.0.0.1`，仍以**音訊副檔名白名單**收斂暴露面：UI 只需要播放音訊，
而任意檔案讀取是這個端點唯一能造成的傷害。`Range` 支援不是加分項而是必要——
沒有 206，`<audio>` 每次拖動進度列都得從頭下載。

尚未落地的模組（`library` / `batch` / `denoise`）由 `optionalModule()` 動態載入，
缺席時端點回 **501** 加明確訊息，**不會**讓 typecheck 或啟動失敗。

---

## 10. 驗收門檻

引擎（`AudioUsbStudio/`）：

```
npm run typecheck   # 零 error TS
node test/run.ts    # 全部 passed
```

網頁前端（`AudioUsbStudio/web/`）：

```
npx tsc --noEmit    # 零 error
npx vite build      # 必須成功產出 dist/
```

**現況（M1+M2 完成）**：typecheck 零 error、**173/173 passed**、web 兩道門檻
皆過。測試含真實 ffmpeg 端到端驗證，而非字串斷言，例如：

| 驗證項 | 量測方式 | 實測結果 |
|---|---|---|
| CBR 320k 名副其實 | `ffprobe` 讀產物 `bit_rate` | `320000`（非 158k） |
| 兩遍 loudnorm 保留動態 | 比對來源/輸出 loudnorm step | 來源 30.00 → 輸出 **30.10 dB**，`I=-14.04 LUFS` |
| 歸一化真的有效 | `volumedetect` 讀輸出 `max_volume` | target `-3.0` → **-3 dB**；`-12.0` → **-12 dB** |
| crossfade 時長守恆 | 4s+4s 重疊 1s | `timelineDuration` = **7**，ffprobe 檔案長度 = 7 |
| 混響真的產生尾音 | `volumedetect` 量測 tail | 四預設 tail −45 ~ −51 dB（原始檔無尾音） |
| 去重不誤刪 | 5 檔（4 不同 + 1 真拷貝）跑批次 | 僅丟 1 個真拷貝，4 首全保留 |
| HTTP API 契約 | 真實啟動 server 後 `fetch` | `/api/health` 200、UI 200、bundle 200 |

### 10.1 已修復的關鍵缺陷（附證據）

| 編號 | 症狀 | 根因 | 狀態 |
|---|---|---|---|
| BUG-1 | 靜音插入到時間軸尾端 | `insertAt` 用未切割的 clips 計算 → `findIndex` 回 −1 | 已修（先 `split` 再插 gap） |
| BUG-2 | 混響輸出字面 `@@IR@@`，render 失敗 | 本 build 的 `afir` **沒有 `ir=<path>` 選項** | 已修（改用多 tap `aecho`） |
| BUG-3 | 歸一化靜默 no-op | `build: () => ''`，從未量測 peak | 已修（新增 peak 量測 pass） |
| BUG-4 | crossfade 未從時長扣除 | `timelineDuration` 只做原始加總 | 已修（`crossfadeOverlap()`） |
| BUG-5 | `preset.denoise` 只在 batch 生效 | compiler 未讀 preset | 已修 |
| BUG-6 | 參數越界讓整個渲染失敗 | 無夾限 | 已修（`clamp()` + warning） |
| S-1 | 連續量測 10/12 拿到 `report: null` | `-report` 檔名只有秒級解析度，同秒撞名 | 已修（`FFREPORT` 自選唯一檔名，12/12） |
| D-1 | **去重刪掉不同歌曲**（critical） | 相似度取最差對齊；定態訊號無鑑別力 | 已修（取最佳對齊 + 熵守門） |
| D-2 | **去重仍會刪掉不同歌曲**（critical，真實 HTTP 批次中發現） | 熵守門用**比例**（`seen/n`），短指紋的分母小使單一值的 11 個 sub-fingerprint 得 `1/11 = 0.09`，越過 0.05 地板；兩個無關單音（660 Hz FLAC 19 值 / 880 Hz MP3 11 值）相似度 **0.9375** → 其中一首被刪 | 已修（改用**絕對相異值數** `distinctValues < 4` 為守門，`isStationary()` 同時檢查計數與比例） |
| UI-1 | 選取微調四顆按鈕**永久 disabled**（`←選取`／`選取→`／`延長▶`／`◀縮短`） | `WaveformCanvas` 宣告了 `onNudgeSelection`／`onExtendSelection` 並以 `disabled={!onNudgeSelection}` 渲染，但 `EditorTab` 從未傳入 → 控制項是死的 | 已修（`EditorTab` 新增 `nudgeSelection()`／`extendSelection()` 並接上，另補 Alt+←/→ 與 Shift+←/→ 鍵盤手勢） |
| L-1 | **雙擊後「完全沒有視窗」、什麼都沒發生**（critical） | `openInBrowser()` 是 `spawn(...).unref()` **且沒有 `'error'` 監聽**。`spawn` 對「找不到、或被應用程式控制政策封鎖」的執行檔是**非同步**回報，外層 `try/catch` 永遠看不到；未處理的 `'error'` 事件讓 Node 直接終止行程 → 主控台視窗一閃即消失 | 已修（`startDetached()` 同時掛 `'error'` 與 `'spawn'`；改成四個啟動策略依序後備 `cmd`→`explorer`→`rundll32`→`powershell`；全部失敗則**大聲印出可手動輸入的 URL**。`tools/launcher.cjs` 頂層失敗改走 `reportFatal()`：stderr + 寫入 exe 旁的 `AudioUsbStudio-error.log` + TTY 時停住等按鍵，不再讓視窗一閃即散） |
| UI-2 | 開啟後「按什麼都沒反應」：唯一看得到的檔案選擇器是死路 | `EditorTab` 的 `<input type="file">` 只用 `URL.createObjectURL` 做本機播放，**從未把檔案送進引擎**，所以波形／剪輯／效果／匯出永遠拿不到它；且沒有空狀態引導，實務上只有「手動輸入絕對路徑」一條能走的路 | 已修（新增 `OnboardingPanel` 空狀態與 `file-intake` 上傳／拖放，接上 `/api/pick`、`/api/upload`、`/api/file`；失敗一律顯示出來，不再靜默） |

---

## 11. 網頁 UI（已補完的互動）

UI 只做顯示與送意圖，**零 DSP**；所有音訊處理都在 Node 引擎經 ffmpeg 完成。

### 11.1 波形與時間軸

| 能力 | 操作 | 實作要點 |
|---|---|---|
| 縮放 | 滾輪（以指標位置為錨點）、工具列 `放大`／`縮小` | **純前端**：一次取足夠 bucket 數，縮放只改「畫哪一段 `peaks`」，每格滾輪只重繪 canvas，**不重打伺服器** |
| 縮放至選取 | 工具列按鈕 | 以選取範圍 ±5% padding 為視窗 |
| 平移 | Shift+滾輪、Alt+拖曳、工具列 `←`／`→` | 平移量為目前視窗寬度的一半 |
| 回到全曲 | 雙擊波形、工具列 `全曲` | 僅在已縮放時可用 |
| 選取 | 拖曳；`Alt+←/→` 平移、`Shift+←/→` 調整尾端 | 平移夾限在 `[0, duration-len]`；尾端保留 1 ms 下限，因 `activeRange()` 把零寬選取視為「無選取」並回退到整條時間軸 |
| 數值讀取 | 波形上與工具列皆顯示 `from → to（長度）` | — |

縮放必須是 **native non-passive** 的 `wheel` 監聽（React 的合成事件是 passive，`preventDefault()` 無效，會讓整頁跟著捲動）。

### 11.2 編輯與復原

- `TimelineTrack` 的 HTML5 拖放重排已接 `moveClip`，含拖到**末端位置**。
- 復原／重做：工具列按鈕 + `Ctrl+Z`／`Ctrl+Y`（`Ctrl+Shift+Z` 亦可），快照堆疊上限 100 步；`commit()` 會先丟棄 redo 分支，與引擎 `History` 語意一致。
- 鍵盤：`Space` 播放/暫停、`S` 分割、`Ctrl+Z/Y` 復原重做。在 `INPUT`/`SELECT`/`TEXTAREA` 內不攔截。

### 11.3 效果

`EFFECT_ORDER` 由 `EFFECT_META` 推導（依 stage 排序），因此引擎的 **14 種效果**全部可從 `EffectsTab` 加入，參數控制項由 meta 的 `params` 泛型渲染，無硬編碼清單可與引擎走樣。

### 11.4 載入音訊（空狀態、原生對話框、拖放、上傳）

沒有音訊時畫面顯示 `OnboardingPanel`（不在任何分頁後面），三個大按鈕：**選擇音訊檔案**、**選擇資料夾**、**拖放檔案到這裡**。這條路徑存在的理由很具體：改動前唯一看得到的檔案選擇器只用 `URL.createObjectURL` 做本機播放，**從未把檔案送進引擎**，所以波形、剪輯、效果、匯出永遠拿不到它——使用者能做的唯一操作是手動輸入絕對路徑。

| 載入方式 | 走的路徑 | 失敗時 |
|---|---|---|
| 原生檔案／資料夾對話框 | `POST /api/pick` → PowerShell WinForms `-STA` | 回 **501** → UI 靜默改走瀏覽器上傳（不是錯誤訊息） |
| 拖放（含整個資料夾） | `webkitGetAsEntry()` 走訪 → 逐檔 `POST /api/upload` | 瀏覽器無法列舉資料夾時，明確告訴使用者改用原生資料夾對話框 |
| 瀏覽器上傳 | `POST /api/upload?name=`（原始位元組） | 超過 512 MB → **413**；檔名不安全 → 消毒後存放 |

三個實作要點：

1. **`dt.items` 與 `webkitGetAsEntry()` 必須在第一個 `await` 之前同步取得**——拖放事件的 `DataTransferItemList` 在事件處理器返回後就失效，先 await 再讀只會拿到空清單（`file-intake.ts`）。
2. 上傳一律**循序**，完成後才走正常的 probe → waveform → 載入路徑；並行上傳會讓「哪一個才是剛載入的」變得不可判定。
3. 引擎端播放改用 `api.fileUrl(activeSource.path)`（`/api/file?path=`），取代先前由 basename 推導、實際永遠解析不到的那個 URL；`<audio>` 的 `onError` 會把真正的原因顯示出來。

**錯誤不再被吞掉**：`store.ts` 有可逐條關閉的錯誤清單（上限 4 條）與進度提示行，`ApiError` 帶著 HTTP 狀態與伺服器 `error` 字串；`window` 的 `unhandledrejection` 與 `error` 也一併顯示。改動前失敗是靜默的，這正是「按什麼都沒反應」的來源。


