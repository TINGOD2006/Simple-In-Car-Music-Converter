using AudioUsbStudio.Shell;

namespace AudioUsbStudio.Shell.Tests;

public static class EngineHostContractTests
{
    private const string EngineExe = @"C:\app\engine\AudioUsbStudio.Engine.exe";
    private const string LogPath = @"C:\lad\AudioUsbStudio\engine.log";

    public static void Register()
    {
        Harness.Test("BuildEngineArgs tells the engine to serve on the chosen port", () =>
            Harness.AssertSeq(
                EngineHostContract.BuildEngineArgs(5000),
                new[] { "serve", "--port", "5000" },
                "engine argv"));

        Harness.Test("BuildStartInfo runs without a console window and without the shell", () =>
        {
            var info = EngineHostContract.BuildStartInfo(EngineExe, LogPath, 5000);
            Harness.Assert(info.CreateNoWindow, "CreateNoWindow must be true, or the user sees a black console");
            Harness.Assert(!info.UseShellExecute, "UseShellExecute must be false, or the redirects are ignored");
        });

        // The engine finds ffmpeg through its own executable path, so it does not strictly need a
        // working directory — but inheriting whatever directory the shell happened to start in
        // makes behaviour depend on how the app was launched.
        Harness.Test("BuildStartInfo runs from the engine's own directory", () =>
        {
            var info = EngineHostContract.BuildStartInfo(EngineExe, LogPath, 5000);
            Harness.AssertEq(
                info.WorkingDirectory,
                Path.GetDirectoryName(EngineExe)!,
                "working directory");
        });

        Harness.Test("BuildStartInfo captures the engine's output", () =>
        {
            var info = EngineHostContract.BuildStartInfo(EngineExe, LogPath, 5000);
            Harness.Assert(info.RedirectStandardOutput, "stdout must be redirected so it can reach the log");
            Harness.Assert(info.RedirectStandardError, "stderr must be redirected so it can reach the log");
        });

        Harness.Test("BuildEngineArgs rejects a port that cannot exist", () =>
        {
            foreach (var bad in new[] { 0, -1, 65536 })
            {
                var threw = false;
                try
                {
                    EngineHostContract.BuildEngineArgs(bad);
                }
                catch (ArgumentOutOfRangeException)
                {
                    threw = true;
                }

                Harness.Assert(threw, $"port {bad} should have been rejected");
            }
        });
    }
}
