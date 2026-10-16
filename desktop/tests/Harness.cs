namespace AudioUsbStudio.Shell.Tests;

/// <summary>
/// A console test harness, deliberately shaped like the engine's own test/harness.ts.
///
/// No xUnit/NUnit: this machine's .NET HTTP stack cannot reach nuget.org (see
/// desktop/build-shell.mjs), so desktop/NuGet.config serves packages from a local folder
/// holding only what was pre-fetched. A test framework would drag in a transitive graph
/// that would have to be pre-fetched as well, for no benefit at this size.
/// </summary>
public static class Harness
{
    private static readonly List<(string Name, Action Body)> Cases = new();

    /// <summary>Registers one test. Tests run in registration order.</summary>
    public static void Test(string name, Action body) => Cases.Add((name, body));

    /// <summary>
    /// Registers an async test. The harness blocks on it, so a test can await real I/O
    /// without every caller having to remember the unwrapping dance.
    /// </summary>
    public static void Test(string name, Func<Task> body) =>
        Cases.Add((name, () => body().GetAwaiter().GetResult()));

    /// <summary>Fails the test with <paramref name="message"/> unless the condition holds.</summary>
    public static void Assert(bool condition, string message)
    {
        if (!condition) throw new HarnessFailure(message);
    }

    /// <summary>Fails unless actual equals expected, printing both so the diff is visible.</summary>
    public static void AssertEq<T>(T actual, T expected, string message)
    {
        if (!EqualityComparer<T>.Default.Equals(actual, expected))
        {
            throw new HarnessFailure($"{message} (expected <{expected}>, got <{actual}>)");
        }
    }

    /// <summary>
    /// Fails unless the sequences match element for element. Exists because <see cref="AssertEq{T}"/>
    /// compares arrays by reference, which would silently pass nothing and fail everything.
    /// </summary>
    public static void AssertSeq<T>(IEnumerable<T> actual, IEnumerable<T> expected, string message)
    {
        var got = actual.ToArray();
        var want = expected.ToArray();
        if (!got.SequenceEqual(want))
        {
            throw new HarnessFailure(
                $"{message} (expected [{string.Join(", ", want)}], got [{string.Join(", ", got)}])");
        }
    }

    /// <summary>
    /// Abandons the current test because a precondition is not met. Reported as "skip" and never
    /// counted as a pass, so a test that silently stops exercising anything stays visible.
    /// </summary>
    [System.Diagnostics.CodeAnalysis.DoesNotReturn]
    public static void Skip(string reason) => throw new HarnessSkipped(reason);

    /// <summary>
    /// Runs every registered test, printing ok/FAIL/skip, and returns the failure count.
    /// </summary>
    public static int RunAll()
    {
        var failed = 0;
        var skipped = 0;
        foreach (var (name, body) in Cases)
        {
            try
            {
                body();
                Console.WriteLine($"ok   {name}");
            }
            catch (HarnessSkipped ex)
            {
                skipped++;
                Console.WriteLine($"skip {name}");
                Console.WriteLine($"     {ex.Message}");
            }
            catch (Exception ex)
            {
                failed++;
                Console.WriteLine($"FAIL {name}");
                Console.WriteLine($"     {ex.Message}");
            }
        }

        var summary = $"{Cases.Count - failed - skipped}/{Cases.Count} passed";
        if (skipped > 0) summary += $" ({skipped} skipped)";
        Console.WriteLine(summary);
        return failed;
    }
}

/// <summary>Thrown by <see cref="Harness.Skip"/>; a missing precondition, not a failure.</summary>
public sealed class HarnessSkipped : Exception
{
    public HarnessSkipped(string reason) : base(reason) { }
}

/// <summary>Thrown by the harness assertions; carries the human-readable reason.</summary>
public sealed class HarnessFailure : Exception
{
    public HarnessFailure(string message) : base(message) { }
}
