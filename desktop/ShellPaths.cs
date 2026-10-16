namespace AudioUsbStudio.Shell;

/// <summary>
/// Every filesystem location the shell has to know about, derived in one place.
///
/// Two roots are kept deliberately separate:
///
/// <list type="bullet">
/// <item><c>shellDir</c> — wherever AudioUsbStudio.exe happens to live. The engine and its
/// tools sit underneath it, which is what makes the release folder portable: copy the folder
/// and the paths still resolve.</item>
/// <item><c>dataDir</c> — per-user state (logs, the WebView2 profile). See
/// <see cref="DataDirCandidates"/>: which directory this is has to be discovered, not assumed.</item>
/// </list>
/// </summary>
public static class ShellPaths
{
    /// <summary>Folder name used under LOCALAPPDATA for everything this app persists.</summary>
    public const string AppFolderName = "AudioUsbStudio";

    /// <summary>File name of the engine executable, relative to <c>shellDir\engine</c>.</summary>
    public const string EngineExeName = "AudioUsbStudio.Engine.exe";

    /// <summary>Engine executable path for a shell living in <paramref name="shellDir"/>.</summary>
    public static string EngineExePath(string shellDir) =>
        Path.Combine(shellDir, "engine", EngineExeName);

    /// <summary>Directory holding ffmpeg, ffprobe and deep-filter for the engine.</summary>
    public static string EngineBinDir(string shellDir) =>
        Path.Combine(shellDir, "engine", "bin");

    /// <summary>Where the engine's own stdout/stderr are captured.</summary>
    public static string EngineLogPath(string dataDir) =>
        Path.Combine(dataDir, "engine.log");

    /// <summary>Where the shell records a failure that killed it before a window appeared.</summary>
    public static string ShellErrorLogPath(string dataDir) =>
        Path.Combine(dataDir, "shell-error.log");

    /// <summary>WebView2 user-data folder; a dedicated one keeps this app out of the shared profile.</summary>
    public static string UserDataDir(string dataDir) =>
        Path.Combine(dataDir, "WebView2");

    /// <summary>
    /// True when the engine ships next to the shell, i.e. this is the portable release layout
    /// rather than a development build.
    /// </summary>
    public static bool IsPortableLayout(string shellDir) =>
        File.Exists(EngineExePath(shellDir));

    /// <summary>
    /// Candidate directories for per-user state, best first.
    ///
    /// The order is not a preference so much as a fallback chain, because assuming a location is
    /// how this shell shipped broken: on the machine it first ran on, Windows refused to create
    /// directories under %LOCALAPPDATA% — once for the engine's unpack folder under
    /// %LOCALAPPDATA%\Temp, and then again for %LOCALAPPDATA%\AudioUsbStudio\WebView2 — while the
    /// folder beside the executable was created without complaint. A location is therefore only
    /// ever chosen after it has been created *and* written to.
    /// </summary>
    public static IReadOnlyList<string> DataDirCandidates(
        string shellDir,
        string? localAppData = null,
        string? appData = null,
        string? temp = null)
    {
        var candidates = new List<string>();

        void Add(string? root, string leaf)
        {
            if (string.IsNullOrWhiteSpace(root)) return;
            var full = Path.Combine(root, leaf);
            foreach (var seen in candidates)
            {
                if (string.Equals(seen, full, StringComparison.OrdinalIgnoreCase)) return;
            }
            candidates.Add(full);
        }

        Add(localAppData ?? Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), AppFolderName);
        Add(appData ?? Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), AppFolderName);

        // Beside the executable. Last by convention, first by evidence on the machine that
        // refused the two above — and the honest place for a portable copy to keep its state.
        Add(shellDir, "data");
        Add(temp ?? Path.GetTempPath(), AppFolderName);

        return candidates;
    }

    /// <summary>
    /// The first candidate that can be created <em>and written to</em>, or null when every one was
    /// refused. The reasons are returned either way, so a caller can show them instead of guessing.
    /// </summary>
    public static string? TryResolveDataDir(IReadOnlyList<string> candidates, out IReadOnlyList<string> refusals)
    {
        var problems = new List<string>();

        foreach (var dir in candidates)
        {
            if (TryPrepareWritableDirectory(dir, out var why))
            {
                refusals = problems;
                return dir;
            }

            problems.Add($"{dir}{Environment.NewLine}    {why}");
        }

        refusals = problems;
        return null;
    }

    /// <summary>
    /// Creates <paramref name="dir"/> and proves it is usable by writing a file into it.
    ///
    /// Creating a directory is not evidence that it can be written to: a restrictive ACL, a
    /// read-only volume and a full disk all pass the mkdir and fail the first write.
    /// </summary>
    private static bool TryPrepareWritableDirectory(string dir, out string why)
    {
        try
        {
            Directory.CreateDirectory(dir);

            var probe = Path.Combine(dir, ".write-probe-" + Guid.NewGuid().ToString("n"));
            File.WriteAllText(probe, "ok");
            File.Delete(probe);

            why = string.Empty;
            return true;
        }
        catch (Exception ex)
        {
            why = Describe(ex, dir);
            return false;
        }
    }

    /// <summary>
    /// Turns a refusal into something worth reading, including the case where a <em>file</em> is
    /// what stands in the way — an "access denied" that has nothing to do with rights. The
    /// obstruction is usually the candidate itself; a missing parent directory is the other shape.
    /// </summary>
    private static string Describe(Exception ex, string dir)
    {
        var parent = Path.GetDirectoryName(dir);

        string note;
        if (File.Exists(dir))
        {
            note = $"{Environment.NewLine}    ({dir} exists as a file, not a folder)";
        }
        else if (parent is not null && File.Exists(parent))
        {
            note = $"{Environment.NewLine}    ({parent} exists as a file, not a folder)";
        }
        else
        {
            note = string.Empty;
        }

        return $"{ex.GetType().Name}: {ex.Message}{note}";
    }
}
