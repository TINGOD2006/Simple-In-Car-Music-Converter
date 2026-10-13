# M1 對抗式複查報告（Lead 獨立執行）

狀態：**M1 不可作為 M2 的地基，直到下列 4 項阻塞缺陷修復。**

本報告的每個發現都來自**實際執行 ffmpeg 的真實輸出**，不是讀碼推論。
複查探針：`rev-probe2.mjs`（152 行，8 個攻擊面 A–H），以
`AUS_BATTERY=<dir>` 指向暫存工作區後執行。基準：`npm run typecheck` 零 error、
`node test/run.ts` → 102/102 passed。

> 探針腳本與其 `_battery` 暫存目錄已於修復後清理，避免在交付物中留下一次性操作檔。
> 探針原始碼保存在 scratch vault，entry id `20261013092043-rq7tb2`，可用 `scratch_show` 取回。

**關鍵結論：102 個單元測試全綠，但探針仍找到 6 個真實缺陷。**
原因是既有測試只斷言 **argv 字串**（「有沒有生成這個濾鏡」），
從不**真的把 ffmpeg 跑起來**再檢查輸出。所有缺陷都落在
「argv 看起來對、實際輸出錯」的縫隙裡。

---

## BUG-1 (critical) 靜音插入位置錯誤：`silenceRange` 把靜音放到時間軸尾端

- 檔案：`src/core/edl.ts:185-227`
- 可重現：
  ```js
  const t = EDL.makeTimeline([EDL.makeClip({ sourceId:'src0', srcIn:0, srcOut:10 })], 44100, 2);
  EDL.silenceRange(t, 3, 6).clips.map(c => c.sourceId + '[' + c.srcIn + ',' + c.srcOut + ')');
  ```
- 實際輸出：`["src0[0,3)", "src0[6,10)", "__silence__[0,3)"]` ← 靜音在**結尾**
- 預期：`["src0[0,3)", "__silence__[0,3)", "src0[6,10)"]`
- 渲染結果：`render.ok = false | render.durationSec = 0`
- 根因：`insertAt` 在第 192 行用**尚未切割**的 `before.clips` 計算
  （`starts.get(c.id) >= from`）。單一 10s clip 的 start 是 0，`0 >= 3` 為 false，
  所以 `findIndex` 回 −1，第 223 行把 `at` 設成 `silenced.length` → 追加到尾端。
  該函式從未先 `split()`，因此 `insertAt` 永遠算不出正確插入點。
- 建議修法：先 `split(before, from)` 再 `split(..., to)`（比照 `deleteRange`
  第 158-164 行的作法），然後在切點之間插入單一 gap，並移除迴圈中被切出的中段。

## BUG-2 (critical) 混響輸出字面 `@@IR@@`，ffmpeg 直接失敗

- 檔案：`src/core/effects.ts:140`、`src/core/compiler.ts`（`impulsePaths` 從未被讀取）、
  `src/core/render.ts`（從未替換 token、從未傳 `impulsePaths`）
- 可重現：
  ```js
  effects: [{ id:'e1', enabled:true, type:'reverb', preset:'large-hall', mix:0.3 }]
  ```
- 實際輸出 filter_complex：
  `afir=gtype=0:ir=@@IR@@large-hall:mix=0.3`
- 實際渲染：`render.ok = false`，`ffmpeg exited 4294967274`
- 預期：`@@IR@@large-hall` 應被替換成真實的脈衝響應檔路徑，或明確報錯拒絕渲染。
- 根因：`CompileInput.impulsePaths` 宣告了卻沒有實作；`render()` 既不生成 IR、
  也不替換 token，於是佔位符原樣送進 ffmpeg。**「混響」這項核心功能目前 100% 無法使用。**
- 建議修法：在 renderer 的 scratch 目錄合成 IR（例如以 `lavfi` 的
  `sine`+`aecho` 或指雜訊衰減產生脈衝響應 WAV），再以實際路徑替換 token；
  若無法生成則回傳結構化錯誤，而不是把佔位符交給 ffmpeg。

