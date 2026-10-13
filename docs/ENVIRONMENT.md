# AudioUsbStudio — 環境與沙箱限制（實測，權威）

本檔記錄**已實測驗證**的環境事實。修改任何與 I/O、子程序、ffmpeg 呼叫相關的程式碼前**必讀**。
每一條都是踩過坑得到的，不是推測。

---

## 1. 工具鏈位置

| 工具 | 路徑 / 版本 |
|---|---|
| ffmpeg | `C:\ffmpeg-8.1-full_build\bin\ffmpeg.exe`（8.1-full_build-www.gyan.dev） |
| ffprobe | `C:\ffmpeg-8.1-full_build\bin\ffprobe.exe` |
| node | v24.20.0（**原生執行 .ts**） |
| npm | 11.19.0 |
| python | 3.14.7（`C:\Python314`） |
| 無 | cargo、sox |

ffmpeg 規模實測：**372 demuxers / 183 muxers / 231 音訊解碼器 / 91 音訊編碼器**。
`findBinaries()` 解析順序：explicit dir → `AUS_FFMPEG_DIR` → PATH → well-known（含上面路徑）。

---

## 2. 沙箱硬限制（**架構級約束，不可繞過**）

### 2.1 管線 stdio 被封鎖
```
Error: spawn EPERM  (errno: -4048, syscall: 'spawn')
```
- `child_process.spawn` 帶 **piped stdio** → 一律失敗，即使父程序由 pwsh 啟動也一樣。
- `stdio: 'ignore'` → **成功**，且子程序可以寫檔。
- 失敗變體（全部實測失敗）：`shell: true`、`spawn cmd.exe /c ...`、`spawn pwsh.exe`（ENOENT）、引號包 exe。
- `node --test` 內部會 spawn 子程序 → **不可用**，故本專案自寫 in-process runner（`test/run.ts`）。

> **因此：引擎所有與 ffmpeg 的溝通必須走檔案式 I/O，不可用 stdout pipe。**

### 2.2 已驗證的檔案式 I/O 通道
```powershell
# 探測：-o 寫 JSON 檔（必須相對路徑 + cwd；絕對路徑會被 cwd 前綴而失敗）
ffprobe -v error -print_format json -show_format -show_streams -o probe.json src.wav
#   → 絕對路徑錯誤訊息：Failed to open output '...workspace\C:\...' with error: Invalid argument

# 進度：-progress 寫檔
ffmpeg ... -progress progress.txt out.mp3
#   → progress.txt 內含 bitrate=/total_size=/out_time_us=/progress=end

# 診斷：-report 在 cwd 產生 ffmpeg-YYYYMMDD-HHMMSS.log（內含 loudnorm JSON）
ffmpeg -report ...
```
- **`FFREPORT` 環境變數有效，且是本專案正式採用的通道**（舊版文件曾記為「無效」，已更正）。
  寫法：`FFREPORT=file=<name>:level=48`，在 cwd 產生 `<name>`。
  實測 `level=32` 與 `-report`（預設 level=48）產生的 loudnorm JSON block **逐位元組相同**，
  故可安全用 `level=48` 取得與 `-report` 等價的內容。
- `ebur128=metadata=1` 寫 ffmetadata **無效**（只寫出 `;FFMETADATA1` + `encoder=...`）。

### 2.2.1 report 檔名撞名（S-1，已修）
`-report` 的檔名只有**秒級**解析度（`ffmpeg-YYYYMMDD-HHMMSS.log`）。同一目錄同一秒內的
第二次呼叫會**覆蓋**第一個 log，導致較早的呼叫讀到 null report。
- 症狀：12 次連續量測只有 2 次解析成功（loudnorm 目標因此靜默失效）。
- 修法：`runFfmpeg()` 不再依賴 ffmpeg 的預設檔名，改以
  `FFREPORT=file=ffmpeg-aus-<pid>-<time>-<seq>.log:level=48` **自選唯一檔名**，
  檔案由建構即為全新，before/after 目錄 diff 只留作安全網（例如 `opts.env` 覆寫了 FFREPORT）。
- 修後實測：**12/12 全部解析成功**。

### 2.3 檔案系統
- `run_script` 的 node **無法新建目錄**（`EPERM: operation not permitted, mkdir`），workspace 與 `$DSH_SCRATCH` 皆然；但**寫入 pwsh 已建好的目錄可以**。
- 純 node `writeFileSync` 到未預建路徑 → EPERM；`pwsh → node` 寫檔 → 成功。
- npm 預設快取 `C:\Users\TINGOD\AppData\Local\npm-cache` → **EPERM**。
  **必須用 workspace-local 快取**：`npm install --cache "$p\.npm-cache"`。
- 測試 scratch 用 `os.tmpdir()`（`test/integration.test.ts` 的 `ROOT`），每次跑完自行清除。

#### 2.3.1 特定副檔名會被 scratch plugin 改寫（S-3）
`dsh-scratch-vault` 會攔截操作腳本，也會攔截**特定副檔名**的寫入並改寫到一個
不存在的目錄，症狀是看起來像路徑 bug 的錯誤：

