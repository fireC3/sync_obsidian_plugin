import assert from "node:assert/strict";
import test from "node:test";
import { RemoteNotifications } from "../src/notifications";
import { SyncApi } from "../src/api";
import EncryptedSyncPlugin from "../src/main";

class FakeSocket {
  onopen?: (() => void) | null;
  onmessage?: ((event: { data: string }) => void) | null;
  onclose?: ((event: { code: number }) => void) | null;
  onerror?: (() => void) | null;
  sent: string[] = [];
  closed = false;
  constructor(readonly url: string) {}
  send(text: string) { this.sent.push(text); }
  close() { this.closed = true; }
  message(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
}

function fixture() {
  const sockets: FakeSocket[] = [];
  let pulls = 0;
  const rejected: number[] = [];
  const notifications = new RemoteNotifications(() => { pulls++; }, code => rejected.push(code), url => {
    const socket = new FakeSocket(url);
    sockets.push(socket);
    return socket as unknown as WebSocket;
  });
  const connection = { url: 'wss://sync.example/api/v1/vaults/a/events', token: 'private-session' };
  return { sockets, rejected, notifications, connection, pulls: () => pulls };
}

test('notifications authenticate outside the URL, catch up on ready and handle heartbeats', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  t.after(() => f.notifications.stop());
  f.notifications.configure(f.connection);
  const socket = f.sockets[0];
  assert.ok(!socket.url.includes(f.connection.token));
  socket.onopen?.();
  assert.deepEqual(JSON.parse(socket.sent[0]), { type: 'authenticate', token: f.connection.token });
  socket.message({ type: 'changed', sequence: 1 });
  assert.equal(f.pulls(), 0, 'wait for authenticated ready');
  socket.message({ type: 'ready' });
  socket.message({ type: 'changed', sequence: 2 });
  socket.message({ type: 'resync' });
  socket.message({ type: 'ping' });
  socket.message(null);
  socket.message({ type: 'changed', sequence: 'invalid' });
  assert.equal(f.pulls(), 3);
  assert.deepEqual(JSON.parse(socket.sent.at(-1)!), { type: 'pong' });
  f.notifications.configure({ ...f.connection });
  assert.equal(f.sockets.length, 1, 'unchanged settings retain the connection');
});

test('socket retries back off, reconnect catches up, and silent connections time out', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  t.after(() => f.notifications.stop());
  f.notifications.configure(f.connection);
  f.sockets[0].onclose?.({ code: 1006 });
  t.mock.timers.tick(999);
  assert.equal(f.sockets.length, 1);
  t.mock.timers.tick(1);
  f.sockets[1].onerror?.();
  t.mock.timers.tick(1999);
  assert.equal(f.sockets.length, 2);
  t.mock.timers.tick(1);
  f.sockets[2].message({ type: 'ready' });
  assert.equal(f.pulls(), 1);
  t.mock.timers.tick(45000);
  assert.equal(f.sockets[2].closed, true);
  t.mock.timers.tick(1000);
  assert.equal(f.sockets.length, 4);
  f.sockets[3].message({ type: 'ready' });
  assert.equal(f.pulls(), 2, 'reconnect always pulls changes missed offline');
});

test('rejection, pause and switching vaults discard stale callbacks and cancel retries', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  f.notifications.configure(f.connection);
  const stale = f.sockets[0].onmessage!;
  f.notifications.configure({ ...f.connection, url: 'wss://sync.example/api/v1/vaults/b/events' });
  assert.equal(f.sockets[0].closed, true);
  stale({ data: '{"type":"ready"}' });
  assert.equal(f.pulls(), 0);
  f.sockets[1].onclose?.({ code: 4401 });
  t.mock.timers.tick(60000);
  assert.deepEqual(f.rejected, [401]);
  assert.equal(f.sockets.length, 2);
  f.notifications.configure(f.connection);
  f.sockets[2].onclose?.({ code: 4404 });
  assert.deepEqual(f.rejected, [401, 404]);
  f.notifications.configure(f.connection);
  f.sockets[3].onerror?.();
  f.notifications.stop();
  t.mock.timers.tick(60000);
  assert.equal(f.sockets.length, 4);
});

