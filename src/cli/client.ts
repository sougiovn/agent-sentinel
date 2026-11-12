import type { RpcMethod, RpcMethods, RpcResponse } from "../daemon/protocol.ts";

export class DaemonUnavailableError extends Error {
  constructor() {
    super("Sentinel daemon is not running. Start it with `sentinel`.");
  }
}

export class Client {
  constructor(private socket: string) {}

  async call<M extends RpcMethod>(method: M, params: RpcMethods[M][0], timeoutMs = 120_000): Promise<RpcMethods[M][1]> {
    let res: Response;
    try {
      res = await fetch("http://sentinel/rpc", {
        method: "POST",
        unix: this.socket,
        body: JSON.stringify({ method, params }),
        headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      } as RequestInit);
    } catch (e) {
      if ((e as Error).name === "TimeoutError") throw e;
      throw new DaemonUnavailableError();
    }
    const body = (await res.json()) as RpcResponse<M>;
    if (!body.ok) throw new Error(body.error);
    return body.result;
  }

  async alive(): Promise<boolean> {
    try {
      await this.call("status", {}, 2000);
      return true;
    } catch {
      return false;
    }
  }
}
