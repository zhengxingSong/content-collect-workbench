// 配置存储：userData 下 config.json。

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  backendPort: 5200,
  mcpPort: 3333,
  host: '127.0.0.1',
  // 运行模式：python（Electron 直接监督本机进程）| docker（docker compose 托管全栈）
  runtimeMode: 'python',
  // 退避重启故障预算（设计文档 §15）
  restartBudget: 5,
  restartWindowMs: 60 * 60 * 1000,
};

class ConfigStore {
  constructor(userDataDir) {
    this.file = path.join(userDataDir, 'config.json');
    this.data = { ...DEFAULTS };
    try {
      this.data = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(this.file, 'utf-8')) };
    } catch (_) { /* 首次运行 */ }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }
}

module.exports = { ConfigStore };
