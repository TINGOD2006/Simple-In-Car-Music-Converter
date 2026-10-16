using AudioUsbStudio.Shell.Ui;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace AudioUsbStudio.Shell;

/// <summary>Where the shell is in its life cycle. Nothing renders the editor before <see cref="Ready"/>.</summary>
public enum ShellState
{
    Starting,
    Ready,
    Failed,
}

/// <summary>
/// The window. It owns three things and nothing else: getting the engine running, rendering the
/// editor once it is, and making sure that when either fails the user is told why.
///
/// The engine is a separate process reached over loopback HTTP. That boundary is deliberate: the
/// engine, its 195 tests and its command line are all unchanged by this shell, and an engine crash
/// takes down a panel rather than the window.
/// </summary>
public sealed class MainForm : Form
{
    private readonly string _engineExe;
    private readonly string _localAppData;
    private readonly string _shellDir;
    private readonly string? _dataDirOverride;
    private readonly SplashPanel _splash = new() { Dock = DockStyle.Fill };
    private readonly ErrorPanel _error = new() { Dock = DockStyle.Fill, Visible = false };

    private EngineHost? _engine;
    private WebView2? _webView;
    private string? _dataDir;
    private IReadOnlyList<string> _dataRefusals = Array.Empty<string>();

    public MainForm(
        string? engineExeOverride = null,
        string? localAppDataOverride = null,
        string? dataDirOverride = null)
    {
        Text = "Audio USB Studio";
        MinimumSize = new Size(960, 600);
        Width = 1280;
        Height = 840;
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Color.FromArgb(24, 26, 32);
        ForeColor = Color.Gainsboro;

        _localAppData = localAppDataOverride
            ?? Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        _dataDirOverride = dataDirOverride;

        // The published layout keeps the engine in a subfolder beside the shell executable. In the
        // test host that folder does not exist, which is why every test injects an override.
        _engineExe = engineExeOverride ?? ShellPaths.EngineExePath(AppContext.BaseDirectory);

        // The engine lives in <shellDir>\engine\, so an injected engine path implies its shell
        // directory; without an override the shell is simply wherever this process runs from.
        _shellDir = engineExeOverride is null
            ? AppContext.BaseDirectory
            : Path.GetDirectoryName(Path.GetDirectoryName(Path.GetFullPath(_engineExe)) ?? string.Empty)
              ?? AppContext.BaseDirectory;

        _error.RetryRequested += OnRetryRequested;

        // Added back-to-front: the last control added sits at the back of the z-order, so the
        // splash ends up hidden behind the error panel rather than the other way round.
        Controls.Add(_error);
        Controls.Add(_splash);
    }

    /// <summary>The current state. Starts at <see cref="ShellState.Starting"/>.</summary>
    public ShellState State { get; private set; } = ShellState.Starting;

    /// <summary>Replaces the splash line. Deliberately does not change <see cref="State"/>.</summary>
    public void ShowSplash(string status)
    {
        if (InvokeRequired)
        {
            BeginInvoke(() => ShowSplash(status));
            return;
        }

        _splash.SetStatus(status);
        _splash.Visible = true;
    }

    /// <summary>
    /// Shows a failure. <paramref name="canRetry"/> is false for failures retrying cannot fix — a
    /// missing engine binary, a missing WebView2 runtime — so the user is not offered a button that
    /// would only make them wait for the same outcome.
    /// </summary>
    public void ShowError(string message, string? details, bool canRetry = true)
    {
        State = ShellState.Failed;

        if (InvokeRequired)
        {
            BeginInvoke(() => ShowError(message, details, canRetry));
            return;
        }

        _error.SetError(message, details, canRetry);
        _splash.Visible = false;
        _error.Visible = true;
        _error.BringToFront();
    }

