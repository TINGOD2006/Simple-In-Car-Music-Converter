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
| GET | `/api/measure?path=` | 量測單檔響度（一遍 `loudnorm` 分析）。回 `{ok,path,lufs,truePeakDb,lra}`。缺 `path` 回 400、不存在回 404、無法量測（無音訊串流／不可讀）回 **422**——回 0 會讓不可讀的列看起來像靜音，而不是壞檔 |
| POST | `/api/probe` | 單檔探測 |
| GET | `/api/waveform?path=&buckets=` | 波形峰值 |
| POST | `/api/compile` | 回傳精確 argv + filterComplex（UI 顯示真正指令） |
| POST | `/api/render` | 渲染（可帶 `doVerify`） |
| POST | `/api/preview` | 效果試聽；**直接回傳 `audio/wav` 位元組**（不再回一個瀏覽器取不到的路徑） |
| POST | `/api/batch` | `dryRun:true` 同步回 plan；否則 202 + jobId。`overwrite:true` 就地取代原檔（見 §9.2）；`overwrite` 非布林回 400。`includePaths:string[]` 限定只處理這些來源（見 §9.3）；格式錯誤回 400 |
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

### 9.2 為什麼 `overwrite` 是安全閥而不是開關

`overwrite:true` 會**就地取代使用者的原檔**。USB 上的音樂庫往往是唯一一份，所以
這裡刻意不寫成「把 `outputDir` 換成來源目錄」那種等價形式，而是另一條渲染路徑：

1. **先寫暫存檔**，位置在原檔**同一個目錄**（因此同一個磁碟區）。暫存檔帶目標副檔名
   （`<原名>.aus-tmp-xxxx.mp3`），否則 ffmpeg 選不到 muxer。
2. 渲染後**用 ffprobe 複驗**（時長、聲道、取樣率、響度都在容忍值內）。
3. **驗證有問題就拒絕取代**：刪掉暫存檔並把該列標為失敗。非覆寫模式只是把問題記進
   `message`；覆寫模式必須更嚴格——它要弄丟的是一份可用的原檔。
4. 驗證通過才 `rename` 覆蓋（同一磁碟區的 rename 是原子操作）。若目標副檔名與來源不同
   （例如 `.wav` → `.mp3`），`rename` **之後**才刪來源——順序永遠是先寫新的、再刪舊的。
5. 任一步失敗都只影響那一列：原檔一字不動，`.aus-tmp-*` 由 `discardStaged()` 清掉。

`outputDir` 在覆寫模式下被忽略但仍必填，而且是刻意的：讓「就地取代」與「寫到別的地方」
在呼叫端只差一個布林，比要求呼叫端永遠說清楚它想寫哪裡要危險得多。

**實測**（真實 ffmpeg，非字串斷言）：對含 2 個檔案的目錄跑一次 `overwrite` 批次 →
job `done`、progress 2/2、兩列 `ok` 且 `verify: ok`、報告回的 `outputPath` 就是磁碟上實際
存在的檔案、原 `.wav` 已被取代、**沒有任何 `.aus-tmp-*` 殘留**、`outputDir` 沒有被建立。

### 9.3 為什麼 `includePaths` 必須存在

`roots` 只能說「去哪裡找」，不能說「在你找到的檔案裡，只處理這幾個」。少了 `includePaths`，
UI 的勾選框就只是裝飾：使用者刻意不勾的無損原檔，會因為剛好躺在被選取的文件夾底下而被轉成
MP3，而那是不可逆的。

因此 `POST /api/batch` 接受 `includePaths: string[]`，`planBatch()` 在**做任何其他判斷之前**
先用它過濾（路徑先 `resolve`、大小寫不敏感，因為 Windows 呼叫端對大小寫沒有共識）。空陣列是
合法的，意思是「什麼都不轉」；格式錯誤（非陣列、含非字串）回 **400**——忽略一份壞掉的選取
清單，正好會轉換使用者取消勾選的那些檔案。

**實測**：來源目錄放一個無損 `Keep-Lossless.wav` 與一個 128 kbps `Convert-Me.mp3`，只把 mp3
放進 `includePaths`，跑真正的 `overwrite` 批次：

| | 之前 | 之後 |
|---|---|---|
| `Keep-Lossless.wav`（未勾選） | sha256 `4194aa4787c98434` | **`4194aa4787c98434`（完全相同）** |
| `Convert-Me.mp3`（已勾選） | 48,945 B / 128 kbps | 122,319 B / 320 kbps |
| `.aus-tmp-*` 殘留 | — | 無 |

dry run 亦確認 plan 只有 1 項且正是 `Convert-Me.mp3`。

### 9.4 `.aus-tmp-` 是契約字串，不是實作細節

