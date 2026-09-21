import { App, normalizePath } from "obsidian";
import { SyncApi } from "./api";
import { chunkRanges } from "./chunker";
import {
  concatBytes,
  createVaultCrypto,
  decryptChunk,
  decryptPath,
  encryptChunk,
  encryptPath,
  hashBytes,
  keyedId,
  pathKey,
  type VaultCrypto
} from "./crypto";
import type {
  CommitChange,
  LocalFileState,
  ObservedFile,
  PluginData,
  RemoteChange
} from "./types";

interface PendingChange {
  opId: string;
  state: LocalFileState;
  observed?: ObservedFile;
  deleted: boolean;
  previousPath?: string;
}

export class SyncEngine {
  private running = false;
  private rerunRequested = false;

  constructor(
    private readonly app: App,
    private readonly getData: () => PluginData,
    private readonly saveData: () => Promise<void>,
    private readonly report: (message: string) => void
  ) {}

  async sync(): Promise<boolean> {
    if (this.running) {
      this.rerunRequested = true;
      return false;
    }
    this.running = true;
    try {
      do {
        this.rerunRequested = false;
        await this.syncOnce();
      } while (this.rerunRequested);
    } finally {
      this.running = false;
    }
    return true;
  }

  async pullFromServer(): Promise<number> {
    if (this.running) {
      throw new Error("已有同步任务正在运行，请稍后重试");
    }
    this.running = true;
    try {
      const data = this.getData();
      validateConfiguration(data);
      const keys = await createVaultCrypto(data.settings.rootKey);
      const api = new SyncApi(data.settings);
      this.report("正在重新读取服务器上的 Vault 状态…");

      data.files = {};
      data.lastSequence = 0;
      await this.saveData();
      await this.pullAll(api, keys, data);

      const liveFiles = Object.values(data.files).filter((file) => !file.deleted).length;
      this.report(`服务器拉取完成，共连接 ${liveFiles} 个文件`);
      return liveFiles;
    } finally {
      this.running = false;
    }
  }

  async testConnection(): Promise<{ files: number; sequence: number }> {
    const data = this.getData();
    validateConfiguration(data);
    const keys = await createVaultCrypto(data.settings.rootKey);
    const api = new SyncApi(data.settings);
    await api.health();
    const state = await api.state("");
    if (state.files.length > 0) {
      const first = state.files[0];
      await decryptPath(keys, first.encryptedPath, first.pathKey);
    }
    return { files: state.files.length, sequence: state.currentSequence };
  }

  private async syncOnce(): Promise<void> {
    const data = this.getData();
    validateConfiguration(data);
    const keys = await createVaultCrypto(data.settings.rootKey);
    const api = new SyncApi(data.settings);

    this.report("正在拉取远端变更…");
    await this.pullAll(api, keys, data);

    this.report("正在扫描本地文件…");
    const observed = await this.scanLocal(data);
    const pending = this.findPending(data, observed);
    if (pending.length === 0) {
      await this.saveData();
      this.report("同步完成，没有本地变化");
      return;
    }

    this.report(`正在上传 ${pending.length} 个变化…`);
    for (let offset = 0; offset < pending.length; offset += 50) {
      await this.pushBatch(api, keys, data, pending.slice(offset, offset + 50));
      await this.saveData();
    }
    this.report("同步完成");
  }

  private async pullAll(api: SyncApi, keys: VaultCrypto, data: PluginData): Promise<void> {
    if (data.lastSequence === 0) {
      await this.bootstrapCurrentState(api, keys, data);
    }
    let hasMore = true;
    while (hasMore) {
      const response = await api.changes(data.lastSequence);
      for (const change of response.changes) {
        await this.applyRemote(api, keys, data, change);
        data.lastSequence = change.sequence;
      }
      if (response.changes.length === 0) {
        data.lastSequence = Math.max(data.lastSequence, response.nextSequence);
      }
      hasMore = response.hasMore;
      await this.saveData();
    }
  }

