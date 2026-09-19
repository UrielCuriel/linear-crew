import { createOpencodeServer } from "@opencode-ai/sdk/v2/server";

export interface ManagedServerOptions {
  hostname: string;
  port: number;
  signal?: AbortSignal;
}

export async function startManagedOpenCodeServer(options: ManagedServerOptions) {
  const password = Bun.env.OPENCODE_SERVER_PASSWORD;
  if (!isLoopback(options.hostname) && !password) {
    throw new Error("OPENCODE_SERVER_PASSWORD is required when the managed server is not bound to loopback");
  }
  assertPortAvailable(options.hostname, options.port);
  try {
    return await createOpencodeServer(options);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`OpenCode server failed to start. The unsecured-server warning is informational on loopback and is not fatal.\n${detail}`, { cause });
  }
}

function assertPortAvailable(hostname: string, port: number): void {
  let probe: Bun.TCPSocketListener<undefined> | undefined;
  try {
    probe = Bun.listen({ hostname, port, socket: { data() {} } });
  } catch (cause) {
    throw new Error(`Cannot start OpenCode: ${hostname}:${port} is already in use. Stop that server, choose --port, or use the scheduler command to connect to an existing server.`, { cause });
  } finally {
    probe?.stop(true);
  }
}

function isLoopback(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]";
}