## BUG-3 (major) `normalize`（歸一化）是靜默 no-op

- 檔案：`src/core/effects.ts:152-159`（`build: () => ''`）、`src/core/render.ts`
- 可重現：clip 加 `{ type:'normalize', targetPeakDb:-1.0 }`
- 實際輸出 filter_complex：
  `[0:a]atrim=start=0:end=4,asetpts=N/SR/TB[c0];[c0]aresample=44100,...[prog]`
- `=> contains any volume/normalize filter? false`、`warnings: []`
- 預期：應先量測峰值再套用增益，或至少產生 warning。
- 根因：註解說「renderer handles it and the compiler is told the resolved gain」，
  但 renderer 從未為 `normalize` 做量測。**「歸一化」這項核心功能靜默失效，
  使用者以為做了、實際完全沒做。**
- 建議修法：比照 loudnorm 的兩遍作法，加一個 peak 量測 pass，
  將 resolved gain 併入 `resolvedGainDb`。

## BUG-4 (major) crossfade 未從時長扣除，導致 verify 誤判失敗

- 檔案：`src/core/edl.ts:67-69`（`timelineDuration`）、`src/core/render.ts:110`
- 可重現：兩個 4s clip，第二個 `crossfadeInSec = 1`
- 實際：`EDL timelineDuration = 8`（未扣除重疊）→ `render.durationSec = 8`
  → **實際渲染檔案長度 = 7s** → `verify(expectedDuration=8).ok = false`，
  `problems: ["duration is 7.000s, expected 8.000s (delta 1.000s)"]`
- 預期：EDL 時長應為 7s（crossfade 讓兩段重疊 1s），verify 應通過。
- 根因：`timelineDuration` 只做 `sum(clipDuration)`，未扣除每個
  `crossfadeInSec`；`clipStarts`/`locate` 也有同樣的偏移錯誤，
  所以只要有 crossfade，播放頭位置與 verify 期望值全部偏掉。
- 影響：**任何使用 crossfade 的專案都無法通過驗證**，會被誤報為壞檔。
- 建議修法：在 `timelineDuration`、`clipStarts`、`locate` 中扣除 crossfade 重疊，
  並讓 renderer 的 `durationSec` 改用 `timelineDuration(opts.timeline)`。

## BUG-5 (major) `preset.denoise` 只在 batch 路徑生效，單曲 render 靜默略過

- 檔案：`src/core/compiler.ts`（從未讀取 `preset.denoise`）、`src/core/batch.ts:142-144`
- 可重現：以 `EDL.usbPreset()`（`denoise: 'gentle'`）直接 `compile()`
- 實際 filter_complex：`[0:a]atrim=...`，`=> contains afftdn? false`
- 預期：同一個 preset 不應因為進入點不同而產生不同音訊。
- 根因：`batch.ts` 自己把 denoise 加成一個 effect，`compiler.ts` 則完全忽略
  `preset.denoise`。**批次匯出會降噪，但 CLI `render` 與網頁編輯器單曲匯出不會** ——
  同一份 preset、兩種結果。
- 建議修法：把 `preset.denoise` 的處理移進 `compiler.ts`（當 clip 上沒有
  明確 denoise effect 時套用），讓所有進入點一致。

## BUG-6 (minor) 效果參數越界直接讓整個渲染失敗，無夾限與提示

- 檔案：`src/core/effects.ts`（各 `build`）
- 實際以 ffmpeg 逐一驗證（`-f lavfi -i sine=... -af <frag> -f null -`）：
  | 參數 | 結果 |
  |---|---|
  | `adeclick=threshold=0` | exit 4294967262 失敗（合法範圍 1..100）|
  | `adeclick=threshold=500` | exit 4294967262 失敗 |
  | `atempo=0.25` | exit 4294967262 失敗（atempo 下限 0.5）|
  | `alimiter=limit=1.5` | exit 4294967262 失敗（上限 1.0）|
  | `alimiter=limit=0` | exit 4294967262 失敗 |
  | `aecho=0.8:0.9:0:0` | exit 4294967274 失敗（延遲須 > 0）|
  | `atempo=3` | exit 0 通過 |
  | `equalizer=...:width=0:...` | exit 0 通過 |
  | `volume=-500dB` | exit 0 通過 |
  | `highpass=f=0` | exit 0 通過 |
