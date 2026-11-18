import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { MeshStepInput, meshStep } from "./mesh-worker.js";
import { VERSION } from "./version.js";

const handle = serveStdio(() => {
  const server = new McpServer({ name: "mastercam-mesh", version: VERSION });
  server.registerTool("convert_step_to_stl", {
    description: "Convert a workspace STEP file to binary STL at specified tolerances in a dedicated local Mastercam 2027 process. Generates a new output directory beneath the configured workspace.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: MeshStepInput
  }, async (args, ctx) => {
    try {
      const data = await meshStep(MeshStepInput.parse(args), ctx.mcpReq.signal);
      const structuredContent = { ok: true, data };
      return { structuredContent, content: [{ type: "text", text: JSON.stringify(structuredContent) }] };
    } catch (error) {
      const structuredContent = { ok: false, error: error instanceof Error ? error.message : String(error) };
      return { isError: true, structuredContent, content: [{ type: "text", text: JSON.stringify(structuredContent) }] };
    }
  });
  return server;
}, { legacy: "serve", onerror: error => console.error("[mastercam-mesh]", error.message) });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => { void handle.close(); });
}
