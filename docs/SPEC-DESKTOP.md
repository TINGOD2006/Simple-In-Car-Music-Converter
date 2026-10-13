# AudioUsbStudio 桌面版規格（v0.2）

> 狀態：**草案，待核可**。依「討論 → 確認 → 寫規格 → 核可 → 才實作」的順序，本文件尚未開始實作。
> 使用者決策（2026-10-13）：外殼採 **A（C# WinForms + WebView2）**；發行採 **免安裝綠色版**；第一版 **不動 ffmpeg**。

---

## 0. 這份規格要解決什麼

**現狀症狀**（使用者原話）：「打開後無任何反饋」。
根因不是白屏，而是**外殼**：

| 問題 | 證據 |
|---|---|
| 雙擊會出現黑色主控台 | `release\AudioUsbStudio.exe` 的 PE 子系統 = 3（`WINDOWS_CUI`） |
| UI 只能在外部瀏覽器 | 引擎只提供 HTTP；啟動器 fire-and-forget 開瀏覽器且吞掉失敗 |
| 開瀏覽器失敗就什麼都看不到 | `src/server/main.ts` 的 `openInBrowser()` 沒有 `.on('error')` → 未捕捉例外會殺掉行程 |
| 第二個實例直接閃退 | `EADDRINUSE` 寫到 stderr，無視窗、無訊息 |

**目標**：雙擊就是一個原生視窗，裡面就是編輯器；**任何失敗路徑都要有看得見的訊息**。

---

## 1. 範圍

**納入**
- C# WinForms + WebView2 外殼（單一實例、原生視窗、原生檔案對話框）
- 免安裝綠色版發行佈局與建置腳本
- 引擎與頁面的橋接（原生對話框）、失敗模式的可見化

**排除（第一版不做）**
- ffmpeg 體積最佳化（425.8 MB）
- 程式碼簽章、自動更新、安裝程式
- 引擎的 DSP／API 行為變更

---

## 2. 架構

保留「**引擎＝獨立行程，經本機 HTTP + JSON 通訊**」這個邊界。理由：UI 換外殼時引擎零改動、195 個測試零改動、無介面批次（`batch …`，音樂 USB 的主力流程）繼續成立、引擎崩潰不會帶走視窗。

```
AudioUsbStudio-0.2.0-win-x64\
  AudioUsbStudio.exe                      ← 外殼（GUI 子系統，無主控台）
  AudioUsbStudio.Shell.dll
  AudioUsbStudio.Shell.deps.json
  AudioUsbStudio.Shell.runtimeconfig.json
  Microsoft.Web.WebView2.Core.dll         ← 621.1 KB
  Microsoft.Web.WebView2.WinForms.dll     ←  38.6 KB
  WebView2Loader.dll                      ← 原生載入器
  *.dll                                   ← 自帶 .NET 執行階段（見 §6）
  engine\
    AudioUsbStudio.Engine.exe             ← 既有 Node SEA exe，89.6 MB，**零改動**
    bin\
      ffmpeg.exe                          ← 213.0 MB
      ffprobe.exe                         ← 212.8 MB
      deep-filter.exe                     ←  25.7 MB
  README.txt
```

**為什麼引擎放在 `engine\` 子目錄**：引擎以 `dirname(process.execPath)` 當 `AUS_APP_ROOT` 來找 `bin\ffmpeg.exe`、`bin\deep-filter.exe`（`src/core/ffbin.ts`、`src/core/denoise.ts`）。把引擎與它的 `bin\` 一起放進 `engine\`，路徑解析**完全不用改**。

---

## 3. 啟動序列

```
外殼啟動（GUI 子系統，不顯示主控台）
 ├─ 1. 單一實例：Mutex "Local\AudioUsbStudio.SingleInstance"
 │      已有實例 → 把既有視窗帶到前景後退出（不閃退、不沉默）
 ├─ 2. 挑自由埠：TcpListener(Loopback, 0) 讀實際埠 → 停止
 ├─ 3. 建立 Win32 Job Object（KILL_ON_JOB_CLOSE）
 ├─ 4. 啟動引擎子行程：
 │      engine\AudioUsbStudio.Engine.exe serve --port <port>
 │      CREATE_NO_WINDOW；stdout/stderr 重導到 %LOCALAPPDATA%\AudioUsbStudio\engine.log
 │      子行程加入 Job Object → 外殼被強殺時引擎一起死
 ├─ 5. 顯示「正在啟動…」載入畫面（避免空白視窗）
 ├─ 6. 輪詢 GET /api/health（每 100 ms，逾時 15 秒）
 │      逾時/子行程結束 → 錯誤畫面（含 engine.log 尾巴 + 重試按鈕）
 ├─ 7. 建立 WebView2：
 │      user data folder = %LOCALAPPDATA%\AudioUsbStudio\WebView2
 │      （不可放進程式目錄，否則綠色版複製到唯讀位置會失敗）
 └─ 8. 導覽到 http://127.0.0.1:<port>/
