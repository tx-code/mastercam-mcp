# STEP to STL on Mastercam 2027

`serve-mesh` is a local stdio MCP server for CAD meshing. It exposes
`convert_step_to_stl` and runs the Mastercam 2027 translators in a dedicated
process. The regular `serve` workflow still uses the existing live or fixture
backend for CAM tools.

## Build

Use Windows, a licensed Mastercam 2027 installation, the .NET 10 SDK, and
Node.js 22 or later. The worker builds against the SDK DLL already installed
with Mastercam.

```powershell
pnpm install --frozen-lockfile
pnpm build
$env:MASTERCAM_ROOT = 'C:\Program Files\Mastercam 2027'
dotnet build native/MastercamMcp.MeshWorker.2027/MastercamMcp.MeshWorker.2027.csproj -c Release
```

Set these variables in the MCP client process that launches
`node dist/cli.js serve-mesh`.

| Variable | Value |
| --- | --- |
| `MASTERCAM_MCP_MESH_EXE` | Absolute path to `Mastercam.exe` |
| `MASTERCAM_MCP_MESH_DLL` | Absolute path to the built `MastercamMcp.MeshWorker.dll` |
| `MASTERCAM_MCP_MESH_ROOT` | Absolute path to an existing local workspace containing the STEP files |

## Call

Close other Mastercam windows before starting a job. A job opens one STEP
file and exports one to eight tolerances in the same import session.

```json
{
  "input": "parts/example.step",
  "tolerancesMm": [0.01, 0.1]
}
```

The converter accepts relative `.step` and `.stp` inputs that resolve inside
the workspace. Each call creates a new job directory. Its receipt reports
the model units, solid and surface counts, import time, and individual STL
paths, triangle counts, exported bounds in millimeters, and native export
times. Import and export times exclude application startup.

Tolerances are requested in millimeters and converted for an inch document.
The STL files retain the native model units because STL does not encode
units. The interface checks binary record length and finite vertex values.
Qualify geometric deviation, topology, and expected model coverage
separately. Translator prompts or licensing errors may stop an automated
job. Failed job directories remain available for local diagnosis.

The worker serializes jobs within the workspace and waits for its own
Mastercam process to exit. If a server crash leaves the workspace lock,
confirm no worker is running before removing `.mastercam-mesh-worker.lock`.