  private async bootstrapCurrentState(
    api: SyncApi,
    keys: VaultCrypto,
    data: PluginData
  ): Promise<void> {
    let cursor = "";
    let hasMore = true;
    while (hasMore) {
      const response = await api.state(cursor);
      for (const file of response.files) {
        await this.applyRemote(api, keys, data, file);
      }
      cursor = response.nextCursor;
      hasMore = response.hasMore;
      await this.saveData();
    }
    // Keep lastSequence at zero. Replaying the lightweight change metadata closes
    // races with commits made while the paginated state was being read. Versions
    // already loaded above are skipped without downloading their chunks again.
  }

  private async applyRemote(
    api: SyncApi,
    keys: VaultCrypto,
    data: PluginData,
    remote: RemoteChange
  ): Promise<void> {
    const decryptedPath = await decryptPath(keys, remote.encryptedPath, remote.pathKey);
    if (!isSafeRelativePath(decryptedPath)) {
      throw new Error(`服务器返回了不安全的路径：${decryptedPath}`);
    }
    const remotePath = normalizePath(decryptedPath);
    if (!this.shouldSync(remotePath, data)) {
      return;
    }

    let state = data.files[remote.fileId];
    if (state !== undefined && remote.version <= state.baseVersion) {
      return;
    }

    const localPath = state?.path ?? remotePath;
    const localExists = await this.app.vault.adapter.exists(localPath);
    const localBytes = localExists
      ? new Uint8Array(await this.app.vault.adapter.readBinary(localPath))
      : undefined;
    const localHash = localBytes === undefined ? "" : await hashBytes(localBytes);
    if (remote.deleted) {
      const localDirty =
        state === undefined
          ? localExists
          : state.deleted
            ? localExists
            : !localExists || localHash !== state.syncedHash;
      if (localDirty && localBytes !== undefined) {
        const conflictPath = await this.conflictPath(localPath, remote.deviceId);
        await this.writeFile(conflictPath, localBytes);
        this.report(`远端删除与本地修改冲突，已保留本地副本：${conflictPath}`);
      }
      if (localExists) {
        await this.app.vault.adapter.remove(localPath);
      }
      data.files[remote.fileId] = {
        fileId: remote.fileId,
        path: remotePath,
        baseVersion: remote.version,
        syncedHash: "",
        deleted: true
      };
      return;
    }

    const parts: Uint8Array[] = [];
    for (const chunkId of remote.chunks) {
      parts.push(await decryptChunk(keys, await api.getChunk(chunkId), chunkId));
    }
    const remoteBytes = concatBytes(parts);
    if (remoteBytes.length !== remote.size) {
      throw new Error(`文件 ${remotePath} 的大小与远端清单不一致`);
    }
    const remoteHash = await hashBytes(remoteBytes);
    const localDirty =
      state === undefined
        ? localExists && localHash !== remoteHash
        : state.deleted
          ? localExists && localHash !== remoteHash
          : (!localExists || localHash !== state.syncedHash) && localHash !== remoteHash;

    if (localDirty && localBytes !== undefined) {
      const conflictPath = await this.conflictPath(localPath, remote.deviceId);
      await this.writeFile(conflictPath, localBytes);
      this.report(`检测到冲突，已保留本地副本：${conflictPath}`);
    } else if (localDirty) {
      this.report(`远端修改与本地删除冲突，已保留远端版本：${remotePath}`);
    }

    if (state !== undefined && state.path !== remotePath) {
      const oldExists = await this.app.vault.adapter.exists(state.path);
      if (oldExists) {
        await this.app.vault.adapter.remove(state.path);
      }
    }
    await this.writeFile(remotePath, remoteBytes);
    state = {
      fileId: remote.fileId,
      path: remotePath,
      baseVersion: remote.version,
      syncedHash: remoteHash,
      deleted: false
    };
    data.files[remote.fileId] = state;
  }

