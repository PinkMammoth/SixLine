// Thin desktop shell: window, local file dialogs, file read/write. No networking.
const { app, BrowserWindow, dialog, ipcMain, protocol, Menu, net } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { pathToFileURL } = require('node:url');

const DIST = path.join(__dirname, '..', 'dist');
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

// A supported file passed on the command line (or via a Windows file association) is opened at startup.
const fileFromArgv = (argv) => argv.slice(1).find((a) => /\.(gp[345]|tabproj|midi?)$/i.test(a));
const fileArg = fileFromArgv(process.argv);

// One window: opening a project from Explorer while SixLine runs opens it in the existing window.
if (!app.requestSingleInstanceLock()) app.quit();
let mainWindow = null;
app.on('second-instance', (_e, argv, cwd) => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
  const f = fileFromArgv(argv);
  if (f) mainWindow.webContents.send('open-path', path.resolve(cwd, f));
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'SixLine',
    backgroundColor: '#ffffff',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: false, devTools: !app.isPackaged },
  });
  mainWindow = win;
  // the page blocks unload while any tab has unsaved changes: ask before discarding them
  win.webContents.on('will-prevent-unload', (event) => {
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Quit without saving', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'SixLine',
      message: 'Some open songs have unsaved changes.',
      detail: 'Quit anyway and lose those changes?',
    });
    if (choice === 0) event.preventDefault(); // allow the unload
  });
  // a dev server is only honoured in development builds
  if (!app.isPackaged && process.env.VITE_DEV_URL) win.loadURL(process.env.VITE_DEV_URL);
  else win.loadURL('app://local/index.html');
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null); // the app draws its own menu; keeps all shortcuts in the renderer
  protocol.handle('app', (req) => {
    const rel = decodeURIComponent(new URL(req.url).pathname);
    const file = path.normalize(path.join(DIST, rel));
    if (!file.startsWith(DIST)) return new Response('forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });

  ipcMain.handle('open-file', async (e, filters) => {
    const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), { properties: ['openFile'], filters });
    if (r.canceled || !r.filePaths[0]) return null;
    return readFile(r.filePaths[0]);
  });
  ipcMain.handle('read-file', (_e, p) => readFile(p));
  ipcMain.handle('save-file', async (e, { path: p, data, defaultName, filters }) => {
    if (!p) {
      const r = await dialog.showSaveDialog(BrowserWindow.fromWebContents(e.sender), { defaultPath: defaultName, filters });
      if (r.canceled || !r.filePath) return null;
      p = r.filePath;
    }
    await fs.writeFile(p, Buffer.from(data));
    return p;
  });
  ipcMain.handle('initial-file', () => (fileArg ? path.resolve(fileArg) : null));

  createWindow();
});

async function readFile(p) {
  const buf = await fs.readFile(p);
  return { path: p, name: path.basename(p), bytes: new Uint8Array(buf) };
}

app.on('window-all-closed', () => app.quit());