    /// <summary>
    /// Brings the engine up and renders the editor. Never throws: every failure path ends in
    /// <see cref="ShowError"/> and a <c>false</c> return, because an exception escaping here is
    /// exactly the unhandled-exception death this shell exists to stop.
    /// </summary>
    public async Task<bool> StartEngineAsync(CancellationToken ct = default)
    {
        try
        {
            if (!File.Exists(_engineExe))
            {
                ShowError(
                    "找不到引擎程式。 (The engine executable is missing.)",
                    $"expected at: {_engineExe}\n\n"
                    + "This build is incomplete. Re-extract the whole folder; the engine lives in "
                    + "the engine\\ subfolder next to AudioUsbStudio.exe.",
                    canRetry: false);
                return false;
            }

            var runtime = WebView2Runtime.GetAvailableBrowserVersionString();
            if (runtime is null)
            {
                ShowError(
                    "找不到 WebView2 執行階段。 (The WebView2 runtime is not installed.)",
                    "The editor is a web page, so it needs the Microsoft Edge WebView2 Runtime.\n"
                    + "Install it from: https://developer.microsoft.com/microsoft-edge/webview2/",
                    canRetry: false);
                return false;
            }

            var dataDir = ResolveDataDir();
            if (dataDir is null)
            {
                ShowError(
                    "無法建立可寫入的資料夾。 (No writable folder could be created.)",
                    "Every location below was refused:" + Environment.NewLine + Environment.NewLine
                    + string.Join(Environment.NewLine, _dataRefusals),
                    canRetry: true);
                return false;
            }

            ShowSplash("正在啟動引擎…");

            _engine?.Dispose();
            _engine = new EngineHost(_engineExe, ShellPaths.EngineLogPath(dataDir));
            _engine.EngineExited += OnEngineExited;

            ShowSplash($"正在啟動引擎… (WebView2 {runtime})");

            if (!await _engine.StartAsync(ct).ConfigureAwait(true))
            {
                ShowError("引擎啟動失敗。 (The engine did not start.)", _engine.Details, canRetry: true);
                return false;
            }

            ShowSplash("正在連上介面…");
            if (!await EnsureWebViewAsync(_engine.Port, dataDir).ConfigureAwait(true)) return false;

            State = ShellState.Ready;
            return true;
        }
        catch (Exception ex)
        {
            ShowError("介面啟動時發生未預期的錯誤。 (The shell failed unexpectedly.)", ex.ToString(), canRetry: true);
            return false;
        }
    }

    /// <summary>
    /// The directory this app keeps its per-user state in, decided once and remembered.
    ///
    /// This is not defensive padding. On the machine this first shipped to, Windows refused to
    /// create directories under %LOCALAPPDATA% — once for the engine's unpack folder under
    /// %LOCALAPPDATA%\Temp, and again for %LOCALAPPDATA%\AudioUsbStudio\WebView2 — while the folder
    /// beside the executable was created without complaint. So the location is probed with a real
    /// write, and null means every candidate was refused, with the reasons kept for the message.
    /// </summary>
    private string? ResolveDataDir()
    {
        if (_dataDirOverride is not null) return _dataDirOverride;
        if (_dataDir is not null) return _dataDir;

        _dataDir = ShellPaths.TryResolveDataDir(
            ShellPaths.DataDirCandidates(_shellDir, _localAppData),
            out var refusals);
        _dataRefusals = refusals;
        return _dataDir;
    }

    /// <summary>Creates the WebView2 on first use and navigates it at the engine.</summary>
    /// <returns>True when the editor is on its way to being rendered.</returns>
    private async Task<bool> EnsureWebViewAsync(int port, string dataDir)
    {
        var url = $"http://127.0.0.1:{port}/";

        if (_webView is not null)
        {
            _webView.CoreWebView2?.Navigate(url);
            return true;
        }

        // The WebView2 profile is a directory this app must own. When that is refused, say which
        // folder and why rather than letting a raw stack trace be the message the user has to read.
        var userData = ShellPaths.UserDataDir(dataDir);
        CoreWebView2Environment environment;
        try
        {
            Directory.CreateDirectory(userData);
            environment = await CoreWebView2Environment.CreateAsync(null, userData).ConfigureAwait(true);
        }
        catch (Exception ex)
        {
            ShowError(
                "無法建立 WebView2 的資料夾。 (Could not create the WebView2 data folder.)",
                userData + Environment.NewLine + Environment.NewLine
                + ex.GetType().Name + ": " + ex.Message,
                canRetry: true);
            return false;
        }

        var view = new WebView2 { Dock = DockStyle.Fill };
        Controls.Add(view);
        view.BringToFront();

        await view.EnsureCoreWebView2Async(environment).ConfigureAwait(true);

        view.CoreWebView2.WebMessageReceived += OnWebMessage;
        view.CoreWebView2.ProcessFailed += OnProcessFailed;
        view.NavigationCompleted += OnNavigationCompleted;

        _webView = view;
        _splash.Visible = false;
        view.CoreWebView2.Navigate(url);
        return true;
    }