- 影響：UI 滑桿只要停在邊界值（例如速度拉到最慢、限幅器超過 0 dB），
  **整個匯出就會失敗**，而錯誤訊息只是 ffmpeg 的原始 exit code。
- 建議修法：在 `effects.ts` 夾限到 ffmpeg 合法域
  （`declick.threshold` 1..100、`speed.factor` 0.5..100、`limiter.limitDb` ≤ 0、
  `echo.delayMs` > 0），並在夾限時推入 warning 讓 UI 顯示。

## 已驗證無問題的攻擊面

- **不同取樣率多來源 concat**（探針 D）：44.1kHz + 48kHz 兩個來源，`render.ok = true`、
  渲染長度 8s、輸出 44100Hz 正確。
- **`probe()` 對不存在的檔案**（探針 H）：**不 throw**，回傳
  `audio = null | formatName = "unknown" | duration = 0 | streams.length = 0`，
  呼叫端可安全以 `audio === null` 判斷失敗。
- **CBR 320k**：既有整合測試以 ffprobe 實測 `bit_rate = 320000` 通過（非 158k）。

## 結論

M1 的核心編輯模型與渲染管線骨架是健全的：102 個測試、不同取樣率拼接、
CBR 320k、錯誤結構化回傳都正確。但**四項使用者明列的核心功能目前是壞的**：

| 功能 | 狀態 |
|---|---|
| 靜音（Silence） | 壞 —— 靜音落在時間軸尾端 |
| 混響（Reverb） | 壞 —— 100% 渲染失敗 |
| 歸一化（Normalize） | 壞 —— 靜默 no-op，什麼都沒做 |
| 淡化/交叉淡化（Crossfade） | 壞 —— verify 誤判、播放頭偏移 |

**必須先修 BUG-1、BUG-2、BUG-3、BUG-4（阻塞項），才可作為 M2 的地基。**
BUG-5、BUG-6 為一致性與健壯性問題，可在 M2 進行中一併處理。

根本教訓：既有 102 個測試全部只斷言 argv 字串，從未真正執行 ffmpeg 並檢查輸出。
M2 的測試必須包含**真實渲染 + ffprobe 複驗**，否則同類缺陷會再次穿過綠燈。

---

# 修復複驗（Lead 執行，2026-10-13）

上列 6 項缺陷已全部修復，且**每一項都以真實 ffmpeg 輸出重新量測**，不是只跑單元測試。
驗收基準：`npm run typecheck` 零 error、`node test/run.ts` → **166/166 passed**。

## 單次渲染同時驗證 BUG-1 / BUG-2 / BUG-3 / BUG-4

一條 timeline：`s1[0,4)` + `s2[0,4) crossfade=1`，再 `silenceRange(1,2)`，
`b` clip 帶 `reverb(large-hall, mix 0.3)` 與 `normalize(-3.0)`。

| 檢查 | 結果 |
|---|---|
| clip 順序（BUG-1） | `s1[0,1) __silence__[0,1) s1[2,4) s2[0,4)` ← 靜音在**中間**，不再是尾端 |
| `timelineDuration`（BUG-4） | **7.000**（8 − 1 重疊），已扣除 crossfade |
| filter graph 含 `aecho=`（BUG-2） | `true`，不再有 `@@IR@@` 佔位符 |
| `render.ok` | `true`（原本 BUG-2 是 `ffmpeg exited 4294967274`） |
| `verify.ok` | `true`，`problems: []` |
| ffprobe 實際產物 | duration 7.191s、codec mp3、44100Hz、2ch、**stream bit_rate 320000（真 CBR）** |

## BUG-3 歸一化：獨立量測增益確實生效

以 ffmpeg `volumedetect` 量測**真實輸出檔**的 max_volume（非讀 argv）：

