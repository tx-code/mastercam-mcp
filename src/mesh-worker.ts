import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { open, readFile, realpath, stat, writeFile, mkdtemp, unlink } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import * as z from "zod/v4";

const execute = promisify(execFile);
const outputName = /^mesh-0[1-8]\.stl$/;
const finite = z.number().finite();

export const MeshStepInput = z.object({
  input: z.string().min(1).describe("STEP file path relative to the configured mesh workspace."),
  tolerancesMm: z.array(finite.positive()).min(1).max(8)
    .describe("One or more requested STL export tolerances in millimeters.")
}).strict();

const Receipt = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(false), error: z.string() }),
  z.object({
    ok: z.literal(true), modelUnits: z.enum(["mm", "inch"]), solids: z.number().int().nonnegative(),
    surfaces: z.number().int().nonnegative(), importMs: finite.nonnegative(),
    outputs: z.array(z.object({
      filename: z.string().regex(outputName), toleranceMm: finite.positive(),
      nativeTolerance: finite.positive(), exportMs: finite.nonnegative()
    })).min(1).max(8)
  })
]);

function configuredPath(name: string): string {
  const value = process.env[name];
  if (!value || !isAbsolute(value)) throw new Error(`${name} must be an absolute local path.`);
  return value;
}

export async function stepInWorkspace(workspace: string, input: string): Promise<string> {
  if (isAbsolute(input) || input.includes(":") || ![".step", ".stp"].includes(extname(input).toLowerCase()))
    throw new Error("Input must be a relative .step or .stp path.");
  const relativePath = (path: string) => relative(workspace, path);
  const isInside = (path: string) => {
    const delta = relativePath(path);
    return delta !== ".." && !delta.startsWith(`..${sep}`) && !isAbsolute(delta);
  };
  const requested = resolve(workspace, input);
  if (!isInside(requested)) throw new Error("STEP input is outside the mesh workspace.");
  const path = await realpath(requested);
  if (!isInside(path) || ![".step", ".stp"].includes(extname(path).toLowerCase()) || !(await stat(path)).isFile())
    throw new Error("STEP input must resolve to a regular STEP file inside the mesh workspace.");
  return path;
}

export async function inspectBinaryStl(path: string, millimetersPerUnit: number) {
  const file = await open(path, "r");
  try {
    const header = Buffer.alloc(84);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    if (bytesRead !== 84) throw new Error("Missing binary STL header.");
    const triangles = header.readUInt32LE(80);
    const size = (await file.stat()).size;
    if (triangles === 0 || size !== 84 + triangles * 50)
      throw new Error("STL is empty or does not match its binary triangle count.");
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    const buffer = Buffer.alloc(50 * 4096);
    for (let base = 0; base < triangles; base += 4096) {
      const count = Math.min(4096, triangles - base);
      const { bytesRead } = await file.read(buffer, 0, count * 50, 84 + base * 50);
      if (bytesRead !== count * 50) throw new Error("Truncated binary STL facet data.");
      for (let i = 0; i < count; i++) {
        for (let v = 0; v < 3; v++) {
          for (let axis = 0; axis < 3; axis++) {
            const x = buffer.readFloatLE(i * 50 + 12 + (v * 3 + axis) * 4) * millimetersPerUnit;
            if (!Number.isFinite(x)) throw new Error("STL contains a nonfinite vertex.");
            min[axis] = Math.min(min[axis]!, x);
            max[axis] = Math.max(max[axis]!, x);
          }
        }
      }
    }
    return { triangles, bytes: size, boundsMm: [...min, ...max] };
  } finally {
    await file.close();
  }
}

async function ensureMastercamClosed() {
  const tasklist = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tasklist.exe");
  const result = await execute(tasklist, ["/FI", "IMAGENAME eq Mastercam.exe", "/FO", "CSV", "/NH"],
    { timeout: 5000, windowsHide: true });
  if (/^"Mastercam\.exe",/im.test(result.stdout))
    throw new Error("Close the existing Mastercam window before starting a dedicated mesh worker.");
}