暫存檔的命名是 `<原名>.aus-tmp-<6 字><副檔名>`（見 9.2），它必須**刻意保留目標副檔名**，
否則 ffmpeg 選不到 muxer——代價是 `Song - Artist.aus-tmp-u9nvkk.mp3` 在只看副檔名的程式眼裡
就是一支 `.mp3`。2026-10-16 的事故就是這樣來的：崩潰殘留的暫存檔被掃成一支真曲目，批次再把它
改名到它已經佔住的名字上，製造出 `Song - Artist (2).mp3`。

所以這個字串只有一個出口：`src/core/staging.ts` 的 `STAGING_MARK` 與 `isStagingName()`。
判斷必須是**大小寫不敏感的子字串**比對，**不能**用 `extname()`（`.aus-tmp-u9nvkk.mp3` 的
`extname()` 就是 `.mp3`），而且掃描與清掃兩側共用同一個判斷式，兩邊不可能對「什麼是暫存檔」
產生分歧。

**掃描側**：`library.ts` 的 `walk()` 在拿到 `Dirent` 的第一件事就
`if (isStagingName(d.name)) continue;`——在 `extname()` 之前、在 `join()` 之前。暫存檔因此
連一次 ffprobe 都不會被問到，也不可能出現在 `entries` 或 `errors` 裡。

**清掃側**：`sweepStaleStaging(dirs, olderThanMs = 1 小時)` 只刪暫存**檔**，且候選必須同時
通過兩道規則：

| 規則 | 條件 | 為什麼 |
|---|---|---|
| (a) 已經舊了 | `mtime` 早於 `now - olderThanMs` | 剛開始寫的暫存檔是活的 |
| (b) 沒人在用 | `openSync(file, 'r+')` 成功 | 別的行程正在寫的暫存檔，刪掉就是弄丟那次的成果 |

任何一關沒過就是保留。`statSync` 失敗（事故現場的損壞目錄項，`errno -4094`）保守地保留；
目錄與符號連結永遠不刪、也不跟隨；`kept` 只列「被找到但沒刪的暫存檔」，非暫存檔與目錄
完全不出現在回傳值裡——沉默代表「不甘我的事」。

**Windows 實測限制（別對規則 (b) 抱錯誤期待）**：Node/libuv 開檔用
`FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE`，所以**同一行程**已持有 fd 時，
第二次 `openSync('r+')` 會成功、`unlinkSync` 也會成功——規則 (b) **看不見同行程的持有者**。
它真正擋住的是**另一個行程**以 `FileShare.None` 取得的獨佔持有（實測 `openSync('r+')`
回 `EBUSY`），以及讓路徑根本開不起來的損壞（上述 `-4094`）。測試因此分兩條，兩條都在同一個
目錄放一個**同齡、沒人持有**的對照暫存檔，並斷言它在同一輪被刪除——否則「保留」可能只是
什麼都沒做：

- `staging: a stale staging file held open by an exclusive writer is kept, not deleted`
  ——子行程以 `FileShare.None` 獨佔持有（真 `EBUSY`）。
- `staging: a stale staging file this process holds open via openSync is kept when it cannot
  be opened for write`——行程內 `openSync` 持有該 fd，並以 `fchmodSync(fd, 0o444)` 讓它
  不可寫（Windows 會設 `FILE_ATTRIBUTE_READONLY`，探測回 `EPERM`）。這是 Windows 上
  **唯一能單獨歸因給規則 (b)** 的情境：開不了寫入，卻刪得掉。
- `staging: a stale staging file another process holds with write sharing is kept even though
  we can open it`——子行程以 `FileShare.ReadWrite` 持有（libuv 的形狀，也就是另一個
  AudioUsbStudio 實例正在渲染同一支曲目）。這裡 `openSync('r+')` **會成功**，規則 (b)
  看不見持有者，真正保住它的是「`unlinkSync` 失敗（`EBUSY`）即保留」那一關；測試先斷言
  「我們真的開得起來」這個前提，否則它會因為無聊的理由而通過。

（三條規則 (b) 測試都做過突變檢查：把 `canOpenForWrite()` 強制回 `true`，只有 read-only
那條轉紅；把 `unlinkSync` 的 try/catch 拿掉，只有 `FileShare.ReadWrite` 那條轉紅。兩關都
不是裝飾品。）

**實測**：`library:` 側亦有一條測試在「真檔 + 同目錄同齡 `.aus-tmp-` 檔（含子目錄）」下
只回 1 個 entry、`ffprobe` 也只被問過那一個檔；`node test/run.ts` 全綠。

### 9.5 就地轉換不改檔名，目標名不可用時要說人話

**`preserveNames`：改名是事故，不是功能。** 真實事故：一次 `overwrite` 批次把 199 個檔中的
123 個改成 `{artist} - {title}`，其中同名的兩首被 `planFilenames()` 綴成 `X.mp3` 與
`X (2).mp3`。使用者要的是「把這些檔轉成 MP3」，不是「幫我重新命名」。所以 `overwrite:true`
的預設是 `preserveNames:true`：

