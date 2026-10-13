# AudioUsbStudio 桌面外殼實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把現有「啟動器 + 瀏覽器分頁」換成真正的 Windows 桌面程式——雙擊 `AudioUsbStudio.exe` 出現原生視窗、內嵌編輯器 UI，且每一條失敗路徑都有看得見的訊息。

**Architecture:** 三層。最上層是 C# WinForms + WebView2 外殼（GUI 子系統、無主控台、單一實例、原生檔案對話框）；既有 Node SEA 引擎以「獨立行程、本機 HTTP + JSON」不變地存活在 `engine\`；`engine\bin\` 放 ffmpeg / ffprobe / deep-filter。外殼**自己挑自由埠**再傳 `--port`，因此不需要解析引擎輸出，引擎零改動。

**Tech Stack:** C# 12 / .NET 10（`net10.0-windows`）、WinForms、Microsoft.Web.WebView2 1.0.3351.48、自製 console 測試 harness；既有 Node 24 + TypeScript（引擎與前端，皆不改）；node 作為建置腳本語言。

**Spec:** `docs/SPEC-DESKTOP.md`

## Global Constraints

- 僅 Windows x64。
- **引擎零改動**：`AudioUsbStudio/src/**` 與 `AudioUsbStudio/test/**` 不得修改。若某任務真的必須動，先停下來取得核可，不要自行判斷。
- 第一版**不做**：ffmpeg 體積最佳化、程式碼簽章、安裝程式、自動更新。
- 發行參數固定為 `-c Release -r win-x64 --self-contained true -p:PublishSingleFile=false`。
- 產出的外殼執行檔 PE 子系統必須是 **2（`WINDOWS_GUI`）**，否則會出現黑色主控台，等於沒解決問題。
- WebView2 user data folder 必須在 `%LOCALAPPDATA%\AudioUsbStudio\WebView2`。**不可**放在程式目錄——綠色版被複製到唯讀位置時會失敗。
- 日誌位置固定：引擎 `%LOCALAPPDATA%\AudioUsbStudio\engine.log`、外殼 `%LOCALAPPDATA%\AudioUsbStudio\shell-error.log`。
- 使用者可見文字一律**繁體中文**（與既有 UI 的 `lang="zh-Hant"` 一致）。
- NuGet 套件版本固定 `Microsoft.Web.WebView2` = `1.0.3351.48`。建置**不得依賴 nuget.org 可達**：由 node 預抓 nupkg 到 `desktop/nuget-local/`，NuGet 只用本地來源。
- 測試不得引入 xUnit 等測試框架（它們的遞迴相依無法離線滿足）；比照專案既有 `test/harness.ts` 的風格，用自製 console harness。
- 邏輯類別一律宣告 `public`，因為測試專案要參考它們。
- 既有回歸必須保持全綠：`npm run typecheck` exit 0、`npm test` 195/195、`web` 的 `npx tsc --noEmit` exit 0 與 `npx vite build` exit 0。

## Review Focus

每一項交付都必須附上**可重跑的指令**。審查者請特別盯這五點：

