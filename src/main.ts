import { App, Modal, Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
import { generateRootKey } from "./crypto";
import { SyncEngine } from "./sync-engine";
import type { PluginData, SyncLogEntry, SyncSettings } from "./types";

const DEFAULT_SETTINGS: SyncSettings = {
  serverUrl: "http://127.0.0.1:8787",
  token: "",
  vaultId: "default",
  rootKey: "",
  deviceId: "",
  deviceName: "",
  autoSync: true,
  debounceSeconds: 30,
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

  private engine!: SyncEngine;
  private debounceTimer?: number;
  private statusBarEl!: HTMLElement;

  async onload(): Promise<void> {
    const saved = (await this.loadData()) as Partial<PluginData> | null;
    this.data = {
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
    if (!this.data.settings.rootKey) {
      this.data.settings.rootKey = generateRootKey();
    }

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
      id: "pull-from-server",
      name: "从服务器重新拉取 Vault",
      callback: () => this.confirmPullFromServer()
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
    this.registerInterval(window.setInterval(() => this.scheduleSync(), 5 * 60 * 1000));

    await this.persist();
    if (this.data.settings.autoSync && this.data.settings.token) {
      this.app.workspace.onLayoutReady(() => this.scheduleSync(2));
    }
  }

  onunload(): void {
    if (this.debounceTimer !== undefined) {
      window.clearTimeout(this.debounceTimer);
    }
  }

  async persist(): Promise<void> {
    await this.saveData(this.data);
  }

  resetConnectionState(): void {
    this.data.files = {};
    this.data.lastSequence = 0;
  }

  scheduleSync(seconds = this.data.settings.debounceSeconds): void {
    if (!this.data.settings.autoSync || !this.data.settings.token) {
      return;
    }
    if (this.debounceTimer !== undefined) {
      window.clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = window.setTimeout(
      () => void this.runSync(false),
      Math.max(1, seconds) * 1000
    );
  }

  async runSync(manual: boolean): Promise<void> {
    this.setStatus("↻ 正在同步", "running");
    this.recordLog(manual ? "开始手动双向同步" : "开始自动双向同步");
    try {
      const completed = await this.engine.sync();
      if (!completed) {
        this.recordLog("已有同步正在运行，本次请求已排队");
        return;
      }
      this.data.lastSuccessfulSync = Date.now();
      this.recordLog("✓ 已完全同步");
      this.updateIdleStatus();
      if (manual) {
        new Notice("加密同步完成", 5000);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.recordLog(`同步失败：${message}`, "error");
      this.setStatus("⚠ 同步失败", "error");
      new Notice(`同步失败：${message}`, 10000);
    } finally {
      await this.persist();
    }
  }

  async runPullFromServer(): Promise<void> {
    this.setStatus("↓ 正在从服务器拉取", "running");
    this.recordLog("开始从服务器重新拉取 Vault");
    try {
      const files = await this.engine.pullFromServer();
      this.data.lastSuccessfulSync = Date.now();
      this.recordLog(`✓ 服务器拉取完成，远端当前包含 ${files} 个文件`);
      this.updateIdleStatus();
      new Notice(`服务器拉取完成：${files} 个文件`, 7000);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.recordLog(`服务器拉取失败：${message}`, "error");
      this.setStatus("⚠ 拉取失败", "error");
      new Notice(`服务器拉取失败：${message}`, 10000);
    } finally {
      await this.persist();
    }
  }

  async testConnection(): Promise<void> {
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

  confirmPullFromServer(): void {
    new ConfirmActionModal(
      this.app,
      "从服务器重新拉取 Vault？",
      "插件会重建本地同步索引并下载服务器当前状态。本地不同内容会保存为冲突副本，不会静默丢弃。",
      "开始拉取",
      () => this.runPullFromServer()
    ).open();
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

  private updateIdleStatus(): void {
    if (!this.data.settings.token) {
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

  display(): void {
    const { containerEl } = this;
    const settings = this.plugin.data.settings;
    containerEl.empty();

    new Setting(containerEl).setName("远端 Vault 连接").setHeading();

    new Setting(containerEl)
      .setName("服务器地址")
      .setDesc("公网地址必须使用 HTTPS；地址末尾不需要 /api/v1")
      .addText((text) =>
        text
          .setPlaceholder("https://backup.example.com")
          .setValue(settings.serverUrl)
          .onChange(async (value) => {
            settings.serverUrl = value.trim();
            this.plugin.resetConnectionState();
            await this.plugin.persist();
          })
      );

    new Setting(containerEl)
      .setName("访问令牌")
      .setDesc("与服务器 OBS_BACKUP_TOKEN 保持一致")
      .setClass("encrypted-sync-secret")
      .addText((text) => {
        text.inputEl.type = "password";
        return text.setValue(settings.token).onChange(async (value) => {
          settings.token = value.trim();
          await this.plugin.persist();
        });
      });

    new Setting(containerEl)
      .setName("远端 Vault ID")
      .setDesc("所有需要互相同步的设备必须填写完全相同的 ID")
      .addText((text) =>
        text.setValue(settings.vaultId).onChange(async (value) => {
          settings.vaultId = value.trim();
          this.plugin.resetConnectionState();
          await this.plugin.persist();
        })
      );

    new Setting(containerEl)
      .setName("Vault 根密钥")
      .setDesc("连接已有远端 Vault 时，从第一台设备复制；服务器无法恢复此密钥")
      .setClass("encrypted-sync-secret")
      .addText((text) => {
        text.inputEl.type = "password";
        return text.setValue(settings.rootKey).onChange(async (value) => {
          settings.rootKey = value.trim();
          this.plugin.resetConnectionState();
          await this.plugin.persist();
        });
      })
      .addButton((button) =>
        button
          .setButtonText("生成新密钥")
          .setWarning()
          .onClick(() =>
            new ConfirmActionModal(
              this.app,
              "确认生成新的根密钥？",
              "新密钥无法读取当前远端 Vault。继续后请同时使用一个新的 Vault ID。",
              "确认生成",
              async () => {
                settings.rootKey = generateRootKey();
                this.plugin.resetConnectionState();
                await this.plugin.persist();
                this.display();
                new Notice("已生成新密钥，请安全备份并使用新的 Vault ID。", 10000);
              }
            ).open()
          )
      );

    containerEl.createDiv({
      cls: "encrypted-sync-warning",
      text: "根密钥丢失后无法恢复数据。不要通过同步服务器传递根密钥。"
    });

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
      .setName("从服务器重新拉取")
      .setDesc("用于新设备、索引异常或需要以远端当前状态重建本地 Vault")
      .addButton((button) =>
        button
          .setButtonText("从服务器拉取")
          .setWarning()
          .onClick(() => this.plugin.confirmPullFromServer())
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
      .setDesc("文件变化停止一段时间后开始同步")
      .addToggle((toggle) =>
        toggle.setValue(settings.autoSync).onChange(async (value) => {
          settings.autoSync = value;
          await this.plugin.persist();
        })
      );

    new Setting(containerEl)
      .setName("延迟秒数")
      .setDesc("连续编辑时重置计时，避免频繁上传")
      .addText((text) =>
        text.setValue(String(settings.debounceSeconds)).onChange(async (value) => {
          const parsed = Number.parseInt(value, 10);
          if (Number.isFinite(parsed)) {
            settings.debounceSeconds = Math.min(3600, Math.max(1, parsed));
            await this.plugin.persist();
          }
        })
      );

    new Setting(containerEl)
      .setName("同步 Obsidian 配置")
      .setDesc("同步 .obsidian 中的普通配置，但始终排除插件目录、缓存和工作区状态")
      .addToggle((toggle) =>
        toggle.setValue(settings.syncObsidianConfig).onChange(async (value) => {
          settings.syncObsidianConfig = value;
          this.plugin.data.lastSequence = 0;
          await this.plugin.persist();
        })
      );

    new Setting(containerEl)
      .setName("排除路径")
      .setDesc("逗号或换行分隔的 Vault 相对路径前缀")
      .addTextArea((text) =>
        text.setValue(settings.excludedPrefixes).onChange(async (value) => {
          settings.excludedPrefixes = value;
          this.plugin.data.lastSequence = 0;
          await this.plugin.persist();
        })
      );
  }
}

class ConfirmActionModal extends Modal {
  constructor(
    app: App,
    private readonly title: string,
    private readonly description: string,
    private readonly confirmLabel: string,
    private readonly action: () => Promise<void>
  ) {
    super(app);
  }

  onOpen(): void {
    this.contentEl.createEl("h2", { text: this.title });
    this.contentEl.createEl("p", { text: this.description });
    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText("取消").onClick(() => this.close()))
      .addButton((button) =>
        button
          .setButtonText(this.confirmLabel)
          .setWarning()
          .onClick(async () => {
            this.close();
            await this.action();
          })
      );
  }

  onClose(): void {
    this.contentEl.empty();
  }
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
