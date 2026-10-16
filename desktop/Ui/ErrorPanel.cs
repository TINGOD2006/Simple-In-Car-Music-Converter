namespace AudioUsbStudio.Shell.Ui;

/// <summary>
/// Shown when the shell cannot get the engine running. Seven failures can land here, and every one
/// of them used to be invisible: a console window that flashed and vanished, carrying the only copy
/// of the reason. This panel, plus the error log the shell writes next to itself, is the fix.
///
/// The details box is the important part — it holds the engine log tail, it is read-only and
/// scrollable, and it is selectable so the text can be pasted somewhere. A failure that cannot be
/// reported is a failure that cannot be fixed.
/// </summary>
public sealed class ErrorPanel : UserControl
{
    private readonly Label _message;
    private readonly Label _hint;
    private readonly TextBox _details;
    private readonly Button _retry;

    public ErrorPanel()
    {
        Dock = DockStyle.Fill;
        BackColor = Color.FromArgb(24, 26, 32);
        ForeColor = Color.Gainsboro;

        _message = new Label
        {
            Name = "MessageLabel",
            Text = string.Empty,
            AutoSize = false,
            Dock = DockStyle.Top,
            Height = 70,
            Padding = new Padding(24, 20, 24, 4),
            Font = new Font("Segoe UI", 12f, FontStyle.Bold),
            ForeColor = Color.FromArgb(255, 122, 122),
        };

        _hint = new Label
        {
            Name = "HintLabel",
            Text = "The engine is a separate program that does the work. "
                 + "It is not running, so there is nothing to edit with right now.",
            AutoSize = false,
            Dock = DockStyle.Top,
            Height = 44,
            Padding = new Padding(24, 0, 24, 8),
            Font = new Font("Segoe UI", 9.5f),
            ForeColor = Color.Gainsboro,
        };

        _details = new TextBox
        {
            Name = "DetailsBox",
            Text = string.Empty,
            ReadOnly = true,
            Multiline = true,
            ScrollBars = ScrollBars.Vertical,
            WordWrap = false,
            Dock = DockStyle.Fill,
            Visible = false,
            BackColor = Color.FromArgb(16, 17, 21),
            ForeColor = Color.Gainsboro,
            Font = new Font("Consolas", 9f),
            BorderStyle = BorderStyle.FixedSingle,
        };

        _retry = new Button
        {
            Name = "RetryButton",
            Text = "Try again",
            AutoSize = true,
            Padding = new Padding(14, 6, 14, 6),
            Visible = false,
        };
        _retry.Click += (_, _) => RetryRequested?.Invoke();

        var buttons = new FlowLayoutPanel
        {
            Name = "ButtonRow",
            Dock = DockStyle.Bottom,
            Height = 52,
            Padding = new Padding(20, 10, 20, 10),
            FlowDirection = FlowDirection.LeftToRight,
            WrapContents = false,
            AutoSize = false,
            BackColor = Color.Transparent,
        };
        buttons.Controls.Add(_retry);

        // Docked children are laid out from the back of the z-order forwards, so these are added
        // in the reverse of the order they should occupy the window.
        Controls.Add(_details);
        Controls.Add(buttons);
        Controls.Add(_hint);
        Controls.Add(_message);
    }

    /// <summary>Raised when the user asks to try starting the engine again.</summary>
    public event Action? RetryRequested;

    /// <summary>The headline, as last set.</summary>
    public string Message => _message.Text;

    /// <summary>The details text, as last set. Empty when there were none.</summary>
    public string Details => _details.Text;

    /// <summary>
    /// Shows a failure. <paramref name="canRetry"/> is false for failures that retrying cannot fix
    /// (a missing engine binary, an unwritable folder) — offering the button there would just be a
    /// second way to make the user wait for the same outcome.
    /// </summary>
    public void SetError(string message, string? details, bool canRetry)
    {
        _message.Text = message ?? string.Empty;
        _hint.Text = canRetry
            ? "The engine is a separate program that does the work. Trying again restarts it."
            : "The engine is a separate program that does the work. Retrying will not change this one.";

        var text = (details ?? string.Empty).TrimEnd();
        _details.Text = text;
        _details.Visible = text.Length > 0;

        _retry.Visible = canRetry;
        _retry.Enabled = canRetry;
    }
}