test('explicit resume retries immediately and a stalled handshake is bounded', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  t.after(() => f.notifications.stop());
  f.notifications.configure(f.connection);
  t.mock.timers.tick(10000);
  assert.equal(f.sockets[0].closed, true);
  f.notifications.reconnect();
  assert.equal(f.sockets.length, 2);
  t.mock.timers.tick(1000);
  assert.equal(f.sockets.length, 2, 'resume cancelled the older retry');
});

test('event URLs preserve proxy prefixes and permit insecure transport only on loopback', () => {
  const settings = new EncryptedSyncPlugin().data.settings;
  assert.equal(new SyncApi({ ...settings, serverUrl: 'https://sync.example/prefix/', vaultId: 'a', token: 'secret' }).eventsUrl(),
    'wss://sync.example/prefix/api/v1/vaults/a/events');
  assert.equal(new SyncApi({ ...settings, vaultId: 'a' }).eventsUrl(), 'ws://127.0.0.1:8787/api/v1/vaults/a/events');
  assert.throws(() => new SyncApi({ ...settings, serverUrl: 'http://sync.example' }));
});

function pluginFixture() {
  (globalThis as any).window = { setTimeout, clearTimeout };
  const plugin = new EncryptedSyncPlugin() as any;
  plugin.wrappingKey = {};
  plugin.data.settings.token = 'configured';
  plugin.data.settings.rootKey = 'configured';
  plugin.persist = async () => {};
  plugin.recordLog = plugin.setStatus = plugin.updateIdleStatus = () => {};
  return plugin;
}

test('notifications received during a sync coalesce into one follow-up pull', async t => {
  const plugin = pluginFixture();
  t.after(() => plugin.onunload());
  let runs = 0;
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  plugin.engine = { sync: async () => { runs++; if (runs === 1) await waiting; return true; } };
  const active = plugin.runSync(false);
  for (let n = 0; n < 10; n++) plugin.scheduleSync(0);
  assert.equal(runs, 1);
  release();
  await active;
  assert.equal(runs, 2);
});

test('push respects HTTP failure backoff and retries without waiting for fallback polling', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const plugin = pluginFixture();
  t.after(() => plugin.onunload());
  let runs = 0;
  plugin.engine = { sync: async () => { if (++runs === 1) throw Error('offline'); return true; } };
  await plugin.runSync(false);
  plugin.scheduleSync(0);
  assert.equal(runs, 1);
  t.mock.timers.tick(4999);
  assert.equal(runs, 1);
  t.mock.timers.tick(1);
  await Promise.resolve();
  assert.equal(runs, 2);
});

test('plugin closes notifications when paused, locked, logged out or unloaded', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const plugin = pluginFixture();
  const f = fixture();
  plugin.notifications = f.notifications;
  t.after(() => plugin.onunload());
  plugin.updateNotifications();
  assert.equal(f.sockets.length, 1);
  plugin.data.settings.autoSync = false;
  plugin.updateNotifications();
  assert.equal(f.sockets[0].closed, true);
  plugin.data.settings.autoSync = true;
  plugin.updateNotifications();
  plugin.wrappingKey = undefined;
  plugin.updateNotifications();
  assert.equal(f.sockets[1].closed, true);
  plugin.wrappingKey = {};
  plugin.updateNotifications();
  plugin.data.settings.token = '';
  plugin.updateNotifications();
  assert.equal(f.sockets[2].closed, true);
  plugin.data.settings.token = 'new-session';
  plugin.updateNotifications();
  plugin.onunload();
  assert.equal(f.sockets[3].closed, true);
  t.mock.timers.tick(60000);
  assert.equal(f.sockets.length, 4);
});
