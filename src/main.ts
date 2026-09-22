import { App, Modal, Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
import { SyncApi, ApiError } from "./api";
import type { Credentials } from "./credentials";
import { createProtection, openCredentials, sealCredentials } from "./credentials";
import { generateRootKey } from "./crypto";
import { SyncEngine } from "./sync-engine";
import type { AccountSession, RemoteVault, PluginData, SyncLogEntry, SyncSettings } from "./types";

const DEFAULT_SETTINGS: SyncSettings = {
  serverUrl: "http://127.0.0.1:8787",
  token: "",
  vaultId: "default",
  rootKey: "",
  deviceId: "",
  deviceName: "",
  autoSync: true,

  syncObsidianConfig: false,
  excludedPrefixes: ""
};

export default class EncryptedSyncPlugin extends Plugin {
  data: PluginData = {
    settings: { ...DEFAULT_SETTINGS },
    files: {},
    lastSequence: 0,
    logs: []
  };

  accountSession?: AccountSession;
  accountServer = "";
  remoteVaults: RemoteVault[] = [];
  private legacyCredentials?: Credentials;
  private wrappingKey?: CryptoKey;
  private wrappingSalt = "";
  private engine!: SyncEngine;
  private debounceTimer?: number;
  private syncBusy = false;
  private disposed = false;
  private retryAt = 0;
  private failures = 0;
  private saveQueue: Promise<void> = Promise.resolve();
  private statusBarEl!: HTMLElement;

  async onload(): Promise<void> {
    const saved = (await this.loadData()) as Partial<PluginData> | null;
    this.data = {
      secretId: saved?.secretId,
      encryptedCredentials: saved?.encryptedCredentials,
      account: saved?.account,
      vaultName: saved?.vaultName,
      legacyBackup: saved?.legacyBackup,
      settings: { ...DEFAULT_SETTINGS, ...saved?.settings },
      files: saved?.files ?? {},
      lastSequence: saved?.lastSequence ?? 0,
      lastSuccessfulSync: saved?.lastSuccessfulSync,
      logs: saved?.logs ?? []
    };
    if (!this.data.settings.deviceId) {
      this.data.settings.deviceId = crypto.randomUUID();
    }
    if (!this.data.settings.deviceName) {
      this.data.settings.deviceName = this.app.vault.getName();
    }
    // Credentials remain on disk in their old location until an explicit unlock
    // can migrate them transactionally. Never generate a replacement for a lost key.
    this.data.settings.token = "";
    this.data.settings.rootKey = "";
    // Drop the obsolete delay setting when migrating older installations.
    delete (this.data.settings as SyncSettings & { debounceSeconds?: number }).debounceSeconds;

    this.engine = new SyncEngine(
      this.app,
      () => this.data,
      () => this.persist(),
      (message) => this.recordLog(message)
    );

    this.addRibbonIcon("refresh-cw", "立即双向同步", () => void this.runSync(true));
    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass("encrypted-sync-status");
    this.registerDomEvent(this.statusBarEl, "click", () => void this.runSync(true));
    this.updateIdleStatus();

    this.addCommand({
      id: "sync-now",
      name: "立即双向同步",
      callback: () => void this.runSync(true)
    });
    this.addCommand({
      id: "show-sync-log",
      name: "显示同步日志",
      callback: () => this.showSyncLog()
    });
    this.addSettingTab(new SyncSettingTab(this));

    const schedule = (): void => this.scheduleSync();
    this.registerEvent(this.app.vault.on("create", schedule));
    this.registerEvent(this.app.vault.on("modify", schedule));
    this.registerEvent(this.app.vault.on("delete", schedule));
    this.registerEvent(this.app.vault.on("rename", schedule));
    // Remote checks must never be postponed by local typing.
    this.registerInterval(window.setInterval(() => {
      if (Date.now() >= this.retryAt) this.scheduleSync(0);
    }, 5000));
    const resume = (): void => { this.retryAt = 0; this.scheduleSync(0); };
    this.registerDomEvent(window, "online", resume);
    this.registerDomEvent(window, "focus", resume);
    this.registerDomEvent(document, "visibilitychange", () => {
      if (document.visibilityState === "visible") resume();
    });

    await this.persist();
    this.app.workspace.onLayoutReady(() => {
      if (!this.disposed && this.data.encryptedCredentials) new UnlockModal(this).open();
    });
  }

  onunload(): void {
    this.disposed = true;
    if (this.debounceTimer !== undefined) {
      window.clearTimeout(this.debounceTimer);
    }
  }

  get isSyncing(): boolean { return this.syncBusy; }

  get isLocked(): boolean { return !this.wrappingKey; }

  async unlock(password: string): Promise<void> {
    if (this.syncBusy) throw new Error("正在处理同步或解锁，请稍后重试");
    this.syncBusy = true;
    const previous = this.data;
    try {
      const saved = (await this.loadData()) as Partial<PluginData> | null;
      let credentials: { token: string; rootKey: string };
      if (saved?.encryptedCredentials) {
        const opened = await openCredentials(saved.encryptedCredentials, password);
        credentials = opened.credentials;
        this.wrappingKey = opened.key;
        this.wrappingSalt = opened.salt;
        if (saved.legacyBackup) this.legacyCredentials = (await openCredentials(saved.legacyBackup.encryptedCredentials, password)).credentials;
      } else {
        const protection = await createProtection(password);
        const legacy = saved?.secretId;
        const token = legacy ? this.app.secretStorage?.getSecret(`${legacy}-token`) : saved?.settings?.token;
        const rootKey = legacy ? this.app.secretStorage?.getSecret(`${legacy}-key`) : saved?.settings?.rootKey;
        if (legacy && !rootKey) throw new Error("旧密钥不可用，请恢复原密钥；不会自动生成替代密钥");
        credentials = { token: token ?? "", rootKey: rootKey || generateRootKey() };
        this.wrappingKey = protection.key;
        this.wrappingSalt = protection.salt;
      }
      this.data = { ...previous, settings: { ...previous.settings, ...credentials } };
      await this.persist();
      const verified = (await this.loadData()) as PluginData;
      if (!verified.encryptedCredentials) throw new Error("密钥密文写入验证失败");
      const reopened = await openCredentials(verified.encryptedCredentials, password);
      if (reopened.credentials.rootKey !== credentials.rootKey || reopened.credentials.token !== credentials.token) throw new Error("密钥密文校验失败");
      if (saved?.secretId) {
        // Keep the reference until both legacy entries have been removed, so a
        // crash during cleanup can resume on the next unlock.
        const storage = this.app.secretStorage as { setSecret: (id: string, value: string) => void; deleteSecret?: (id: string) => void | Promise<void> };
        for (const suffix of ["token", "key"]) {
          const id = `${saved.secretId}-${suffix}`;
          if (storage.deleteSecret) await storage.deleteSecret(id);
          else storage.setSecret(id, "");
        }
        delete this.data.secretId;
        await this.persist();
      }
      if (this.data.account && credentials.token) {
        this.accountSession = { ...this.data.account, token: credentials.token };
        this.accountServer = this.data.settings.serverUrl;
      }
      this.updateIdleStatus();
    } catch (error) {
      this.data = previous;
      this.wrappingKey = undefined;
      this.wrappingSalt = "";
      throw error;
    } finally { this.syncBusy = false; }
    this.scheduleSync(0);
  }

  async changeLocalPassword(password: string): Promise<void> {
    if (this.isLocked || this.syncBusy) throw new Error("请先解锁，并等待当前同步完成");
    this.syncBusy = true;
    const oldKey = this.wrappingKey;
    const oldSalt = this.wrappingSalt;
    try {
      const protection = await createProtection(password);
      this.wrappingKey = protection.key;
      this.wrappingSalt = protection.salt;
      await this.persist();
    } catch (error) { this.wrappingKey = oldKey; this.wrappingSalt = oldSalt; throw error; }
    finally { this.syncBusy = false; }
  }

  async persist(): Promise<void> {
    if (!this.wrappingKey) return;
    // Serialize encryption and disk writes together to preserve snapshot order.
    const key = this.wrappingKey;
    const salt = this.wrappingSalt;
    const snapshot = JSON.parse(JSON.stringify(this.data)) as PluginData;
    const credentials = { token: snapshot.settings.token, rootKey: snapshot.settings.rootKey };
    snapshot.settings.token = "";
    snapshot.settings.rootKey = "";
    const saving = this.saveQueue.catch(() => {}).then(async () => {
      snapshot.encryptedCredentials = await sealCredentials(credentials, key, salt);
      if (snapshot.legacyBackup && this.legacyCredentials) snapshot.legacyBackup.encryptedCredentials = await sealCredentials(this.legacyCredentials, key, salt);
      await this.saveData(snapshot);
      this.data.encryptedCredentials = snapshot.encryptedCredentials;
    });
    this.saveQueue = saving;
    await saving;
  }

  resetConnectionState(): void {
    this.data.files = {};
    this.data.lastSequence = 0;
  }

  scheduleSync(seconds = 1): void {
    if (this.isLocked || this.disposed || !this.data.settings.autoSync || !this.data.settings.token || !this.data.settings.rootKey) return;
    if (seconds === 0) {
      if (this.debounceTimer !== undefined) window.clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
      if (!this.syncBusy) void this.runSync(false);
      return;
    }
    // First event wins: continuous typing cannot starve uploads.
    if (this.debounceTimer !== undefined) return;
    this.debounceTimer = window.setTimeout(() => {
      this.debounceTimer = undefined;
      if (Date.now() >= this.retryAt) void this.runSync(false);
    }, seconds * 1000);
  }

  private accountApi(): SyncApi {
    if (!this.accountSession) throw new Error("请先登录账户");
    return new SyncApi({ ...this.data.settings, serverUrl: this.accountServer, token: this.accountSession.token });
  }

  async loginAccount(server: string, username: string, password: string, register: boolean): Promise<void> {
    if (this.syncBusy) throw new Error("正在同步，请稍后登录");
    this.syncBusy = true;
    try {
      const api = new SyncApi({ ...this.data.settings, serverUrl: server, token: "" });
      const session = await api.accountLogin(username.trim(), password, register);
      if (this.data.account && (this.data.account.userId !== session.userId || this.data.settings.serverUrl !== server.replace(/\/+$/, ""))) {
        this.data.settings.autoSync = false;
        await this.persist();
      }
      this.accountSession = session;
      this.accountServer = server.replace(/\/+$/, "");
      await this.refreshVaults();
    } finally { this.syncBusy = false; }
  }
  async refreshVaults(): Promise<void> {
    const session = this.accountSession;
    const vaults = await this.accountApi().listVaults();
    if (this.accountSession === session) this.remoteVaults = vaults;
  }

  async exportLegacyKey(password: string): Promise<{ path: string; vaultId: string }> {
    const saved = (await this.loadData()) as PluginData | null;
    let rootKey: string | undefined;
    let vaultId = saved?.settings.vaultId ?? "";
    if (saved?.secretId) rootKey = this.app.secretStorage?.getSecret(`${saved.secretId}-key`) ?? undefined;
    else if (saved?.legacyBackup) { rootKey = this.legacyCredentials?.rootKey; vaultId = saved.legacyBackup.vaultId; }
    else if (!saved?.account) rootKey = this.data.settings.rootKey || saved?.settings.rootKey;
    if (!rootKey) throw new Error("请先解锁旧的本地凭据；不会生成替代密钥");
    const protection = await createProtection(password);
    const encrypted = await sealCredentials({ token: "", rootKey }, protection.key, protection.salt);
    const path = `${this.app.vault.configDir}/plugins/${this.manifest.id}/legacy-key-envelope.json`;
    await this.app.vault.adapter.write(path, JSON.stringify(encrypted, null, 2));
    return { path, vaultId };
  }

  async registerVault(name: string, password: string): Promise<RemoteVault> {
    const protection = await createProtection(password);
    const encryptedKey = await sealCredentials({ token: "", rootKey: generateRootKey() }, protection.key, protection.salt);
    const vault = await this.accountApi().createVault(name.trim(), encryptedKey);
    await this.refreshVaults();
    return vault;
  }

  async connectVault(vault: RemoteVault, password: string, pullOnly: boolean): Promise<void> {
    if (!this.accountSession) throw new Error("请先登录账户");
    if (this.syncBusy) throw new Error("正在同步，请稍后切换仓库");
    this.syncBusy = true;
    const previous = this.data;
    const oldKey = this.wrappingKey; const oldSalt = this.wrappingSalt; const oldLegacy = this.legacyCredentials;
    try {
      // Fetch the authorized registry again; never accept a locally supplied owner or root key.
      const selected = (await this.accountApi().listVaults()).find(item => item.id === vault.id);
      if (!selected) throw new Error("该仓库不属于当前账户或已不可用");
      const opened = await openCredentials(selected.encryptedKey, password);
      const protection = await createProtection(password);
      const settings = { ...previous.settings, serverUrl: this.accountServer, token: this.accountSession.token, vaultId: selected.id, rootKey: opened.credentials.rootKey };
      const candidate: PluginData = { settings, files: {}, lastSequence: 0, logs: [] };
      await new SyncEngine(this.app, () => candidate, async () => {}, () => {}).testConnection();
      const changed = previous.settings.serverUrl !== settings.serverUrl || previous.settings.vaultId !== settings.vaultId || previous.account?.userId !== this.accountSession.userId;
      const saved = (await this.loadData()) as PluginData | null;
      // Preserve old pre-account credentials as an encrypted archive before retiring their store.
      let legacyBackup = previous.legacyBackup;
      if (saved?.secretId) {
        const rootKey = this.app.secretStorage?.getSecret(`${saved.secretId}-key`);
        const token = this.app.secretStorage?.getSecret(`${saved.secretId}-token`);
        if (!rootKey) throw new Error("旧密钥不可用，请先恢复旧密钥后再切换");
        this.legacyCredentials = { rootKey, token: token ?? "" };
        legacyBackup = { serverUrl: saved.settings.serverUrl, vaultId: saved.settings.vaultId, encryptedCredentials: await sealCredentials(this.legacyCredentials, protection.key, protection.salt) };
      } else if (!saved?.encryptedCredentials && saved?.settings.rootKey) {
        this.legacyCredentials = { rootKey: saved.settings.rootKey, token: saved.settings.token };
        legacyBackup = { serverUrl: saved.settings.serverUrl, vaultId: saved.settings.vaultId, encryptedCredentials: await sealCredentials(this.legacyCredentials, protection.key, protection.salt) };
      } else if (saved?.encryptedCredentials && !saved.account && !legacyBackup) {
        if (!previous.settings.rootKey) throw new Error("请先解锁本机旧凭据，再连接账户仓库");
        this.legacyCredentials = { rootKey: previous.settings.rootKey, token: previous.settings.token };
        legacyBackup = { serverUrl: previous.settings.serverUrl, vaultId: previous.settings.vaultId, encryptedCredentials: await sealCredentials(this.legacyCredentials, protection.key, protection.salt) };
      } else if (legacyBackup && !this.legacyCredentials) throw new Error("请先解锁本机旧凭据，再切换仓库");
      this.wrappingKey = protection.key; this.wrappingSalt = protection.salt;
      this.data = { ...previous, settings, legacyBackup, vaultName: selected.name, account: { userId: this.accountSession.userId, username: this.accountSession.username, expiresMs: this.accountSession.expiresMs } };
      if (changed) { this.resetConnectionState(); this.data.lastSuccessfulSync = undefined; }
      await this.persist();
      const verified = (await this.loadData()) as PluginData;
      const decoded = await openCredentials(verified.encryptedCredentials!, password);
      if (decoded.credentials.rootKey !== settings.rootKey) throw new Error("本地密文保存校验失败");
      if (verified.legacyBackup && this.legacyCredentials && (await openCredentials(verified.legacyBackup.encryptedCredentials, password)).credentials.rootKey !== this.legacyCredentials.rootKey) throw new Error("旧密钥备份校验失败");
      if (saved?.secretId) {
        const storage = this.app.secretStorage as { setSecret: (id: string, value: string) => void; deleteSecret?: (id: string) => void | Promise<void> };
        for (const suffix of ["token", "key"]) { const id = `${saved.secretId}-${suffix}`; if (storage.deleteSecret) await storage.deleteSecret(id); else storage.setSecret(id, ""); }
        delete this.data.secretId; await this.persist();
      }
    } catch (error) { this.data = previous; this.wrappingKey = oldKey; this.wrappingSalt = oldSalt; this.legacyCredentials = oldLegacy; throw error; }
    finally { this.syncBusy = false; }
    if (pullOnly) {
      this.syncBusy = true;
      // Pull-only explicitly pauses automatic uploads until the user resumes them.
      this.data.settings.autoSync = false;
      try { await this.persist(); await this.engine.pullFromServer(); this.updateIdleStatus(); }
      finally { this.syncBusy = false; }
    } else { this.data.settings.autoSync = true; await this.persist(); this.scheduleSync(0); }
  }

  async logoutAccount(): Promise<void> {
    if (this.syncBusy) throw new Error("正在同步，请稍后退出");
    const session = this.accountSession;
    await this.accountApi().logout();
    this.accountSession = undefined; this.remoteVaults = [];
    if (session?.token === this.data.settings.token) { this.data.settings.token = ""; if (this.data.account) this.data.account.expiresMs = 0; await this.persist(); }
    this.updateIdleStatus();
  }

  async runSync(manual: boolean): Promise<void> {
    if (this.isLocked) { if (manual) new UnlockModal(this).open(); return; }
    if (this.disposed || this.syncBusy || (!manual && !this.data.settings.autoSync)) return;
    this.syncBusy = true;
    this.setStatus("↻ 正在同步", "running");
    this.recordLog(manual ? "开始手动双向同步" : "开始自动双向同步");
    try {
      const completed = await this.engine.sync();
      if (!completed) {
        this.recordLog("已有同步正在运行，本次请求已排队");
        return;
      }
      this.failures = 0;
      this.retryAt = 0;
      this.data.lastSuccessfulSync = Date.now();
      this.recordLog("✓ 本轮同步完成");
      this.updateIdleStatus();
      if (manual) {
        new Notice("加密同步完成", 5000);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.recordLog(`同步失败：${message}`, "error");
      this.setStatus("⚠ 同步失败", "error");
      if (error instanceof ApiError && error.status === 401) {
        this.data.settings.autoSync = false;
        this.accountSession = undefined;
        this.data.settings.token = "";
        if (this.data.account) this.data.account.expiresMs = 0;
        this.recordLog("登录已失效，请在设置中重新登录", "error");
      }
      this.failures++;
      this.retryAt = Date.now() + Math.min(60000, 5000 * 2 ** Math.min(this.failures - 1, 4));
      if (manual) new Notice(`同步失败：${message}`, 10000);
    } finally {
      try { await this.persist(); } finally { this.syncBusy = false; }
    }
  }

  async testConnection(): Promise<void> {
    if (this.isLocked) { new UnlockModal(this).open(); return; }
    this.setStatus("… 正在测试连接", "running");
    try {
      const result = await this.engine.testConnection();
      this.recordLog(`连接成功：远端 sequence ${result.sequence}`);
      this.updateIdleStatus();
      new Notice(`连接成功，远端 sequence ${result.sequence}`, 6000);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.recordLog(`连接测试失败：${message}`, "error");
      this.setStatus("⚠ 连接失败", "error");
      new Notice(`连接测试失败：${message}`, 10000);
    } finally {
      await this.persist();
    }
  }

  showSyncLog(): void {
    new SyncLogModal(this.app, this.data.logs).open();
  }

  statusDescription(): string {
    if (this.data.lastSuccessfulSync === undefined) {
      return `尚未成功同步；本地游标 ${this.data.lastSequence}`;
    }
    return `上次成功：${new Date(this.data.lastSuccessfulSync).toLocaleString()}；本地游标 ${this.data.lastSequence}`;
  }

  private recordLog(message: string, level: SyncLogEntry["level"] = "info"): void {
    this.data.logs.push({ timestamp: Date.now(), level, message });
    this.data.logs = this.data.logs.slice(-200);
    if (level === "error") {
      console.error(`[Encrypted Sync] ${message}`);
    } else {
      console.info(`[Encrypted Sync] ${message}`);
      if (!message.startsWith("✓")) {
        this.setStatus(message, "running");
      }
    }
  }

  updateIdleStatus(): void {
    if (this.isLocked) { this.setStatus("🔒 同步已锁定，点击解锁", "idle"); return; }
    if (!this.data.settings.autoSync) {
      this.setStatus("Ⅱ 同步已暂停", "idle");
      return;
    }
    if (!this.data.settings.token || !this.data.settings.rootKey) {
      this.setStatus("○ 同步未配置", "idle");
      return;
    }
    if (this.data.lastSuccessfulSync === undefined) {
      this.setStatus("○ 等待首次同步", "idle");
      return;
    }
    const time = new Date(this.data.lastSuccessfulSync).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit"
    });
    this.setStatus(`✓ 已同步 ${time}`, "success");
  }

  private setStatus(text: string, state: "idle" | "running" | "success" | "error"): void {
    if (this.statusBarEl === undefined) {
      return;
    }
    this.statusBarEl.setText(text);
    this.statusBarEl.dataset.syncState = state;
    this.statusBarEl.setAttr("aria-label", "点击立即执行加密同步");
  }
}