  private async scanLocal(data: PluginData): Promise<Map<string, ObservedFile>> {
    const paths = await this.listFiles("");
    const observed = new Map<string, ObservedFile>();
    for (const rawPath of paths.sort()) {
      const path = normalizePath(rawPath);
      if (!this.shouldSync(path, data)) {
        continue;
      }
      const bytes = new Uint8Array(await this.app.vault.adapter.readBinary(path));
      const stat = await this.app.vault.adapter.stat(path);
      observed.set(path, {
        path,
        hash: await hashBytes(bytes),
        size: bytes.length,
        modifiedMs: stat?.mtime ?? Date.now()
      });
    }
    return observed;
  }

  private findPending(data: PluginData, observed: Map<string, ObservedFile>): PendingChange[] {
    const pending: PendingChange[] = [];
    const matched = new Set<string>();
    const states = Object.values(data.files);
    const byPath = new Map(states.filter((state) => !state.deleted).map((state) => [state.path, state]));

    for (const file of observed.values()) {
      let state = byPath.get(file.path);
      let previousPath: string | undefined;
      if (state === undefined) {
        state = states.find(
          (candidate) =>
            !candidate.deleted &&
            !matched.has(candidate.fileId) &&
            !observed.has(candidate.path) &&
            candidate.syncedHash === file.hash
        );
        if (state !== undefined) {
          previousPath = state.path;
          state.path = file.path;
        }
      }
      if (state === undefined) {
        state = {
          fileId: crypto.randomUUID(),
          path: file.path,
          baseVersion: 0,
          syncedHash: "",
          deleted: false
        };
        data.files[state.fileId] = state;
      }
      matched.add(state.fileId);
      if (state.syncedHash !== file.hash || previousPath !== undefined || state.deleted) {
        pending.push({
          opId: crypto.randomUUID(),
          state,
          observed: file,
          deleted: false,
          previousPath
        });
      }
    }

    for (const state of states) {
      if (
        !state.deleted &&
        this.shouldSync(state.path, data) &&
        !matched.has(state.fileId) &&
        !observed.has(state.path)
      ) {
        pending.push({ opId: crypto.randomUUID(), state, deleted: true });
      }
    }
    return pending;
  }

  private async pushBatch(
    api: SyncApi,
    keys: VaultCrypto,
    data: PluginData,
    pending: PendingChange[]
  ): Promise<void> {
    const commits: CommitChange[] = [];
    for (const item of pending) {
      const chunkIds: string[] = [];
      const chunks = new Map<string, Uint8Array>();
      if (!item.deleted && item.observed !== undefined) {
        const bytes = new Uint8Array(
          await this.app.vault.adapter.readBinary(item.observed.path)
        );
        const stat = await this.app.vault.adapter.stat(item.observed.path);
        item.observed = {
          path: item.observed.path,
          hash: await hashBytes(bytes),
          size: bytes.length,
          modifiedMs: stat?.mtime ?? Date.now()
        };
        for (const range of chunkRanges(bytes)) {
          const chunk = bytes.slice(range.start, range.end);
          const id = await keyedId(keys.indexKey, chunk);
          chunkIds.push(id);
          chunks.set(id, chunk);
        }
        const missing = await api.missingChunks([...chunks.keys()]);
        for (const id of missing) {
          const chunk = chunks.get(id);
          if (chunk === undefined) {
            throw new Error(`缺少本地块 ${id}`);
          }
          await api.putChunk(id, await encryptChunk(keys, chunk, id));
        }
      }

      commits.push({
        opId: item.opId,
        fileId: item.state.fileId,
        pathKey: await pathKey(keys, item.state.path),
        encryptedPath: await encryptPath(keys, item.state.path),
        baseVersion: item.state.baseVersion,
        deleted: item.deleted,
        size: item.observed?.size ?? 0,
        modifiedMs: item.observed?.modifiedMs ?? Date.now(),
        chunks: chunkIds
      });
    }

    const response = await api.commit(commits);
    for (const applied of response.applied) {
      const item = pending.find((candidate) => candidate.opId === applied.opId);
      if (item === undefined) {
        continue;
      }
      item.state.baseVersion = applied.version;
      item.state.deleted = item.deleted;
      item.state.syncedHash = item.deleted ? "" : item.observed?.hash ?? "";
    }

    for (const conflict of response.conflicts) {
      const item = pending.find((candidate) => candidate.opId === conflict.opId);
      if (item === undefined) {
        continue;
      }
      if (conflict.current !== undefined) {
        await this.applyRemote(api, keys, data, conflict.current);
      } else {
        await this.preserveRejectedPath(data, item, conflict.reason);
      }
    }
  }

