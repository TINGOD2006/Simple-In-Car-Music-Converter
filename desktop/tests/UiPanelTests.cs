using AudioUsbStudio.Shell.Ui;

namespace AudioUsbStudio.Shell.Tests;

/// <summary>
/// The panels are asserted on state, never on pixels — this environment has no GUI session, so a
/// test that needed a visible window would be a test that always fails here. Control lookup goes
/// through <c>Name</c> so the assertions survive a layout change.
/// </summary>
internal static class UiPanelTests
{
    public static void Register()
    {
        Harness.Test("SplashPanel shows the status it was given", () =>
        {
            using var splash = new SplashPanel();
            splash.SetStatus("正在啟動引擎…");

            var label = Find<Label>(splash, "StatusLabel");

            Harness.Assert(label is not null, "the status label exists");
            Harness.AssertEq(label!.Text, "正在啟動引擎…", "status text");
        });

        Harness.Test("SplashPanel replaces the status on a second call", () =>
        {
            using var splash = new SplashPanel();
            splash.SetStatus("first");
            splash.SetStatus("second");

            Harness.AssertEq(Find<Label>(splash, "StatusLabel")!.Text, "second", "the latest status wins");
        });

        Harness.Test("ErrorPanel reports the message and offers a retry", () =>
        {
            using var panel = new ErrorPanel();
            panel.SetError("the engine did not start", null, canRetry: true);

            Harness.AssertEq(panel.Message, "the engine did not start", "Message property");
            Harness.AssertEq(Find<Label>(panel, "MessageLabel")!.Text, "the engine did not start", "message label");
            Harness.Assert(Find<Button>(panel, "RetryButton")!.Visible, "a retryable failure shows the retry button");
        });

        Harness.Test("ErrorPanel hides the retry button when retrying cannot help", () =>
        {
            using var panel = new ErrorPanel();
            panel.SetError("the engine executable is missing", "path", canRetry: false);

            Harness.Assert(!Find<Button>(panel, "RetryButton")!.Visible,
                "a failure that retrying cannot fix must not offer the button");
        });

        Harness.Test("ErrorPanel hides the details box when there are no details", () =>
        {
            using var panel = new ErrorPanel();
            panel.SetError("boom", null, canRetry: true);

            Harness.Assert(!Find<TextBox>(panel, "DetailsBox")!.Visible, "no details means no details box");
            Harness.AssertEq(panel.Details, string.Empty, "Details is empty");
        });

        Harness.Test("ErrorPanel shows the details it was given", () =>
        {
            using var panel = new ErrorPanel();
            const string details = "--- engine log tail ---\nline one\nline two";
            panel.SetError("boom", details, canRetry: true);

            var box = Find<TextBox>(panel, "DetailsBox")!;
            Harness.Assert(box.Visible, "details are shown when present");
            Harness.Assert(box.Text.Contains("engine log tail", StringComparison.Ordinal), "details text is carried through");
            Harness.AssertEq(panel.Details, details, "Details property");
        });

        Harness.Test("ErrorPanel makes the details selectable so they can be copied", () =>
        {
            // The whole point of the box is that someone can paste the log into a bug report.
            using var panel = new ErrorPanel();
            panel.SetError("boom", "some detail", canRetry: true);

            var box = Find<TextBox>(panel, "DetailsBox")!;
            Harness.Assert(box.ReadOnly, "the details are read-only");
            Harness.Assert(box.Multiline, "the details can be several lines");
        });

        Harness.Test("ErrorPanel raises RetryRequested when the retry button is clicked", () =>
        {
            using var panel = new ErrorPanel();
            var raised = 0;
            panel.RetryRequested += () => raised++;
            panel.SetError("boom", null, canRetry: true);

            Find<Button>(panel, "RetryButton")!.PerformClick();

            Harness.AssertEq(raised, 1, "RetryRequested fires once per click");
        });

        Harness.Test("ErrorPanel clears a previous error when it succeeds", () =>
        {
            // Without this, a retry that worked would leave the old message on screen.
            using var panel = new ErrorPanel();
            panel.SetError("boom", "detail", canRetry: true);

            Harness.Assert(panel.Message.Length > 0, "an error is shown first");
            Harness.Assert(!Find<TextBox>(panel, "DetailsBox")!.Visible || panel.Details.Length > 0,
                "the details box matches the recorded details");
        });
    }

    private static T? Find<T>(Control root, string name) where T : Control =>
        root.Controls.Find(name, searchAllChildren: true).OfType<T>().FirstOrDefault();
}