class SyncSettingTab extends PluginSettingTab {
  constructor(private readonly plugin: EncryptedSyncPlugin) {
    super(plugin.app, plugin);
  }

  private syncBusyForSettings(): boolean {
    return this.plugin.isSyncing;
  }

  display(): void {
    const { containerEl } = this;
    const settings = this.plugin.data.settings;
    containerEl.empty();
    new Setting(containerEl).setName("账户与远端仓库").setHeading();
    if (this.plugin.isLocked && this.plugin.data.encryptedCredentials) {
      new Setting(containerEl).setName("解锁已保存的连接")
        .setDesc("输入本地解锁密码可恢复已有连接；密钥和登录会话仅以密文保存。")
        .addButton(button => button.setButtonText("解锁").onClick(() => new UnlockModal(this.plugin, () => this.display()).open()));
    }
    if (!this.plugin.accountSession) {
      let server = settings.serverUrl;
      let username = this.plugin.data.account?.username ?? "";
      let password = "";
      let passwordInput: HTMLInputElement;
      new Setting(containerEl).setName("服务器地址").setDesc("公网必须使用 HTTPS").addText(text => text.setValue(server).onChange(value => { server = value.trim(); }));
      new Setting(containerEl).setName("用户名").addText(text => text.setValue(username).onChange(value => { username = value.trim(); }));
      new Setting(containerEl).setName("登录密码").setDesc("注册时至少 12 个字符。登录密码不保存；仓库加密密码另行设置，不发给服务器。")
        .addText(text => { text.inputEl.type = "password"; passwordInput = text.inputEl; text.onChange(value => { password = value; }); });
      const submit = async (register: boolean): Promise<void> => {
        try { await this.plugin.loginAccount(server, username, password, register); this.display(); }
        catch (error) { new Notice(error instanceof Error ? error.message : String(error)); }
        finally { password = ""; if (passwordInput) passwordInput.value = ""; }
      };
      new Setting(containerEl)
        .addButton(button => button.setButtonText("登录").setCta().onClick(() => submit(false)))
        .addButton(button => button.setButtonText("注册账户").onClick(() => submit(true)));
      return;
    }
    new Setting(containerEl).setName(`已登录：${this.plugin.accountSession.username}`)
      .setDesc(this.plugin.accountServer)
      .addButton(button => button.setButtonText("刷新仓库").onClick(async () => {
        try { await this.plugin.refreshVaults(); this.display(); } catch (error) { new Notice(String(error)); }
      }))
      .addButton(button => button.setButtonText("退出登录").onClick(async () => {
        try { await this.plugin.logoutAccount(); this.display(); } catch (error) { new Notice(String(error)); }
      }));
    for (const vault of this.plugin.remoteVaults) {
      new Setting(containerEl).setName(vault.name)
        .setDesc(vault.id === settings.vaultId && this.plugin.accountServer === settings.serverUrl ? "当前本地仓库已连接此远端仓库" : "此仓库已注册，可连接同步或仅拉取")
        .addButton(button => button.setButtonText("连接并同步").onClick(() => new VaultPasswordModal(this.plugin, vault, false, () => this.display()).open()))
        .addButton(button => button.setButtonText("仅拉取").onClick(() => new VaultPasswordModal(this.plugin, vault, true, () => this.display()).open()));
    }
    if (!this.plugin.remoteVaults.length) containerEl.createEl("p", { text: "账户下尚无仓库，或尚未刷新列表。可以注册一个新仓库。" });
    if (this.plugin.data.secretId || this.plugin.data.legacyBackup || (!this.plugin.data.account && this.plugin.data.encryptedCredentials)) {
      new Setting(containerEl).setName("迁移旧版远端仓库")
        .setDesc("导出旧密钥的密文后，由服务器管理员把旧仓库绑定到当前账户，再刷新列表连接。")
        .addButton(button => button.setButtonText("导出密钥密文").onClick(() => new LegacyExportModal(this.plugin).open()));
    }
    let vaultName = this.app.vault.getName();
    new Setting(containerEl).setName("注册新仓库")
      .setDesc("已注册的仓库请从上方选择。同一账户不允许重复仓库名称。")
      .addText(text => text.setValue(vaultName).onChange(value => { vaultName = value.trim(); }))
      .addButton(button => button.setButtonText("创建仓库").onClick(() => new VaultPasswordModal(this.plugin, { name: vaultName }, false, () => this.display()).open()));
    if (this.plugin.isLocked || !settings.token || !settings.rootKey || !this.plugin.data.account) return;
    new Setting(containerEl).setName("本地密钥已加密保存")
      .setDesc("新连接默认用仓库加密密码保护本机凭据。可独立修改本机解锁密码；这不会修改仓库加密密码。")
      .addButton(button => button.setButtonText("修改本机解锁密码").onClick(() => new UnlockModal(this.plugin, () => this.display(), true).open()));

    new Setting(containerEl)
      .setName("设备名称")
      .setDesc(`用于服务器和同步日志；设备 ID：${settings.deviceId}`)
      .addText((text) =>
        text.setValue(settings.deviceName).onChange(async (value) => {
          settings.deviceName = value.trim() || this.app.vault.getName();
          await this.plugin.persist();
        })
      );

    new Setting(containerEl)
      .setName("连接与同步")
      .setDesc(this.plugin.statusDescription())
      .addButton((button) =>
        button.setButtonText("测试连接").onClick(() => void this.plugin.testConnection())
      )
      .addButton((button) =>
        button
          .setButtonText("立即双向同步")
          .setCta()
          .onClick(() => void this.plugin.runSync(true))
      );

    new Setting(containerEl)
      .setName("同步日志")
      .setDesc("显示最近200条客户端同步活动和错误")
      .addButton((button) =>
        button.setButtonText("查看日志").onClick(() => this.plugin.showSyncLog())
      );

    new Setting(containerEl).setName("自动与选择性同步").setHeading();

    new Setting(containerEl)
      .setName("自动同步")
      .setDesc("启动、联网和返回窗口时立即同步；持续检查远端变化。关闭后暂停自动同步。")
      .addToggle((toggle) =>
        toggle.setValue(settings.autoSync).onChange(async (value) => {
          settings.autoSync = value;
          await this.plugin.persist();
          this.plugin.updateIdleStatus();
          this.plugin.scheduleSync(0);
        })
      );

    new Setting(containerEl)
      .setName("同步 Obsidian 配置")
      .setDesc("同步 .obsidian 中的普通配置，但始终排除插件目录、缓存和工作区状态")
      .addToggle((toggle) =>
        toggle.setValue(settings.syncObsidianConfig).onChange(async (value) => {
          if (this.syncBusyForSettings()) { new Notice("正在同步，请稍后调整同步范围"); this.display(); return; }
          settings.syncObsidianConfig = value;
          this.plugin.resetConnectionState();
          await this.plugin.persist();
          this.plugin.scheduleSync(0);
        })
      );

    new Setting(containerEl)
      .setName("排除路径")
      .setDesc("逗号或换行分隔的 Vault 相对路径前缀")
      .addTextArea((text) =>
        text.setValue(settings.excludedPrefixes).onChange(async (value) => {
          if (this.syncBusyForSettings()) { new Notice("正在同步，请稍后调整同步范围"); this.display(); return; }
          settings.excludedPrefixes = value;
          this.plugin.resetConnectionState();
          await this.plugin.persist();
          this.plugin.scheduleSync(0);
        })
      );
  }
}

