import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";

export interface ToolCall {
  name: string;
  arguments?: Record<string, unknown>;
}

export interface ToolCaller {
  callTool(call: ToolCall): Promise<CallToolResult>;
  ping?(): Promise<void>;
  listTools?(): Promise<Tool[]>;
}

export interface CredentialIsolatingFetchOptions {
  upstreamToken: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

export function createCredentialIsolatingFetch(
  options: CredentialIsolatingFetchOptions,
): typeof fetch {
  const fetchImpl = options.fetchImpl ?? fetch;

  return async (input, init = {}) => {
    const headers = new Headers(init.headers);
    headers.delete("X-MCP-Auth-Token");
    headers.set("Authorization", `Bearer ${options.upstreamToken}`);
    const timeoutSignal = AbortSignal.timeout(options.timeoutMs);
    const signal = init.signal
      ? AbortSignal.any([init.signal, timeoutSignal])
      : timeoutSignal;
    return fetchImpl(input, { ...init, headers, signal });
  };
}

export class OfficialWeKnoraMcpClient implements ToolCaller {
  private readonly client = new Client({
    name: "weknora-mcp-access-gateway",
    version: "0.1.0",
  });
  private readonly transport: StreamableHTTPClientTransport;
  private connected = false;

  constructor(options: {
    url: URL;
    token: string;
    timeoutMs: number;
    fetchImpl?: typeof fetch;
  }) {
    this.transport = new StreamableHTTPClientTransport(options.url, {
      fetch: createCredentialIsolatingFetch({
        upstreamToken: options.token,
        timeoutMs: options.timeoutMs,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      }),
    });
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    await this.client.connect(this.transport);
    this.connected = true;
  }

  async callTool(call: ToolCall): Promise<CallToolResult> {
    await this.connect();
    return this.client.callTool(call) as Promise<CallToolResult>;
  }

  async ping(): Promise<void> {
    await this.connect();
    await this.client.ping();
  }

  async listTools(): Promise<Tool[]> {
    await this.connect();
    return (await this.client.listTools()).tools;
  }

  async close(): Promise<void> {
    if (!this.connected) return;
    await this.client.close();
    this.connected = false;
  }
}
