using System.Diagnostics;
using System.Net.Http;

namespace AudioUsbStudio.Shell;

/// <summary>
/// Waits for the engine's HTTP endpoint to answer.
///
/// The shell starts the engine as a separate process, so "it launched" says nothing about
/// "it is serving". Pointing WebView2 at the URL before the listener exists produces the exact
/// blank-window symptom this desktop shell exists to remove, so the window is only shown once
/// <see cref="WaitAsync"/> has seen a real 2xx.
///
/// The contract is that this never throws and never blocks past its deadline: it is called
/// while a splash window is on screen, and an exception there is an invisible failure.
/// </summary>
public static class HealthProbe
{
    /// <summary>Polls <c>baseUrl/api/health</c> until a 2xx or the deadline. Never throws.</summary>
    public static async Task<bool> WaitAsync(
        string baseUrl,
        TimeSpan timeout,
        TimeSpan interval,
        CancellationToken ct = default)
    {
        if (timeout <= TimeSpan.Zero) return false;

        // One attempt must not be able to eat the whole deadline, and a connection that hangs
        // without ever being refused should not stall a long wait either. Taking the smaller of
        // the deadline and one second gives both.
        var perRequest = timeout < TimeSpan.FromSeconds(1) ? timeout : TimeSpan.FromSeconds(1);
        var url = baseUrl.TrimEnd('/') + "/api/health";
        var watch = Stopwatch.StartNew();

        try
        {
            using var client = new HttpClient { Timeout = perRequest };

            while (watch.Elapsed < timeout && !ct.IsCancellationRequested)
            {
                try
                {
                    using var response = await client.GetAsync(url, ct).ConfigureAwait(false);
                    if (response.IsSuccessStatusCode) return true;
                }
                catch
                {
                    // Connection refused, request timeout, malformed URL, cancellation for this
                    // single attempt — every one of these just means "not ready yet".
                }

                try
                {
                    await Task.Delay(interval, ct).ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                {
                    break;
                }
            }
        }
        catch
        {
            // Nothing above should reach here, but the contract is "never throws", so it must
            // not depend on that being true.
        }

        return false;
    }
}
