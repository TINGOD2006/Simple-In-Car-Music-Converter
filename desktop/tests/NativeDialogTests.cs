namespace AudioUsbStudio.Shell.Tests;

/// <summary>
/// Only the pure half of <see cref="NativeDialog"/> is covered here. Showing a modal dialog needs
/// a real GUI session, which this environment does not have, so <c>PickFiles</c>/<c>PickFolder</c>
/// stay on Task 14's list of manually verified items.
/// </summary>
internal static class NativeDialogTests
{
    public static void Register()
    {
        Harness.Test("BuildAudioFilter offers the formats the engine claims to support", () =>
        {
            var filter = NativeDialog.BuildAudioFilter();

            foreach (var extension in new[] { "*.mp3", "*.wav", "*.flac", "*.m4a", "*.ogg" })
            {
                Harness.Assert(
                    filter.Contains(extension, StringComparison.OrdinalIgnoreCase),
                    $"the filter should offer {extension}");
            }
        });

        Harness.Test("BuildAudioFilter is a well-formed WinForms filter string", () =>
        {
            // A malformed filter does not throw — the dialog silently shows nothing selectable,
            // which looks exactly like a broken app.
            var parts = NativeDialog.BuildAudioFilter().Split('|');

            Harness.Assert(parts.Length % 2 == 0, "a filter is a sequence of label|pattern pairs");
            Harness.Assert(parts.Length >= 4, "at least one audio entry plus a fallback");

            for (var i = 0; i < parts.Length; i += 2)
            {
                Harness.Assert(!string.IsNullOrWhiteSpace(parts[i]), $"label {i / 2} is empty");
                Harness.Assert(!string.IsNullOrWhiteSpace(parts[i + 1]), $"pattern {i / 2} is empty");
            }

            Harness.Assert(parts[^1].Contains('*'), "the last pattern must let a user pick something unexpected");
        });

        Harness.Test("BuildAudioFilter lists no extension twice", () =>
        {
            var pattern = NativeDialog.BuildAudioFilter().Split('|')[1];
            var extensions = pattern
                .Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .Select(e => e.ToLowerInvariant())
                .ToArray();

            Harness.AssertEq(extensions.Length, extensions.Distinct().Count(), "no duplicate patterns");
        });

        Harness.Test("KeepAudioFiles drops anything that is not audio", () =>
        {
            var kept = NativeDialog.KeepAudioFiles(new[] { "song.mp3", "notes.txt", "track.flac", "cover.jpg" });

            Harness.AssertSeq(kept, new[] { "song.mp3", "track.flac" }, "only audio extensions survive, in order");
        });

        Harness.Test("KeepAudioFiles is case insensitive about the extension", () =>
        {
            var kept = NativeDialog.KeepAudioFiles(new[] { "SONG.MP3", "song.WaV", "notes.TXT" });

            Harness.AssertSeq(kept, new[] { "SONG.MP3", "song.WaV" }, "extension case does not matter");
        });

        Harness.Test("KeepAudioFiles treats paths differing only in case as one file", () =>
        {
            // Windows paths are case insensitive, so these name the same file. Offering it twice
            // would render two timeline clips over one source.
            var kept = NativeDialog.KeepAudioFiles(new[] { @"C:\music\a.mp3", @"C:\music\b.mp3", @"c:\MUSIC\A.MP3" });

            Harness.AssertSeq(kept, new[] { @"C:\music\a.mp3", @"C:\music\b.mp3" }, "the first spelling wins");
        });

        Harness.Test("KeepAudioFiles returns an empty array for an empty input", () =>
        {
            Harness.AssertSeq(
                NativeDialog.KeepAudioFiles(Array.Empty<string>()), Array.Empty<string>(), "empty in, empty out");
        });

        Harness.Test("KeepAudioFiles ignores blank entries", () =>
        {
            var kept = NativeDialog.KeepAudioFiles(new[] { "", "   ", "a.mp3" });

            Harness.AssertSeq(kept, new[] { "a.mp3" }, "a blank path is not a file");
        });

        Harness.Test("KeepAudioFiles leaves a path with no extension alone", () =>
        {
            // A file with no extension is not audio; keeping it would hand the engine a path it
            // will refuse, producing an error the user cannot act on.
            var kept = NativeDialog.KeepAudioFiles(new[] { "README", "track.flac" });

            Harness.AssertSeq(kept, new[] { "track.flac" }, "no extension means not audio");
        });
    }
}