async function waitForReceipt(path: string, child: ChildProcess, signal: AbortSignal) {
  let spawnError: Error | undefined;
  child.once("error", error => { spawnError = error; });
  while (true) {
    signal.throwIfAborted();
    try {
      return Receipt.parse(JSON.parse(await readFile(path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (spawnError) throw spawnError;
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error("Mastercam exited before the worker returned a result.");
    await delay(200, undefined, { signal });
  }
}

async function closeWorker(child: ChildProcess, graceful: boolean) {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  if (graceful) {
    for (let i = 0; i < 20 && child.exitCode === null && child.signalCode === null; i++) await delay(200);
  }
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
  for (let i = 0; i < 25 && child.exitCode === null && child.signalCode === null; i++) await delay(200);
  if (child.exitCode === null && child.signalCode === null)
    throw new Error("The dedicated worker did not exit.");
}

export async function meshStep(args: z.infer<typeof MeshStepInput>, callerSignal: AbortSignal) {
  if (process.platform !== "win32") throw new Error("The Mastercam mesh worker requires Windows.");
  const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(120_000)]);
  signal.throwIfAborted();
  const workspace = await realpath(configuredPath("MASTERCAM_MCP_MESH_ROOT"));
  const mastercam = await realpath(configuredPath("MASTERCAM_MCP_MESH_EXE"));
  const addin = await realpath(configuredPath("MASTERCAM_MCP_MESH_DLL"));
  if (basename(mastercam).toLowerCase() !== "mastercam.exe" || !(await stat(mastercam)).isFile() ||
      basename(addin).toLowerCase() !== "mastercammcp.meshworker.dll" || !(await stat(addin)).isFile())
    throw new Error("Configure the Mastercam executable and the built MastercamMcp.MeshWorker.dll.");
  const input = await stepInWorkspace(workspace, args.input);
  const lockPath = join(workspace, ".mastercam-mesh-worker.lock");
  const lock = await open(lockPath, "wx").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "EEXIST") throw new Error("A mesh worker already holds this workspace lock.");
    throw error;
  });
  let child: ChildProcess | undefined;
  let complete = false;
  try {
    await lock.writeFile(String(process.pid));
    await ensureMastercamClosed();
    const job = await mkdtemp(join(workspace, "mastercam-mesh-"));
    const token = randomUUID();
    const request = join(job, "request.json");
    await writeFile(request, JSON.stringify({ token, input, tolerancesMm: args.tolerancesMm }), { flag: "wx" });
    signal.throwIfAborted();
    child = spawn(mastercam, [addin], {
      cwd: dirname(mastercam), stdio: "ignore", windowsHide: true,
      env: { ...process.env, MASTERCAM_MCP_MESH_REQUEST: request, MASTERCAM_MCP_MESH_TOKEN: token }
    });
    const receipt = await waitForReceipt(join(job, "result.json"), child, signal);
    complete = true;
    if (!receipt.ok) throw new Error(receipt.error);
    if (receipt.outputs.length !== args.tolerancesMm.length || receipt.solids + receipt.surfaces === 0)
      throw new Error("Mastercam returned an incomplete mesh receipt.");
    const scale = receipt.modelUnits === "inch" ? 25.4 : 1;
    const outputs = [];
    for (const [i, mesh] of receipt.outputs.entries()) {
      signal.throwIfAborted();
      const filename = `mesh-${String(i + 1).padStart(2, "0")}.stl`;
      if (mesh.filename !== filename || mesh.toleranceMm !== args.tolerancesMm[i])
        throw new Error("Mastercam's output does not match the requested tolerance.");
      const path = join(job, filename);
      outputs.push({ ...mesh, path, ...await inspectBinaryStl(path, scale) });
    }
    return { input, job, modelUnits: receipt.modelUnits, solids: receipt.solids, surfaces: receipt.surfaces,
      importMs: receipt.importMs, outputs };
  } finally {
    try {
      if (child) await closeWorker(child, complete);
    } finally {
      await lock.close();
      await unlink(lockPath);
    }
  }
}
