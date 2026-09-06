// 内容收集工作台 — Electron 主进程。
//
// 参照 llama.cpp desktop 模式（设计文档 §6）：托盘常驻、关窗隐藏、单实例、
// 进程监督（ServiceManager）、崩溃退避重启（带故障预算）。
// 渲染层直接加载 Flask 后端 SPA（复用现有 frontend，不重写 UI）。

const { app, BrowserWindow, Tray, Menu, dialog, nativeImage, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const { ConfigStore } = require('./src/config');
const { ServiceLogger } = require('./src/logger');
const { ServiceManager } = require('./src/service-manager');

let mainWindow = null;
let tray = null;
let quitting = false;
let serviceManager = null;
let configStore = null;
let logger = null;

// 单实例锁（§6）
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

app.on('second-instance', () => {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  }
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: '内容收集工作台',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,     // §4 Electron 加固
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  // 关窗隐藏到托盘（§6）
  mainWindow.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  // 外链交给系统浏览器，不在桌面特权页面内导航（§4）
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost')) {
      return { action: 'allow' };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });

  loadApp();
}

async function loadApp() {
  const backendUrl = serviceManager && serviceManager.backendUrl;
  if (backendUrl && serviceManager.services.backend && serviceManager.services.backend.isRunning()) {
    await mainWindow.loadURL(backendUrl);
  } else {
    // 后端未就绪的降级页
    await mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`
      <html><body style="font-family:sans-serif;background:#1b1e28;color:#eee;
        display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
        <div style="text-align:center">
          <h2>服务启动中…</h2>
          <p id="status">正在启动后端与 MCP 服务，窗口将自动跳转。</p>
          <p style="opacity:.6">日志：${app.getPath('userData')}\\\\logs</p>
        </div>
        <script>setTimeout(()=>location.reload(), 2000)<\/script>
      </body></html>`));
  }
}

function createTray() {
  // 空图标占位；正式图标由 resources/icon.ico 提供
  const iconPath = path.join(__dirname, 'resources', 'icon.ico');
  const icon = fs.existsSync(iconPath)
    ? nativeImage.createFromPath(iconPath)
    : nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip('内容收集工作台');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示主窗口', click: () => { if (mainWindow) mainWindow.show(); } },
    { type: 'separator' },
    { label: '退出（停止全部服务）', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('double-click', () => { if (mainWindow) mainWindow.show(); });
}

async function startServices() {
  // 打包模式：服务栈位于 resources/service（extraResources，§16 打包布局）
  const projectRoot = app.isPackaged
    ? path.join(process.resourcesPath, 'service')
    : path.resolve(__dirname, '..');
  configStore = new ConfigStore(app.getPath('userData'));
  logger = new ServiceLogger(path.join(app.getPath('userData'), 'logs'), 'services');
  serviceManager = new ServiceManager(configStore, logger, projectRoot);

  try {
    const urls = await serviceManager.startAll();
    logger.info(`all services ready: ${JSON.stringify(urls)}`);
  } catch (e) {
    logger.error(`startup failed: ${e.message}`);
    dialog.showErrorBox('启动失败', e.message + '\n\n应用将继续运行，可从托盘退出。');
  }
}

app.whenReady().then(async () => {
  createTray();
  createWindow();
  await startServices();
  await loadApp();  // 服务就绪后（重）加载真实 SPA
});

app.on('window-all-closed', () => {
  // 托盘常驻：不随窗口关闭退出
});

app.on('before-quit', () => {
  quitting = true;
});

// 退出顺序（§15）：停止接单（服务自停）→ 停止子进程；后端自身负责保存状态与 mitm 清理
app.on('will-quit', () => {
  if (serviceManager) serviceManager.stopAll();
});