    private void OnRetryRequested()
    {
        _ = StartEngineAsync();
    }

    /// <summary>The page asked for a native file or folder dialog.</summary>
    private void OnWebMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        string json;
        try
        {
            json = e.WebMessageAsJson;
        }
        catch
        {
            return;
        }

        var request = BridgeProtocol.Parse(json);
        if (request is null)
        {
            // Not one of ours. Future message types must not be swallowed by a handler that
            // assumed it was a pick request.
            return;
        }

        // THE DIALOG MUST NOT OPEN FROM INSIDE THIS HANDLER.
        //
        // A modal dialog shown here is created while the WebView2 is still dispatching this very
        // message, so it comes up behind an active child window and without the foreground.
        // Windows then spends the user's first click on the dialog simply activating it, which is
        // the reported "I have to choose the folder twice". Posting the work to the message queue
        // lets this handler return first, so the dialog is the only thing waiting for input.
        BeginInvoke(new Action(() => ShowPickDialog(request)));
    }

    /// <summary>
    /// Shows the native dialog away from the WebView2 message handler, then answers the page.
    /// </summary>
    private void ShowPickDialog(PickRequest request)
    {
        // Bring the shell to the foreground first. A dialog owned by a background window is
        // precisely the inactive dialog that eats its first click.
        try
        {
            if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
            Activate();
        }
        catch
        {
            // Not fatal: the dialog still opens, it may just need one click to take focus.
        }

        string[]? paths;
        if (request.Mode == "folder")
        {
            paths = NativeDialog.PickFolder(Handle, request.Title ?? "選擇資料夾");
        }
        else
        {
            paths = NativeDialog.PickFiles(Handle, request.Title ?? "選擇音訊檔案", request.Multiple);
        }

        if (paths is null)
        {
            // The dialog could not be shown at all; the page falls back to the upload path.
            PostToPage(BridgeProtocol.ErrorJson(request.Id, "no native file dialog is available here"));
            return;
        }

        if (paths.Length == 0)
        {
            // Cancelled is a normal outcome and must not look like an error.
            PostToPage(BridgeProtocol.CancelledJson(request.Id));
            return;
        }

        PostToPage(BridgeProtocol.SuccessJson(request.Id, paths));
    }

    private void OnProcessFailed(object? sender, CoreWebView2ProcessFailedEventArgs e)
    {
        ShowError(
            "介面程序已停止。 (The editor's renderer stopped.)",
            e.ProcessFailedKind.ToString(),
            canRetry: true);
    }

    private void OnNavigationCompleted(object? sender, CoreWebView2NavigationCompletedEventArgs e)
    {
        if (e.IsSuccess)
        {
            return;
        }

        ShowError(
            "無法載入介面。 (The editor page failed to load.)",
            $"navigation failed: {e.WebErrorStatus}",
            canRetry: true);
    }

    private void OnEngineExited(int exitCode)
    {
        if (State == ShellState.Ready)
        {
            ShowError(
                "引擎已停止。 (The engine stopped.)",
                $"the engine exited with code {exitCode}\n\nsee: {ShellPaths.EngineLogPath(_localAppData)}",
                canRetry: true);
        }
    }

    private void PostToPage(string json)
    {
        try
        {
            _webView?.CoreWebView2?.PostWebMessageAsJson(json);
        }
        catch
        {
            // The page can be mid-teardown; there is nowhere to deliver the answer.
        }
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        _engine?.Dispose();
        _engine = null;
        base.OnFormClosing(e);
    }
}
