using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text.Json;
using Mastercam.App;
using Mastercam.App.Types;
using Mastercam.IO;
using Mastercam.Support;
using Mastercam.UI;

namespace MastercamMcp.MeshWorker;

public sealed class EntryPoint : NetHook3App
{
    private static System.Windows.Forms.Timer? pending;

    public override MCamReturn Run(int param)
    {
        var request = Environment.GetEnvironmentVariable("MASTERCAM_MCP_MESH_REQUEST");
        if (string.IsNullOrEmpty(request) || !File.Exists(request) || pending != null)
            return MCamReturn.NoErrors;

        // Run after the startup add-in invocation returns to Mastercam's UI loop.
        var timer = new System.Windows.Forms.Timer { Interval = 500 };
        pending = timer;
        timer.Tick += (_, _) =>
        {
            timer.Stop();
            timer.Dispose();
            RunJob(request);
        };
        timer.Start();
        return MCamReturn.NoErrors;
    }

    private static void RunJob(string request)
    {
        var folder = Path.GetDirectoryName(Path.GetFullPath(request))!;
        object result;
        var ownsDocument = false;
        try
        {
            using var json = JsonDocument.Parse(File.ReadAllText(request));
            var token = Environment.GetEnvironmentVariable("MASTERCAM_MCP_MESH_TOKEN");
            if (string.IsNullOrEmpty(token) || token != json.RootElement.GetProperty("token").GetString())
                return;
            if (SearchManager.GetSolidGeometry().Length != 0 || SearchManager.GetSurfaceGeometry().Length != 0)
                throw new InvalidOperationException("The worker does not have an empty document.");
            var input = json.RootElement.GetProperty("input").GetString()!;
            var tolerances = json.RootElement.GetProperty("tolerancesMm");
            if (tolerances.GetArrayLength() is < 1 or > 8)
                throw new ArgumentException("Expected one to eight tolerances.");

            var clock = Stopwatch.StartNew();
            ownsDocument = true;
            if (!FileManager.Open(false, input, false, false))
                throw new IOException("Mastercam could not open the STEP file.");
            var importMs = clock.Elapsed.TotalMilliseconds;
            var solids = SearchManager.GetSolidGeometry().Length;
            var surfaces = SearchManager.GetSurfaceGeometry().Length;
            if (solids + surfaces == 0)
                throw new InvalidDataException("The imported file has no solids or surfaces.");

            var metric = SettingsManager.Metric;
            var outputs = new List<object>();
            foreach (var value in tolerances.EnumerateArray())
            {
                var toleranceMm = value.GetDouble();
                if (!double.IsFinite(toleranceMm) || toleranceMm <= 0)
                    throw new ArgumentException("Tolerance must be positive and finite.");
                var filename = $"mesh-{outputs.Count + 1:D2}.stl";
                var target = Path.Combine(folder, filename);
                if (File.Exists(target)) throw new IOException("An output STL already exists.");

                var nativeTolerance = metric ? toleranceMm : toleranceMm / 25.4;
                clock.Restart();
                if (!FileManager.WriteSTL(target, 0, nativeTolerance, false, true, false, false, false))
                    throw new IOException("Mastercam could not write the STL.");
                outputs.Add(new { filename, toleranceMm, nativeTolerance, exportMs = clock.Elapsed.TotalMilliseconds });
            }
            result = new { ok = true, modelUnits = metric ? "mm" : "inch", solids, surfaces, importMs, outputs };
        }
        catch (Exception error)
        {
            result = new { ok = false, error = error.Message };
        }
        finally
        {
            // The parent only starts this add-in in its own empty process.
            if (ownsDocument)
            {
                try { FileManager.New(false, false); }
                catch { /* The parent still owns and reaps this process. */ }
            }
        }

        var temporary = Path.Combine(folder, "result.json.tmp");
        File.WriteAllText(temporary, JsonSerializer.Serialize(result));
        File.Move(temporary, Path.Combine(folder, "result.json"));
        var window = MastercamWindow.GetHandle();
        if (window != null) PostMessage(window.Handle, 0x0010, IntPtr.Zero, IntPtr.Zero);
    }

    [DllImport("user32.dll", EntryPoint = "PostMessageW")]
    private static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
}