```

**關鍵設計決定**：外殼**自己挑埠並用 `--port` 傳入**，因此不需要解析引擎的 stdout，也不需要引擎新增任何輸出格式。這是「引擎零改動」得以成立的關鍵。

`--port`、`--web`、`--scratch` 皆為現有參數（`src/server/main.ts:52` 的 `runServer`），且 `serve` 模式**不會**自動開瀏覽器（只有無引數／GUI 模式才會），正是外殼需要的行為。

---

## 4. 頁面 ↔ 外殼橋接（原生檔案對話框）

用 WebView2 的 message channel，不走 HTTP：

```
頁面 → 外殼   window.chrome.webview.postMessage({
                id, type: 'pick', mode: 'files'|'folder', title?, multiple?
              })
外殼 → 頁面   { id, ok: true,  paths: [...] }
              { id, ok: false, error: '...' }
```

新增 `web/src/native-bridge.ts`（約 60 行）：偵測 `window.chrome?.webview`、以 `id` 對應 promise、逾時（30 秒，使用者可能停在對話框前）。

`web/src/api.ts` 的 `api.pick` 改成三層降級：

1. **原生橋接**（桌面外殼內）→ `IFileOpenDialog`／`FolderBrowserDialog`，直接拿絕對路徑
2. **`POST /api/pick`**（瀏覽器開發模式）→ 既有的 PowerShell 對話框
3. **上傳**（`POST /api/upload`）→ 既有降級路徑

第 2 層保留不動，所以開發時用瀏覽器仍然可用；只是它從「唯一手段」退成「備援」。

---

## 5. 失敗模式：每一條都要有看得見的訊息

這是本次改版的核心價值。**沒有「什麼都沒發生」這條路。**

| 失敗 | 外殼行為 |
|---|---|
| 找不到 `engine\AudioUsbStudio.Engine.exe` | 錯誤畫面：預期路徑 + 「重新檢查」按鈕 |
| 埠被佔 | 重挑（最多 5 次），失敗才報錯 |
| 引擎 15 秒內沒回應 | 錯誤畫面 + `engine.log` 尾巴 + 「重試」 |
| 引擎中途崩潰 | 監看子行程 `Exited` → 「引擎已停止」+ 「重試」 |
| WebView2 執行階段缺失 | 錯誤畫面 + 說明 + 「開啟下載頁」按鈕 |
| WebView2 導覽失敗 | 錯誤畫面 + URL（可直接貼到瀏覽器） |
| 外殼自身例外 | 全域 `Application.ThreadException` → MessageBox + 寫 `shell-error.log` |

---

## 6. 發行模式：自帶 .NET 執行階段（決定）

`SelfContained=true`、`RuntimeIdentifier=win-x64`、`PublishSingleFile=false`。

**理由**：框架相依版在缺 .NET 桌面執行階段的機器上**根本無法啟動**，連錯誤訊息都沒有——正是這次要治的病。付 +約 70 MB 換「雙擊就能跑」。

**體積預估**：外殼自帶執行階段約 70 MB ＋ 引擎 89.6 MB ＋ bin 451.5 MB ≈ **611 MB**（現行 541 MB）。
後續若要縮，再評估 `PublishTrimmed`（WinForms 裁剪支援有限，須實測）。

---

## 7. 視窗行為

- 標題：`Audio USB Studio`
- 預設尺寸 1280×840；最小 960×600
- 記住上次大小與位置 → `%LOCALAPPDATA%\AudioUsbStudio\window.json`
- 關閉視窗 = 結束引擎（Job Object 保證）
- 圖示：第一版沿用預設；自訂 `.ico` 列為後續項

---

## 8. 引擎是否需要改動

**結論：零改動。** 逐項確認：

| 需求 | 現況 |
|---|---|
| 指定任意埠 | `--port` 已支援 |
| 不自動開瀏覽器 | `serve` 模式本來就不開 |
| 知道 web root | `defaultWebRoot()` 已走 `assetRoot()/web/dist` |
| 找 ffmpeg／deep-filter | `AUS_APP_ROOT` = exe 目錄；放在 `engine\` 就正確 |
| 引擎日誌 | 由外殼重導 stdout/stderr，引擎不需知情 |

---

## 9. 建置流程

```
desktop/
  AudioUsbStudio.Shell.csproj
  Program.cs            外殼進入點、單一實例、錯誤處理
  MainForm.cs           視窗、載入畫面、錯誤畫面、WebView2 託管
  EngineHost.cs         挑埠、啟動引擎、Job Object、health 輪詢、日誌重導
  NativeDialog.cs       IFileOpenDialog / FolderBrowserDialog
  Bridge.cs             WebView2 message channel 收送
  NuGet.config          本地來源（由腳本產生）
  nuget-local/          預抓的 nupkg 快取（由腳本產生）
  build-shell.mjs       node：確保 nupkg → dotnet publish
