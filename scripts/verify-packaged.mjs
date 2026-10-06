// Verifies the packaged Windows build end to end: silent install, real workflow in the installed app
// (driven by Playwright), file association, portable exe, silent uninstall.
// Run with `npm run verify:packaged` after `npm run dist`. On WSL it re-runs itself under Windows Node.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;

if (process.platform !== 'win32') {
  // WSL: hand over to Windows Node (installed apps and their windows live on the Windows side)
  const r = spawnSync('node.exe', [path.join('scripts', 'verify-packaged.mjs'), ...process.argv.slice(2)], { cwd: root, stdio: 'inherit' });
  process.exit(r.status ?? 1);
}

const { _electron: electron } = await import('playwright-core');
const { parseMidi } = (await import('midi-file')).default;
const assert = (await import('node:assert/strict')).default;

const release = path.join(root, 'release', version);
const installer = path.join(release, `SixLine-Setup-${version}.exe`);
const portable = path.join(release, `SixLine-${version}-portable.exe`);
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sixline-verify-'));
const installDir = path.join(process.env.LOCALAPPDATA, 'Programs', 'SixLine');
const installedExe = path.join(installDir, 'SixLine.exe');
const ps = (cmd) => execFileSync('powershell.exe', ['-NoProfile', '-Command', cmd], { encoding: 'utf8' }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Poll until fn() is truthy (installers/uninstallers and the portable unpacker finish asynchronously). */
async function until(fn, seconds = 60) {
  for (let i = 0; i < seconds * 2; i++) {
    const v = await fn();
    if (v) return v;
    await sleep(500);
  }
  return fn();
}

let failures = 0;
async function step(name, fn) {
  try {
    await fn();
    console.log('  ok  ' + name);
  } catch (e) {
    failures++;
    console.log('  FAIL ' + name + '\n       ' + String(e.message || e).split('\n').join('\n       '));
  }
}

// fixtures copied to a normal Windows folder (not the WSL share)
const gpSrc = ['gp5-examples/Tower10.gp5', 'fixtures/fixture.gp5'].map((f) => path.join(root, f)).find((f) => fs.existsSync(f));
const gp = path.join(work, path.basename(gpSrc));
fs.copyFileSync(gpSrc, gp);
console.log(`Packaged SixLine ${version}: verifying in ${work}\n  GP file: ${path.basename(gpSrc)}${gpSrc.includes('gp5-examples') ? ' (private fixture)' : ' (private fixtures absent; generated fixture)'}`);

const waitIdle = (win) =>
  win.waitForFunction(() => window.sixline?.score && !window.sixline.rendering && document.querySelector('#at .at-surface *'), null, { timeout: 60000 });

async function launch(args = []) {
  const app = await electron.launch({ executablePath: installedExe, args, cwd: work, timeout: 60000 });
  const win = await app.firstWindow();
  const errors = [];
  win.on('pageerror', (e) => errors.push(String(e)));
  await waitIdle(win);
  return { app, win, errors };
}
const stub = (app, kind, file) =>
  app.evaluate(({ dialog }, [kind, file]) => {
    if (kind === 'open') dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    else dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
  }, [kind, file]);
const killAll = () => spawnSync('taskkill', ['/IM', 'SixLine.exe', '/F'], { stdio: 'ignore' });

// ---------------------------------------------------------------------------------------------
console.log('Install');
await step('installer exists and carries SixLine version info', async () => {
  assert.ok(fs.existsSync(installer), installer);
  const info = ps(`(Get-Item '${installer}').VersionInfo.ProductName + '|' + (Get-Item '${installer}').VersionInfo.ProductVersion`);
  assert.match(info, /^SixLine\|0\.1\.0/);
});
await step('silent install (per user) creates app, Start Menu entry, uninstaller and .tabproj association', async () => {
  killAll();
  const r = spawnSync(installer, ['/S'], { stdio: 'inherit' });
  assert.equal(r.status, 0, 'installer exit code');
  for (let i = 0; i < 60 && !fs.existsSync(installedExe); i++) await sleep(500);
  assert.ok(fs.existsSync(installedExe), installedExe);
  const startMenu = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'SixLine.lnk');
  assert.ok(fs.existsSync(startMenu), startMenu);
  assert.ok(!fs.existsSync(path.join(os.homedir(), 'Desktop', 'SixLine.lnk')), 'silent install declines the desktop shortcut');
  const exeInfo = ps(`(Get-Item '${installedExe}').VersionInfo.FileDescription + '|' + (Get-Item '${installedExe}').VersionInfo.FileVersion`);
  assert.equal(exeInfo, 'SixLine|0.1.0');
  const uninstall = ps(`Get-ChildItem HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall | ForEach-Object { Get-ItemProperty $_.PSPath } | Where-Object { $_.DisplayName -like 'SixLine*' } | ForEach-Object { $_.DisplayName + '|' + $_.DisplayVersion }`);
  assert.match(uninstall, /SixLine 0\.1\.0\|0\.1\.0/);
  const assoc = ps(`(Get-ItemProperty 'HKCU:\\Software\\Classes\\.tabproj').'(default)'`);
  assert.ok(assoc, '.tabproj registered');
  const cmd = ps(`(Get-ItemProperty 'HKCU:\\Software\\Classes\\${assoc}\\shell\\open\\command').'(default)'`);
  assert.match(cmd, /SixLine\.exe"? "%1"/);
});

// ---------------------------------------------------------------------------------------------
console.log('Workflow in the installed app');
const saved = path.join(work, 'verify.tabproj');
const midOut = path.join(work, 'verify.mid');
let edited = null;
{
  const { app, win, errors } = await launch();
  await step('1. packaged SixLine launches (no DevTools, app:// content)', async () => {
    assert.match(await win.title(), /SixLine/);
    assert.equal(await win.evaluate(() => location.protocol), 'app:');
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.isDevToolsOpened()), false);
    assert.equal(await app.evaluate(({ app }) => app.isPackaged), true);
  });
  await step('2. new song', async () => {
    await win.keyboard.press('Control+n');
    await win.waitForSelector('dialog[open]');
    await win.fill('#f-title', 'Packaged check');
    await win.click('dialog button[value=ok]');
    await win.waitForFunction(() => window.sixline.editor.song.title === 'Packaged check', null, { timeout: 10000 });
    await waitIdle(win);
    await win.keyboard.press('5');
    await waitIdle(win);
    assert.equal(await win.evaluate(() => window.sixline.editor.noteAtCursor()?.fret), 5);
  });
  await step(`3. open ${path.basename(gp)}`, async () => {
    await stub(app, 'open', gp);
    await win.keyboard.press('Control+o');
    await win.waitForFunction((n) => window.sixline.editor.song.tracks.length > 1 && document.title.includes(n), path.basename(gp, '.gp5'), { timeout: 30000 });
    await waitIdle(win);
  });
  await step('4. notation and tablature render', async () => {
    const n = await win.evaluate(() => {
      const t = window.sixline;
      const b = t.score.tracks[0].staves[0].bars[0].voices[0].beats[0];
      return t.api.boundsLookup.findBeats(b).length;
    });
    assert.equal(n, 2);
    await win.screenshot({ path: path.join(work, 'packaged.png') });
  });
  await step('5. playback starts (SoundFont loads; time advances)', async () => {
    await win.waitForFunction(() => window.sixline.api.isReadyForPlayback, null, { timeout: 30000 });
    await win.keyboard.press('Space');
    await win.waitForFunction(() => window.sixline.playerState === 1, null, { timeout: 10000 });
    await sleep(1500);
    const pos = await win.evaluate(() => window.sixline.playerPos.current);
    await win.keyboard.press('Space');
    await win.click('#b-stop');
    assert.ok(pos > 800, `playback position ${pos}ms`);
  });
  await step('6. edit a tablature note (click + type 1 9)', async () => {
    await win.evaluate(() => window.sixline.editor.setCursor({ track: 0, bar: 1, beat: 0, string: 0 }));
    await waitIdle(win);
    const p = await win.evaluate(() => {
      const t = window.sixline;
      const b = t.score.tracks[0].staves[0].bars[1].voices[0].beats[0];
      const all = t.api.boundsLookup.findBeats(b);
      const tab = all[all.length - 1].barBounds.visualBounds;
      const r = document.getElementById('at').getBoundingClientRect();
      return { x: r.left + all[0].onNotesX, y: r.top + tab.y };
    });
    await win.mouse.click(p.x, p.y);
    await win.keyboard.press('1');
    await win.keyboard.press('9');
    await waitIdle(win);
    edited = await win.evaluate(() => {
      const t = window.sixline;
      const c = t.editor.cursor;
      const beat = t.score.tracks[0].staves[0].bars[c.bar].voices[0].beats[c.beat];
      return { cursor: { ...c }, fret: t.editor.noteAtCursor()?.fret, key: t.editor.track.tuning[c.string] + 19, tick: t.score.masterBars[c.bar].start + beat.playbackStart };
    });
    assert.equal(edited.fret, 19);
    assert.deepEqual([edited.cursor.bar, edited.cursor.string], [1, 0]);
  });
  await step('7. save as .tabproj', async () => {
    await stub(app, 'save', saved);
    await win.keyboard.press('Control+s');
    await win.waitForFunction(() => !document.title.includes('*'), null, { timeout: 10000 });
    const doc = JSON.parse(fs.readFileSync(saved, 'utf8'));
    assert.equal(doc.format, 'tabproj');
  });
  await step('no page errors', async () => assert.deepEqual(errors, []));
  await app.close();
}
{
  await sleep(1000);
  const { app, win, errors } = await launch([saved]);
  await step('8+9. close, relaunch with the saved project: it reopens with the edit', async () => {
    assert.match(await win.title(), /verify\.tabproj - SixLine/);
    const fret = await win.evaluate(({ bar, beat, string }) => window.sixline.editor.song.tracks[0].measures[bar].voices[0][beat].notes.find((n) => n.string === string)?.fret, edited.cursor);
    assert.equal(fret, 19);
  });
  await step('10+11. export MIDI; independently parsed file contains the edited note', async () => {
    await stub(app, 'save', midOut);
    await win.keyboard.press('Control+e');
    await win.waitForFunction(() => document.getElementById('msg')?.textContent.includes('Exported MIDI'), null, { timeout: 15000 });
    const midi = parseMidi(fs.readFileSync(midOut));
    let t = 0;
    const hit = midi.tracks[0].some((e) => ((t += e.deltaTime), e.type === 'noteOn' && e.velocity > 0 && e.noteNumber === edited.key && t === edited.tick));
    assert.ok(hit, `note ${edited.key} at tick ${edited.tick} in exported MIDI`);
    console.log(`       edited note key ${edited.key} @ tick ${edited.tick} found in ${path.basename(midOut)}`);
  });
  await step('opening another project from Explorer while running reuses the open window', async () => {
    const second = path.join(work, 'second.tabproj');
    fs.copyFileSync(saved, second);
    ps(`Start-Process -FilePath '${second}'`);
    await win.waitForFunction(() => document.title.startsWith('second.tabproj'), null, { timeout: 20000 });
    await sleep(1000);
    const windows = Number(ps(`@(Get-Process SixLine -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle }).Count`));
    assert.equal(windows, 1, 'one SixLine window');
  });
  await step('no page errors', async () => assert.deepEqual(errors, []));
  await app.close();
}

