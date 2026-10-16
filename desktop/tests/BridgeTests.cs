using System.Text.Json;

namespace AudioUsbStudio.Shell.Tests;

/// <summary>
/// The bridge protocol is the only thing the page and the shell agree on, so every shape it can
/// receive is pinned here — including all the malformed ones. A loose parser would not fail
/// loudly; it would throw across the managed/native boundary and take the window with it.
/// </summary>
internal static class BridgeTests
{
    public static void Register()
    {
        Harness.Test("Parse understands a well-formed pick request", () =>
        {
            var request = BridgeProtocol.Parse("{\"id\":\"1\",\"type\":\"pick\",\"mode\":\"files\"}");

            Harness.Assert(request is not null, "a well-formed pick request should parse");
            Harness.AssertEq(request!.Id, "1", "id");
            Harness.AssertEq(request.Mode, "files", "mode");
            Harness.AssertEq(request.Multiple, false, "multiple defaults to false");
            Harness.AssertEq(request.Title, null, "title defaults to null");
        });

        Harness.Test("Parse carries the title and multiple through", () =>
        {
            var request = BridgeProtocol.Parse(
                "{\"id\":\"7\",\"type\":\"pick\",\"mode\":\"files\",\"title\":\"Pick audio\",\"multiple\":true}");

            Harness.Assert(request is not null, "parses");
            Harness.AssertEq(request!.Title, "Pick audio", "title");
            Harness.AssertEq(request.Multiple, true, "multiple");
        });

        Harness.Test("Parse never reports a folder pick as multiple", () =>
        {
            // A folder dialog picks one directory; carrying multiple=true past this point would
            // promise the page results it can never receive.
            var request = BridgeProtocol.Parse(
                "{\"id\":\"2\",\"type\":\"pick\",\"mode\":\"folder\",\"multiple\":true}");

            Harness.Assert(request is not null, "parses");
            Harness.AssertEq(request!.Mode, "folder", "mode");
            Harness.AssertEq(request.Multiple, false, "a folder pick is forced to single");
        });

        Harness.Test("Parse rejects a request with no id", () =>
        {
            Harness.AssertEq(
                BridgeProtocol.Parse("{\"type\":\"pick\",\"mode\":\"files\"}"), null, "missing id");
        });

        Harness.Test("Parse rejects a request with no mode", () =>
        {
            Harness.AssertEq(
                BridgeProtocol.Parse("{\"id\":\"1\",\"type\":\"pick\"}"), null, "missing mode");
        });

        Harness.Test("Parse rejects an unknown mode", () =>
        {
            Harness.AssertEq(
                BridgeProtocol.Parse("{\"id\":\"1\",\"type\":\"pick\",\"mode\":\"songs\"}"), null,
                "unknown mode");
        });

        Harness.Test("Parse ignores a message that is not a pick", () =>
        {
            // Anything else on the channel belongs to a future feature; swallowing it here would
            // make that feature silently do nothing.
            Harness.AssertEq(
                BridgeProtocol.Parse("{\"id\":\"1\",\"type\":\"render\",\"mode\":\"files\"}"), null,
                "a non-pick message");
        });

        Harness.Test("Parse returns null for junk instead of throwing", () =>
        {
            Harness.AssertEq(BridgeProtocol.Parse("not json at all"), null, "not JSON");
            Harness.AssertEq(BridgeProtocol.Parse(""), null, "empty string");
            Harness.AssertEq(BridgeProtocol.Parse(null!), null, "null input");
            Harness.AssertEq(BridgeProtocol.Parse("[]"), null, "an array, not an object");
            Harness.AssertEq(BridgeProtocol.Parse("{\"id\":42,\"type\":\"pick\",\"mode\":\"files\"}"), null,
                "a numeric id is not a string id");
        });

        Harness.Test("SuccessJson carries the chosen paths and marks the reply ok", () =>
        {
            var json = BridgeProtocol.SuccessJson("1", new[] { @"C:\music\a.mp3" });
            using var doc = JsonDocument.Parse(json);

            Harness.AssertEq(doc.RootElement.GetProperty("id").GetString(), "1", "id echoed back");
            // The page resolves a pick only when it can see this flag. It was missing here
            // while the page-side test asserted it, so neither suite could catch the drift:
            // every finished folder pick looked like a broken bridge, and the page opened the
            // engine's folder dialog on top of the shell's.
            Harness.Assert(doc.RootElement.TryGetProperty("ok", out var ok), "ok present");
            Harness.AssertEq(ok.GetBoolean(), true, "a selection is a success");
            Harness.Assert(doc.RootElement.TryGetProperty("paths", out var paths), "paths present");
            Harness.AssertEq(paths.GetArrayLength(), 1, "one path");
            Harness.AssertEq(paths[0].GetString(), @"C:\music\a.mp3", "path value");
        });

        Harness.Test("SuccessJson can report an empty selection", () =>
        {
            var json = BridgeProtocol.SuccessJson("9", Array.Empty<string>());
            using var doc = JsonDocument.Parse(json);

            Harness.AssertEq(doc.RootElement.GetProperty("paths").GetArrayLength(), 0, "no paths");
        });

        Harness.Test("CancelledJson is distinguishable from an error", () =>
        {
            // The page ignores a cancellation silently and shows an error. If the two replies were
            // shaped alike, cancelling a dialog would pop an error banner.
            var cancelled = BridgeProtocol.CancelledJson("1");
            var error = BridgeProtocol.ErrorJson("1", "the dialog could not be shown");

            using var cancelledDoc = JsonDocument.Parse(cancelled);
            using var errorDoc = JsonDocument.Parse(error);

            Harness.Assert(cancelledDoc.RootElement.GetProperty("cancelled").GetBoolean(),
                "cancelled is true");
            Harness.Assert(!cancelledDoc.RootElement.TryGetProperty("error", out _),
                "a cancellation carries no error field");
            Harness.AssertEq(errorDoc.RootElement.GetProperty("error").GetString(),
                "the dialog could not be shown", "error text");
            Harness.Assert(!errorDoc.RootElement.TryGetProperty("cancelled", out _),
                "an error is not a cancellation");
            Harness.Assert(!cancelledDoc.RootElement.GetProperty("ok").GetBoolean(),
                "a cancellation is not a success");
            Harness.Assert(!errorDoc.RootElement.GetProperty("ok").GetBoolean(),
                "an error is not a success");
            Harness.Assert(cancelled != error, "the two replies must not be identical");
        });

        Harness.Test("every reply tells the page whether it succeeded", () =>
        {
            // The page classifies a reply by `ok` before anything else, so a reply that is
            // missing the flag — or carries the wrong one — is read as "the bridge is broken".
            // That is how a successful folder pick once turned into a second folder window.
            foreach (var json in new[]
                     {
                         BridgeProtocol.SuccessJson("1", new[] { @"C:\a.mp3" }),
                         BridgeProtocol.CancelledJson("1"),
                         BridgeProtocol.ErrorJson("1", "boom"),
                     })
            {
                using var doc = JsonDocument.Parse(json);
                Harness.Assert(doc.RootElement.TryGetProperty("ok", out _), $"ok missing from {json}");
            }

            Harness.Assert(
                BridgeProtocol.SuccessJson("abc", Array.Empty<string>()).Contains("\"ok\":true"),
                "a success writes ok:true, which is what the page looks for");
            Harness.Assert(
                !BridgeProtocol.CancelledJson("abc").Contains("\"ok\":true"),
                "a cancellation must not look like a success");
            Harness.Assert(
                !BridgeProtocol.ErrorJson("abc", "boom").Contains("\"ok\":true"),
                "an error must not look like a success");
        });

        Harness.Test("every reply echoes the request id", () =>
        {
            Harness.Assert(BridgeProtocol.SuccessJson("abc", Array.Empty<string>()).Contains("\"abc\""),
                "success echoes the id");
            Harness.Assert(BridgeProtocol.CancelledJson("abc").Contains("\"abc\""),
                "cancelled echoes the id");
            Harness.Assert(BridgeProtocol.ErrorJson("abc", "boom").Contains("\"abc\""),
                "error echoes the id");
        });

        Harness.Test("paths survive JSON escaping", () =>
        {
            // Windows paths are full of backslashes; a hand-rolled serializer would produce
            // invalid JSON here and the page would fail to parse a perfectly good selection.
            var messy = @"C:\od d\quote""name\back\slash.mp3";
            var json = BridgeProtocol.SuccessJson("1", new[] { messy });
            using var doc = JsonDocument.Parse(json);

            Harness.AssertEq(doc.RootElement.GetProperty("paths")[0].GetString(), messy, "path round-trips");
        });
    }
}
