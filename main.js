'use strict';

const fs = require('fs');
const path = require('path');
const {
  app,
  BrowserWindow,
  Menu,
  dialog,
  ipcMain,
  nativeTheme,
  shell
} = require('electron');
const { APP_ROOT, DEFAULT_CONFIG, loadConfig, saveConfig } = require('./src/main/config');
const { startMediaServer } = require('./src/main/localServer');
const { JobManager } = require('./src/main/jobs');
const { ServiceManager } = require('./src/main/services');
const { modelStatus, systemInfo } = require('./src/main/system');

const APP_VERSION = require('./package.json').version;
app.setName('Gendo');
app.setAppUserModelId('com.gendo.workbench');
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

let mainWindow = null;
let config = null;
let jobs = null;
let services = null;
let mediaServer = null;
let isQuitting = false;

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function broadcastConfig() {
  send('config:update', loadConfig());
}

function createWindow() {
  nativeTheme.themeSource = 'dark';
  Menu.setApplicationMenu(null);

  mainWindow = new BrowserWindow({
    width: 1500,
    height: 960,
    minWidth: 1160,
    minHeight: 720,
    show: false,
    title: 'Gendo',
    icon: path.join(APP_ROOT, 'assets', 'gendo.ico'),
    backgroundColor: '#090a0c',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(APP_ROOT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,
      spellcheck: false
    }
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.maximize();
    mainWindow.show();
    const capturePath = process.env.GENDO_CAPTURE;
    if (capturePath) {
      const capturePage = process.env.GENDO_CAPTURE_PAGE || '';
      const captureService = process.env.GENDO_CAPTURE_SERVICE || '';
      const waitMs = Number(process.env.GENDO_CAPTURE_WAIT_MS || (captureService ? 45000 : 1800));
      setTimeout(async () => {
        try {
          if (capturePage) {
            await mainWindow.webContents.executeJavaScript(
              `document.querySelector('[data-page="${capturePage.replace(/[^a-z]/gi, '')}"]')?.click()`
            );
          }
          if (captureService) {
            await new Promise((resolve) => setTimeout(resolve, 900));
            await mainWindow.webContents.executeJavaScript(
              `document.getElementById('${captureService === 'dlss' ? 'dlssLaunchBtn' : 'mazanokeLaunchBtn'}')?.click()`
            );
          }
          await new Promise((resolve) => setTimeout(resolve, waitMs));
          const image = await mainWindow.webContents.capturePage();
          fs.mkdirSync(path.dirname(capturePath), { recursive: true });
          fs.writeFileSync(capturePath, image.toPNG());
          console.log('Captured Gendo UI to', capturePath);
          if (process.env.GENDO_CAPTURE_EXIT === '1') app.quit();
        } catch (error) {
          console.error('Gendo capture failed:', error.message);
        }
      }, 2800);
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-attach-webview', (event, webPreferences) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    webPreferences.webSecurity = true;
  });

  mainWindow.webContents.on('did-attach-webview', (event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
  });

  mainWindow.loadFile(path.join(APP_ROOT, 'renderer', 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
}

function registerIpc() {
  const getConfig = () => config || loadConfig();

  ipcMain.handle('app:info', () => ({
    name: 'Gendo',
    version: APP_VERSION,
    appRoot: APP_ROOT,
    configPath: path.join(APP_ROOT, 'config.json'),
    workspace: getConfig().workspace,
    mediaBase: `http://127.0.0.1:${mediaServer.port}`,
    isPackaged: app.isPackaged
  }));

  ipcMain.handle('config:get', () => getConfig());
  ipcMain.handle('config:defaults', () => JSON.parse(JSON.stringify(DEFAULT_CONFIG)));
  ipcMain.handle('config:save', (event, patch) => {
    config = saveConfig(patch);
    jobs.getConfig = () => config;
    services.getConfig = () => config;
    broadcastConfig();
    return config;
  });

  ipcMain.handle('system:info', () => systemInfo(getConfig(), APP_VERSION));
  ipcMain.handle('system:models', () => modelStatus(getConfig()));

  ipcMain.handle('dialog:pickFiles', async (event, options = {}) => {
    const kind = options.kind || 'any';
    const filters = kind === 'image'
      ? [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'tif', 'tiff'] }]
      : kind === 'video'
        ? [{ name: 'Videos', extensions: ['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v'] }]
        : [{ name: 'All files', extensions: ['*'] }];
    const result = await dialog.showOpenDialog(mainWindow, {
      title: options.title || 'Choose files',
      properties: ['openFile', 'multiSelections'],
      filters
    });
    return result.canceled ? [] : result.filePaths;
  });

  ipcMain.handle('dialog:pickFolder', async (event, options = {}) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: options.title || 'Choose folder',
      defaultPath: options.defaultPath,
      properties: ['openDirectory', 'createDirectory']
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('jobs:start', (event, { kind, payload }) => jobs.enqueue(kind, payload));
  ipcMain.handle('jobs:list', () => jobs.list());
  ipcMain.handle('jobs:get', (event, id) => jobs.get(id));
  ipcMain.handle('jobs:log', (event, id) => jobs.readLog(id));
  ipcMain.handle('jobs:cancel', (event, id) => jobs.cancel(id));

  ipcMain.handle('path:open', async (event, targetPath) => {
    if (!targetPath) return 'No path provided.';
    return shell.openPath(targetPath);
  });
  ipcMain.handle('path:reveal', (event, targetPath) => {
    if (!targetPath) return false;
    shell.showItemInFolder(targetPath);
    return true;
  });
  ipcMain.handle('path:openFolder', async (event, targetPath) => {
    if (!targetPath) return 'No path provided.';
    return shell.openPath(targetPath);
  });
  ipcMain.handle('external:open', async (event, url) => {
    if (!/^https?:\/\//i.test(url)) return false;
    await shell.openExternal(url);
    return true;
  });

  ipcMain.handle('services:list', () => services.getAll());
  ipcMain.handle('services:start', async (event, name) => services.start(name));
  ipcMain.handle('services:stop', async (event, name) => services.stop(name));
  ipcMain.handle('services:log', (event, name) => services.readLog(name));

  ipcMain.handle('app:openWorkspace', () => shell.openPath(getConfig().workspace));
  ipcMain.handle('app:openLogs', () => shell.openPath(path.join(getConfig().workspace, 'logs')));
}

if (gotLock) {
  app.whenReady().then(async () => {
    config = loadConfig();
    mediaServer = await startMediaServer();
    services = new ServiceManager(() => config, APP_ROOT);
    jobs = new JobManager(() => config);
    registerIpc();

    jobs.on('update', (job) => send('job:update', job));
    jobs.on('log', (entry) => send('job:log', entry));
    services.on('update', (status) => send('service:update', status));

    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (event) => {
  if (isQuitting) return;
  event.preventDefault();
  isQuitting = true;
  Promise.resolve(jobs?.shutdown())
    .then(() => services?.stopAll())
    .catch(() => {})
    .finally(async () => {
      try { await mediaServer?.close(); } catch { /* ignore */ }
      setTimeout(() => app.quit(), 250);
    });
});
