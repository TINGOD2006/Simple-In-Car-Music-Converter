namespace AudioUsbStudio.Shell;

/// <summary>
/// The native file dialogs, plus the two pure helpers behind them.
///
/// The extension list mirrors the engine's allow-list in <c>src/server/files.ts</c> on purpose: the
/// dialog should not be able to hand back a path the engine will then refuse, because that error
/// ("415 Unsupported") tells the user nothing they can act on.
/// </summary>
public static class NativeDialog
{
    /// <summary>
    /// Every extension the engine accepts. Kept in sync with <c>AUDIO_EXTENSIONS</c> in
    /// <c>src/server/files.ts</c>; the desktop tests assert the five formats the product names.
    /// </summary>
    public static readonly string[] AudioExtensions =
    {
        ".aac", ".ac3", ".adts", ".aif", ".aifc", ".aiff", ".amr", ".ape", ".asf", ".au", ".awb",
        ".bwf", ".caf", ".dts", ".dtshd", ".eac3", ".flac", ".gsm", ".m4a", ".m4b", ".mka", ".mkv",
        ".mov", ".mp1", ".mp2", ".mp3", ".mp4", ".mpa", ".mpc", ".oga", ".ogg", ".opus", ".ra",
        ".rf64", ".rm", ".snd", ".spx", ".tak", ".tta", ".voc", ".vox", ".w64", ".wav", ".webm",
        ".wma", ".wv",
    };

    private static readonly HashSet<string> AudioExtensionSet =
        new(AudioExtensions, StringComparer.OrdinalIgnoreCase);

    /// <summary>
    /// The WinForms filter string. The trailing entry matters: someone with a container this build
    /// has not heard of is otherwise stuck with a dialog that shows none of their files.
    /// </summary>
    public static string BuildAudioFilter()
    {
        var patterns = string.Join(';', AudioExtensions.Select(extension => "*" + extension));
        return $"Audio files ({patterns})|{patterns}|All files (*.*)|*.*";
    }

    /// <summary>
    /// Keeps only audio paths, in their original order, without duplicates. Paths differing only in
    /// case are one file on Windows, so the first spelling wins.
    /// </summary>
    public static string[] KeepAudioFiles(IEnumerable<string> paths)
    {
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var kept = new List<string>();

        foreach (var raw in paths)
        {
            if (string.IsNullOrWhiteSpace(raw)) continue;

            var path = raw.Trim();
            if (!AudioExtensionSet.Contains(Path.GetExtension(path))) continue;
            if (!seen.Add(path)) continue;

            kept.Add(path);
        }

        return kept.ToArray();
    }

    /// <summary>
    /// Shows the open dialog. Returns null when a dialog cannot be shown at all (so the page can
    /// fall back to the HTTP picker and then to an upload); returns an empty array when the user
    /// simply closed it.
    /// </summary>
    public static string[]? PickFiles(nint owner, string title, bool multiple)
    {
        try
        {
            using var dialog = new OpenFileDialog
            {
                Title = string.IsNullOrWhiteSpace(title) ? "Choose audio files" : title,
                Filter = BuildAudioFilter(),
                Multiselect = multiple,
                CheckFileExists = true,
                CheckPathExists = true,
                DereferenceLinks = true,
            };

            if (dialog.ShowDialog(OwnerWindow.From(owner)) != DialogResult.OK) return Array.Empty<string>();

            return KeepAudioFiles(dialog.FileNames);
        }
        catch
        {
            // A dialog that cannot be shown is a missing capability, not a user error. Reporting it
            // as null is what lets the page degrade instead of showing a dead end.
            return null;
        }
    }

    /// <summary>
    /// Shows the folder dialog. Returns null when it cannot be shown, empty when the user closed it.
    /// </summary>
    public static string[]? PickFolder(nint owner, string title)
    {
        try
        {
            using var dialog = new FolderBrowserDialog
            {
                Description = string.IsNullOrWhiteSpace(title) ? "Choose a folder of audio" : title,
                UseDescriptionForTitle = true,
                ShowNewFolderButton = false,
            };

            if (dialog.ShowDialog(OwnerWindow.From(owner)) != DialogResult.OK) return Array.Empty<string>();
            if (string.IsNullOrWhiteSpace(dialog.SelectedPath)) return Array.Empty<string>();

            return new[] { dialog.SelectedPath };
        }
        catch
        {
            return null;
        }
    }

    /// <summary>
    /// Wraps the window handle the page handed us so it can own the modal dialog. A zero handle
    /// yields null, which makes the dialog centred on the desktop rather than on nothing.
    /// </summary>
    private sealed class OwnerWindow : IWin32Window
    {
        private OwnerWindow(nint handle) => Handle = handle;

        public nint Handle { get; }

        public static IWin32Window? From(nint handle) => handle == 0 ? null : new OwnerWindow(handle);
    }
}