- 目標名就是來源自己的名字。副檔名**不分大小寫相同時逐字保留**（`TRACK.MP3` 不會變成
  `TRACK.mp3`）；容器真的改變時才換成 preset 的副檔名（`song.wav` → `song.mp3`），否則
  檔案內容會跟它的名字互相說謊。
- **不套用 `filenamePattern`**，也**永不產生 `(2)`**。
- 要標籤命名就明確傳 `preserveNames:false`；`overwrite:false`（匯出到別的目錄）行為完全不變。
- `POST /api/batch` 接受 `preserveNames`，非布林回 **400**——把壞掉的值強制轉型，正好會
  重新命名使用者要求不要動的檔案庫。

§9.2 的「先寫暫存檔 → 複驗 → 才覆蓋」流程不變，變的只有目標檔名怎麼決定。

**目標名不可用時**：損毀的 FAT32 目錄項佔住某個檔名時，`statSync(finalPath)` 丟的是
`UNKNOWN: unknown error`（node errno -4094）——**不是** ENOENT。因此判斷原則寫成「**除了
乾淨的 ENOENT 以外都算這個名字不能用**」，不窄化成特定 errno、也不比對訊息文字。（實測：
本機 NTFS 上除了 NUL byte 之外合成不出這個錯誤，`?`、`:`、保留名 `CON`、超長名、>MAX_PATH
全部回 ENOENT，所以真實裝置的那個 errno 只能靠單元測試覆蓋「非 ENOENT」分支。）

rename **之前**先探測，因為 rename 之後原檔就沒了，那是最後一個還能保護它、也還能解釋的時刻：

| 探測結果 | 行為 |
|---|---|
| `ENOENT`（目標不存在） | 照舊 rename |
| 目標是目錄，或 `stat` 丟非 ENOENT | 該列 `failed`：`目標檔名在這台裝置上損毀，無法寫入：<檔名>。請用磁碟檢查工具修復這個資料夾，或先在電腦上轉換後再複製回來。（<裝置／探測的原始說法>）` |
| 目標是別人的一般檔案 | 該列 `failed`，訊息指明該檔名被佔用；不覆蓋、不刪除 |
| `rename` 本身失敗 | 同一個句式，並附上 rename 的**原始錯誤文字** |

無論哪一種：`discardStaged()` 清掉暫存檔，**原檔一位元組都不動（mtime 也不動）**，
`outputPath` 回 `null`（不謊報一個不存在的路徑）。

**順手修掉的兩個靜默資料遺失**（保留檔名之後才變得可達）：

1. 同目錄有既存的 `song.mp3`，同批次的 `song.flac`（preset mp3）目標也是 `song.mp3`：舊行為
   會覆蓋那個既存檔、再把自己當成「已被取代的來源」刪掉。現在前者讓後者 `skipped`
   （`target name is taken by an existing file (song.mp3)`）；同一批次內兩首搶同一個還不存在
   的名字時，先到者得，後者 `skipped`（`target name is already claimed by another track in
   this batch`）。兩者都排在 dedup 與容量判斷**之後**，所以被丟棄的項目不會佔走名字。
2. 刪除來源原本用 `resolve()` 比字串。來源 `TRACK.MP3`、目標 `Track.mp3` 在 Windows 上是
   **同一個目錄項**，舊碼會把剛剛寫好的轉檔刪掉。改用 `realpathSync()` 比較（`isSameFile`）。

**實測**（真實 ffmpeg 批次，非字串斷言）：`INTEGRATION: overwrite refuses a damaged
destination name and leaves the original intact`（同名目錄佔位 → `failed`、訊息含檔名與可行動
建議、原檔 bytes **與 mtime 完全相同**、佔位目錄未被刪、無 `.aus-tmp-` 殘留）；
`INTEGRATION: in-place overwrite keeps the original names by default`（兩個原本會撞成
`X.mp3`／`X (2).mp3` 的檔各自保留原名，且顯式傳入的 `filenamePattern` 被忽略）；
`INTEGRATION: preserveNames:false still re-organises in-place by the tag pattern`；
`INTEGRATION: in-place naming keeps a source name that already has the preset extension`
（`TRACK.MP3`）；`INTEGRATION: an in-place conversion never claims a name another file already
uses`（既存檔 bytes 不變、批次外檔案不被動到）。

### 9.6 清掃暫存檔的時機：真跑之前，dry run 永遠不清

§9.4 的 `sweepStaleStaging()` 原本只被交付、沒有任何呼叫端。後果不是理論：上一次崩潰留下的
`.aus-tmp-*.mp3` 會一直躺在隨身碟上（實測 8 個、76.7 MB），而那個名字正是「與真檔撞名後
產生 `(2)` 重複檔」那條事故的來源。

