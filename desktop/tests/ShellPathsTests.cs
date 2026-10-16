using AudioUsbStudio.Shell;

namespace AudioUsbStudio.Shell.Tests;

public static class ShellPathsTests
{
    public static void Register()
    {
        Harness.Test("EngineExePath puts the engine in engine\\", () =>
            Harness.AssertEq(
                ShellPaths.EngineExePath(@"C:\app"),
                @"C:\app\engine\AudioUsbStudio.Engine.exe",
                "engine exe path"));

        Harness.Test("EngineBinDir points at engine\\bin", () =>
            Harness.AssertEq(
                ShellPaths.EngineBinDir(@"C:\app"),
                @"C:\app\engine\bin",
                "engine bin dir"));

        Harness.Test("EngineLogPath lives in the data directory", () =>
            Harness.AssertEq(
                ShellPaths.EngineLogPath(@"C:\data"),
                @"C:\data\engine.log",
                "engine log path"));

        Harness.Test("ShellErrorLogPath lives in the data directory", () =>
            Harness.AssertEq(
                ShellPaths.ShellErrorLogPath(@"C:\data"),
                @"C:\data\shell-error.log",
                "shell error log path"));

        Harness.Test("UserDataDir is the WebView2 profile directory", () =>
            Harness.AssertEq(
                ShellPaths.UserDataDir(@"C:\data"),
                @"C:\data\WebView2",
                "WebView2 user data dir"));

        // The portable layout is the whole point of shipping a folder, so it is decided by
        // whether the engine actually sits next to the shell — not by a flag or a marker file.
        Harness.Test("IsPortableLayout is true only when engine\\ holds the engine exe", () =>
        {
            var root = Path.Combine(Path.GetTempPath(), "aus-shellpaths-" + Guid.NewGuid().ToString("n"));
            var engineDir = Path.Combine(root, "engine");
            Directory.CreateDirectory(engineDir);
            try
            {
                Harness.Assert(!ShellPaths.IsPortableLayout(root), "an empty engine/ is not a portable layout");
                File.WriteAllText(ShellPaths.EngineExePath(root), "stub");
                Harness.Assert(ShellPaths.IsPortableLayout(root), "engine exe present means portable layout");
            }
            finally
            {
                Directory.Delete(root, recursive: true);
            }
        });

        // The candidate order is the whole fix for the machine that refused %LOCALAPPDATA%: the
        // folder beside the executable must be in the list, because it is the one that worked there.
        Harness.Test("DataDirCandidates tries LOCALAPPDATA, then APPDATA, then beside the shell, then TEMP", () =>
            Harness.AssertSeq(
                ShellPaths.DataDirCandidates(@"C:\app", @"C:\lad", @"C:\ad", @"C:\tmp"),
                new[]
                {
                    @"C:\lad\AudioUsbStudio",
                    @"C:\ad\AudioUsbStudio",
                    @"C:\app\data",
                    @"C:\tmp\AudioUsbStudio",
                },
                "candidate order"));

        Harness.Test("DataDirCandidates never repeats a location when the roots coincide", () =>
            Harness.AssertSeq(
                ShellPaths.DataDirCandidates(@"C:\same", @"C:\same", @"C:\same", @"C:\same"),
                new[] { @"C:\same\AudioUsbStudio", @"C:\same\data" },
                "deduplicated candidates"));

        // A file standing where a directory should go is the failure an "access denied" message
        // hides best, so it is asserted explicitly rather than trusted to the exception text.
        Harness.Test("TryResolveDataDir skips a refused location and reports why", () =>
        {
            var root = NewScratch();
            try
            {
                var blocked = Path.Combine(root, "AudioUsbStudio");
                File.WriteAllText(blocked, "a file, not a folder");
                var good = Path.Combine(root, "data");

                var chosen = ShellPaths.TryResolveDataDir(new[] { blocked, good }, out var refusals);

                Harness.AssertEq(chosen, good, "the writable candidate wins");
                Harness.AssertEq(refusals.Count, 1, "the refused candidate is reported");
                Harness.Assert(
                    refusals[0].Contains("exists as a file", StringComparison.Ordinal),
                    $"the reason names the file in the way (got: {refusals[0]})");
            }
            finally
            {
                Directory.Delete(root, recursive: true);
            }
        });

        Harness.Test("TryResolveDataDir returns null and lists every refusal when nothing works", () =>
        {
            var root = NewScratch();
            try
            {
                var first = Path.Combine(root, "one");
                var second = Path.Combine(root, "two");
                File.WriteAllText(first, "blocked");
                File.WriteAllText(second, "blocked");

                var chosen = ShellPaths.TryResolveDataDir(new[] { first, second }, out var refusals);

                Harness.Assert(chosen is null, "no location means no directory");
                Harness.AssertEq(refusals.Count, 2, "both refusals are kept");
            }
            finally
            {
                Directory.Delete(root, recursive: true);
            }
        });

        Harness.Test("TryResolveDataDir accepts a directory that already exists", () =>
        {
            var root = NewScratch();
            try
            {
                var existing = Path.Combine(root, "AudioUsbStudio");
                Directory.CreateDirectory(existing);

                var chosen = ShellPaths.TryResolveDataDir(new[] { existing }, out var refusals);

                Harness.AssertEq(chosen, existing, "an existing directory is usable");
                Harness.AssertEq(refusals.Count, 0, "nothing was refused");
            }
            finally
            {
                Directory.Delete(root, recursive: true);
            }
        });
    }

    private static string NewScratch()
    {
        var root = Path.Combine(Path.GetTempPath(), "aus-shellpaths-" + Guid.NewGuid().ToString("n"));
        Directory.CreateDirectory(root);
        return root;
    }
}
