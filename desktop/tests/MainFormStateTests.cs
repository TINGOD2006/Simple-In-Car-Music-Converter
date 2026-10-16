namespace AudioUsbStudio.Shell.Tests;

/// <summary>
/// The state machine is asserted directly rather than through the screen, because this environment
/// has no GUI session. What is being pinned here is the ordering contract — a shell that reaches
/// Ready without a live engine, or that reports Failed without saying so, is the bug these tests
/// exist to prevent.
/// </summary>
internal static class MainFormStateTests
{
    public static void Register()
    {
        Harness.Test("a fresh MainForm is in the Starting state", () =>
        {
            using var form = new MainForm(MissingEngineExe());

            Harness.AssertEq(form.State, ShellState.Starting, "state before anything has been started");
        });

        Harness.Test("MainForm carries the product title and a sane window size", () =>
        {
            using var form = new MainForm(MissingEngineExe());

            Harness.AssertEq(form.Text, "Audio USB Studio", "window title");
            Harness.AssertEq(form.MinimumSize.Width, 960, "minimum width");
            Harness.AssertEq(form.MinimumSize.Height, 600, "minimum height");
            Harness.AssertEq(form.Width, 1280, "default width");
            Harness.AssertEq(form.Height, 840, "default height");
        });

        Harness.Test("ShowSplash keeps the shell in the Starting state", () =>
        {
            using var form = new MainForm(MissingEngineExe());

            form.ShowSplash("正在啟動引擎…");

            Harness.AssertEq(form.State, ShellState.Starting, "a status line is not a state change");
        });

        Harness.Test("ShowError moves the shell to Failed", () =>
        {
            using var form = new MainForm(MissingEngineExe());

            form.ShowError("引擎啟動失敗", null);

            Harness.AssertEq(form.State, ShellState.Failed, "state after an error is reported");
        });

        Harness.Test("ShowError can decline to offer a retry", () =>
        {
            // Retrying a missing binary just makes the user wait for the same outcome.
            using var form = new MainForm(MissingEngineExe());

            form.ShowError("引擎檔案不存在", "path", canRetry: false);

            Harness.AssertEq(form.State, ShellState.Failed, "still a failure");
        });

        Harness.Test("StartEngineAsync fails cleanly when the engine executable is missing", () =>
        {
            using var form = new MainForm(MissingEngineExe());

            var started = form.StartEngineAsync().GetAwaiter().GetResult();

            Harness.Assert(!started, "starting a missing engine reports failure");
            Harness.AssertEq(form.State, ShellState.Failed, "state after a failed start");
        });

        Harness.Test("StartEngineAsync reports failure instead of throwing on a bad engine path", () =>
        {
            // A directory that cannot exist: the failure must be reported, not raised, or the
            // unhandled exception takes the window down with it — the original symptom.
            using var form = new MainForm(MissingEngineExe());

            var threw = false;
            var started = false;
            try
            {
                started = form.StartEngineAsync().GetAwaiter().GetResult();
            }
            catch
            {
                threw = true;
            }

            Harness.Assert(!threw, "StartEngineAsync must not let an exception escape");
            Harness.Assert(!started, "and it must still report failure");
        });
    }

    /// <summary>A path under a random temp directory, so it can never accidentally exist.</summary>
    private static string MissingEngineExe() => Path.Combine(
        Path.GetTempPath(),
        "aus-no-such-engine-" + Guid.NewGuid().ToString("N"),
        "AudioUsbStudio.Engine.exe");
}
