using System.Text.Json;

namespace AudioUsbStudio.Shell;

/// <summary>
/// A request from the page asking the shell to show a native file dialog.
/// <see cref="Mode"/> is "files" or "folder"; <see cref="Multiple"/> is always false for a folder.
/// </summary>
public sealed record PickRequest(string Id, string Mode, string? Title, bool Multiple);

/// <summary>
/// The JSON shapes exchanged on the WebView2 message channel.
///
/// Every reply echoes the request id, because the page may have several dialogs in flight and has
/// no other way to pair a reply with its request. Cancellation and failure are deliberately
/// different shapes: the page ignores a cancellation and shows an error, so a cancel that looked
/// like an error would pop a banner every time someone closed a dialog.
/// </summary>
public static class BridgeProtocol
{
    /// <summary>
    /// Parses a message from the page. Returns null for anything that is not a well-formed
    /// <c>pick</c> request — a malformed message is not worth an exception thrown across the
    /// managed/native boundary.
    /// </summary>
    public static PickRequest? Parse(string json)
    {
        if (string.IsNullOrWhiteSpace(json)) return null;

        try
        {
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;

            if (root.ValueKind != JsonValueKind.Object) return null;

            // Anything that is not a pick belongs to a message type this build does not know.
            // Rejecting it here keeps a future message from being silently half-handled.
            if (!TryGetString(root, "type", out var type) || !string.Equals(type, "pick", StringComparison.Ordinal))
            {
                return null;
            }

            if (!TryGetString(root, "id", out var id) || string.IsNullOrEmpty(id)) return null;
            if (!TryGetString(root, "mode", out var mode)) return null;
            if (mode is not ("files" or "folder")) return null;

            var title = TryGetString(root, "title", out var parsedTitle) ? parsedTitle : null;

            // A folder dialog picks exactly one directory, so a page asking for multiple folders
            // would be promised results that can never arrive.
            var multiple = mode == "files"
                           && root.TryGetProperty("multiple", out var m)
                           && m.ValueKind == JsonValueKind.True;

            return new PickRequest(id, mode, title, multiple);
        }
        catch (JsonException)
        {
            return null;
        }
        catch (Exception)
        {
            // JsonDocument can also throw for reasons that are not JSON syntax (for example a
            // depth or size limit). The page must not be able to crash the shell with a message.
            return null;
        }
    }

    /// <summary>
    /// Reports the chosen paths. An empty list means the dialog returned nothing.
    ///
    /// <c>ok</c> is not decoration. The page resolves a pick only when it can see that the host
    /// succeeded; a success reply without this flag was classified as a failure, so the page
    /// escalated to the engine's own folder dialog and the user was left with a second window
    /// stacked on the one they had just answered — "I have to choose the folder twice".
    /// </summary>
    public static string SuccessJson(string id, IReadOnlyList<string> paths) => Write(writer =>
    {
        writer.WriteString("id", id);
        writer.WriteBoolean("ok", true);
        writer.WriteStartArray("paths");
        foreach (var path in paths) writer.WriteStringValue(path);
        writer.WriteEndArray();
    });

    /// <summary>Reports that the user closed the dialog. The page stays silent.</summary>
    public static string CancelledJson(string id) => Write(writer =>
    {
        writer.WriteString("id", id);
        // Stated rather than implied by the absence of `ok`: a reply the page cannot classify
        // becomes an error banner, and cancelling a dialog is not an error.
        writer.WriteBoolean("ok", false);
        writer.WriteBoolean("cancelled", true);
    });

    /// <summary>Reports that the dialog could not be shown. The page shows this text.</summary>
    public static string ErrorJson(string id, string message) => Write(writer =>
    {
        writer.WriteString("id", id);
        writer.WriteBoolean("ok", false);
        writer.WriteString("error", message);
    });

    /// <summary>
    /// Builds a reply with <see cref="Utf8JsonWriter"/> rather than string interpolation. Windows
    /// paths are full of backslashes and can contain quotes; hand-rolled JSON would produce
    /// something the page cannot parse, for a selection that was perfectly valid.
    /// </summary>
    private static string Write(Action<Utf8JsonWriter> body)
    {
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream))
        {
            writer.WriteStartObject();
            body(writer);
            writer.WriteEndObject();
        }

        return System.Text.Encoding.UTF8.GetString(stream.ToArray());
    }

    private static bool TryGetString(JsonElement root, string name, out string value)
    {
        value = string.Empty;
        if (!root.TryGetProperty(name, out var property)) return false;
        if (property.ValueKind != JsonValueKind.String) return false;
        value = property.GetString() ?? string.Empty;
        return true;
    }
}
