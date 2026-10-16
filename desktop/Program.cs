using System.Diagnostics;
using System.Runtime.InteropServices;

namespace AudioUsbStudio.Shell;

/// <summary>
/// Shell entry point.
///
/// Two things happen here that are not about the window itself, and both exist because of how the
/// previous build failed: a second launch brings the running window forward instead of dying on an
/// occupied port, and every unhandled exception is written to a log beside the executable before
/// the process goes down. A window that vanished used to take the only copy of the reason with it.
/// </summary>
internal static class Program
{
    private const string MutexName = @"Local\AudioUsbStudio.SingleInstance";

    [STAThread]
    private static void Main()
    {
        ApplicationConfiguration.Initialize();
        Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
        InstallGlobalExceptionHandlers();

        using var singleInstance = new Mutex(initiallyOwned: true, MutexName, out var isFirstInstance);
        if (!isFirstInstance)
        {
            BringRunningWindowToFront();
            return;
        }

        using var form = new MainForm();
        form.Shown += async (_, _) => await form.StartEngineAsync();
        Application.Run(form);

        GC.KeepAlive(singleInstance);
    }

    private static void InstallGlobalExceptionHandlers()
    {
        Application.ThreadException += (_, e) => ReportFatal(e.Exception);
        AppDomain.CurrentDomain.UnhandledException += (_, e) => ReportFatal(e.ExceptionObject as Exception);
        TaskScheduler.UnobservedTaskException += (_, e) =>
        {
            ReportFatal(e.Exception);
            e.SetObserved();
        };
    }

    /// <summary>
    /// Writes the failure next to the executable and tells the user where it went.
    ///
    /// Where "there" is has to be discovered, because the first machine this shipped to refused to
    /// create directories under %LOCALAPPDATA% — which is why the folder beside the executable is in
    /// the candidate list at all.
    /// </summary>
    private static void ReportFatal(Exception? ex)
    {
        if (ex is null)
        {
            return;
        }

        var shellDir = AppContext.BaseDirectory;
        var dataDir = ShellPaths.TryResolveDataDir(ShellPaths.DataDirCandidates(shellDir), out _)
                      ?? shellDir;

        var logPath = ShellPaths.ShellErrorLogPath(dataDir);

        try
        {
            var directory = Path.GetDirectoryName(logPath);
            if (!string.IsNullOrEmpty(directory))
            {
                Directory.CreateDirectory(directory);
            }

            File.AppendAllText(logPath, $"[{DateTimeOffset.Now:O}]{Environment.NewLine}{ex}{Environment.NewLine}{Environment.NewLine}");
        }
        catch
        {
            // If the log cannot be written there is nothing further to try; still tell the user.
        }

        try
        {
            MessageBox.Show(
                "Audio USB Studio hit an unexpected error and has to close."
                + Environment.NewLine + Environment.NewLine
                + ex.Message
                + Environment.NewLine + Environment.NewLine
                + "A log was written to:" + Environment.NewLine + logPath,
                "Audio USB Studio",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
        }
        catch
        {
            // Nothing left to fall back on.
        }
    }

    /// <summary>
    /// Brings an already-running window forward. Launching the app twice used to start a second
    /// server, lose the port race, and exit without ever showing a window.
    /// </summary>
    private static void BringRunningWindowToFront()
    {
        try
        {
            foreach (var process in Process.GetProcessesByName("AudioUsbStudio"))
            {
                var handle = process.MainWindowHandle;
                if (handle == IntPtr.Zero)
                {
                    continue;
                }

                ShowWindow(handle, SW_RESTORE);
                SetForegroundWindow(handle);
                return;
            }
        }
        catch
        {
            // Bringing the old window forward is a convenience; failing it changes nothing.
        }
    }

    private const int SW_RESTORE = 9;

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);
}
