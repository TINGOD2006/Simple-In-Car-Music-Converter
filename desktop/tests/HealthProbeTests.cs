using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Text;
using AudioUsbStudio.Shell;

namespace AudioUsbStudio.Shell.Tests;

public static class HealthProbeTests
{
    public static void Register()
    {
        Harness.Test("WaitAsync returns true once the engine answers", async () =>
        {
            var (listener, port) = StartStub();
            var serve = Serve(listener, 200);
            try
            {
                var healthy = await HealthProbe.WaitAsync(
                    $"http://127.0.0.1:{port}",
                    TimeSpan.FromSeconds(5),
                    TimeSpan.FromMilliseconds(50));

                Harness.Assert(healthy, "a listening engine should be reported healthy");
            }
            finally
            {
                await Shutdown(listener, serve);
            }
        });

        // A single-shot probe would pass the test above too, so this one starts the probe while
        // nothing is listening and only brings the stub up afterwards. Passing proves the
        // implementation polls rather than checking once.
        Harness.Test("WaitAsync keeps polling until the engine appears", async () =>
        {
            var port = PortPicker.PickFreeLoopbackPort();
            var baseUrl = $"http://127.0.0.1:{port}";

            var probe = HealthProbe.WaitAsync(baseUrl, TimeSpan.FromSeconds(10), TimeSpan.FromMilliseconds(50));

            await Task.Delay(200);
            var listener = new TcpListener(IPAddress.Loopback, port);
            listener.Start();
            var serve = Serve(listener, 200);
            try
            {
                var healthy = await probe;
                Harness.Assert(healthy, "the probe should keep polling until the engine answers");
            }
            finally
            {
                await Shutdown(listener, serve);
            }
        });

        Harness.Test("WaitAsync gives up instead of blocking forever", async () =>
        {
            var port = PortPicker.PickFreeLoopbackPort();
            var watch = Stopwatch.StartNew();
            var healthy = await HealthProbe.WaitAsync(
                $"http://127.0.0.1:{port}",
                TimeSpan.FromMilliseconds(400),
                TimeSpan.FromMilliseconds(50));
            watch.Stop();

            Harness.Assert(!healthy, "nothing is listening, so the probe must report unhealthy");
            Harness.Assert(
                watch.Elapsed < TimeSpan.FromSeconds(2),
                $"probe took {watch.ElapsedMilliseconds} ms; the deadline was 400 ms, so it did not honour it");
        });

        // The contract says the probe never throws — the shell calls it while a splash window is
        // already on screen, so an exception here would be an invisible failure.
        Harness.Test("WaitAsync reports unhealthy for a nonsense base URL instead of throwing", async () =>
        {
            var healthy = await HealthProbe.WaitAsync(
                "definitely not a url",
                TimeSpan.FromMilliseconds(300),
                TimeSpan.FromMilliseconds(50));

            Harness.Assert(!healthy, "a malformed base URL must come back as unhealthy");
        });

        Harness.Test("WaitAsync stops early when cancelled", async () =>
        {
            var port = PortPicker.PickFreeLoopbackPort();
            using var cts = new CancellationTokenSource();
            var watch = Stopwatch.StartNew();
            var probe = HealthProbe.WaitAsync(
                $"http://127.0.0.1:{port}",
                TimeSpan.FromSeconds(10),
                TimeSpan.FromMilliseconds(50),
                cts.Token);

            await Task.Delay(150);
            cts.Cancel();
            var healthy = await probe;
            watch.Stop();

            Harness.Assert(!healthy, "a cancelled probe reports unhealthy");
            Harness.Assert(
                watch.Elapsed < TimeSpan.FromSeconds(2),
                $"cancelled probe took {watch.ElapsedMilliseconds} ms; it should have stopped near 150 ms");
        });
    }

    /// <summary>
    /// Binds an ephemeral loopback port and reports the port the OS actually chose, so the test
    /// and the server cannot disagree about which port is under test.
    /// </summary>
    private static (TcpListener Listener, int Port) StartStub()
    {
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        return (listener, ((IPEndPoint)listener.LocalEndpoint).Port);
    }

    /// <summary>
    /// Answers every request with a bare HTTP 200 until the listener is stopped.
    ///
    /// This writes HTTP by hand over a raw socket rather than using <c>HttpListener</c>. Not
    /// because HTTP is being mocked — the probe still speaks to a real server over a real
    /// socket — but because <c>HttpListener</c> goes through http.sys, which this sandbox
    /// refuses to hand a handle to (<c>HttpListenerException: 控制代碼無效</c> on Start).
    /// </summary>
    private static Task Serve(TcpListener listener, int statusCode) =>
        Task.Run(async () =>
        {
            while (true)
            {
                TcpClient client;
                try
                {
                    client = await listener.AcceptTcpClientAsync();
                }
                catch
                {
                    break; // Stop() tore the listener down; that is how this ends.
                }

                _ = Task.Run(async () =>
                {
                    try
                    {
                        using var connection = client;
                        using var stream = connection.GetStream();

                        // We never inspect the request, but reading it first keeps the client
                        // from seeing a reset instead of a response.
                        var scratch = new byte[1024];
                        try
                        {
                            await stream.ReadAsync(scratch.AsMemory(0, scratch.Length));
                        }
                        catch
                        {
                            // Peer went away; the response below is simply not delivered.
                        }

                        const string body = "ok";
                        var head =
                            $"HTTP/1.1 {statusCode} OK\r\n" +
                            "Content-Type: text/plain\r\n" +
                            $"Content-Length: {body.Length}\r\n" +
                            "Connection: close\r\n\r\n" + body;
                        await stream.WriteAsync(Encoding.ASCII.GetBytes(head));
                        await stream.FlushAsync();
                    }
                    catch
                    {
                        // A probe that already timed out and hung up is not a test failure.
                    }
                });
            }
        });

    /// <summary>
    /// Stops the listener and drains the accept loop. Both halves are defensive: this runs from a
    /// finally, and a throw here would mask the assertion the test actually cares about.
    /// </summary>
    private static async Task Shutdown(TcpListener listener, Task serve)
    {
        try
        {
            listener.Stop();
        }
        catch
        {
            // Already gone.
        }

        try
        {
            await serve;
        }
        catch
        {
            // Accept-loop failures are never what the test is asserting.
        }
    }
}
