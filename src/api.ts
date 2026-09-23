import { requestUrl } from "obsidian";
import type { EncryptedCredentials } from "./credentials";
import { exactBuffer } from "./crypto";
import type {
  AccountSession,
  RemoteVault,
  ChangesResponse,
  CommitChange,
  CommitResponse,
  RemoteChange,
  StateResponse,
  SyncSettings
} from "./types";

export class SyncApi {
  private readonly baseUrl: string;

  constructor(private readonly settings: SyncSettings) {
    this.baseUrl = settings.serverUrl.replace(/\/+$/, "");
    let url: URL;
    try { url = new URL(this.baseUrl); } catch { throw new Error("服务器地址无效"); }
    if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw new Error("请使用 HTTPS 服务器地址（仅本机允许 HTTP），地址不能含凭据或查询参数");
  }

  async accountLogin(username: string, password: string, register = false): Promise<AccountSession> {
    return this.jsonRequest("POST", `/api/v1/auth/${register ? "register" : "login"}`, { username, password }, false) as Promise<AccountSession>;
  }
  async listVaults(): Promise<RemoteVault[]> { return this.jsonRequest("GET", "/api/v1/vaults") as Promise<RemoteVault[]>; }
  async createVault(name: string, encryptedKey: EncryptedCredentials): Promise<RemoteVault> {
    return this.jsonRequest("POST", "/api/v1/vaults", { name, encryptedKey }) as Promise<RemoteVault>;
  }
  async logout(): Promise<void> { await this.jsonRequest("POST", "/api/v1/auth/logout"); }

  async health(): Promise<void> {
    await this.jsonRequest("GET", "/api/v1/health", undefined, false);
  }

  eventsUrl(): string {
    const url = new URL(`${this.baseUrl}${this.vaultPath()}/events`);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.toString();
  }

  async changes(after: number): Promise<ChangesResponse> {
    return this.jsonRequest(
      "GET",
      `${this.vaultPath()}/changes?after=${after}&limit=500`
    ) as Promise<ChangesResponse>;
  }

  async state(after: string): Promise<StateResponse> {
    return this.jsonRequest(
      "GET",
      `${this.vaultPath()}/state?after=${encodeURIComponent(after)}&limit=500`
    ) as Promise<StateResponse>;
  }

  async missingChunks(ids: string[]): Promise<Set<string>> {
    const missing = new Set<string>();
    for (let offset = 0; offset < ids.length; offset += 500) {
      const response = (await this.jsonRequest("POST", `${this.vaultPath()}/chunks/exists`, {
        ids: ids.slice(offset, offset + 500)
      })) as { missing: string[] };
      response.missing.forEach((id) => missing.add(id));
    }
    return missing;
  }

  async putChunk(id: string, encrypted: Uint8Array): Promise<void> {
    const response = await boundedRequest({
      url: `${this.baseUrl}${this.vaultPath()}/chunks/${id}`,
      method: "PUT",
      headers: this.headers("application/octet-stream"),
      body: exactBuffer(encrypted),
      throw: false
    });
    if (response.status !== 204) {
      throw new ApiError(response.status, this.errorMessage(response.status, response.text));
    }
  }

  async getChunk(id: string): Promise<Uint8Array> {
    const response = await boundedRequest({
      url: `${this.baseUrl}${this.vaultPath()}/chunks/${id}`,
      method: "GET",
      headers: this.headers(),
      throw: false
    });
    if (response.status !== 200) {
      throw new ApiError(response.status, this.errorMessage(response.status, response.text));
    }
    return new Uint8Array(response.arrayBuffer);
  }

  async commit(changes: CommitChange[]): Promise<CommitResponse> {
    const deviceLabel = `${this.settings.deviceName}:${this.settings.deviceId}`.slice(0, 128);
    return this.jsonRequest("POST", `${this.vaultPath()}/commit`, {
      deviceId: deviceLabel,
      changes
    }) as Promise<CommitResponse>;
  }

  private async jsonRequest(
    method: string,
    path: string,
    body?: unknown,
    authenticated = true
  ): Promise<unknown> {
    const response = await boundedRequest({
      url: `${this.baseUrl}${path}`,
      method,
      headers: authenticated ? this.headers("application/json") : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      throw: false
    });
    if (response.status < 200 || response.status >= 300) {
      throw new ApiError(response.status, this.errorMessage(response.status, response.text));
    }
    return response.json;
  }

  private headers(contentType?: string): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.settings.token}`
    };
    if (contentType !== undefined) {
      headers["Content-Type"] = contentType;
    }
    return headers;
  }

  private vaultPath(): string {
    return `/api/v1/vaults/${encodeURIComponent(this.settings.vaultId)}`;
  }

  private errorMessage(status: number, text: string): string {
    try {
      const parsed = JSON.parse(text) as { error?: string };
      return `服务器返回 ${status}: ${parsed.error ?? text}`;
    } catch {
      return `服务器返回 ${status}: ${text || "无响应内容"}`;
    }
  }
}

export function isRemoteChange(value: unknown): value is RemoteChange {
  return typeof value === "object" && value !== null && "fileId" in value;
}

// A stalled request must not permanently lock the sync queue.
async function boundedRequest(options: Parameters<typeof requestUrl>[0]): Promise<Awaited<ReturnType<typeof requestUrl>>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      requestUrl(options),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("连接超时，将自动重试")), 30000);
      })
    ]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

export class ApiError extends Error { constructor(public readonly status: number, message: string) { super(message); } }
