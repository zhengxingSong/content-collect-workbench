// ServiceManager 无 GUI 冒烟测试：启动后端+MCP → 就绪检查 → 状态 → 全部停止。
// 运行：node smoke.js  （完成后打印 SERVICE_SMOKE_OK）

const os = require('os');
const path = require('path');
const { ServiceManager } = require('./src/service-manager');
const { ServiceLogger } = require('./src/logger');
const { ConfigStore } = require('./src/config');

(async () => {
  const tmp = path.join(os.tmpdir(), `mp-desktop-smoke-${Date.now()}`);
  fs_mkdir(tmp);
  const logger = new ServiceLogger(path.join(tmp, 'logs'), 'services');
  const cfg = new ConfigStore(tmp);
  cfg.data.backendPort = 5202;
  cfg.data.mcpPort = 3335;
  const projectRoot = path.resolve(__dirname, '..');
  const sm = new ServiceManager(cfg, logger, projectRoot);

  const urls = await sm.startAll();
  console.log('ready:', JSON.stringify(urls));
  const status = sm.status();
  console.log('status:', JSON.stringify(status));
  const allRunning = Object.values(status).every((s) => s.running);
  sm.stopAll();
  await new Promise((r) => setTimeout(r, 3000));
  const after = sm.status();
  console.log('after stop:', JSON.stringify(after));
  if (allRunning && Object.values(after).every((s) => !s.running)) {
    console.log('SERVICE_SMOKE_OK');
    process.exit(0);
  }
  console.log('SERVICE_SMOKE_FAIL');
  process.exit(1);

  function fs_mkdir(p) { require('fs').mkdirSync(p, { recursive: true }); }
})();
