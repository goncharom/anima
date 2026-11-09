import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type JsonObject, type Registry, type ToolRegistration } from "@earendil-works/pi-durable";
import type { CodemodeNamespace } from "@earendil-works/pi-durable/codemode";
import { McpClient, StdioTransport, toLlmContent, type Tool } from "@earendil-works/pi-mcp";

type ServerConfig = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  enabled?: boolean;
};
type Server = {
  name: string;
  prefix: string;
  config: ServerConfig;
  client?: McpClient;
  connecting?: Promise<McpClient>;
  tools: ToolRegistration[];
};

const resultSchema = Type.Object({
  content: Type.Array(Type.Unknown()),
  structuredContent: Type.Optional(Type.Unknown()),
  isError: Type.Optional(Type.Boolean()),
}, { additionalProperties: true });

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readServers(): Promise<Server[]> {
  const path = join(homedir(), ".anima", "mcp.json");
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const config: unknown = JSON.parse(text);
  if (!object(config) || (config.mcpServers !== undefined && !object(config.mcpServers))) {
    throw new Error(`${path}: expected an object with mcpServers`);
  }
  const names = new Set<string>();
  const servers: Server[] = [];
  for (const [name, entry] of Object.entries(config.mcpServers ?? {})) {
    if (!object(entry)) throw new Error(`${path}: invalid MCP server ${name}`);
    if (entry.enabled === false) continue;
    const normalized = name.replaceAll("-", "_");
    if (!/^[A-Za-z0-9_-]+$/.test(name) || names.has(normalized)) {
      throw new Error(`${path}: invalid or colliding MCP server name ${name}`);
    }
    names.add(normalized);
    if (entry.url !== undefined || (entry.type !== undefined && entry.type !== "stdio")) {
      throw new Error(`${path}: ${name}: only local stdio MCP servers are supported`);
    }
    if (typeof entry.command !== "string" || !entry.command.trim()
      || (entry.args !== undefined && (!Array.isArray(entry.args) || !entry.args.every((arg) => typeof arg === "string")))
      || (entry.cwd !== undefined && typeof entry.cwd !== "string")
      || (entry.enabled !== undefined && typeof entry.enabled !== "boolean")
      || (entry.env !== undefined && (!object(entry.env) || !Object.values(entry.env).every((value) => typeof value === "string")))) {
      throw new Error(`${path}: ${name}: expected command, optional string args/env/cwd, and boolean enabled`);
    }
    // Leave room for tool names and a collision suffix within providers' 64-character limit.
    const namespace = normalized.length > 32 ? `${normalized.slice(0, 23)}_${hash(name)}` : normalized;
    servers.push({ name, prefix: `mcp__${namespace}__`, config: entry as ServerConfig, tools: [] });
  }
  return servers;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

/** Connect only user-configured stdio servers; register their tools for codemode discovery. */
export async function openMcp(registry: Registry, onNamespaces: (namespaces: CodemodeNamespace[]) => void) {
  const servers = await readServers();
  let closed = false;
  let closing: Promise<void> | undefined;

  function publish(): void {
    if (closed) return;
    registry.install(defineExtension({ name: "mcp", tools: servers.flatMap((server) => server.tools) }));
    onNamespaces(servers.map((server) => ({
      name: server.prefix.slice(0, -2), prefix: server.prefix,
      description: server.client?.instructions?.split("\n")[0],
      instructions: server.client?.instructions,
    })));
  }

  async function refresh(server: Server, client: McpClient): Promise<void> {
    const tools = await client.listTools();
    if (closed || server.client !== client) return;
    const baseName = (tool: Tool) => server.prefix + tool.name.replace(/[^A-Za-z0-9_]/g, "_");
    const counts = new Map<string, number>();
    for (const tool of tools) counts.set(baseName(tool), (counts.get(baseName(tool)) ?? 0) + 1);
    server.tools = tools.map((tool) => {
      const base = baseName(tool);
      const name = base.length <= 64 && counts.get(base) === 1
        ? base : `${base.slice(0, 55)}_${hash(`${server.name}\0${tool.name}`)}`;
      return defineTool({
        name,
        description: tool.description ?? tool.name,
        parameters: Type.Unsafe<Record<string, unknown>>({
          ...tool.inputSchema, type: "object", properties: tool.inputSchema.properties ?? {},
        }),
        structuredOutputSchema: resultSchema,
        deferred: true,
        replay: "unsafe",
        outputLimits: { maxBytes: 20 * 1024, maxLines: 2000 },
        execute: async (args, api, context) => {
          const client = await connect(server);
          const result = await client.callTool(tool.name, args, {
            signal: context.abortSignal,
            onProgress: (progress) => api.output(progress.message ?? `Progress ${progress.progress}`),
          });
          const { _meta, ...fullResult } = result;
          return {
            output: toLlmContent(result),
            structuredOutput: fullResult as unknown as JsonObject,
            isError: result.isError === true,
          };
        },
      });
    });
    publish();
  }

  function connect(server: Server): Promise<McpClient> {
    if (closed) return Promise.reject(new Error("MCP is closed"));
    if (server.client?.connectionState === "connected") return Promise.resolve(server.client);
    return server.connecting ??= (async () => {
      await server.client?.close();
      if (closed) throw new Error("MCP is closed");
      const client = new McpClient({ name: "anima", version: "1.0.0" });
      server.client = client;
      try {
        await client.connect(new StdioTransport({ ...server.config, stderr: "inherit" }));
        client.onNotification("notifications/tools/list_changed", () => {
          void refresh(server, client).catch((error) => console.error(`MCP ${server.name}: tool refresh failed:`, error));
        });
        await refresh(server, client);
        return client;
      } catch (error) {
        await client.close();
        throw new Error(`MCP ${server.name}: connection failed`, { cause: error });
      }
    })().finally(() => { server.connecting = undefined; });
  }

  function close(): Promise<void> {
    closed = true;
    return closing ??= Promise.all(servers.map((server) => server.client?.close())).then(() => {});
  }

  try {
    await Promise.all(servers.map(connect));
    publish();
    return { close };
  } catch (error) {
    await close();
    throw error;
  }
}
