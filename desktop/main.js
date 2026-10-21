/* Electron 外壳：启动本地 Python 服务并加载页面 */
const { app, BrowserWindow, dialog } = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const http = require("http");

const PORT = 8765;
let child = null;
let win = null;
let quitting = false;

function probe(callback, retries) {
  http
    .get({ host: "127.0.0.1", port: PORT, path: "/api/health", timeout: 800 }, (res) => {
      res.resume();
      callback(true);
    })
    .on("error", () => {
      if (retries <= 0) return callback(false);
      setTimeout(() => probe(callback, retries - 1), 400);
    });
}

function startServer() {
  const root = app.isPackaged ? process.resourcesPath : path.join(__dirname, "..");
  const isWin = process.platform === "win32";
  const cmd = isWin ? "python" : "python3";
  child = spawn(cmd, ["main.py", "--no-browser"], {
    cwd: root,
    windowsHide: true,
    env: Object.assign({}, process.env, { PYTHONIOENCODING: "utf-8" }),
  });

  child.on("error", () => {
    // 部分 Windows 环境只提供 py 启动器
    if (isWin) {
      child = spawn("py", ["main.py", "--no-browser"], { cwd: root, windowsHide: true });
    }
  });
  child.stderr.on("data", (d) => console.log("[python]", String(d).trim()));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1080,
    minHeight: 720,
    backgroundColor: "#080d11",
    autoHideMenuBar: true,
    title: "镜界 MIRROR · AI 数字人陪练",
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.loadURL(`http://127.0.0.1:${PORT}`);
}

app.whenReady().then(() => {
  startServer();
  probe((ok) => {
    if (!ok) {
      dialog.showErrorBox(
        "服务启动失败",
        "未能启动本地服务。请确认已安装 Python 3.9+ 并加入 PATH，或直接双击 start.bat 使用浏览器模式。"
      );
      app.quit();
      return;
    }
    createWindow();
  }, 20);
});

app.on("window-all-closed", () => {
  quitting = true;
  if (child) child.kill();
  app.quit();
});

app.on("before-quit", () => {
  quitting = true;
  if (child) child.kill();
});

process.on("exit", () => {
  if (child && !quitting) child.kill();
});
