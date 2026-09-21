import { App, Modal, Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
import { generateRootKey } from "./crypto";
import { SyncEngine } from "./sync-engine";
import type { PluginData, SyncSettings } from "./types";

const DEFAULT_SETTINGS: SyncSettings = {
  serverUrl: "http://127.0.0.1:8787",
  token: "",
  vaultId: "default",
  rootKey: "",
  deviceId: "",
  autoSync: true,
  debounceSeconds: 30,
  syncObsidianConfig: false,
  excludedPrefixes: ""
};

export default class EncryptedSyncPlugin extends Plugin {
  data: PluginData = {
    settings: { ...DEFAULT_SETTINGS },
    files: {},
    lastSequence: 0
  };

  private engine!: SyncEngine;
  private debounceTimer?: number;

  async onload(): Promise<void> {
    const saved = (await this.loadData()) as Partial<PluginData> | null;
    this.data = {
      settings: { ...DEFAULT_SETTINGS, ...saved?.settings },
      files: saved?.files ?? {},
      lastSequence: saved?.lastSequence ?? 0
    };
    if (!this.data.settings.deviceId) {
      this.data.settings.deviceId = crypto.randomUUID();
    }
    if (!this.data.settings.rootKey) {
      this.data.settings.rootKey = generateRootKey();
    }
    await this.persist();

    this.engine = new SyncEngine(
      this.app,
      () => this.data,
      () => this.persist(),
      (message) => new Notice(message, 5000)
    );

    this.addRibbonIcon("refresh-cw", "加密同步", () => void this.runSync());
    this.addCommand({
      id: "sync-now",
      name: "立即执行加密同步",
      callback: () => void this.runSync()
    });
    this.addSettingTab(new SyncSettingTab(this));

    const schedule = (): void => this.scheduleSync();
    this.registerEvent(this.app.vault.on("create", schedule));
    this.registerEvent(this.app.vault.on("modify", schedule));
    this.registerEvent(this.app.vault.on("delete", schedule));
    this.registerEvent(this.app.vault.on("rename", schedule));
    this.registerInterval(window.setInterval(() => this.scheduleSync(), 5 * 60 * 1000));

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

  scheduleSync(seconds = this.data.settings.debounceSeconds): void {
    if (!this.data.settings.autoSync || !this.data.settings.token) {
      return;
    }
    if (this.debounceTimer !== undefined) {
      window.clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = window.setTimeout(() => void this.runSync(), Math.max(1, seconds) * 1000);
  }

  async runSync(): Promise<void> {
    try {
      await this.engine.sync();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Encrypted Sync failed", error);
      new Notice(`同步失败：${message}`, 10000);
    }
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

    new Setting(containerEl)
      .setName("服务器地址")
      .setDesc("公网地址必须使用 HTTPS")
      .addText((text) =>
        text
          .setPlaceholder("https://backup.example.com")
          .setValue(settings.serverUrl)
          .onChange(async (value) => {
            settings.serverUrl = value.trim();
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
      .setName("Vault ID")
      .setDesc("同一个 Vault 的所有设备必须完全一致")
      .addText((text) =>
        text.setValue(settings.vaultId).onChange(async (value) => {
          settings.vaultId = value.trim();
          await this.plugin.persist();
        })
      );

    new Setting(containerEl)
      .setName("Vault 根密钥")
      .setDesc("同一 Vault 的设备使用相同密钥；服务器无法恢复此密钥")
      .setClass("encrypted-sync-secret")
      .addText((text) => {
        text.inputEl.type = "password";
        return text.setValue(settings.rootKey).onChange(async (value) => {
          settings.rootKey = value.trim();
          await this.plugin.persist();
        });
      })
      .addButton((button) =>
        button
          .setButtonText("生成新密钥")
          .setWarning()
          .onClick(() =>
            new KeyRotationModal(this.app, async () => {
              settings.rootKey = generateRootKey();
              this.plugin.data.files = {};
              this.plugin.data.lastSequence = 0;
              await this.plugin.persist();
              this.display();
              new Notice(
                "已生成新密钥。请立即安全备份；已有远端数据将无法用新密钥读取。",
                12000
              );
            }).open()
          )
      );

    containerEl.createDiv({
      cls: "encrypted-sync-warning",
      text: "根密钥丢失后无法恢复数据。不要通过同步服务器传递根密钥。"
    });

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

    new Setting(containerEl).setName("设备 ID").setDesc(settings.deviceId);
  }
}

class KeyRotationModal extends Modal {
  constructor(
    app: App,
    private readonly confirmRotation: () => Promise<void>
  ) {
    super(app);
  }

  onOpen(): void {
    this.contentEl.createEl("h2", { text: "确认生成新的根密钥？" });
    this.contentEl.createEl("p", {
      text: "新密钥无法解密服务器上的现有数据。只有在创建全新 Vault 或确认旧数据不再需要时才应继续。"
    });
    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText("取消").onClick(() => this.close()))
      .addButton((button) =>
        button
          .setButtonText("确认生成")
          .setWarning()
          .onClick(async () => {
            await this.confirmRotation();
            this.close();
          })
      );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