class LegacyExportModal extends Modal {
  constructor(private readonly plugin: EncryptedSyncPlugin) { super(plugin.app); }
  onOpen(): void {
    this.contentEl.createEl("h2", { text: "为旧仓库设置加密密码" });
    this.contentEl.createEl("p", { text: "只导出根密钥的密文，不改动旧凭据或远端数据。管理员绑定成功后，选择旧仓库并输入此密码即可继续同步。" });
    let password = ""; let confirmation = "";
    new Setting(this.contentEl).setName("仓库加密密码").addText(text => { text.inputEl.type = "password"; text.onChange(value => { password = value; }); });
    new Setting(this.contentEl).setName("确认密码").addText(text => { text.inputEl.type = "password"; text.onChange(value => { confirmation = value; }); });
    new Setting(this.contentEl).addButton(button => button.setButtonText("导出密文").onClick(async () => {
      if (password !== confirmation) { new Notice("两次密码输入不一致"); return; }
      button.setDisabled(true);
      try { const result = await this.plugin.exportLegacyKey(password); this.contentEl.empty(); this.contentEl.createEl("p", { text: `旧仓库 ID：${result.vaultId}；密文文件：${result.path}。请交给服务器管理员执行 --assign-legacy，操作说明见服务器 README。` }); }
      catch (error) { new Notice(String(error)); }
      finally { password = ""; confirmation = ""; button.setDisabled(false); }
    }));
  }
  onClose(): void { this.contentEl.empty(); }
}

