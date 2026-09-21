export interface SyncSettings {
  serverUrl: string;
  token: string;
  vaultId: string;
  rootKey: string;
  deviceId: string;
  deviceName: string;
  autoSync: boolean;
  debounceSeconds: number;
  syncObsidianConfig: boolean;
  excludedPrefixes: string;
}

export interface LocalFileState {
  fileId: string;
  path: string;
  baseVersion: number;
  syncedHash: string;
  deleted: boolean;
}

export interface PluginData {
  settings: SyncSettings;
  files: Record<string, LocalFileState>;
  lastSequence: number;
  lastSuccessfulSync?: number;
  logs: SyncLogEntry[];
}

export interface SyncLogEntry {
  timestamp: number;
  level: "info" | "error";
  message: string;
}

export interface RemoteChange {
  sequence: number;
  fileId: string;
  pathKey: string;
  encryptedPath: string;
  version: number;
  deleted: boolean;
  size: number;
  modifiedMs: number;
  chunks: string[];
  deviceId: string;
}

export interface ChangesResponse {
  changes: RemoteChange[];
  nextSequence: number;
  currentSequence: number;
  hasMore: boolean;
}

export interface StateResponse {
  files: RemoteChange[];
  nextCursor: string;
  currentSequence: number;
  hasMore: boolean;
}

export interface CommitChange {
  opId: string;
  fileId: string;
  pathKey: string;
  encryptedPath: string;
  baseVersion: number;
  deleted: boolean;
  size: number;
  modifiedMs: number;
  chunks: string[];
}

export interface CommitResponse {
  sequence: number;
  applied: Array<{
    opId: string;
    fileId: string;
    version: number;
    sequence: number;
  }>;
  conflicts: Array<{
    opId: string;
    fileId: string;
    reason: string;
    current?: RemoteChange;
  }>;
}

export interface ObservedFile {
  path: string;
  hash: string;
  size: number;
  modifiedMs: number;
}
