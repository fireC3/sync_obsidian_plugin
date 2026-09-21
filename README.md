# Encrypted Sync for Obsidian

一个与 `ObsidianBackupServer` 配套的多端同步插件。首版提供客户端加密、内容定义分块、增量变更、删除/重命名传播和安全冲突副本。

## 数据处理

- 4 MiB 以下文件作为单块处理。
- 大文件使用约 1 MiB 平均块大小的 FastCDC 风格内容定义分块。
- 块 ID 是 Vault 独立的 HMAC-SHA-256，不把普通明文哈希交给服务器。
- 路径和内容使用 HKDF 派生的 AES-256-GCM 密钥加密。
- 插件目录、缓存、工作区状态和 `.trash` 默认排除。
- 本地元信息只是缓存；新设备可从服务器重建。

## 构建

```bash
npm install
npm run build
```

把下列文件复制到 Vault 的 `.obsidian/plugins/obsidian-encrypted-sync/`：

```text
main.js
manifest.json
styles.css
```

也可以把本仓库直接放入该目录构建。

## 首次配置

1. 填写 HTTPS 服务器地址和服务令牌。
2. 为同一知识库设置相同的 Vault ID。
3. 第一台设备自动生成根密钥；安全备份后手工传递给其他设备。
4. 手动执行一次“立即执行加密同步”。

切勿在已有远端数据的情况下随意生成新根密钥。当前版本尚未提供二维码配对和密钥轮换。

## 首版限制

- 一个服务令牌可访问所有 Vault，尚无分设备撤销。
- 插件元信息暂存在 `data.json`，超大 Vault 后续应迁移到分片索引。
- 冲突以副本保留，尚未做 Markdown 三方自动合并。
- 浏览器/Obsidian API 需要把单个文件读入内存后分块。
- 尚无服务端垃圾回收、可视化历史恢复和密钥配对流程。
- 这是可运行原型，正式存放唯一数据前需要安全审计和恢复演练。
