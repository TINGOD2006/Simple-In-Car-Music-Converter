using System.Net;
using System.Net.Sockets;

namespace AudioUsbStudio.Shell;

/// <summary>
/// Hands the engine a port that was free a moment ago.
///
/// The engine is told which port to bind rather than being asked which one it bound, because
/// the shell has to know the URL <em>before</em> it can point WebView2 at it. Binding
/// loopback:0 and immediately releasing is the standard way to get an OS-assigned free port.
///
/// This is not a reservation: another process can take the port during the gap. That window is
/// why the engine start loop retries rather than treating one failed bind as fatal.
/// </summary>
public static class PortPicker
{
    /// <summary>Returns a loopback port the OS just reported as free.</summary>
    public static int PickFreeLoopbackPort()
    {
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        try
        {
            return ((IPEndPoint)listener.LocalEndpoint).Port;
        }
        finally
        {
            listener.Stop();
        }
    }
}
