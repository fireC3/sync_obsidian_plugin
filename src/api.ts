import { requestUrl } from "obsidian";
import { exactBuffer } from "./crypto";
import type {
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
  }

  async health(): Promise<void> {
    await this.jsonRequest("GET", "/api/v1/health", undefined, false);
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
    const response = await requestUrl({
      url: `${this.baseUrl}${this.vaultPath()}/chunks/${id}`,
      method: "PUT",
      headers: this.headers("application/octet-stream"),
      body: exactBuffer(encrypted),
      throw: false
    });
    if (response.status !== 204) {
      throw new Error(this.errorMessage(response.status, response.text));
    }
  }

  async getChunk(id: string): Promise<Uint8Array> {
    const response = await requestUrl({
      url: `${this.baseUrl}${this.vaultPath()}/chunks/${id}`,
      method: "GET",
      headers: this.headers(),
      throw: false
    });
    if (response.status !== 200) {
      throw new Error(this.errorMessage(response.status, response.text));
    }
    return new Uint8Array(response.arrayBuffer);
  }

  async commit(changes: CommitChange[]): Promise<CommitResponse> {
    return this.jsonRequest("POST", `${this.vaultPath()}/commit`, {
      deviceId: this.settings.deviceId,
      changes
    }) as Promise<CommitResponse>;
  }

  private async jsonRequest(
    method: string,
    path: string,
    body?: unknown,
    authenticated = true
  ): Promise<unknown> {
    const response = await requestUrl({
      url: `${this.baseUrl}${path}`,
      method,
      headers: authenticated ? this.headers("application/json") : {},
      body: body === undefined ? undefined : JSON.stringify(body),
      throw: false
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(this.errorMessage(response.status, response.text));
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