1. **子系統位元**：`AUSShell.exe` 是不是真的 GUI 子系統（本計畫第 1 個任務就建立檢查腳本，之後每次都要重跑）。
2. **引擎真的沒被動過**：`src/` 與 `test/` 的檔案雜湊在計畫開始與結束時必須相同。
3. **失敗模式覆蓋**：規格 §5 列的七條路徑，每一條都要能在程式碼裡指出對應分支，且畫面上有訊息。審查者請逐條對照，不接受「應該會」。
4. **路徑解析**：引擎放在 `engine\`、工具在 `engine\bin\`、使用者資料在 `%LOCALAPPDATA%`。任何寫死絕對路徑或假設 CWD 的寫法都要挑出來。
5. **未驗證的事要說出來**：沙箱沒有 GUI 工作階段，視窗實際渲染與原生 modal 對話框無法在此驗證。任何聲稱「已驗證 UI 可用」而沒有指令的敘述，一律退回。

## 版本控制

`AudioUsbStudio` **目前不是 git repo**。本計畫的每個任務以「可重跑的驗證指令通過」作為檢查點，而不是 commit。

建議先 `git init` 並把 `release/`、`build/`、`.npm-cache/`、`node_modules/`、`desktop/nuget-local/` 加進 `.gitignore`，這樣每個任務才有可回退的 diff。若你不同意，我會改用在每個任務前複製一份 `_backup-<task>/` 的方式。**這一點在動工前需要你決定。**

---

## File Structure

**新增（外殼）**

| 檔案 | 職責 |
|---|---|
| `AudioUsbStudio/desktop/AudioUsbStudio.Shell.csproj` | 專案定義：WinExe、`net10.0-windows`、WinForms、WebView2、自帶執行階段 |
| `AudioUsbStudio/desktop/Program.cs` | 進入點：STA、全域例外、單一實例、組裝 `MainForm` |
| `AudioUsbStudio/desktop/ShellPaths.cs` | 純路徑解析（引擎位置、日誌、WebView2 user data） |
| `AudioUsbStudio/desktop/PortPicker.cs` | 挑一個可用的 loopback 埠 |
| `AudioUsbStudio/desktop/HealthProbe.cs` | 輪詢 `/api/health` 直到逾時 |
| `AudioUsbStudio/desktop/EngineHost.cs` | 啟動引擎、Job Object、日誌重導、健康等待、關閉 |
| `AudioUsbStudio/desktop/Bridge.cs` | WebView2 message channel 的訊息協定與收送 |
| `AudioUsbStudio/desktop/NativeDialog.cs` | 原生檔案／資料夾對話框 |
| `AudioUsbStudio/desktop/WebView2Runtime.cs` | 偵測 WebView2 執行階段是否可用 |
| `AudioUsbStudio/desktop/Ui/SplashPanel.cs` | 「正在啟動…」畫面 |
| `AudioUsbStudio/desktop/Ui/ErrorPanel.cs` | 錯誤畫面（訊息 + 明細 + 重試） |
| `AudioUsbStudio/desktop/MainForm.cs` | 視窗、狀態機、WebView2 託管、事件接線 |
| `AudioUsbStudio/desktop/nuget-packages.json` | 需要的 NuGet 套件與版本清單 |
| `AudioUsbStudio/desktop/build-shell.mjs` | node：確保 nupkg → `dotnet publish` |
| `AudioUsbStudio/desktop/tests/AudioUsbStudio.Shell.Tests.csproj` | 測試 console 專案 |
| `AudioUsbStudio/desktop/tests/Harness.cs` | 斷言與統計（比照 `test/harness.ts`） |
| `AudioUsbStudio/desktop/tests/*Tests.cs` | 各單元測試 |
| `AudioUsbStudio/desktop/tests/Program.cs` | 跑全部測試並回傳 exit code |

**新增（其他）**

| 檔案 | 職責 |
|---|---|
| `AudioUsbStudio/tools/check-shell-binary.mjs` | 驗證外殼 exe 的 PE 子系統與大小 |
| `AudioUsbStudio/tools/build-desktop-release.mjs` | 組出 `dist\AudioUsbStudio-<ver>-win-x64\` |
| `AudioUsbStudio/web/src/native-bridge.ts` | 前端橋接：偵測、送請求、以 id 對應回應、逾時 |
| `AudioUsbStudio/test/native-bridge.test.ts` | 前端橋接的單元測試 |
| `AudioUsbStudio/desktop/native-bridge.d.ts` | `window.chrome.webview` 的型別宣告 |

**修改**

| 檔案 | 改什麼 |
|---|---|
| `AudioUsbStudio/web/src/api.ts` | `api.pick` 改成三層降級（原生 → `POST /api/pick` → 上傳） |
| `AudioUsbStudio/docs/SPEC.md` | 新增 §11.5 指向桌面版，並在 §10 記錄新的驗收指令 |
| `AudioUsbStudio/release/README.txt` | 由新的發行腳本重新產生（不再由 `tools/build-exe.mjs` 產生） |

**不動**：`AudioUsbStudio/src/**`、`AudioUsbStudio/test/**`、`AudioUsbStudio/tools/build-exe.mjs`、`AudioUsbStudio/tools/launcher.cjs`。

---

## Task 1：外殼專案骨架與可離線建置

**Files**
- Create: `AudioUsbStudio/desktop/nuget-packages.json`
- Create: `AudioUsbStudio/desktop/AudioUsbStudio.Shell.csproj`
- Create: `AudioUsbStudio/desktop/Program.cs`
- Create: `AudioUsbStudio/desktop/build-shell.mjs`
- Create: `AudioUsbStudio/tools/check-shell-binary.mjs`

**Interfaces**
- `desktop/nuget-packages.json`：`{ "packages": [{ "id": "Microsoft.Web.WebView2", "version": "1.0.3351.48" }] }`
- `node desktop/build-shell.mjs [--out <dir>]` → 發行到 `AudioUsbStudio/build/shell`，exit 0
- `node tools/check-shell-binary.mjs <exe路徑>` → 印出子系統與大小，非 2 則 exit 1

- [ ] **Step 1: 建立 `nuget-packages.json`**

  內容如上；這是唯一的套件真相來源，`build-shell.mjs` 據此預抓。

- [ ] **Step 2: 建立 `.csproj`**

  關鍵屬性：`OutputType=WinExe`、`TargetFramework=net10.0-windows`、`UseWindowsForms=true`、`Nullable=enable`、`ImplicitUsings=enable`、`AssemblyName=AudioUsbStudio`、`RootNamespace=AudioUsbStudio.Shell`、`ApplicationHighDpiMode=PerMonitorV2`、`RuntimeIdentifier=win-x64`、`SelfContained=true`、`PublishSingleFile=false`，以及 `<PackageReference Include="Microsoft.Web.WebView2" Version="1.0.3351.48" />`。

- [ ] **Step 3: 建立最小 `Program.cs`**

  只開一個標題 `Audio USB Studio` 的空視窗，證明工具鏈通了。**此時不要**碰引擎。

- [ ] **Step 4: 建立 `build-shell.mjs`**

  步驟：(1) 讀 `nuget-packages.json`；(2) 對每個套件，若 `desktop/nuget-local/<id>.<version>.nupkg` 不存在，用 node `fetch` 從 `https://www.nuget.org/api/v2/package/<id>/<version>` 下載——**這是必要的**，因為這台機器的 .NET HTTP 堆疊會 `NU1301 The SSL connection could not be established`，而 node 的 `fetch` 可以；(3) 產生 `desktop/NuGet.config`，`<clear />` 後只加本地來源 `desktop/nuget-local`；(4) 用 `spawn` 跑 `dotnet publish`，**stdio 用 fd 導到日誌檔再讀回**（這個沙箱禁止 piped stdio，直接 `stdio:'pipe'` 會 EPERM）。

- [ ] **Step 5: 建立 `check-shell-binary.mjs`**

  用 `readFileSync` 讀 exe：`0x3C` 取 PE 標頭位移，`+0x5C` 取 `UInt16` 子系統。印 `SUBSYSTEM=<n>` 與檔案大小；不等於 2 就 `process.exit(1)`。

- [ ] **Step 6: 跑建置並驗證**

  ```powershell
  cd C:\Users\TINGOD\Desktop\CodeHome\AudioUsbStudio
  node desktop/build-shell.mjs
  node tools/check-shell-binary.mjs build\shell\AudioUsbStudio.exe
  ```

  預期：publish exit 0；`SUBSYSTEM=2`。

- [ ] **Step 7: 檢查點**——記下 `build\shell\` 的檔案清單與總大小。

**驗收**：`check-shell-binary.mjs` exit 0 且印出 `SUBSYSTEM=2`。
**注意**：`dotnet publish` 會出現 `MSB3277`（WebView2 的 WPF 組件帶入 `WindowsBase` 4.0 與 5.0 衝突）——這是警告不是錯誤；若想消除，之後在 `<PackageReference>` 上加 `ExcludeAssets` 排除 WPF 資產。

---

## Task 2：`ShellPaths` 與測試 harness

**Files**
- Create: `AudioUsbStudio/desktop/tests/AudioUsbStudio.Shell.Tests.csproj`
- Create: `AudioUsbStudio/desktop/tests/Harness.cs`
- Create: `AudioUsbStudio/desktop/tests/Program.cs`
- Create: `AudioUsbStudio/desktop/tests/ShellPathsTests.cs`
- Create: `AudioUsbStudio/desktop/ShellPaths.cs`

**Interfaces**

```csharp
namespace AudioUsbStudio.Shell;

public static class ShellPaths
{
    // 引擎 exe 相對於外殼所在目錄。
    public static string EngineExePath(string shellDir);
    // 引擎的工具目錄（ffmpeg / ffprobe / deep-filter）。
    public static string EngineBinDir(string shellDir);
    public static string EngineLogPath(string localAppData);
    public static string ShellErrorLogPath(string localAppData);
    public static string UserDataDir(string localAppData);
    // 綠色版：engine\ 與外殼同層時為 true。
    public static bool IsPortableLayout(string shellDir);
}
```

**測試 harness 介面**（比照 `test/harness.ts`）

```csharp
public static class Harness
{
    public static void Test(string name, Action body);
    public static void Assert(bool condition, string message);
    public static void AssertEq<T>(T actual, T expected, string message);
    public static int RunAll();   // 印 ok/FAIL，回傳失敗數
}
```

- [ ] **Step 1: 建立測試專案**

  `OutputType=Exe`、`TargetFramework=net10.0-windows`、`UseWindowsForms=true`、`AssemblyName=AudioUsbStudio.Shell.Tests`，`<ProjectReference Include="..\AudioUsbStudio.Shell.csproj" />`。

- [ ] **Step 2: 寫 `Harness.cs`**

  靜態清單收集 `(name, body)`；`RunAll` 逐一執行、捕捉例外、印 `<ok|FAIL> <name>` 與失敗訊息，最後印 `<passed>/<total> passed` 並回傳失敗數。

- [ ] **Step 3: 寫 `Program.cs`（測試入口）**

  `return Harness.RunAll();`（`Main` 回傳 `int`）。

- [ ] **Step 4: 先寫失敗的測試**

  `ShellPathsTests.cs`：註冊五個測試——
  - `EngineExePath(@"C:\app")` == `C:\app\engine\AudioUsbStudio.Engine.exe`
  - `EngineBinDir(@"C:\app")` == `C:\app\engine\bin`
  - `EngineLogPath(@"C:\lad")` == `C:\lad\AudioUsbStudio\engine.log`
  - `ShellErrorLogPath(@"C:\lad")` == `C:\lad\AudioUsbStudio\shell-error.log`
  - `UserDataDir(@"C:\lad")` == `C:\lad\AudioUsbStudio\WebView2`
  - `IsPortableLayout(@"C:\app")` 在 `C:\app\engine\AudioUsbStudio.Engine.exe` 存在時為 true（測試中用 `Path.GetTempPath()` 造一個假檔，finally 刪掉）

- [ ] **Step 5: 跑測試，確認失敗**

  ```powershell
  dotnet run --project desktop\tests
  ```

  預期：編譯失敗（`ShellPaths` 不存在）。

- [ ] **Step 6: 實作 `ShellPaths`**

  用 `Path.Combine`；`IsPortableLayout` 用 `File.Exists(EngineExePath(shellDir))`。

- [ ] **Step 7: 跑測試，確認通過**

  預期：`6/6 passed`，exit 0。

- [ ] **Step 8: 檢查點**

**驗收**：`dotnet run --project desktop\tests` → `<n>/<n> passed`，exit 0。

---

## Task 3：`PortPicker`

**Files**
- Create: `AudioUsbStudio/desktop/PortPicker.cs`
- Create: `AudioUsbStudio/desktop/tests/PortPickerTests.cs`

**Interfaces**

```csharp
public static class PortPicker
{
    // 綁 loopback:0 取得作業系統指定的自由埠，隨即釋放並回傳。
    public static int PickFreeLoopbackPort();
}
```

- [ ] **Step 1: 先寫失敗的測試**

  兩個測試：
  - 連續呼叫 20 次，每次都在 1–65535 之間
  - 取到的埠可以立刻再被 `TcpListener` 綁上（證明它是自由的）

- [ ] **Step 2: 跑測試確認失敗**——`PortPicker` 不存在，編譯失敗。

- [ ] **Step 3: 實作**

  `var l = new TcpListener(IPAddress.Loopback, 0); l.Start(); var p = ((IPEndPoint)l.LocalEndpoint).Port; l.Stop(); return p;`

- [ ] **Step 4: 跑測試確認通過**——`8/8 passed`。

- [ ] **Step 5: 檢查點**

**驗收**：`dotnet run --project desktop\tests` → 全綠。
**已知**：挑埠與引擎綁定之間有極小的競態窗口；規格 §5 要求外殼重試最多 5 次，這個重試邏輯在 Task 6 實作。

---

## Task 4：`HealthProbe`

**Files**
- Create: `AudioUsbStudio/desktop/HealthProbe.cs`
- Create: `AudioUsbStudio/desktop/tests/HealthProbeTests.cs`

**Interfaces**

```csharp
public static class HealthProbe
{
    // 每 intervalMs 輪詢一次 /api/health，直到成功或逾時。永不丟例外。
    public static Task<bool> WaitAsync(string baseUrl, TimeSpan timeout, TimeSpan interval, CancellationToken ct = default);
}
```

- [ ] **Step 1: 先寫失敗的測試**

  三個測試，全部用真實的 `HttpListener`（不 mock HTTP）：
  - 起一個 `HttpListener` 監聽 `/api/health` 回 200 → `WaitAsync` 回 `true`
  - 逾時 400 ms、沒有任何 listener → 回 `false`，且實際經過時間 < 2 秒（證明它真的會放棄，不是永久卡住）
  - listener 在 200 ms 後才開始回應 → 仍回 `true`（證明是輪詢而非單次探測）

  用 `uniquePort = PortPicker.PickFreeLoopbackPort()` 取得每個測試自己的埠，避免互相干擾。

- [ ] **Step 2: 跑測試確認失敗**

- [ ] **Step 3: 實作**

  `HttpClient` 逾時設 1 秒（短於輪詢間隔時取較小者）；迴圈 `while (sw.Elapsed < timeout && !ct.IsCancellationRequested)`；每次 `try { var r = await client.GetAsync(url, ct); if (r.IsSuccessStatusCode) return true; } catch { }`；`await Task.Delay(interval, ct)`；逾時回 `false`。整個方法包在 try/catch，永不丟。

- [ ] **Step 4: 跑測試確認通過**——`13/13 passed`。

- [ ] **Step 5: 檢查點**

**驗收**：三個測試全過，其中「逾時會放棄」的測試有時間斷言。

---

## Task 5：`EngineHost` 的啟動契約

把「該用什麼參數、什麼行程設定啟動引擎」變成可測的純資料，先不真的啟動。

**Files**
- Create: `AudioUsbStudio/desktop/EngineHost.cs`（先只放契約部分）
- Create: `AudioUsbStudio/desktop/tests/EngineHostContractTests.cs`

**Interfaces**

```csharp
public static class EngineHostContract
{
    // 回傳 ["serve", "--port", "<port>"]
    public static string[] BuildEngineArgs(int port);
    // CreateNoWindow、不用 UseShellExecute、stdout/stderr 導向 logPath
    public static ProcessStartInfo BuildStartInfo(string engineExe, string logPath, int port);
}
```

- [ ] **Step 1: 先寫失敗的測試**

  - `BuildEngineArgs(5000)` 序列等於 `["serve","--port","5000"]`
  - `BuildStartInfo(...).CreateNoWindow` 為 `true`
  - `BuildStartInfo(...).UseShellExecute` 為 `false`
  - `BuildStartInfo(...).WorkingDirectory` 是引擎 exe 的目錄（**不是** CWD，因為引擎用 `process.execPath` 找工具，但仍不該依賴 CWD）
  - 埠若不在 `1..65535` 則丟 `ArgumentOutOfRangeException`

- [ ] **Step 2: 跑測試確認失敗**

- [ ] **Step 3: 實作契約**

  日誌重導用 `RedirectStandardOutput = false` + 在啟動後把 `Process.StandardOutput` 接到檔案串流是行不通的；正確做法是 `StartInfo` 不重導，改由 **Task 6** 在 `Process` 啟動後另開一個讀取執行緒把輸出寫進檔案。因此 `BuildStartInfo` 這裡只設 `RedirectStandardOutput = true` 與 `RedirectStandardError = true`，實際搬運在 Task 6；測試則斷言 `RedirectStandardOutput`/`RedirectStandardError` 為 `true`。

- [ ] **Step 4: 跑測試確認通過**——`18/18 passed`。

- [ ] **Step 5: 檢查點**

**驗收**：argv 契約與行程設定都有斷言。

---

## Task 6：`EngineHost` 啟動、Job Object、日誌、重試

**Files**
- Modify: `AudioUsbStudio/desktop/EngineHost.cs`（加上 `EngineHost` 類別）
- Create: `AudioUsbStudio/desktop/JobObject.cs`
- Create: `AudioUsbStudio/desktop/tests/EngineHostTests.cs`

**Interfaces**

```csharp
public sealed class EngineHost : IDisposable
{
    public EngineHost(string engineExe, string logPath, TimeSpan? healthTimeout = null);
    public int Port { get; }
    public event Action<int>? EngineExited;   // exit code
    // 挑埠（最多 5 次）→ 啟動 → 等 health → true=就緒；false=失敗，Details 有原因
    public Task<bool> StartAsync(CancellationToken ct = default);
    public string Details { get; }            // 失敗時的原因（含日誌尾巴）
    public void Dispose();                    // 終止引擎
}

public sealed class JobObject : IDisposable
{
    public JobObject();                        // KILL_ON_JOB_CLOSE
    public bool Assign(Process process);
    public void Dispose();
}
```

- [ ] **Step 1: 先寫失敗的測試**

  用**真正的引擎 exe**（`release\AudioUsbStudio.exe`）當受測對象——這是最有價值的測試，因為它驗證了真實的啟動契約：
  - 起一個 stub `HttpListener` 佔住一個埠，然後把引擎指定到一個已知自由的埠 → `StartAsync` 回 `true`，`Details` 為空
  - 引擎路徑指向不存在的檔案 → `StartAsync` 回 `false`，`Details` 含「找不到」且含該路徑
  - `Dispose()` 之後引擎行程必須結束：記下 `Process.GetProcessesByName` 的數量，Dispose 後輪詢 2 秒確認歸零
  - `JobObject.Assign` 對已啟動的行程回 `true`

  測試若找不到 `release\AudioUsbStudio.exe` 就 `return`（並在輸出標明 skipped），避免在還沒打包的環境失敗。

- [ ] **Step 2: 跑測試確認失敗**

- [ ] **Step 3: 實作 `JobObject`**

  P/Invoke `CreateJobObject`、`SetInformationJobObject`（`JOBOBJECT_EXTENDED_LIMIT_INFORMATION`、`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`）、`AssignProcessToJobObject`、`CloseHandle`。

- [ ] **Step 4: 實作 `EngineHost.StartAsync`**

  流程：最多 5 次 { `PortPicker.PickFreeLoopbackPort()` → `Process.Start(BuildStartInfo(...))` → `JobObject.Assign` → 啟動兩個讀取執行緒把 stdout/stderr 逐行 append 到 `logPath` → `HealthProbe.WaitAsync("http://127.0.0.1:<port>", timeout, 100ms)` }；期間若 `process.HasExited` 提早為真，讀 `logPath` 尾巴放進 `Details` 並立即失敗。

- [ ] **Step 5: 跑測試確認通過**

- [ ] **Step 6: 檢查點**

**驗收**：三個測試全過，且「Dispose 後行程歸零」的斷言真的跑過（不是 skipped）。

---

## Task 7：`Bridge` 訊息協定

**Files**
- Create: `AudioUsbStudio/desktop/Bridge.cs`
- Create: `AudioUsbStudio/desktop/tests/BridgeTests.cs`

**Interfaces**

```csharp
public sealed record PickRequest(string Id, string Mode, string? Title, bool Multiple);

public static class BridgeProtocol
{
    // 解析頁面送來的 JSON；無法解析或欄位不合法回 null。
    public static PickRequest? Parse(string json);
    public static string SuccessJson(string id, IReadOnlyList<string> paths);
    public static string CancelledJson(string id);
    public static string ErrorJson(string id, string message);
}
```

- [ ] **Step 1: 先寫失敗的測試**

  - 合法 `{"id":"1","type":"pick","mode":"files"}` → `PickRequest("1","files",null,false)`
  - `mode` 是 `folder` → `Multiple` 被強制為 `false`
  - 缺 `id`、缺 `mode`、`mode` 是別的值、不是 JSON、是 `null` → 全部回 `null`
  - `type` 不是 `pick` → 回 `null`（未來擴充時不會誤吞）
  - `SuccessJson("1", ["C:\\a.mp3"])` 是可被 `JsonDocument` 解析的物件，且 `paths` 長度為 1
  - `CancelledJson("1")` 含 `"cancelled":true`
  - 使用者取消與錯誤必須是**不同**的訊息（前者 UI 要靜默）

- [ ] **Step 2: 跑測試確認失敗**

- [ ] **Step 3: 實作**

  用 `System.Text.Json`。`Parse` 全程 try/catch，任何例外回 `null`。

- [ ] **Step 4: 跑測試確認通過**——`26/26 passed`。

- [ ] **Step 5: 檢查點**

**驗收**：協定的每一種輸入都有斷言，包含所有不合法的情況。

---

## Task 8：`NativeDialog`

**Files**
- Create: `AudioUsbStudio/desktop/NativeDialog.cs`
- Create: `AudioUsbStudio/desktop/tests/NativeDialogTests.cs`

**Interfaces**

```csharp
public static class NativeDialog
{
    // 純函式：組出給 OpenFileDialog 的 Filter 字串。
    public static string BuildAudioFilter();
    // 純函式：過濾掉非音訊、去重、保留順序。
    public static string[] KeepAudioFiles(IEnumerable<string> paths);
    // 有 UI：回 null = 無法顯示對話框（非 Windows／被封鎖）；回空陣列 = 使用者取消。
    public static string[]? PickFiles(nint owner, string title, bool multiple);
    public static string[]? PickFolder(nint owner, string title);
}
```

- [ ] **Step 1: 先寫失敗的測試**（只測純函式，modal 對話框無法在無 GUI 工作階段驗證）

  - `BuildAudioFilter()` 同時含 `*.mp3`、`*.wav`、`*.flac`、`*.m4a`、`*.ogg`
  - `KeepAudioFiles(["a.mp3","b.txt","c.flac","A.MP3"])` → 保留 `a.mp3`、`c.flac`、`A.MP3`（大小寫不敏感）且順序不變
  - `KeepAudioFiles` 對同一個檔案路徑去重
  - 空輸入回空陣列

- [ ] **Step 2: 跑測試確認失敗**

- [ ] **Step 3: 實作**

  `BuildAudioFilter` 與 `KeepAudioFiles` 是純函式（副檔名清單與規格 §4 一致）。`PickFiles`／`PickFolder` 用 `OpenFileDialog`／`FolderBrowserDialog`，`ShowDialog(owner)` 回 `DialogResult.Cancel` 時回**空陣列**；整個方法包 try/catch，例外時回 `null`（讓前端降級到 HTTP，再降級到上傳）。

- [ ] **Step 4: 跑測試確認通過**——`30/30 passed`。

- [ ] **Step 5: 檢查點**

**驗收**：純函式有斷言；`PickFiles`/`PickFolder` 至少能手動在實機驗證（列為 Task 14 的未驗證項）。

---

## Task 9：`SplashPanel` 與 `ErrorPanel`

**Files**
- Create: `AudioUsbStudio/desktop/Ui/SplashPanel.cs`
- Create: `AudioUsbStudio/desktop/Ui/ErrorPanel.cs`
- Create: `AudioUsbStudio/desktop/tests/UiPanelTests.cs`

**Interfaces**

```csharp
public sealed class SplashPanel : UserControl
{
    public void SetStatus(string text);       // 例：「正在啟動引擎…」
}

public sealed class ErrorPanel : UserControl
{
    public void SetError(string message, string? details, bool canRetry);
    public event Action? RetryRequested;
    public string Message { get; }
    public string Details { get; }
}
```

- [ ] **Step 1: 先寫失敗的測試**

  在 STA 執行緒上建構（`[STAThread]` 已在 harness 的 `Main`），不斷言繪製，只斷言狀態：
  - `SplashPanel.SetStatus("x")` 之後，找到內部 `Label` 的文字是 `"x"`
  - `ErrorPanel.SetError("msg", null, true)` 之後 `Message == "msg"` 且重試鈕可見
  - `ErrorPanel.SetError("msg", "detail", false)` 之後重試鈕**不可見**
  - `ErrorPanel` 的明細區塊在 `details` 為 `null` 時不可見
  - 觸發重試鈕的 `Click` 會讓 `RetryRequested` 被叫到一次

  用 `Controls.Find` 或給內部控制項具名（`Name = "StatusLabel"` 等）以便斷言。

- [ ] **Step 2: 跑測試確認失敗**

- [ ] **Step 3: 實作兩個 panel**

  純程式碼建構（不用 designer）：`Dock`、`Font`、`AutoSize`、`Padding`；錯誤畫面要有可捲動的明細 `TextBox`（`ReadOnly`、`Multiline`、`ScrollBars.Vertical`），讓使用者能把日誌複製出來。

- [ ] **Step 4: 跑測試確認通過**——`35/35 passed`。

- [ ] **Step 5: 檢查點**

**驗收**：五個斷言全過。

---

## Task 10：`MainForm` 狀態機組裝

**Files**
- Create: `AudioUsbStudio/desktop/WebView2Runtime.cs`
- Create: `AudioUsbStudio/desktop/MainForm.cs`
- Modify: `AudioUsbStudio/desktop/Program.cs`（改成啟動 `MainForm`、單一實例、全域例外）
- Create: `AudioUsbStudio/desktop/tests/MainFormStateTests.cs`

**Interfaces**

```csharp
public enum ShellState { Starting, Ready, Failed }

public sealed class MainForm : Form
{
    public ShellState State { get; }
    public void ShowSplash(string status);
    public void ShowError(string message, string? details, bool canRetry = true);
    public Task<bool> StartEngineAsync(CancellationToken ct = default);
}
```

- [ ] **Step 1: 先寫失敗的測試**

  - 新建 `MainForm` 的 `State` 是 `Starting`
  - `ShowSplash("x")` 之後 `State` 仍是 `Starting`
  - `ShowError("m", null)` 之後 `State` 是 `Failed`
  - `Text` 是 `Audio USB Studio`；`MinimumSize` 是 `960×600`；`Width/Height` 預設 `1280×840`
  - `AudioUsbStudio.exe` 不存在時 `StartEngineAsync` 回 `false` 且 `State` 變 `Failed`（用一個指向不存在路徑的 `MainForm` 建構子多載注入 `engineExe`，讓測試不必依賴真實佈局）

- [ ] **Step 2: 跑測試確認失敗**

- [ ] **Step 3: 實作 `WebView2Runtime`**

  `CoreWebView2Environment.GetAvailableBrowserVersionString()` 包 try/catch；回 `null` 代表執行階段不可用。

- [ ] **Step 4: 實作 `MainForm`**

  - 建構子：設標題、尺寸、`MinimumSize`；把 `SplashPanel` 塞滿；`State = Starting`
  - 建構子多載：`MainForm(string? engineExeOverride = null, string? localAppDataOverride = null)` 供測試注入
  - `StartEngineAsync`：檢查引擎 exe 存在 → 檢查 WebView2 執行階段 → `EngineHost.StartAsync` → 成功則 `await EnsureWebViewAsync()` 後導覽 `http://127.0.0.1:<port>/`，`State = Ready`；任何失敗 → `ShowError`，`State = Failed`
  - `EnsureWebViewAsync`：`CoreWebView2Environment.CreateAsync(null, ShellPaths.UserDataDir(lad))`；建立 `WebView2` 控制項並 `Dock = Fill`；交換掉 `SplashPanel`
  - 接線：`WebView2.CoreWebView2.WebMessageReceived += Bridge.OnMessage`；`ProcessFailed` → `ShowError("引擎已停止", ...)`；`NavigationCompleted` 失敗 → `ShowError` 帶 URL
  - `FormClosing` → `EngineHost.Dispose()`
  - 全域：`Application.ThreadException` 與 `AppDomain.CurrentDomain.UnhandledException` → 寫 `ShellErrorLogPath` + MessageBox（規格 §5 最後一條）

- [ ] **Step 5: 實作 `Program.cs`**

  `[STAThread]`、`ApplicationConfiguration.Initialize()`、`Mutex("Local\\AudioUsbStudio.SingleInstance")` 單一實例（已有實例則嘗試把既有視窗帶到前景後 `return`）、`Application.Run(new MainForm())`。

- [ ] **Step 6: 跑測試確認通過**——`40/40 passed`。

- [ ] **Step 7: 跑完整建置與子系統檢查**

  ```powershell
  node desktop/build-shell.mjs
  node tools/check-shell-binary.mjs build\shell\AudioUsbStudio.exe
  ```

  預期 `SUBSYSTEM=2`。

- [ ] **Step 8: 檢查點**

**驗收**：`dotnet run --project desktop\tests` 全綠；`SUBSYSTEM=2`。
**未驗證（明確列出）**：視窗實際渲染、WebView2 真的顯示頁面——沙箱無 GUI 工作階段；這兩項留給 Task 14 誠實標註。

---

## Task 11：前端橋接 `native-bridge.ts`

**Files**
- Create: `AudioUsbStudio/web/src/native-bridge.ts`
- Create: `AudioUsbStudio/desktop/native-bridge.d.ts`
- Create: `AudioUsbStudio/test/native-bridge.test.ts`

**Interfaces**

```ts
export type NativeTransport = {
  post(message: unknown): void;
  subscribe(handler: (data: unknown) => void): () => void;
};

export type PickMode = 'files' | 'folder';

export function detectNativeTransport(scope?: unknown): NativeTransport | null;
export function bridgePick(
  transport: NativeTransport,
  mode: PickMode,
  opts?: { title?: string; multiple?: boolean; timeoutMs?: number },
): Promise<string[] | null>;   // null = 取消；丟錯 = 橋接失敗
```

**關鍵設計**：`bridgePick` 只依賴注入的 `transport`，所以能在 node 裡用假 transport 完整測試，不需要瀏覽器。

- [ ] **Step 1: 先寫失敗的測試**

  `test/native-bridge.test.ts`（放在既有的自動探索目錄，`test/run.ts` 會自動收）：
  - `detectNativeTransport({})` → `null`
  - `detectNativeTransport({ chrome: { webview: { postMessage(){}, addEventListener(){} } } })` → 非 null
  - 假 transport 在收到 `post` 後立刻回 `{id, ok:true, paths:["C:\\a.mp3"]}` → `bridgePick` 回該陣列
  - 回 `{id, cancelled:true}` → 回 `null`
  - 回 `{id, ok:false, error:"x"}` → 丟出含 `"x"` 的錯誤
  - **完全不回**（timeoutMs = 50）→ 丟出含 `timeout` 的錯誤
  - 兩次並行呼叫要各自拿到自己的回應（id 對應正確，不會互搶）

- [ ] **Step 2: 跑測試確認失敗**

  ```powershell
  node test/run.ts
  ```

- [ ] **Step 3: 實作 `native-bridge.ts`**

  `detectNativeTransport` 檢查 `scope.chrome?.webview?.postMessage` 與 `addEventListener` 都是函式。`bridgePick` 生成 `id = "pick-" + counter++`，把 `resolve`/`reject` 放進 `Map<string, …>`，`post({id, type:'pick', mode, title, multiple})`，設 `setTimeout` 逾時；收到回應時檢查 `cancelled` / `ok` / `error` 三態。

- [ ] **Step 4: 建立 `native-bridge.d.ts`**

  宣告 `interface Window { chrome?: { webview?: { postMessage(m: unknown): void; addEventListener(t: string, h: (e: { data: unknown }) => void): void } } }`。放在 `desktop/` 下會被 C# 專案 glob 到嗎？——不會（`*.csproj` 預設只收 `.cs`），但為了整潔，改放 `AudioUsbStudio/web/src/native-bridge.d.ts`。

- [ ] **Step 5: 跑測試確認通過**

  ```powershell
  node test/run.ts
  ```

  預期 `202/202 passed`（195 既有 + 7 新增）。

- [ ] **Step 6: 檢查點**

**驗收**：`node test/run.ts` 全綠且總數增加 7。

---

## Task 12：`api.pick` 三層降級

**Files**
- Modify: `AudioUsbStudio/web/src/api.ts`
- Create: `AudioUsbStudio/test/api-pick.test.ts`

**Interfaces**

```ts
// api.pick 維持既有簽章，但內部改成：
// 1) 有原生橋接 → bridgePick（null = 取消，直接回傳取消）
// 2) 否則 → POST /api/pick；501 視為「無原生對話框可用」
// 3) 兩者都不可用 → 丟出 NO_NATIVE_DIALOG 讓 UI 走上傳
export const NO_NATIVE_DIALOG = 'no-native-dialog';
```

- [ ] **Step 1: 先寫失敗的測試**

  用可注入的 `fetch` 與 `transport`：
  - 有橋接且成功 → 不會呼叫 `fetch`
  - 無橋接、`POST /api/pick` 回 200 → 回傳路徑
  - 無橋接、回 501 → 丟出的錯誤能被既有的 `isNoNativeDialog()` 認出
  - 橋接丟錯、`POST /api/pick` 回 200 → 仍回傳路徑（**降級要真的發生**）

- [ ] **Step 2: 跑測試確認失敗**

- [ ] **Step 3: 實作**

  把 `api.pick` 改成先問 `detectNativeTransport()`。注意保留既有回傳形狀，避免動到 `App.tsx` 的呼叫端。

- [ ] **Step 4: 跑測試確認通過**——`206/206 passed`。

- [ ] **Step 5: 前端建置與型別檢查**

  ```powershell
  cd web
  npx tsc --noEmit
  npx vite build
  ```

  預期兩者 exit 0。

- [ ] **Step 6: 檢查點**

**驗收**：`node test/run.ts` 與 web 的 `tsc`／`vite build` 全綠。

---

## Task 13：發行佈局 `build-desktop-release.mjs`

**Files**
- Create: `AudioUsbStudio/tools/build-desktop-release.mjs`
- Modify: `AudioUsbStudio/release/README.txt`（改由新腳本產生）

**Interfaces**

```
node tools/build-desktop-release.mjs [--skip-engine] [--out <dir>]
```
產出 `AudioUsbStudio/dist/AudioUsbStudio-0.2.0-win-x64/`。

- [ ] **Step 1: 寫腳本**

  步驟：
  1. `node tools/build-exe.mjs`（除非 `--skip-engine`）→ `release\`
  2. `node desktop/build-shell.mjs` → `build\shell\`
  3. 清空並建立輸出目錄
  4. 把 `build\shell\*` 複製到輸出根目錄
  5. 把 `release\AudioUsbStudio.exe` **改名**複製為 `engine\AudioUsbStudio.Engine.exe`（改名安全：launcher 用 `process.execPath` 的目錄，不看自己的檔名）
  6. 把 `release\bin\*` 複製到 `engine\bin\`
  7. 產生 `README.txt`（雙擊說明、SmartScreen 警告步驟、無視窗時看 `%LOCALAPPDATA%\AudioUsbStudio\` 的日誌、引擎 CLI 用法）
  8. 印出檔案清單與總大小

- [ ] **Step 2: 寫驗證腳本或斷言**

  在腳本最後自我檢查：`engine\AudioUsbStudio.Engine.exe`、`engine\bin\ffmpeg.exe`、`engine\bin\ffprobe.exe`、`engine\bin\deep-filter.exe`、根目錄的 `AudioUsbStudio.exe` 全部存在，缺任一就 `process.exit(1)`。

- [ ] **Step 3: 執行並檢查**

  ```powershell
  node tools/build-desktop-release.mjs
  node tools/check-shell-binary.mjs dist\AudioUsbStudio-0.2.0-win-x64\AudioUsbStudio.exe
  ```

  預期：exit 0；`SUBSYSTEM=2`；總大小約 611 MB。

- [ ] **Step 4: 檢查點**

**驗收**：輸出目錄檔案齊全、子系統為 2、大小與規格 §6 的預估相符（±20 MB）。

---

## Task 14：端到端驗收與文件

**Files**
- Modify: `AudioUsbStudio/docs/SPEC.md`
- Modify: `AudioUsbStudio/docs/SPEC-DESKTOP.md`（把「待核可」改成「已實作」並補上實測結果）

- [ ] **Step 1: 引擎未被改動的證明**

  ```powershell
  Get-ChildItem src,test -Recurse -File | Get-FileHash -Algorithm SHA256 | Measure-Object
  ```

  與計畫開始時記下的雜湊清單比對，必須完全相同。

- [ ] **Step 2: 既有回歸**

  ```powershell
  cd C:\Users\TINGOD\Desktop\CodeHome\AudioUsbStudio
  npm run typecheck
  npm test
  cd web; npx tsc --noEmit; npx vite build
  ```

  預期：`typecheck` exit 0、`npm test` 206/206、web 兩項 exit 0。

- [ ] **Step 3: 外殼測試**

  ```powershell
  dotnet run --project desktop\tests
  ```

  預期：全綠，exit 0。

- [ ] **Step 4: 發行與子系統**

  ```powershell
  node tools/build-desktop-release.mjs
  node tools/check-shell-binary.mjs dist\AudioUsbStudio-0.2.0-win-x64\AudioUsbStudio.exe
  ```

- [ ] **Step 5: 引擎 CLI 仍可獨立運作**

  ```powershell
  & "dist\AudioUsbStudio-0.2.0-win-x64\engine\AudioUsbStudio.Engine.exe" doctor
  ```

  預期 exit 0，且 `AI denoise: available` 指向 `engine\bin\deep-filter.exe`。

- [ ] **Step 6: 可攜性**

  把整個 dist 目錄複製到 `%TEMP%\<新名>\`，再跑一次 Step 5 的 `doctor`，確認仍指向**新位置**的 `engine\bin`。

- [ ] **Step 7: 更新文件**

  - `docs/SPEC.md`：新增 §11.5「桌面版」指向 `SPEC-DESKTOP.md`；§10.1 記錄外殼的驗收指令。
  - `docs/SPEC-DESKTOP.md`：狀態改為「已實作」；§13 換成實際的驗收結果；把**無法驗證**的項目（視窗渲染、原生對話框）集中列成一個明確的「未驗證」清單。

- [ ] **Step 8: 清理**

  刪除 `desktop/nuget-local/`（可重新下載）、`build/`、測試殘留的 `%TEMP%\aus-shell-*`。

- [ ] **Step 9: 最終檢查點**

**驗收**：Steps 1–6 全部有實際輸出；Step 7 的文件把未驗證項說清楚。

---

## 執行方式

本計畫有 14 個任務，其中 Task 2–10 共享同一組 C# 介面（`ShellPaths` → `PortPicker` → `HealthProbe` → `EngineHost` → `MainForm`），有明確的先後依賴；Task 11–12 在前端，Task 13–14 是整合。任務數中等，單一任務出錯的代價不高（都可重跑），但介面耦合使並行容易互相踩到。

**建議：Native（我自己依序實作，最後跑一次完整的端到端驗收 + 一個獨立審查者複查）。** 原因是 C# 那側的十個任務共用同一組型別，拆給多個代理會產生介面漂移；而驗收的關鍵（子系統位元、引擎雜湊不變、可攜性）本來就需要在最後一次做完。