tools/
  build-desktop-release.mjs   組出 dist\AudioUsbStudio-<ver>-win-x64\
```

**為什麼建置腳本是 node**：這台機器的 .NET HTTP 堆疊因 TLS 問題**無法連到 nuget.org**（`NU1301 The SSL connection could not be established`），但 node 的 `fetch` 可以。所以腳本用 node 預抓 `microsoft.web.webview2.<ver>.nupkg` 到 `desktop/nuget-local/`，再讓 NuGet 只用本地來源還原。這在正常機器上同樣可行，且讓建置**可重現、可離線**。

---

## 10. 驗收門檻（全部要實測，不接受推論）

1. `dotnet publish` 成功
2. 產出的 `AudioUsbStudio.exe` PE 子系統 = **2**（GUI，無主控台）
3. 無引數啟動 → 視窗出現、標題正確
4. 視窗內載入 UI：`/api/health` 200，畫面有 topbar 與「編輯器／效果面板／批次 USB」
5. 原生檔案對話框可用 ⚠️（沙箱無 GUI 工作階段，可能無法實測，須明確標註）
6. 關窗後 `Get-Process AudioUsbStudio` 無殘留，且引擎子行程已結束
7. 引擎 CLI 仍可獨立使用：`engine\AudioUsbStudio.Engine.exe doctor` exit 0
8. 既有回歸全綠：`npm run typecheck` exit 0、`npm test` 195/195、web `tsc` + `vite build` exit 0
9. 把整個 dist 資料夾複製到別的位置仍可運作（可攜性）

---

## 11. 已知限制

- 僅 Windows。
- 未簽章 → 首次執行會有 SmartScreen 警告（README 說明步驟）。
- 依賴 WebView2 執行階段（本機已裝 154.0.4258.62；Win10 1803+ 通常隨 Edge 附帶）。缺的話有明確錯誤訊息。
- **沙箱無法驗證「視窗真的出現」與「原生對話框」**（沒有 GUI 工作階段）。我會用 PE 子系統 + `/api/health` + 行程樹來證明可執行性，並在報告中明確標註哪些項目未經實機驗證。

---

## 12. 風險與對策

| 風險 | 影響 | 對策 |
|---|---|---|
| 沙箱 .NET TLS 失敗，無法還原套件 | 建置卡住 | node 預抓 nupkg → 本地 NuGet 來源（**已實測可行**） |
| 無法在沙箱看到視窗 | 驗證不完整 | PE 子系統 + health + 行程樹；明確標註未驗證項 |
| WebView2 帶入 WPF 參考造成 `MSB3277` 警告 | 只有警告 | 只引用 Core + WinForms，排除 Wpf |
| 體積 +70 MB | 觀感 | 已提供實測數字；後續可評估 trimming |

---

## 13. 動工前已完成的前置驗證（實測證據）

**`dotnet build` 可產生 WinForms + WebView2 的 GUI 執行檔——已證實。**

| 項目 | 結果 |
|---|---|
| .NET SDK | 10.0.400（另裝有 10.0.103） |
| `Microsoft.WindowsDesktop.App.Ref` 目標套件 | 存在 → WinForms 可建置 |
| WindowsDesktop 執行階段 | 6.0.36 / 8.0.30 / 10.0.3 / 10.0.11 |
| WebView2 執行階段 | 154.0.4258.62 |
| `dotnet build` 離線探針 | **exit 0，建置成功**（23.02 秒） |
| 產出 | `AUSShellProbe.exe` 158.5 KB + `Microsoft.Web.WebView2.Core.dll` 621.1 KB + `WinForms.dll` 38.6 KB + `Wpf.dll` 80.6 KB ＝ **1.6 MB** |
| **PE 子系統** | **2 = `WINDOWS_GUI`** → 編成 GUI 執行檔、**不會有黑色主控台** |
| 離線 NuGet 來源 | node 預抓 8.45 MB nupkg → 本地來源還原成功 |
| 唯一警告 | `MSB3277`（WPF 帶入 `WindowsBase` 4.0 vs 5.0 衝突）→ 只引用 Core+WinForms 即可避免 |

**尚未驗證**：`WebView2` 控制項在真實 GUI 工作階段的實際渲染（沙箱無桌面工作階段）。
