using System.Diagnostics;
using AudioUsbStudio.Shell;

namespace AudioUsbStudio.Shell.Tests;

/// <summary>
/// These tests launch the real packaged engine — the shipped one under
/// <c>dist\AudioUsbStudio-*-win-x64\engine\</c> when it exists, otherwise <c>release\AudioUsbStudio.exe</c>.
/// That is the point: the interesting failures here are process-level ones — a console window flashing
/// up, a child outliving the window, the wrong working directory, the engine refusing to unpack — and
/// none of those are visible to a fake. When nothing has been packaged the tests skip rather than fail.
/// </summary>
public static class EngineHostTests
{
    private static readonly TimeSpan HealthTimeout = TimeSpan.FromSeconds(20);

    public static void Register()
    {
        Harness.Test("StartAsync brings the packaged engine up and reports no problems", async () =>
        {
            var engine = RequireEngine();
            using var host = NewHost(engine);

            var started = await host.StartAsync();

            Harness.Assert(started, $"the engine should have started; details: {host.Details}");
            Harness.AssertEq(host.Details, string.Empty, "details when the engine started cleanly");
            Harness.Assert(host.Port is >= 1 and <= 65535, $"the reported port is out of range: {host.Port}");
            Harness.Assert(
                await IsHealthy(host.Port),
                "StartAsync said the engine was ready, so /api/health should answer");
        });

        Harness.Test("StartAsync fails cleanly when the engine executable is missing", async () =>
        {
            var missing = Path.Combine(
                Path.GetTempPath(),
                "aus-no-such-engine-" + Guid.NewGuid().ToString("n"),
                ShellPaths.EngineExeName);

            using var host = new EngineHost(missing, TempLogPath(), TimeSpan.FromSeconds(5));
            var started = await host.StartAsync();

            Harness.Assert(!started, "a missing engine must not report success");
            Harness.Assert(
                host.Details.Contains(missing, StringComparison.OrdinalIgnoreCase),
                $"details should name the path it looked for; got: {host.Details}");
            Harness.Assert(
                host.Details.Contains("not found", StringComparison.OrdinalIgnoreCase),
                $"details should say the engine was not found; got: {host.Details}");
        });

        // The whole reason for the Job Object: if the shell is killed from Task Manager, the engine
        // must not be left serving on a port nobody can see.
        Harness.Test("Dispose leaves no engine process behind", async () =>
        {
            var engine = RequireEngine();
            var name = Path.GetFileNameWithoutExtension(engine);
            var baseline = Process.GetProcessesByName(name).Length;

            var host = NewHost(engine);
            try
            {
                Harness.Assert(await host.StartAsync(), $"the engine should have started; details: {host.Details}");
                Harness.Assert(
                    Process.GetProcessesByName(name).Length > baseline,
                    "the engine process should be running while the host is alive");
            }
            finally
            {
                host.Dispose();
            }

            Harness.Assert(
                await WaitForProcessCount(name, baseline, TimeSpan.FromSeconds(5)),
                "Dispose must not leave an engine process running");
        });

        // KILL_ON_JOB_CLOSE is what makes the guarantee hold even if the shell never gets to run
        // its own cleanup. Asserting it directly means a typo in the P/Invoke flags shows up here
        // rather than as a stray process on the user's machine.
        Harness.Test("closing a JobObject kills the process assigned to it", () =>
        {
            var engine = RequireEngine();
            var port = PortPicker.PickFreeLoopbackPort();
            var process = Process.Start(EngineHostContract.BuildStartInfo(engine, TempLogPath(), port))!;
            try
            {
                var job = new JobObject();
                Harness.Assert(job.Assign(process), "assigning a running process should succeed");

                job.Dispose();

                Harness.Assert(
                    process.WaitForExit(5000),
                    "closing the job should have killed the assigned process");
            }
            finally
            {
                try
                {
                    if (!process.HasExited) process.Kill(entireProcessTree: true);
                }
                catch
                {
                    // Already gone.
                }

                process.Dispose();
            }
        });

        // Guards the v0.2.0 mistake directly. Every test here used to launch release\AudioUsbStudio.exe
        // while the artifact users ran lived under dist\...\engine\, so the shipped build failed on a
        // real machine with all of these green. When a shipped release exists, it must be the one tested.
        Harness.Test("the packaged engine under test is the shipped one when one exists", () =>
        {
            var shipped = FindShippedEngineAnywhere();
            if (shipped is null)
            {
                Harness.Skip(@"dist\AudioUsbStudio-*-win-x64 has not been built; run node tools/build-desktop-release.mjs");
            }

            Harness.AssertEq(
                FindEngineExe(),
                shipped,
                "FindEngineExe must prefer the shipped layout over the bare release build");
        });
    }

    private static EngineHost NewHost(string engineExe) =>
        new(engineExe, TempLogPath(), HealthTimeout);

    private static string TempLogPath() =>
        Path.Combine(Path.GetTempPath(), "aus-enginehost-" + Guid.NewGuid().ToString("n") + ".log");

    private static async Task<bool> IsHealthy(int port) =>
        await HealthProbe.WaitAsync(
            $"http://127.0.0.1:{port}",
            TimeSpan.FromSeconds(5),
            TimeSpan.FromMilliseconds(100));

    private static async Task<bool> WaitForProcessCount(string name, int expected, TimeSpan timeout)
    {
        var watch = Stopwatch.StartNew();
        while (true)
        {
            var count = Process.GetProcessesByName(name).Length;
            if (count <= expected) return true;
            if (watch.Elapsed >= timeout) return false;
            await Task.Delay(100);
        }
    }

    /// <summary>
    /// Locates a packaged engine by walking up from the test binaries, so the tests do not depend
    /// on the working directory <c>dotnet run</c> happened to use.
    ///
    /// The shipped layout wins over the bare <c>release\</c> build. That is not cosmetic: v0.2.0
    /// shipped a layout these tests never launched — this helper only ever looked at
    /// <c>release\AudioUsbStudio.exe</c> — and the artifact the user double-clicked then failed
    /// while every test stayed green.
    /// </summary>
    private static string? FindEngineExe()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        for (var depth = 0; depth < 10 && dir is not null; depth++, dir = dir.Parent)
        {
            var shipped = FindShippedEngine(dir.FullName);
            if (shipped is not null) return shipped;

            var release = Path.Combine(dir.FullName, "release", "AudioUsbStudio.exe");
            if (File.Exists(release)) return release;
        }

        return null;
    }

    /// <summary>The engine inside a <c>dist\AudioUsbStudio-*-win-x64\</c> release, if there is one.</summary>
    private static string? FindShippedEngine(string root)
    {
        var dist = Path.Combine(root, "dist");
        if (!Directory.Exists(dist)) return null;

        foreach (var release in Directory.EnumerateDirectories(dist, "AudioUsbStudio-*-win-x64"))
        {
            var candidate = Path.Combine(release, "engine", ShellPaths.EngineExeName);
            if (File.Exists(candidate)) return candidate;
        }

        return null;
    }

    private static string? FindShippedEngineAnywhere()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        for (var depth = 0; depth < 10 && dir is not null; depth++, dir = dir.Parent)
        {
            var shipped = FindShippedEngine(dir.FullName);
            if (shipped is not null) return shipped;
        }

        return null;
    }

    private static string RequireEngine()
    {
        var engine = FindEngineExe();
        if (engine is null)
        {
            Harness.Skip(@"nothing has been packaged; run node tools/build-exe.mjs or node tools/build-desktop-release.mjs");
        }

        return engine;
    }
}
