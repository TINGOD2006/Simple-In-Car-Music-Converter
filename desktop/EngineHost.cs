using System.Diagnostics;
using System.Globalization;

namespace AudioUsbStudio.Shell;

/// <summary>
/// How the engine gets launched, expressed as plain data so it can be asserted without starting
/// a process. Splitting the contract out from the launching also keeps the interesting decisions
/// (no console window, no shell, redirects on) reviewable on their own.
/// </summary>
public static class EngineHostContract
{
    /// <summary>Arguments that put the engine into serve mode on <paramref name="port"/>.</summary>
    /// <exception cref="ArgumentOutOfRangeException">The port is not in 1..65535.</exception>
    public static string[] BuildEngineArgs(int port)
    {
        if (port is < 1 or > 65535)
        {
            throw new ArgumentOutOfRangeException(nameof(port), port, "engine port must be 1..65535");
        }

        return new[] { "serve", "--port", port.ToString(CultureInfo.InvariantCulture) };
    }

    /// <summary>
    /// Process settings for launching the engine.
    ///
    /// <paramref name="logPath"/> is not consumed here: with the redirects on, the output only
    /// reaches a file once someone reads <see cref="Process.StandardOutput"/> and writes it
    /// somewhere. That reader is the host's job. It is in the signature from the start so the
    /// contract does not grow a parameter later.
    /// </summary>
    public static ProcessStartInfo BuildStartInfo(string engineExe, string logPath, int port)
    {
        var info = new ProcessStartInfo
        {
            FileName = engineExe,

            // The engine resolves ffmpeg and deep-filter from its own executable path, so a
            // working directory is not strictly required — but inheriting whatever directory the
            // shell was launched from would make behaviour depend on how the app was started.
            WorkingDirectory = Path.GetDirectoryName(engineExe) ?? string.Empty,

            // Without this the engine would either open its own console window or ignore the
            // redirects entirely.
            UseShellExecute = false,
            CreateNoWindow = true,

            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };

        foreach (var argument in BuildEngineArgs(port))
        {
            info.ArgumentList.Add(argument);
        }

        return info;
    }
}

/// <summary>
/// Owns the engine process for as long as the window is open.
///
/// Two failure modes shape this class. The engine may fail to bind the port the shell picked
/// (the picker only reports a port that <em>was</em> free), so starting is a retry loop rather
/// than a single attempt. And the engine may die during startup for reasons only it knows, so a
/// failure is reported with the tail of its log attached instead of a bare "could not start".
/// </summary>
public sealed class EngineHost : IDisposable
{
    private const int MaxStartAttempts = 5;

    private readonly string _engineExe;
    private readonly string _logPath;
    private readonly TimeSpan _healthTimeout;
    private readonly object _logLock = new();

    private Process? _process;
    private JobObject? _job;
    private readonly List<Task> _pumps = new();
    private bool _logAvailable;
    private string _logUnavailableReason = string.Empty;
    private bool _fatalStartup;

    public EngineHost(string engineExe, string logPath, TimeSpan? healthTimeout = null)
    {
        _engineExe = engineExe ?? throw new ArgumentNullException(nameof(engineExe));
        _logPath = logPath ?? throw new ArgumentNullException(nameof(logPath));
        _healthTimeout = healthTimeout ?? TimeSpan.FromSeconds(15);
    }

    /// <summary>The port the engine is serving on. Only meaningful after a successful start.</summary>
    public int Port { get; private set; }

    /// <summary>Why the last start failed. Empty after a successful start.</summary>
    public string Details { get; private set; } = string.Empty;

    /// <summary>Raised if the engine exits after a successful start, with its exit code.</summary>
    public event Action<int>? EngineExited;

