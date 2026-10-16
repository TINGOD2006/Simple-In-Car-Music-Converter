namespace AudioUsbStudio.Shell.Ui;

/// <summary>
/// The screen shown while the engine is being started. It exists so there is always something on
/// screen during the gap between "the user double-clicked" and "the UI can answer" — that gap is
/// what previously looked like the program doing nothing at all.
///
/// Built in code rather than with the WinForms designer: a designer file would be a second place
/// to look for layout, and this panel is small enough that the code is shorter than the diff.
/// </summary>
public sealed class SplashPanel : UserControl
{
    private readonly Label _status;

    public SplashPanel()
    {
        Dock = DockStyle.Fill;
        BackColor = Color.FromArgb(24, 26, 32);
        ForeColor = Color.Gainsboro;

        var title = new Label
        {
            Name = "TitleLabel",
            Text = "Audio USB Studio",
            AutoSize = false,
            Dock = DockStyle.Fill,
            TextAlign = ContentAlignment.MiddleCenter,
            Font = new Font("Segoe UI", 20f, FontStyle.Bold),
            ForeColor = Color.White,
        };

        _status = new Label
        {
            Name = "StatusLabel",
            Text = "Starting…",
            AutoSize = false,
            Dock = DockStyle.Fill,
            Height = 30,
            TextAlign = ContentAlignment.MiddleCenter,
            Font = new Font("Segoe UI", 10f),
            ForeColor = Color.Gainsboro,
        };

        var bar = new ProgressBar
        {
            Name = "BusyBar",
            Style = ProgressBarStyle.Marquee,
            MarqueeAnimationSpeed = 30,
            Dock = DockStyle.Fill,
            Height = 6,
        };

        // A top spacer, the block, and a matching bottom spacer keep the text vertically centred
        // without hard-coding a window size.
        var layout = new TableLayoutPanel
        {
            Name = "SplashLayout",
            Dock = DockStyle.Fill,
            ColumnCount = 1,
            RowCount = 5,
            BackColor = Color.Transparent,
        };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 50));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 50));

        layout.Controls.Add(new Panel { Name = "TopSpacer", Dock = DockStyle.Fill }, 0, 0);
        layout.Controls.Add(title, 0, 1);
        layout.Controls.Add(_status, 0, 2);
        layout.Controls.Add(bar, 0, 3);
        layout.Controls.Add(new Panel { Name = "BottomSpacer", Dock = DockStyle.Fill }, 0, 4);

        Controls.Add(layout);
    }

    /// <summary>Replaces the line under the title.</summary>
    public void SetStatus(string text) => _status.Text = text;
}
