import { strict as assert } from "node:assert";
import { mkdtemp, realpath, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspectBinaryStl, stepInWorkspace } from "../src/mesh-worker.js";

test("the mesh worker resolves inputs inside its workspace", async t => {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), "mesh-input-")));
  const input = join(workspace, "part.step");
  await writeFile(input, "fixture");
  t.after(async () => { await unlink(input); await rmdir(workspace); });
  assert.equal(await stepInWorkspace(workspace, "part.step"), input);
  await assert.rejects(stepInWorkspace(workspace, "../part.step"), /outside/);
  await assert.rejects(stepInWorkspace(workspace, input), /relative/);
});

test("the STL receipt validates length and converts inch bounds to millimeters", async t => {
  const folder = await mkdtemp(join(tmpdir(), "mesh-output-"));
  const path = join(folder, "mesh.stl");
  t.after(async () => { await unlink(path); await rmdir(folder); });
  const stl = Buffer.alloc(134);
  stl.writeUInt32LE(1, 80);
  stl.writeFloatLE(2, 84 + 12);
  stl.writeFloatLE(1, 84 + 12 + 12 + 4);
  await writeFile(path, stl);
  assert.deepEqual(await inspectBinaryStl(path, 25.4), {
    triangles: 1, bytes: 134, boundsMm: [0, 0, 0, 50.8, 25.4, 0]
  });
  await writeFile(path, stl.subarray(0, -1));
  await assert.rejects(inspectBinaryStl(path, 1), /triangle count/);
});