// ---------------------------------------------------------------------------------------------
console.log('Windows integration');
const windowTitle = (exeName, seconds = 120) =>
  until(() => {
    const t = ps(`(Get-Process ${exeName} -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle } | Select-Object -First 1).MainWindowTitle`);
    return t && /tabproj/.test(t) ? t : '';
  }, seconds);
await step('double-click equivalent: shell "open" on verify.tabproj starts SixLine with the project', async () => {
  killAll();
  ps(`Start-Process -FilePath '${saved}'`);
  const title = await windowTitle('SixLine');
  killAll();
  assert.match(title, /verify\.tabproj - SixLine/);
});
await step('portable exe starts and opens a project', async () => {
  killAll();
  const port = path.join(work, path.basename(portable));
  fs.copyFileSync(portable, port);
  ps(`Start-Process -FilePath '${port}' -ArgumentList '"${saved}"'`);
  const title = await windowTitle('SixLine');
  killAll();
  assert.match(title, /verify\.tabproj - SixLine/);
});
await step('silent uninstall removes app, shortcuts, association and uninstall entry', async () => {
  await sleep(1000);
  const un = path.join(installDir, 'Uninstall SixLine.exe');
  assert.ok(fs.existsSync(un), un);
  spawnSync(un, ['/S'], { stdio: 'inherit' });
  const startMenu = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'SixLine.lnk');
  const assoc = () => (ps(`Test-Path 'HKCU:\\Software\\Classes\\.tabproj'`) === 'True' ? ps(`(Get-ItemProperty 'HKCU:\\Software\\Classes\\.tabproj').'(default)'`) : '');
  await until(() => !fs.existsSync(installedExe) && !fs.existsSync(startMenu) && !assoc(), 90);
  assert.ok(!fs.existsSync(installedExe), 'app removed');
  assert.ok(!fs.existsSync(startMenu), 'start menu entry removed');
  assert.equal(assoc(), '', 'association removed');
  const uninstall = ps(`Get-ChildItem HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall | ForEach-Object { Get-ItemProperty $_.PSPath } | Where-Object { $_.DisplayName -like 'SixLine*' } | ForEach-Object { $_.DisplayName }`);
  assert.equal(uninstall, '');
});

console.log(failures ? `\n${failures} FAILED (artifacts in ${work})` : `\nall packaged-app checks passed (artifacts in ${work})`);
process.exit(failures ? 1 : 0);
