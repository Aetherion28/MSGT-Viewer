const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');

const DISC_EXT = new Set(['.iso', '.gcm', '.rvz', '.gcz', '.ciso', '.wia']);
const GHOST_EXT = new Set(['.smsghost', '.msgt']);
const portableDir = process.env.PORTABLE_EXECUTABLE_DIR || '';
// The viewer is a sustained WebGL workload. Chromium browsers generally promote it to the
// high-performance GPU; ask Electron to do the same instead of intermittently rendering on a
// power-saving adapter. Keep frame production steady through brief focus/occlusion changes too.
app.commandLine.appendSwitch('force_high_performance_gpu');
if (portableDir) app.setPath('userData', path.join(portableDir, 'MSGT Viewer Data'));
let settings = {};

function storePath(value) {
  if (!portableDir || path.parse(value).root.toLowerCase() !== path.parse(portableDir).root.toLowerCase()) return value;
  return `portable:${path.relative(portableDir, value)}`;
}
function resolvePath(value) {
  return typeof value === 'string' && value.startsWith('portable:')
    ? path.resolve(portableDir, value.slice('portable:'.length))
    : value;
}

function settingsFile() { return path.join(app.getPath('userData'), 'desktop-settings.json'); }
async function loadSettings() {
  try { settings = JSON.parse(await fs.readFile(settingsFile(), 'utf8')); } catch { settings = {}; }
  if (settings.ghostFolder && !settings.readFolder) settings.readFolder = settings.ghostFolder;
}
async function saveSettings() {
  const file = settingsFile(), tmp = file + '.tmp';
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(tmp, JSON.stringify(settings, null, 2));
  await fs.rename(tmp, file);
}
async function discMeta() {
  if (!settings.discPath) return null;
  const discPath = resolvePath(settings.discPath);
  try {
    const stat = await fs.stat(discPath);
    if (!stat.isFile() || !DISC_EXT.has(path.extname(discPath).toLowerCase())) return null;
    return { name: path.basename(discPath), size: stat.size };
  } catch { return null; }
}
async function scanGhosts(root) {
  const out = [], maxFiles = 2000, maxBytes = 64 * 1024 * 1024;
  async function walk(dir) {
    if (out.length >= maxFiles) return;
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (out.length >= maxFiles) break;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && GHOST_EXT.has(path.extname(entry.name).toLowerCase())) {
        const stat = await fs.stat(full);
        if (stat.size <= maxBytes) {
          const bytes = await fs.readFile(full);
          out.push({ name: entry.name, relativePath: path.relative(root, full), data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
        }
      }
    }
  }
  await walk(root);
  return out;
}
async function ghostResult() {
  if (!settings.readFolder) return { folder: '', files: [] };
  const ghostFolder = resolvePath(settings.readFolder);
  try { return { folder: ghostFolder, files: await scanGhosts(ghostFolder) }; }
  catch { return { folder: ghostFolder, files: [] }; }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 900, minHeight: 620,
    icon: path.join(__dirname, 'icon.png'),
    backgroundColor: '#1f3326',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false,
      sandbox: true, backgroundThrottling: false
    }
  });
  win.loadFile(path.join(__dirname, 'site', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (event, url) => { if (!url.startsWith('file:')) { event.preventDefault(); if (/^https:\/\//i.test(url)) shell.openExternal(url); } });
}

app.whenReady().then(async () => {
  await loadSettings();
  ipcMain.handle('desktop:disc-pick', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'GameCube disc images', extensions: [...DISC_EXT].map((x) => x.slice(1)) }] });
    if (result.canceled || !result.filePaths[0]) return null;
    settings.discPath = storePath(result.filePaths[0]); await saveSettings(); return discMeta();
  });
  ipcMain.handle('desktop:disc-current', () => discMeta());
  ipcMain.handle('desktop:disc-forget', async () => { delete settings.discPath; await saveSettings(); });
  ipcMain.handle('desktop:disc-read', async (_event, start, end) => {
    if (!settings.discPath || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end - start > 128 * 1024 * 1024) throw new Error('Invalid disc read.');
    const handle = await fs.open(resolvePath(settings.discPath), 'r');
    try { const data = Buffer.alloc(end - start); const { bytesRead } = await handle.read(data, 0, data.length, start); return data.buffer.slice(data.byteOffset, data.byteOffset + bytesRead); }
    finally { await handle.close(); }
  });
  ipcMain.handle('desktop:ghost-read-folder-pick', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    if (result.canceled || !result.filePaths[0]) return null;
    settings.readFolder = storePath(result.filePaths[0]); await saveSettings(); return ghostResult();
  });
  ipcMain.handle('desktop:ghost-list', () => ghostResult());
  ipcMain.handle('desktop:ghost-save-folder-pick', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    if (result.canceled || !result.filePaths[0]) return null;
    settings.saveFolder = storePath(result.filePaths[0]); await saveSettings();
    return { folder: resolvePath(settings.saveFolder) };
  });
  ipcMain.handle('desktop:ghost-save-folder-current', () => ({ folder: resolvePath(settings.saveFolder) || '' }));
  ipcMain.handle('desktop:ghost-save', async (_event, suppliedName, data) => {
    if (!settings.saveFolder) throw new Error('Choose a ghost download folder first.');
    const rawName = typeof suppliedName === 'string' ? path.basename(suppliedName) : 'ghost.smsghost';
    let name = rawName.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'ghost.smsghost';
    if (!GHOST_EXT.has(path.extname(name).toLowerCase())) name += '.smsghost';
    const bytes = Buffer.from(data);
    if (!bytes.length || bytes.length > 64 * 1024 * 1024) throw new Error('That ghost file has an invalid size.');
    const parsed = path.parse(name);
    const ghostFolder = resolvePath(settings.saveFolder);
    let target = path.join(ghostFolder, name), n = 1;
    while (true) {
      try { await fs.access(target); target = path.join(ghostFolder, `${parsed.name} (${n++})${parsed.ext}`); }
      catch { break; }
    }
    await fs.writeFile(target, bytes);
    return { name: path.basename(target), relativePath: path.relative(ghostFolder, target) };
  });
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