| 設定 | 量測峰值 |
|---|---|
| 來源檔 | −41.1 dBFS |
| 不加 normalize | **−41.1 dB**（維持原狀） |
| `normalize targetPeakDb = -3` | **−3 dB** ✅ |
| `normalize targetPeakDb = -12` | **−12 dB** ✅ |

先前「歸一化是靜默 no-op」的判定已不成立 —— 增益依目標精確落點。

## BUG-5 一致性

`src/core/compiler.ts:73-101` 現在自行套用 `preset.denoise`（當 clip 沒有自己的 denoise
effect 時），註解明言「applied here, not in the batch layer, so that a single render and the
batch run agree」。單曲 render 與批次輸出一致。

## BUG-6 參數夾限

`src/core/effects.ts` 的 `clamp(v, lo, hi, what, ctx)` 已套用於所有已知會讓 ffmpeg 失敗的參數：
`declick.threshold` 1..100、`limiter.limitDb` −60..0、`echo.delayMs` 1..9000、
`echo.decay` 0..1、`reverb.mix` 0..1、`speed.factor` 0.5..100；
夾限時推入 `warnings` 供 UI 顯示。混響改用多 tap `aecho` 後不再需要外部 IR。

## 額外修復（複驗期間發現，非原報告項）

- **S-1（critical，基礎設施）**：`runFfmpeg()` 原本依賴 ffmpeg 的 `-report` 預設檔名，
  該檔名只有**秒級**解析度，同目錄同秒的第二次呼叫會覆蓋第一個 log。
  實測連續 12 次量測只有 **2 次**解析成功 → loudnorm 目標靜默失效。
  修法：改以 `FFREPORT=file=ffmpeg-aus-<pid>-<time>-<seq>.log:level=48` 自選唯一檔名。
  修後 **12/12 全部解析成功**。
- **dedup keeper 規則**：docstring 承諾「bitrate → duration → 輸入序」，實作只比 duration。
  已補上 bitrate 優先（未知 bitrate 不勝過已知值），使同一首歌的 320k 版本勝過 128k 版本。
  刻意**不**改用字典序路徑做最終 tie-break —— 兩份位元相同的檔案在各項可量測指標上完全相等，
  誠實的答案就是「掃描順序中的第一份」，也讓使用者自己的 root 優先序決定結果。
- **D-2（critical，去重仍會刪掉不同歌曲）**：在**真實 HTTP 批次**（`/api/batch` → `/api/jobs/:id`）
  中發現，先前以為已由「熵守門」修好的 D-1 仍會復發。守門用的是**比例** `seen/n`，
  分母是**指紋長度**，因此越短的定態指紋比例越高：一個只含**單一值**的 880 Hz MP3 只有 11 個
  sub-fingerprint，比例 `1/11 = 0.091`，越過 0.05 地板。實測該曲與一首無關的 660 Hz FLAC
  （19 值、比例 0.053）相似度 **0.9375**，其中一首被當重複刪除（HTTP 批次回報 `2 ok, 2 skipped`）。
  修法：新增 `distinctValues()`（絕對相異值數）與 `MIN_DISTINCT_VALUES = 4`，並以
  `isStationary()` 同時檢查**絕對計數**與比例；`similarity()` 改用它。修後同一批次回報
  `3 ok, 1 skipped`，只有位元相同的真拷貝被丟。
  實測對照：真實音樂 39–95 個相異值（比例 0.91–1.00）、ambient drone 54–95（0.56–0.86），
  與定態素材的 1 個值之間有極寬的分離帶。
  教訓：**比例型守門在分母會縮小時不安全**；對「有無資訊」的判斷要用絕對量。

## 結論（更新）

M1 **現在可以作為 M2 的地基**：4 項阻塞缺陷與 2 項一致性/健壯性缺陷全部關閉，
並以真實 ffmpeg 量測複驗。原始報告的教訓已落實為測試策略：
M2 的 `test/batch.test.ts` 與 `test/integration.test.ts` 均包含**真實渲染 + ffprobe 複驗**。
