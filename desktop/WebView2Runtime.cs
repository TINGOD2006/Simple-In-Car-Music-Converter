using Microsoft.Web.WebView2.Core;

namespace AudioUsbStudio.Shell;

/// <summary>
/// Whether the WebView2 runtime is installed.
///
/// The editor is a web page, so without this runtime there is nothing to render. Asking
/// <see cref="CoreWebView2Environment.GetAvailableBrowserVersionString()"/> directly is possible but
/// it throws when the runtime is absent, and that exception would surface from somewhere deep in
/// control construction. Checking it up front turns "the window never appeared" into a sentence the
/// user can act on: install the runtime.
/// </summary>
public static class WebView2Runtime
{
    /// <summary>
    /// The installed runtime version, or null when none is available. Never throws — a machine
    /// without WebView2 is an expected state, not an error in this program.
    /// </summary>
    public static string? GetAvailableBrowserVersionString()
    {
        try
        {
            var version = CoreWebView2Environment.GetAvailableBrowserVersionString();
            return string.IsNullOrWhiteSpace(version) ? null : version;
        }
        catch
        {
            // Any failure here means the same thing to the caller: not usable.
            return null;
        }
    }

    /// <summary>True when the editor can be rendered at all.</summary>
    public static bool IsAvailable() => GetAvailableBrowserVersionString() is not null;
}