class VaultPasswordModal extends Modal {
  constructor(private readonly plugin: EncryptedSyncPlugin, private readonly vault: RemoteVault | { name: string }, private readonly pullOnly: boolean, private readonly done: () => void) { super(plugin.app); }
  onOpen(): void {
    const creating = !("id" in this.vault);
    this.contentEl.createEl("h2", { text: creating ? `注册仓库：${this.vault.name}` : `连接仓库：${this.vault.name}` });
    this.contentEl.createEl("p", { text: "仓库加密密码用于保护同步密钥，不发送给服务器，也不会保存。请使用与登录密码不同的密码并自行保管。连接后，本机凭据也用此密码加密。" });
    this.contentEl.createEl("p", { text: this.pullOnly ? "只下载远端内容，保留冲突副本，并暂停自动上传。需要双向同步时再开启自动同步。" : "本地与远端文件会合并；不同内容保留冲突副本。" });
    let password = ""; let confirmation = ""; const inputs: HTMLInputElement[] = [];
    new Setting(this.contentEl).setName("仓库加密密码").addText(text => { text.inputEl.type = "password"; inputs.push(text.inputEl); text.onChange(value => { password = value; }); });
    if (creating) new Setting(this.contentEl).setName("再次输入密码").addText(text => { text.inputEl.type = "password"; inputs.push(text.inputEl); text.onChange(value => { confirmation = value; }); });
    new Setting(this.contentEl).addButton(button => button.setButtonText(creating ? "注册并同步" : this.pullOnly ? "连接并拉取" : "连接并同步").setCta().onClick(async () => {
      if (creating && password !== confirmation) { new Notice("两次密码输入不一致"); return; }
      button.setDisabled(true);
      try {
        const remote = "id" in this.vault ? this.vault : await this.plugin.registerVault(this.vault.name, password);
        await this.plugin.connectVault(remote, password, this.pullOnly);
        this.close(); this.done();
      } catch (error) { new Notice(error instanceof Error ? error.message : String(error)); this.done(); }
      finally { password = ""; confirmation = ""; inputs.forEach(input => { input.value = ""; }); button.setDisabled(false); }
    }));
  }
  onClose(): void { this.contentEl.empty(); }
}

