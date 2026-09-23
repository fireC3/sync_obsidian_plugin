import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, readdir, stat, access, rm, rename } from "node:fs/promises";
import { existsSync } from 'node:fs';
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { SyncEngine } from "../src/sync-engine";
import EncryptedSyncPlugin from "../src/main";
import { generateRootKey } from "../src/crypto";
import { interceptRequest, TFile } from "obsidian";
import type { PluginData } from "../src/types";
import { RemoteNotifications } from "../src/notifications";

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function makeClient(root: string, serverUrl: string, token: string, rootKey: string, vaultId: string) {
  await mkdir(root, { recursive: true });
  const disk = (path: string) => join(root, path);
  const adapter = {
    exists: async (path: string) => access(disk(path)).then(() => true, () => false),
    readBinary: async (path: string) => { const b = await readFile(disk(path)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); },
    writeBinary: async (path: string, bytes: ArrayBuffer) => writeFile(disk(path), new Uint8Array(bytes)),
    stat: async (path: string) => { const s = await stat(disk(path)); return { mtime: s.mtimeMs }; },
    remove: async (path: string) => rm(disk(path)),
    mkdir: async (path: string) => mkdir(disk(path), { recursive: true }),
    list: async (path: string) => { const entries = await readdir(disk(path), { withFileTypes: true }); return {
      files: entries.filter(e => e.isFile()).map(e => path ? `${path}/${e.name}` : e.name),
      folders: entries.filter(e => e.isDirectory()).map(e => path ? `${path}/${e.name}` : e.name)
    }; }
  };
  const data: PluginData = { settings: { serverUrl, token, rootKey, vaultId, deviceId: crypto.randomUUID(), deviceName: root.split('/').pop()!, autoSync: true, syncObsidianConfig: false, excludedPrefixes: '' }, files: {}, lastSequence: 0, logs: [] };
  const app = { vault: { createBinary: (path: string, bytes: ArrayBuffer) => writeFile(disk(path), new Uint8Array(bytes), { flag: 'wx' }), trash: async (file: TFile) => { await mkdir(disk('.trash'), { recursive: true }); await rename(disk(file.path), disk('.trash/' + crypto.randomUUID())); }, adapter, configDir: '.obsidian', getAbstractFileByPath: (path: string) => existsSync(disk(path)) ? new TFile(path) : null, process: async (file: TFile, fn: (text: string) => string) => {
    const content = fn(await readFile(disk(file.path), 'utf8'));
    await writeFile(disk(file.path), content);
  } } };
  const engine = new SyncEngine(app as any, () => data, async () => {}, () => {});
  return { data, engine, app, root, put: (path: string, text: string) => writeFile(disk(path), text), read: (path: string) => readFile(disk(path), 'utf8'), exists: adapter.exists, remove: adapter.remove, rename: (a: string, b: string) => rename(disk(a), disk(b)) };
}