```
Could not find a part of path '...\workspace\test.raw'.
```

實測：`test.raw` 被攔截，同一目錄的 `test.bin` 正常。因此 `src/core/dedup.ts`
的指紋暫存檔使用 **`.fp`** 副檔名，而非 `.raw`。

> 教訓：診斷「寫檔失敗」時，先換一個副檔名再懷疑路徑。若副檔名可疑（`.raw`
> 之類），用 `.bin` 或專案自有副檔名交叉比對，一次就能分辨是 plugin 攔截還是真 bug。

---

## 3. Node 24 執行 TypeScript 的限制

Node 直接跑 `.ts`（type stripping），但**只支援可抹除語法**：
- ❌ `enum` → `SyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]: TypeScript enum is not supported in strip-only mode`
  → 本專案改用 `const object + as const`（見 `src/core/effects.ts` 的 `Stage`）。
- ❌ ESM 下 `require` 不可用。
- tsconfig 已開 `erasableSyntaxOnly` 讓 tsc 提前攔下這類語法。

---

## 4. ffmpeg 能力邊界（與本專案直接相關）

### 4.1 AI 降噪：**不可作為 ffmpeg 濾鏡**
- `arnndn` 濾鏡存在，但整個 build 目錄**搜不到任何 `.rnnn` 模型檔**。
- DeepFilterNet 的 LADSPA DLL 載入全部失敗（`Failed to load '=deep_filter_mono'`）。
- **結論**：AI 降噪必須是「外部程序階段」：`ffmpeg 輸出 WAV → deep-filter.exe → 回 ffmpeg 鏈`。

### 4.2 DeepFilterNet 是**語音**模型 —— 不可進批次預設
實測「440Hz 正弦 + 白噪音」：

| 頻段 | 輸入 | 輸出 | 判定 |
|---|---|---|---|
| 全頻 | −20.2 dB | −59.2 dB | 掉 39 dB |
| 4kHz+（噪音） | −22.1 dB | −90.3 dB | ✅ 降噪有效 |
| **440Hz（訊號）** | **−26.9 dB** | **−84.3 dB** | ❌ **訊號被殺 57 dB** |

> **若把 DFN 放進批次預設值，整批音樂會變成近乎無聲。** 它只能是單曲手動 opt-in。

### 4.3 `afir` 濾鏡在此 build 是壞的 —— 混響必須用 `aecho`
- `ffmpeg -h filter=afir` 顯示選項只有 `dry / wet / length / gtype`，**沒有 `ir=`**；
  `-filters` 說明為 `N->A Apply Finite Impulse Response filter with supplied coefficients
  in additional stream(s)` → IR 必須是**第二個輸入串流**，不是檔案路徑參數。
- 以 `[0:a][1:a]afir=dry=0:wet=1:gtype=0[o]` 實測：exit 0 但 volumedetect =
  **max −91.0 / mean −91.0 dB（完全靜音）**；`gtype=-1` 同樣 −91.0。
- `afirsrc` 在圖內生成 IR 也失敗（`w` 是 win_func，不是 taps）。
- **結論**：混響改用內聯 `aecho=1:1:<delays>:<decays>`（多 tap），可嵌入既有逗號鏈，
  不需外部 IR 檔。四個預設實測皆有真實尾音（tail −45 ~ −51 dB，原始檔為真靜音）。

### 4.4 編碼器 / 容器
- 無專用 id3v2 muxer → ID3v2.3 用 mp3 muxer + `-id3v2_version 3`。
- muxer `E chromaprint` 存在（指紋可用於近似去重，但相似度比對需自寫）。
- **libmp3lame CBR 陷阱**：`-b:a 320k` 已選 CBR；加上 `-abr 1` 會切到 ABR，
  實測輸出只有 **158 kbps**。正確寫法是 `-b:a 320k -minrate 320k -maxrate 320k -bufsize 640k`。
- 192kHz 現實限制：MP3 最高 48kHz；96/192kHz 須 FLAC/WAV/AIFF/AAC。

---

## 5. 驗收門檻（每次改動都要全綠）

```powershell
$p='C:\Users\TINGOD\Desktop\CodeHome\AudioUsbStudio'; Set-Location $p
npm run typecheck     # tsc --noEmit，必須零 error TS
node test/run.ts      # 必須 166/166 passed
```

`web/` 前端另有兩道獨立門檻（於 `web/` 目錄執行）：
```powershell
cd C:\Users\TINGOD\Desktop\CodeHome\AudioUsbStudio\web
npx tsc --noEmit      # 零 error
npx vite build        # 必須產出 dist/
```
實測：兩者皆 exit 0，`dist/index.html` 0.41 kB、
`dist/assets/index-*.css` 4.24 kB、`dist/assets/index-*.js` 189.58 kB（gzip 60.62 kB）。

依賴已安裝（`typescript` + `@types/node`，devDependencies，workspace-local cache）。
若需重裝：`npm install --cache "$p\.npm-cache"`。