    /// <summary>
    /// Starts the engine and waits until it answers <c>/api/health</c>. Returns false rather than
    /// throwing, with the reason in <see cref="Details"/>.
    /// </summary>
    public async Task<bool> StartAsync(CancellationToken ct = default)
    {
        Details = string.Empty;

        if (!File.Exists(_engineExe))
        {
            Details = $"engine executable not found: {_engineExe}";
            return false;
        }

        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(_logPath)!);
            File.WriteAllText(_logPath, string.Empty);
            _logAvailable = true;
            _logUnavailableReason = string.Empty;
        }
        catch (Exception ex)
        {
            // An unwritable log costs us diagnostics, not the ability to run — but it must not
            // cost us the *reason* the engine died. Remember the failure so the report can say
            // "the log could not be created" instead of the misleading "no engine log was written",
            // which is what the shipped v0.2.0 build told the user.
            _logAvailable = false;
            _logUnavailableReason = ex.Message;
        }

        // The unpacker writes its own log here. Clearing it first makes its presence mean
        // "this run failed to unpack", not "some run once failed to unpack".
        try
        {
            if (File.Exists(LauncherLogPath)) File.Delete(LauncherLogPath);
        }
        catch
        {
            // Best effort: a stale unpacker log would only make the retry decision conservative.
        }

        for (var attempt = 1; attempt <= MaxStartAttempts; attempt++)
        {
            ct.ThrowIfCancellationRequested();
            if (await TryStartOnceAsync(attempt, ct).ConfigureAwait(false)) return true;

            // An unpacker log means the engine refused to start for a reason a retry cannot
            // change (an unwritable directory, a corrupt blob). Five identical attempts only
            // make the user wait five times as long for the same message.
            if (_fatalStartup) break;
        }

        return false;
    }

    public void Dispose()
    {
        StopProcess();

        // Closing the job is the backstop for anything the engine spawned that we never saw.
        _job?.Dispose();
        _job = null;
    }

    private async Task<bool> TryStartOnceAsync(int attempt, CancellationToken ct)
    {
        _pumps.Clear();
        _fatalStartup = false;

        var port = PortPicker.PickFreeLoopbackPort();

        Process process;
        try
        {
            process = Process.Start(EngineHostContract.BuildStartInfo(_engineExe, _logPath, port))
                      ?? throw new InvalidOperationException("Process.Start returned null");
        }
        catch (Exception ex)
        {
            Details = $"could not start the engine: {ex.Message}";
            return false;
        }

        _process = process;
        Port = port;

        // Assigned before the health wait so a shell crash during startup cannot orphan it.
        var job = new JobObject();
        job.Assign(process);
        _job = job;

        process.EnableRaisingEvents = true;
        process.Exited += (_, _) => EngineExited?.Invoke(SafeExitCode(process));

        PumpLog(process.StandardOutput);
        PumpLog(process.StandardError);

        var ready = await HealthProbe
            .WaitAsync($"http://127.0.0.1:{port}", _healthTimeout, TimeSpan.FromMilliseconds(100), ct)
            .ConfigureAwait(false);

        if (ready)
        {
            Details = string.Empty;
            return true;
        }

        // Drain the pumps before reading the log, or a fast failure reads as silence.
        await DrainPumpsAsync().ConfigureAwait(false);

        var because = process.HasExited
            ? $"the engine exited with code {SafeExitCode(process)}"
            : $"the engine did not answer /api/health within {_healthTimeout.TotalSeconds:0.#}s";

        _fatalStartup = File.Exists(LauncherLogPath);

        Details =
            $"{because} (attempt {attempt} of {MaxStartAttempts}){Environment.NewLine}" +
            $"--- engine log tail ({_logPath}) ---{Environment.NewLine}{LogTail()}";

        StopProcess();
        _job?.Dispose();
        _job = null;
        return false;
    }

    /// <summary>
    /// Drains a redirected stream into the log. A process whose output pipe fills up blocks, so
    /// this has to run whether or not anyone is interested in the text.
    /// </summary>
    private void PumpLog(StreamReader reader)
    {
        _ = Task.Run(async () =>
        {
            try
            {
                while (await reader.ReadLineAsync().ConfigureAwait(false) is { } line)
                {
                    lock (_logLock)
                    {
                        File.AppendAllText(_logPath, line + Environment.NewLine);
                    }
                }
            }
            catch
            {
                // The pipe closes when the process dies; that is the normal way this ends.
            }
        });
    }

    /// <summary>
    /// The unpacker writes the reason it could not start — a refused directory, a corrupt
    /// blob — to a log beside the engine executable. When the engine dies before printing a
    /// single line on stdout, that file is the only record of why, so it belongs in the report.
    /// </summary>
    private string LauncherLogPath =>
        Path.Combine(Path.GetDirectoryName(_engineExe) ?? string.Empty, "AudioUsbStudio-error.log");

    private static string ReadTail(string path, int lines)
    {
        try
        {
            if (!File.Exists(path)) return string.Empty;
            var all = File.ReadAllLines(path);
            return all.Length == 0 ? string.Empty : string.Join(Environment.NewLine, all.TakeLast(lines));
        }
        catch (Exception ex)
        {
            return $"(could not read {path}: {ex.Message})";
        }
    }

    /// <summary>
    /// Waits briefly for the output pumps to drain. They run on their own tasks, so without this
    /// a process that dies fast looks exactly like a process that said nothing.
    /// </summary>
    private async Task DrainPumpsAsync()
    {
        try
        {
            await Task.WhenAny(Task.WhenAll(_pumps), Task.Delay(750)).ConfigureAwait(false);
        }
        catch
        {
            // A pump that faulted has nothing left to contribute.
        }
    }

    private string LogTail(int lines = 25)
    {
        var parts = new List<string>();

        if (!_logAvailable)
        {
            parts.Add($"could not create the log at {_logPath}: {_logUnavailableReason}");
        }

        var engine = ReadTail(_logPath, lines);
        parts.Add(engine.Length > 0 ? engine : $"(nothing was written to {_logPath})");

        var launcher = ReadTail(LauncherLogPath, lines);
        if (launcher.Length > 0)
        {
            parts.Add($"--- engine unpacker log ({LauncherLogPath}) ---");
            parts.Add(launcher);
        }

        return string.Join(Environment.NewLine, parts);
    }

    private void StopProcess()
    {
        var process = _process;
        _process = null;
        if (process is null) return;

        try
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
                process.WaitForExit(5000);
            }
        }
        catch
        {
            // Already gone, or not ours to kill. Closing the job handle is the backstop.
        }
        finally
        {
            process.Dispose();
        }
    }

    private static int SafeExitCode(Process process)
    {
        try
        {
            return process.ExitCode;
        }
        catch
        {
            return -1;
        }
    }
}
