// Public, disposable test credentials. Never use these for a real account or vault.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, access, copyFile, writeFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const run = promisify(execFile);
const directory = join(root, 'AccountSyncTests');
const url = 'http://127.0.0.1:18788';
const accountPassword = 'Only-for-local-account-tests-2026!';
const vaultPassword = 'Only-for-local-vault-tests-2026!';
const username = 'account-test-' + Date.now();
const names = { A: 'AccountTest-A', B: 'AccountTest-B' };
const results = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
let server;
async function cli(side, command, ...args) { const { stdout } = await run('obsidian', [`vault=${names[side]}`, command, ...args], { timeout: 20000 }); return stdout.trim(); }
async function evaluate(side, code) { return cli(side, 'eval', `code=(async()=>{const p=app.plugins.plugins["obsidian-encrypted-sync"];${code}})()`); }
async function until(check, label) { const start=Date.now(); while(Date.now()-start<20000) { try { if(await check()) return; } catch{} await sleep(300); } throw Error('timeout: '+label); }
async function check(name, action) { const start=Date.now(); try { await action(); results.push({name,passed:true,durationMs:Date.now()-start}); console.log('PASS',name); } catch(error) {results.push({name,passed:false,error:String(error)});throw error;} }
async function text(side, name) { return readFile(join(directory,names[side],name),'utf8'); }
try {
  // Fresh directories prevent touching legacy encrypted keys or existing test vaults.
  try { await access(directory); if (!process.argv.includes('--resume')) throw Error('AccountSyncTests already exists; use --resume for these dedicated fixtures.'); } catch(e) { if(e.code!=='ENOENT') throw e; }
  await mkdir(directory,{mode:0o700,recursive:true});
  for(const side of ['A','B']) {
    const dir=join(directory,names[side]); const pluginDir=join(dir,'.obsidian/plugins/obsidian-encrypted-sync');
    await mkdir(pluginDir,{recursive:true});
    for(const file of ['main.js','manifest.json','styles.css']) await copyFile(join(root,'sync_obsidian_plugin',file),join(pluginDir,file));
    await writeFile(join(dir,'.obsidian/community-plugins.json'),JSON.stringify(['obsidian-encrypted-sync']));
    await writeFile(join(dir,'本地笔记-'+side+'.md'),'来自 '+side+' 的本地测试笔记',{flag:'wx'}).catch(e=>{if(e.code!=='EEXIST')throw e;});
  }
  await writeFile(join(directory,'README.md'),`# 账户流程测试\n\n仅用于本机测试，不存放真实笔记。\n服务器：${url}\n测试用户名：${username}\n测试登录密码：${accountPassword}\n测试仓库加密/本地解锁密码：${vaultPassword}\n这些是公开的测试凭据，不能用于实际账户。Vault 根密钥和会话仍然只以密文保存。\n`);
  await writeFile(join(directory,'setting.toml'),`[server]\nlisten = "127.0.0.1:18788"\ndata_dir = "${join(directory,'server-data').replaceAll('\\','\\\\')}"\n\n[logging]\nfilter = "error"\n`);
  server=spawn(join(root,'obsidian_sync_server/target/debug/obsidian-backup-server'),[],{cwd:directory,stdio:'ignore'});
  await until(async()=> (await fetch(url+'/api/v1/health')).ok,'server');
  for(const side of ['A','B']) {
    await run('obsidian',['eval',`code=window.electron.ipcRenderer.sendSync("vault-open", ${JSON.stringify(join(directory,names[side]))}, false)`]);
    await until(async()=>await cli(side,'eval','code=app.vault.getName()')==='=> '+names[side],'open '+side);
    await cli(side,'plugins:restrict','off');
    await cli(side,'plugin:enable','id=obsidian-encrypted-sync');
    await cli(side,'plugin:reload','id=obsidian-encrypted-sync');
    await until(async()=>await evaluate(side,'return !!p;')==='=> true','plugin ready '+side);
  }
  await check('first use is locked and has no plaintext credentials',async()=>{
    for(const side of ['A','B']) assert.equal(await evaluate(side,'return p.isLocked && !p.data.settings.token && !p.data.settings.rootKey;'),'=> true');
  });
  // A resumed disposable fixture may contain an older encrypted connection.
  // Unlock it with its documented password before switching accounts so its key
  // can be preserved in the encrypted legacy archive if needed.
  for (const side of ['A','B']) {
    assert.equal(await evaluate(side, `if(p.data.encryptedCredentials) await p.unlock(${JSON.stringify(vaultPassword)});return true;`), '=> true');
    await until(async()=>await evaluate(side,'return !p.isSyncing;')==='=> true','idle before account login');
  }
  await check('register account in A and log in to the same account from B',async()=>{
    assert.equal(await evaluate('A',`await p.loginAccount(${JSON.stringify(url)},${JSON.stringify(username)},${JSON.stringify(accountPassword)},true);return p.remoteVaults.length===0;`),'=> true');
    assert.equal(await evaluate('B',`await p.loginAccount(${JSON.stringify(url)},${JSON.stringify(username)},${JSON.stringify(accountPassword)},false);return p.remoteVaults.length===0;`),'=> true');
  });
  await check('register a remote vault, then discover it on the other device',async()=>{
    assert.equal(await evaluate('A',`await p.registerVault("账户共享仓库",${JSON.stringify(vaultPassword)});return p.remoteVaults.length===1;`),'=> true');
    assert.equal(await evaluate('B','await p.refreshVaults();return p.remoteVaults.length===1 && p.remoteVaults[0].name==="账户共享仓库";'),'=> true');
  });
  await check('wrong vault password cannot connect or overwrite local data',async()=>{
    assert.equal(await evaluate('B','const oldKey=p.data.settings.rootKey;const oldVault=p.data.settings.vaultId;try {await p.connectVault(p.remoteVaults[0],"wrong-password",false);return false;} catch {return p.data.settings.rootKey===oldKey && p.data.settings.vaultId===oldVault;}'),'=> true');
  });
  await check('selecting the registered vault enables automatic two-way sync',async()=>{
    for(const side of ['A','B']) assert.equal(await evaluate(side,`await p.connectVault(p.remoteVaults[0],${JSON.stringify(vaultPassword)},false);return !p.isLocked;`),'=> true');
    await until(async()=> (await text('A','本地笔记-B.md')).includes('B') && (await text('B','本地笔记-A.md')).includes('A'),'bidirectional sync');
    assert.equal(await evaluate('B','return p.data.settings.vaultId===p.remoteVaults[0].id;'),'=> true');
  });
  await check('pull-only does not upload a local-only note',async()=>{
    await until(async()=>await evaluate('B','return !p.isSyncing;')==='=> true','idle B');
    await evaluate('B','p.data.settings.autoSync=false;await p.persist();return true;');
    await cli('B','create',`path=仅本地不上传-${username}.md`,'content=pull-only local note');
    assert.equal(await evaluate('B',`await p.connectVault(p.remoteVaults[0],${JSON.stringify(vaultPassword)},true);return !p.data.settings.autoSync;`),'=> true');
    await sleep(5500);
    assert.equal(await access(join(directory,names.A,`仅本地不上传-${username}.md`)).then(()=>true,()=>false),false);
  });
  await check('saved connection contains ciphertext and no plaintext key or session',async()=>{
    for(const side of ['A','B']) {
      const data=JSON.parse(await text(side,'.obsidian/plugins/obsidian-encrypted-sync/data.json'));
      assert.ok(data.encryptedCredentials.ciphertext);assert.equal(data.settings.token,'');assert.equal(data.settings.rootKey,'');assert.ok(data.account.userId);
      assert.ok(!JSON.stringify(data).includes(accountPassword)); assert.ok(!JSON.stringify(data).includes(vaultPassword));
    }
  });
  await check('reload requires local unlock, then restores the registered connection',async()=>{
    await cli('B','plugin:reload','id=obsidian-encrypted-sync');
    assert.equal(await evaluate('B','return p.isLocked;'),'=> true');
    assert.equal(await evaluate('B',`await p.unlock(${JSON.stringify(vaultPassword)});await p.refreshVaults();return !p.isLocked && p.remoteVaults.length===1;`),'=> true');
  });
  await check('logout revokes the server session',async()=>{
    await until(async()=>await evaluate('B','return !p.isSyncing;')==='=> true','idle before logout');
    assert.equal(await evaluate('B','await p.logoutAccount();return !p.accountSession && !p.data.settings.token;'),'=> true');
  });
} catch(error) {console.error(String(error));process.exitCode=1;}
finally {
  if(server && server.exitCode===null) {const done=new Promise(r=>server.once('exit',r));server.kill('SIGTERM');await done;}
  await writeFile(join(directory,'live-account-report.json'),JSON.stringify({finished:new Date().toISOString(),results},null,2)).catch(()=>{});
}