test('two vaults against the real Rust server: common sync and recovery scenarios', async t => {
  const root = await mkdtemp(join(tmpdir(), 'encrypted-sync-integration-'));
  const socket = createServer();
  await new Promise<void>(r => socket.listen(0, '127.0.0.1', r));
  const port = (socket.address() as any).port;
  await new Promise<void>(r => socket.close(() => r()));
  const url = `http://127.0.0.1:${port}`;
  const legacyToken = crypto.randomUUID();
  const server = spawn(resolve('../obsidian_sync_server/target/debug/obsidian-backup-server'), [], { env: { ...process.env, OBS_BACKUP_TOKEN: legacyToken, OBS_BACKUP_LISTEN: `127.0.0.1:${port}`, OBS_BACKUP_DATA_DIR: join(root, 'server'), RUST_LOG: 'error' }, stdio: 'ignore' });
  t.after(async () => { interceptRequest(); server.kill(); await rm(root, { recursive: true, force: true }); });
  for (let n = 0; ; n++) { try { await fetch(url + '/api/v1/health'); break; } catch (e) { if (n > 100) throw e; await delay(30); } }
  async function request(path: string, method = 'GET', body?: unknown, token?: string) {
    return fetch(url + '/api/v1' + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  }
  const credentials = { username: 'alice', password: 'account-test-password' };
  const registration = await request('/auth/register', 'POST', credentials);
  assert.equal(registration.status, 200);
  const account = await registration.json();
  const token = account.token;
  const key = generateRootKey();
  const { createProtection, sealCredentials } = await import('../src/credentials');
  const protection = await createProtection('vault-test-password');
  const encryptedKey = await sealCredentials({ token: '', rootKey: key }, protection.key, protection.salt);
  const created = await request('/vaults', 'POST', { name: 'Test vault', encryptedKey }, token);
  assert.equal(created.status, 200);
  const registered = await created.json();
  const vaultId = registered.id;
  const a = await makeClient(join(root, 'A'), url, token, key, vaultId);
  const b = await makeClient(join(root, 'B'), url, token, key, vaultId);
  const eventUrl = (id: string) => `${url.replace('http:', 'ws:')}/api/v1/vaults/${id}/events`;
  async function until(check: () => boolean | Promise<boolean>) {
    for (let n = 0; n < 300; n++) { if (await check()) return; await delay(10); }
    assert.fail('timed out waiting for WebSocket sync');
  }
  function subscription(id: string, session: string) {
    const socket = new WebSocket(eventUrl(id));
    const messages: any[] = [];
    let code = 0;
    socket.onopen = () => socket.send(JSON.stringify({ type: 'authenticate', token: session }));
    socket.onmessage = event => {
      const message = JSON.parse(String(event.data)); messages.push(message);
      if (message.type === 'ping') socket.send('{"type":"pong"}');
    };
    socket.onclose = event => { code = event.code; };
    return { socket, messages, code: () => code };
  }
  await t.test('registration, login, duplicate names and logout enforce session lifecycle', async () => {
    assert.equal((await request('/auth/register', 'POST', credentials)).status, 409);
    assert.equal((await request('/auth/login', 'POST', { ...credentials, password: 'incorrect' })).status, 401);
    const login = await (await request('/auth/login', 'POST', credentials)).json();
    assert.notEqual(login.token, token); assert.equal(login.userId, account.userId);
    assert.equal((await request('/vaults', 'POST', { name: 'Test vault', encryptedKey }, token)).status, 409);
    const list = await (await request('/vaults', 'GET', undefined, login.token)).json();
    assert.equal(list.length, 1); assert.equal(list[0].id, vaultId);
    assert.equal((await request('/auth/logout', 'POST', undefined, login.token)).status, 200);
    assert.equal((await request('/vaults', 'GET', undefined, login.token)).status, 401);
    assert.equal((await request('/vaults', 'GET', undefined, legacyToken)).status, 401);
  });
  await t.test('all vault endpoints reject other users and unregistered vault IDs', async () => {
    const other = await (await request('/auth/register', 'POST', { username: 'bob', password: 'other-account-password' })).json();
    assert.deepEqual(await (await request('/vaults', 'GET', undefined, other.token)).json(), []);
    const zero = '0'.repeat(64);
    for (const [suffix, method, body] of [
      ['/state', 'GET', undefined], ['/changes', 'GET', undefined],
      ['/chunks/exists', 'POST', { ids: [zero] }], [`/chunks/${zero}`, 'GET', undefined],
      [`/chunks/${zero}`, 'PUT', 'ciphertext'], ['/commit', 'POST', { deviceId: 'bob', changes: [] }]
    ] as const) assert.equal((await request(`/vaults/${vaultId}${suffix}`, method, body, other.token)).status, 404, suffix);
    assert.equal((await request('/vaults/unregistered/state', 'GET', undefined, token)).status, 404);
    assert.equal((await request('/vaults', 'POST', { name: 'Test vault', encryptedKey }, other.token)).status, 200);
    assert.equal((await request('/vaults', 'POST', { name: 'hack', encryptedKey, ownerId: account.userId }, other.token)).status, 422);
    assert.equal((await request(`/vaults/${vaultId}/state`)).status, 401);
  });
  await t.test('WebSocket subscriptions reject missing sessions and cross-user vault access', async () => {
    const other = await (await request('/auth/register', 'POST', { username: 'push-other', password: 'other-account-password' })).json();
    for (const [id, session, code] of [[vaultId, '', 4401], [vaultId, other.token, 4404], ['unregistered', token, 4404]] as const) {
      const sub = subscription(id, session);
      try {
        await until(() => sub.code() !== 0);
        assert.equal(sub.code(), code);
        assert.deepEqual(sub.messages, [], 'no ready or metadata before authorization');
      } finally { sub.socket.close(); }
    }
  });
  await t.test('committed changes notify only their vault and logout closes only the revoked session', async () => {
    const otherVault = await (await request('/vaults', 'POST', { name: 'Push isolation', encryptedKey }, token)).json();
    const login = await (await request('/auth/login', 'POST', credentials)).json();
    const sub = subscription(vaultId, login.token);
    const isolated = subscription(otherVault.id, token);
    try {
      await until(() => [sub, isolated].every(s => s.messages.some(m => m.type === 'ready')));
      await a.put('push-notification.md', 'committed data'); await a.engine.sync();
      await until(() => sub.messages.some(m => m.type === 'changed'));
      const message = sub.messages.find(m => m.type === 'changed');
      assert.deepEqual(Object.keys(message).sort(), ['sequence', 'type']);
      const changes = await (await request(`/vaults/${vaultId}/changes?after=0`, 'GET', undefined, token)).json();
      assert.ok(changes.currentSequence >= message.sequence, 'notification follows durable commit');
      await request('/auth/logout', 'POST', undefined, login.token);
      await until(() => sub.code() === 4401);
      assert.equal(isolated.code(), 0);
      assert.ok(!isolated.messages.some(m => m.type === 'changed'));
    } finally { sub.socket.close(); isolated.socket.close(); }
  });
  await t.test('push alone syncs an idle device, and reconnect catches changes missed offline', async () => {
    let queue = Promise.resolve();
    let pulls = 0;
    let failure: unknown;
    const notifications = new RemoteNotifications(() => {
      pulls++;
      queue = queue.then(() => b.engine.sync()).then(() => {}).catch(error => { failure = error; });
    }, () => { failure = Error('unexpected notification rejection'); });
    const connection = { url: eventUrl(vaultId), token };
    try {
      notifications.configure(connection);
      await until(() => pulls > 0); await queue;
      await a.put('pushed.md', 'without polling'); await a.engine.sync();
      await until(async () => await b.exists('pushed.md') && await b.read('pushed.md') === 'without polling');
      notifications.stop(); await queue;
      await a.put('pushed.md', 'while disconnected'); await a.engine.sync();
      assert.equal(await b.read('pushed.md'), 'without polling');
      notifications.configure(connection);
      await until(async () => await b.read('pushed.md') === 'while disconnected');
      assert.equal(failure, undefined);
    } finally { notifications.stop(); await queue; }
  });
  const settle = async () => { await a.engine.sync(); await b.engine.sync(); await a.engine.sync(); await b.engine.sync(); };
  await t.test('new device bootstraps remote data without a local edit', async () => {
    await a.put('note.md', 'base'); await a.engine.sync(); await b.engine.sync(); assert.equal(await b.read('note.md'), 'base');
  });
  await t.test('remote-only updates are pulled', async () => {
    await a.put('note.md', 'remote edit'); await settle(); assert.equal(await b.read('note.md'), 'remote edit');
  });
  await t.test('offline simultaneous edits preserve both versions and converge', async () => {
    await a.put('note.md', 'A offline'); await b.put('note.md', 'B offline'); await settle();
    assert.equal(await b.read('note.md'), 'A offline');
    const conflict = (await readdir(b.root)).find(p => p.includes('(conflict'))!;
    assert.ok(conflict); assert.equal(await b.read(conflict), 'B offline'); assert.equal(await a.read(conflict), 'B offline');
  });
  await t.test('rename propagates', async () => {
    await a.rename('note.md', 'renamed.md'); await settle(); assert.ok(!(await b.exists('note.md'))); assert.equal(await b.read('renamed.md'), 'A offline');
  });
  await t.test('failed rename commit retries without losing rename', async () => {
    await a.rename('renamed.md', 'retry.md');
    interceptRequest(async o => { if (o.url.endsWith('/commit')) throw Error('offline'); });
    await assert.rejects(a.engine.sync(), /offline/); interceptRequest();
    await settle(); assert.ok(!(await b.exists('renamed.md'))); assert.equal(await b.read('retry.md'), 'A offline');
  });
  await t.test('delete versus edit preserves edited copy', async () => {
    await a.remove('retry.md'); await b.put('retry.md', 'unsent edit'); await settle();
    const copies = await Promise.all((await readdir(b.root)).filter(p => p.includes('(conflict')).map(p => b.read(p)));
    assert.ok(copies.includes('unsent edit')); assert.ok(!(await b.exists('retry.md')));
  });
  await t.test('binary and empty files round-trip', async () => {
    await writeFile(join(a.root, 'asset.bin'), new Uint8Array([0, 255, 13, 0, 254])); await a.put('empty.md', ''); await settle();
    assert.deepEqual(await readFile(join(a.root, 'asset.bin')), await readFile(join(b.root, 'asset.bin'))); assert.equal(await b.read('empty.md'), '');
  });
  await t.test('an edit made during chunk download is preserved', async () => {
    await a.put('race.md', 'base'); await settle(); await a.put('race.md', 'remote'); await a.engine.sync();
    let injected = false;
    interceptRequest(async o => { if (!injected && o.method === 'GET' && o.url.includes('/chunks/')) { injected = true; await b.put('race.md', 'typed while downloading'); } });
    await b.engine.sync(); interceptRequest(); await settle();
    const copies = await Promise.all((await readdir(b.root)).filter(p => p.startsWith('race (conflict')).map(p => b.read(p)));
    assert.ok(injected); assert.ok(copies.includes('typed while downloading'));
  });
  await t.test('remote rename onto an unsynced local file preserves destination', async () => {
    await a.put('source.md', 'source'); await settle(); await a.rename('source.md', 'destination.md'); await b.put('destination.md', 'local destination'); await settle();
    const copies = await Promise.all((await readdir(b.root)).filter(p => p.startsWith('destination (conflict')).map(p => b.read(p)));
    assert.ok(copies.includes('local destination')); assert.equal(await b.read('destination.md'), 'source');
  });
  await t.test('deleting and recreating a path survives a fresh device bootstrap', async () => {
    await a.put('reborn.md', 'first'); await settle(); await a.remove('reborn.md'); await settle();
    await a.put('reborn.md', 'second'); await settle();
    const fresh = await makeClient(join(root, 'fresh'), url, token, key, vaultId);
    await fresh.engine.sync(); assert.equal(await fresh.read('reborn.md'), 'second');
  });
  await t.test('simultaneous creation of the same path preserves both versions', async () => {
    await a.put('same.md', 'A creation'); await b.put('same.md', 'B creation');
    await Promise.all([a.engine.sync(), b.engine.sync()]); await settle();
    const texts = await Promise.all((await readdir(a.root)).filter(p => p.startsWith('same')).map(p => a.read(p)));
    assert.ok(texts.includes('A creation')); assert.ok(texts.includes('B creation'));
  });
  await t.test('file deletion is recoverable in the local trash', async () => {
    assert.ok((await readdir(join(b.root, '.trash'))).length > 0);
  });
  await t.test('wrong key fails before uploading local notes', async () => {
    const wrong = await makeClient(join(root, 'wrong'), url, token, generateRootKey(), vaultId);
    await wrong.put('private.md', 'never upload'); await assert.rejects(wrong.engine.sync()); assert.equal(wrong.data.lastSequence, 0);
  });
  await t.test('hidden credentials and plugin configuration are excluded', async () => {
    await a.put('.env', 'secret'); await mkdir(join(a.root, '.git')); await a.put('.git/config', 'secret'); await settle(); assert.ok(!(await b.exists('.env'))); assert.ok(!(await b.exists('.git/config')));
  });
});

test('automatic scheduling cannot be starved by typing and remote checks are immediate', async () => {
  const timers = new Map<number, () => void>(); let id = 0;
  (globalThis as any).window = { setTimeout: (fn: () => void) => { timers.set(++id, fn); return id; }, clearTimeout: (id: number) => timers.delete(id) };
  const plugin = new EncryptedSyncPlugin() as any;
  plugin.wrappingKey = {};
  plugin.data.settings.token = 'configured'; plugin.data.settings.rootKey = generateRootKey();
  let runs = 0; plugin.runSync = async () => { runs++; };
  for (let i = 0; i < 100; i++) plugin.scheduleSync();
  assert.equal(timers.size, 1); assert.equal(id, 1);
  plugin.scheduleSync(0); assert.equal(runs, 1); assert.equal(timers.size, 0);
  plugin.data.settings.autoSync = false; plugin.scheduleSync(0); assert.equal(runs, 1);
  plugin.data.settings.autoSync = true; plugin.onunload(); plugin.scheduleSync(0); assert.equal(runs, 1);
});

test('encrypted migration verifies before clearing legacy storage; wrong passwords never overwrite data', async () => {
  const { openCredentials } = await import('../src/credentials');
  const plugin = new EncryptedSyncPlugin() as any;
  const secrets = new Map([['legacy-token', 'test-token'], ['legacy-key', generateRootKey()]]);
  let saved: any = { settings: { ...plugin.data.settings }, files: {}, logs: [], lastSequence: 7, secretId: 'legacy' };
  const original = secrets.get('legacy-key');
  plugin.data = structuredClone(saved);
  plugin.app = { secretStorage: { getSecret: (id: string) => secrets.get(id), deleteSecret: (id: string) => { assert.ok(saved.encryptedCredentials); secrets.delete(id); } } };
  plugin.loadData = async () => structuredClone(saved);
  plugin.saveData = async (value: any) => { saved = structuredClone(value); };
  plugin.scheduleSync = () => {};
  await plugin.unlock('test-only-local-password');
  assert.equal(saved.settings.rootKey, ''); assert.equal(saved.settings.token, '');
  assert.equal(saved.secretId, undefined); assert.equal(secrets.size, 0); assert.equal(saved.lastSequence, 7);
  assert.equal((await openCredentials(saved.encryptedCredentials, 'test-only-local-password')).credentials.rootKey, original);
  const before = JSON.stringify(saved);
  plugin.wrappingKey = undefined; plugin.data.settings.token = ''; plugin.data.settings.rootKey = '';
  await assert.rejects(plugin.unlock('wrong-password'));
  assert.equal(JSON.stringify(saved), before); assert.equal(plugin.isLocked, true);
  await plugin.unlock('test-only-local-password'); assert.equal(plugin.data.settings.rootKey, original);
  await plugin.changeLocalPassword('replacement-test-password');
  await assert.rejects(openCredentials(saved.encryptedCredentials, 'test-only-local-password'));
  assert.equal((await openCredentials(saved.encryptedCredentials, 'replacement-test-password')).credentials.rootKey, original);
});

test('failed encrypted migration keeps legacy credentials recoverable', async () => {
  const plugin = new EncryptedSyncPlugin() as any;
  const original = generateRootKey(); const secrets = new Map([['legacy-token','test-token'], ['legacy-key',original]]);
  const saved = { settings: { ...plugin.data.settings }, files: {}, logs: [], lastSequence: 9, secretId: 'legacy' };
  plugin.data = structuredClone(saved);
  plugin.app = { secretStorage: { getSecret: (id: string) => secrets.get(id), deleteSecret: () => { throw Error('must not delete'); } } };
  plugin.loadData = async () => structuredClone(saved);
  plugin.saveData = async () => { throw Error('disk full'); };
  await assert.rejects(plugin.unlock('test-only-local-password'), /disk full/);
  assert.equal(secrets.get('legacy-key'), original); assert.equal(plugin.isLocked, true); assert.equal(plugin.data.lastSequence, 9);
});

test('startup stays locked and never rewrites legacy plaintext until migration', async () => {
  const events = new Map<string, () => void>(); const intervals: (() => void)[] = [];
  (globalThis as any).window = { setInterval: (fn: () => void, ms: number) => { assert.equal(ms, 60000); intervals.push(fn); return 1; }, clearTimeout: () => {} };
  (globalThis as any).document = { visibilityState: 'visible' };
  const plugin = new EncryptedSyncPlugin() as any;
  let saves = 0; let runs = 0;
  plugin.app = { vault: { getName: () => 'fixture', on: () => ({}) }, workspace: { onLayoutReady: () => {} } };
  plugin.loadData = async () => ({ settings: { token: 'legacy-token', rootKey: generateRootKey() }, files: {}, lastSequence: 42 });
  plugin.saveData = async () => { saves++; };
  plugin.addRibbonIcon = plugin.addCommand = plugin.addSettingTab = plugin.registerEvent = plugin.registerInterval = () => {};
  plugin.addStatusBarItem = () => ({ addClass: () => {}, setText: () => {}, setAttr: () => {}, dataset: {} });
  plugin.registerDomEvent = (_: any, name: string, fn: () => void) => events.set(name, fn);
  plugin.runSync = async () => { runs++; };
  await plugin.onload(); intervals[0](); events.get('online')!(); events.get('focus')!();
  assert.equal(runs, 0); assert.equal(saves, 0); assert.equal(plugin.isLocked, true);
  assert.equal(plugin.data.settings.rootKey, ''); assert.equal(plugin.data.settings.token, '');
  plugin.onunload();
});