class UnlockModal extends Modal {
  constructor(private readonly plugin: EncryptedSyncPlugin, private readonly done?: () => void, private readonly changePassword = false) { super(plugin.app); }
  onOpen(): void {
    const existing = !!this.plugin.data.encryptedCredentials && !this.changePassword;
    this.contentEl.createEl("h2", { text: existing ? "解锁同步密钥" : "设置本地解锁密码" });
    this.contentEl.createEl("p", { text: existing ? "输入本机解锁密码，解锁后自动同步。" : "密码至少 12 个字符，仅用于加密本地令牌和根密钥，不上传也不保存。请妥善保管；遗忘后需重新导入原始同步密钥。旧凭据在密文保存并验证后才会清除。" });
    let password = "";
    let confirmation = "";
    const inputs: HTMLInputElement[] = [];
    new Setting(this.contentEl).setName("解锁密码").addText(text => {
      text.inputEl.type = "password"; text.inputEl.autocomplete = existing ? "current-password" : "new-password";
      inputs.push(text.inputEl); text.onChange(value => { password = value; });
    });
    if (!existing) new Setting(this.contentEl).setName("再次输入密码").addText(text => {
      text.inputEl.type = "password"; text.inputEl.autocomplete = "new-password";
      inputs.push(text.inputEl); text.onChange(value => { confirmation = value; });
    });
    new Setting(this.contentEl).addButton(button => button.setButtonText(existing ? "解锁" : "加密保存并解锁").setCta().onClick(async () => {
      if (!existing && password !== confirmation) { new Notice("两次密码输入不一致"); return; }
      button.setDisabled(true);
      try { if (this.changePassword) await this.plugin.changeLocalPassword(password); else await this.plugin.unlock(password); this.close(); this.done?.(); }
      catch (error) { new Notice(error instanceof Error ? error.message : String(error)); }
      finally { password = ""; confirmation = ""; inputs.forEach(input => { input.value = ""; }); button.setDisabled(false); }
    }));
  }
  onClose(): void { this.contentEl.empty(); }
}

class SyncLogModal extends Modal {
  constructor(
    app: App,
    private readonly logs: SyncLogEntry[]
  ) {
    super(app);
  }

  onOpen(): void {
    this.contentEl.createEl("h2", { text: "Encrypted Sync 日志" });
    const text = this.formatLogs();
    this.contentEl.createEl("pre", {
      cls: "encrypted-sync-log",
      text: text || "尚无同步日志。"
    });
    new Setting(this.contentEl)
      .addButton((button) =>
        button.setButtonText("复制日志").onClick(async () => {
          await navigator.clipboard.writeText(text);
          new Notice("同步日志已复制");
        })
      )
      .addButton((button) => button.setButtonText("关闭").onClick(() => this.close()));
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private formatLogs(): string {
    return this.logs
      .map(
        (entry) =>
          `${new Date(entry.timestamp).toLocaleString()} [${entry.level.toUpperCase()}] ${entry.message}`
      )
      .join("\n");
  }
}