**時機與範圍**（`sweepStaleStagingUnder()`，定義在 `src/server/index.ts`，HTTP 與 CLI 共用
同一支；放在這裡而不是新模組，是因為本次變更的寫入範圍就是這四個檔案。`src/cli/index.ts`
以 `import { sweepStaleStagingUnder } from '../server/index.ts'` 取用 —— 該模組在 import 時
只定義函式，不會開始監聽）：

| 情況 | 行為 |
| --- | --- |
| `/api/batch` 且 `dryRun: true` | **完全不清掃**：handler 在 dry-run 分支就 return，清掃寫在 job callback 內，dry run 到不了那一行 |
| `/api/batch` 真跑 | job 開始後、`runBatch` 之前清掃本次的 `roots`（含子目錄） |
| CLI `batch` | `--dry-run` 在清掃之前 return；真跑清掃同一組 roots |
| 清掃範圍 | 只有本次的 `roots`，每個先 `resolve()` 後去重；不往上層目錄走、不掃整個磁碟區 |
| 清掉 N > 0 | job 進度顯示 `已清除 N 個上次留下的暫存檔`；完成後的 job report 也帶 `stagingSweep: { removed, notice }`；CLI 直接印同一行 |
| 清掉 N = 0 | 不顯示任何訊息（`notice: null`）——每次掃描都吵「清除 0 個」只會被使用者學會忽略 |
| 清掃本身失敗（root 不可讀／字串不合法） | 吞掉：清掃是附加工作，不能讓批次因此失敗；壞掉的 root 由掃描自己回報 |

「什麼算過期」仍然是 `src/core/staging.ts` 的兩條規則（mtime 門檻 + 開不了檔就保留），這裡
只決定**何時**問、**問哪些目錄**，不重寫判定，所以兩邊不會漂移。dry run 不清掃也不是禮貌
問題：dry run 的契約是「不改動磁碟」，刪檔就是改動。

**實測**（`test/server.test.ts`，真 ffmpeg）：`end-to-end: a real batch sweeps a previous
crash's staging file, a dry run does not` —— 目錄內放 `song.mp3` 與 mtime 被推到 2 小時前的
`song.aus-tmp-abc123.mp3`：

- dry run → 200，計劃只有 **1** 條（暫存名不算曲目），之後**兩個檔案都還在**；
- 真跑 → 暫存檔**已被刪除**、`song.mp3` **仍在**（且照常被轉檔），job report 的
  `stagingSweep.removed` 恰 1 筆、`notice` 逐字為 `已清除 1 個上次留下的暫存檔`。

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

**現況（M1+M2 完成）**：typecheck 零 error、**227/227 passed**、web 兩道門檻
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

### 11.5 桌面版外殼（v0.2）

同一個引擎有第二個前端：一個真正的 Windows 視窗。規格、架構與驗收證據見 **[`SPEC-DESKTOP.md`](SPEC-DESKTOP.md)**。

| | 網頁版（v0.1） | 桌面版（v0.2） |
|---|---|---|
| 啟動 | `AudioUsbStudio.exe serve` → 自己開瀏覽器 | 雙擊 `AudioUsbStudio.exe` → 出現視窗 |
| 程序主控台 | 有（PE 子系統 3） | 無（PE 子系統 2，`WinExe`） |
| UI | 外部瀏覽器分頁 | 內嵌 WebView2 控制項 |
| 原生檔案對話框 | `POST /api/pick`（引擎端 PowerShell） | 外殼的 `OpenFileDialog`／`FolderBrowserDialog`，經 `chrome.webview` 訊息通道 |
| 發行 | `release\`（541 MB） | `dist\AudioUsbStudio-0.2.0-win-x64\`（651 MB，自帶 .NET 執行階段） |
| 引擎 | 同一顆 `AudioUsbStudio.exe`（`--self-contained` 的 Node SEA） | 同一顆，改名為 `engine\AudioUsbStudio.Engine.exe`，**零改動** |
| 批次／CLI | `AudioUsbStudio.exe batch …` | `engine\AudioUsbStudio.Engine.exe batch …` |

外殼**不碰 DSP**：它只負責挑一個自由埠、把引擎當子行程啟動（用 Win32 Job Object 綁生命週期，關窗即連坐）、等 `/api/health` 回答、然後把該位址載入 WebView2。引擎那一側的程式碼與 195 個既有測試**一行未改**（`git status --porcelain -- src test` 的已追蹤檔案修改數為 0）。

`api.pick` 因此在瀏覽器與外殼裡都能用，三層降級：外殼橋接 → 引擎端 `POST /api/pick` → 瀏覽器上傳（`NoNativeDialogError`）。