  private async preserveRejectedPath(
    data: PluginData,
    item: PendingChange,
    reason: string
  ): Promise<void> {
    if (!item.deleted && (await this.app.vault.adapter.exists(item.state.path))) {
      const bytes = new Uint8Array(await this.app.vault.adapter.readBinary(item.state.path));
      const conflictPath = await this.conflictPath(item.state.path, "server");
      await this.writeFile(conflictPath, bytes);
      await this.app.vault.adapter.remove(item.state.path);
      delete data.files[item.state.fileId];
      this.report(`服务器拒绝路径（${reason}），内容已保留为：${conflictPath}`);
    }
  }

  private async listFiles(directory: string): Promise<string[]> {
    const listing = await this.app.vault.adapter.list(directory);
    const nested = await Promise.all(listing.folders.map((folder) => this.listFiles(folder)));
    return [...listing.files, ...nested.flat()];
  }

  private shouldSync(path: string, data: PluginData): boolean {
    const normalized = normalizePath(path);
    if (
      normalized === ".obsidian/plugins/obsidian-encrypted-sync" ||
      normalized.startsWith(".obsidian/plugins/obsidian-encrypted-sync/") ||
      normalized.startsWith(".obsidian/plugins/") ||
      normalized.startsWith(".trash/") ||
      normalized === ".DS_Store"
    ) {
      return false;
    }
    if (normalized.startsWith(".obsidian/") && !data.settings.syncObsidianConfig) {
      return false;
    }
    if (
      normalized.startsWith(".obsidian/workspace") ||
      normalized.startsWith(".obsidian/cache/")
    ) {
      return false;
    }
    const excluded = data.settings.excludedPrefixes
      .split(/[,\n]/)
      .map((value) => normalizePath(value.trim()))
      .filter(Boolean);
    return !excluded.some(
      (prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`)
    );
  }

  private async conflictPath(path: string, deviceId: string): Promise<string> {
    const dot = path.lastIndexOf(".");
    const base = dot > path.lastIndexOf("/") ? path.slice(0, dot) : path;
    const extension = dot > path.lastIndexOf("/") ? path.slice(dot) : "";
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const device = deviceId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 12) || "device";
    let candidate = `${base} (conflict ${device} ${timestamp})${extension}`;
    let counter = 2;
    while (await this.app.vault.adapter.exists(candidate)) {
      candidate = `${base} (conflict ${device} ${timestamp} ${counter})${extension}`;
      counter += 1;
    }
    return candidate;
  }

  private async writeFile(path: string, bytes: Uint8Array): Promise<void> {
    const pieces = normalizePath(path).split("/");
    pieces.pop();
    let directory = "";
    for (const piece of pieces) {
      directory = directory ? `${directory}/${piece}` : piece;
      if (!(await this.app.vault.adapter.exists(directory))) {
        await this.app.vault.adapter.mkdir(directory);
      }
    }
    await this.app.vault.adapter.writeBinary(path, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  }
}

function validateConfiguration(data: PluginData): void {
  const { settings } = data;
  if (!settings.serverUrl || !settings.token || !settings.vaultId || !settings.rootKey) {
    throw new Error("请先完整配置服务器地址、令牌、Vault ID 和根密钥");
  }
  if (!/^https:\/\//i.test(settings.serverUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(settings.serverUrl)) {
    throw new Error("远程服务器必须使用 HTTPS");
  }
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(settings.vaultId)) {
    throw new Error("Vault ID 只能包含字母、数字、连字符和下划线");
  }
}

function isSafeRelativePath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith("/") &&
    !path.includes("\0") &&
    !path.split("/").some((part) => part === ".." || part === ".")
  );
}
