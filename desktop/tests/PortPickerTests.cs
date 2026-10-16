using System.Net;
using System.Net.Sockets;
using AudioUsbStudio.Shell;

namespace AudioUsbStudio.Shell.Tests;

public static class PortPickerTests
{
    public static void Register()
    {
        // The OS hands out ephemeral ports from a pool, so the only thing worth asserting
        // about repeated calls is that each answer is a usable port number at all.
        Harness.Test("PickFreeLoopbackPort stays in range across many calls", () =>
        {
            for (var i = 0; i < 20; i++)
            {
                var port = PortPicker.PickFreeLoopbackPort();
                Harness.Assert(port is >= 1 and <= 65535, $"call {i} returned an out-of-range port: {port}");
            }
        });

        // The whole point of the picker is that the engine can bind the answer. If the port
        // were still held, or invented, this bind fails — so the test binds it for real.
        Harness.Test("the returned port can be bound immediately", () =>
        {
            var port = PortPicker.PickFreeLoopbackPort();
            var listener = new TcpListener(IPAddress.Loopback, port);
            try
            {
                listener.Start();
                Harness.AssertEq(
                    ((IPEndPoint)listener.LocalEndpoint).Port,
                    port,
                    "re-bound the picked port");
            }
            finally
            {
                listener.Stop();
            }
        });
    }
}
