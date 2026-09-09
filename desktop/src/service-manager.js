// 进程监督（设计文档 §15）：spawn / 就绪轮询 / 指数退避重启（带故障预算）/ 优雅停止。
//
// 启动序列（§5 连接信息管理）：
//   1. 后端就绪（/api/settings 200）→ 2. 注入实际地址启动 MCP → 3. MCP 就绪（/health）

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

function fetchOk(url, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 500);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

async function waitReady(url, timeoutMs, onTick) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fetchOk(url)) return true;
    if (onTick) onTick();
    await new Promise((r) => setTimeout(r, 800));
  }
  return false;
}

class ManagedService {
  /**
   * @param name 服务名（日志文件名）
   * @param command 启动命令（数组 argv）
   * @param options { cwd, env, readyUrl, readyTimeoutMs, logger, budget }
   */
  constructor(name, command, options) {
    this.name = name;
    this.command = command;
    this.cwd = options.cwd;
    this.env = options.env || {};
    this.readyUrl = options.readyUrl;
    this.readyTimeoutMs = options.readyTimeoutMs || 30000;
    this.logger = options.logger;
    this.budget = options.budget || { restartBudget: 5, restartWindowMs: 3600000 };
    this.child = null;
    this.restarts = [];            // 重启时间戳（滑动窗口预算）
    this.fatal = null;             // 不可重启错误（配置/端口冲突）
    this.stopping = false;
  }

  isRunning() {
    return this.child !== null && this.child.exitCode === null;
  }

  async start() {
    if (this.isRunning()) return true;
    this.stopping = false;
    this.logger.info(`${this.name}: starting: ${this.command.join(' ')}`);
    try {
      this.child = spawn(this.command[0], this.command.slice(1), {
        cwd: this.cwd,
        env: { ...process.env, ...this.env },
        windowsHide: true,
      });
    } catch (e) {
      this.fatal = `spawn failed: ${e.message}`;
      this.logger.error(`${this.name}: ${this.fatal}`);
      return false;
    }
    const child = this.child;
    child.stdout.on('data', (d) => this.logger.info(d.toString().trim()));
    child.stderr.on('data', (d) => this.logger.error(d.toString().trim()));
    child.on('exit', (code, signal) => {
      this.logger.info(`${this.name}: exited code=${code} signal=${signal}`);
      this.child = null;
      // 意外退出 → 预算内退避重启（§15）；stopping 时不重启
      if (!this.stopping && !this.fatal) this.scheduleRestart();
    });

    if (!this.readyUrl) return true;
    const ok = await waitReady(this.readyUrl, this.readyTimeoutMs,
      () => { if (!this.isRunning()) this.fatal = 'exited before ready'; });
    if (!ok) {
      this.logger.error(`${this.name}: not ready within ${this.readyTimeoutMs}ms`);
      if (this.isRunning()) { this.logger.error(`${this.name}: stopping unready process`); this.stop(); }
      return false;
    }
    this.logger.info(`${this.name}: ready at ${this.readyUrl}`);
    return true;
  }

  scheduleRestart() {
    const now = Date.now();
    this.restarts = this.restarts.filter((t) => now - t < this.budget.restartWindowMs);
    if (this.restarts.length >= this.budget.restartBudget) {
      this.fatal = `restart budget exhausted (${this.budget.restartBudget}/hour)`;
      this.logger.error(`${this.name}: ${this.fatal}`);
      return;
    }
    const attempt = this.restarts.push(now);
    const delay = Math.min(30000, 1000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 500);
    this.logger.info(`${this.name}: restarting in ${delay}ms (attempt ${attempt})`);
    setTimeout(() => { if (!this.stopping) this.start(); }, delay);
  }

  stop() {
    this.stopping = true;
    if (!this.isRunning()) return;
    const pid = this.child.pid;
    this.logger.info(`${this.name}: stopping pid=${pid}`);
    if (process.platform === 'win32') {
      spawn('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true });
    } else {
      this.child.kill('SIGTERM');
      setTimeout(() => { if (this.child && this.child.exitCode === null) this.child.kill('SIGKILL'); }, 3000);
    }
  }
}

class DockerComposeService {
  /** docker compose 模式（用户决策 2026-09-06）：宿主机不再跑 Python，服务由 compose 托管。 */
  constructor(name, composeArgs, readyUrl, logger) {
    this.name = name;
    this.composeArgs = composeArgs;   // ['up','-d'] / ['stop']
    this.readyUrl = readyUrl;
    this.logger = logger;
    this.ready = false;
    this.fatal = null;
  }

  _exec(args) {
    return new Promise((resolve) => {
      const child = spawn('docker', ['compose', ...args], { windowsHide: true });
      child.stdout.on('data', (d) => this.logger.info(`compose: ${d.toString().trim()}`));
      child.stderr.on('data', (d) => this.logger.info(`compose: ${d.toString().trim()}`));
      child.on('exit', (code) => resolve(code === 0));
      child.on('error', (e) => { this.logger.error(`docker: ${e.message}`); resolve(false); });
    });
  }

  async probe() {
    return await fetchOk(this.readyUrl, 1200);
  }

  async start() {
    this.logger.info(`${this.name}: docker compose up -d`);
    // 先 build 再 up（构建有缓存，重复执行代价小，且保证代码最新）
    if (!await this._exec(['up', '-d', '--build'])) {
      this.fatal = 'docker compose up 失败：请确认 Docker Desktop 已运行';
      this.logger.error(`${this.name}: ${this.fatal}`);
      return false;
    }
    const ok = await waitReady(this.readyUrl, 60000,
      () => { /* compose 内部有 restart 策略，这里只轮询就绪 */ });
    this.ready = ok;
    if (!ok) {
      this.fatal = '容器未在 60s 内就绪，请查看 docker compose logs';
      this.logger.error(`${this.name}: ${this.fatal}`);
      return false;
    }
    this.logger.info(`${this.name}: ready at ${this.readyUrl}`);
    return true;
  }

  async stop() {
    this.logger.info(`${this.name}: docker compose stop`);
    await this._exec(['stop']);
    this.ready = false;
  }

  isRunning() { return this.ready; }
}

class ServiceManager {
  /**
   * @param cfg { ConfigStore }
   * @param logger { ServiceLogger }
   * @param projectRoot 仓库根（含 venv312 与 backend/）
   */
  constructor(cfg, logger, projectRoot) {
    this.cfg = cfg;
    this.logger = logger;
    this.projectRoot = projectRoot;
    this.services = {};
    this.backendUrl = null;
    this.mcpUrl = null;
  }

  pythonExe() {
    const win = process.platform === 'win32';
    const p = path.join(this.projectRoot, 'venv312', win ? 'Scripts' : 'bin', win ? 'python.exe' : 'python');
    return fs.existsSync(p) ? p : 'python';
  }

  async startAll() {
    const { host } = this.cfg.data;
    const backendPort = this.cfg.data.backendPort;
    const mcpPort = this.cfg.data.mcpPort;
    this.backendUrl = `http://${host}:${backendPort}`;
    this.mcpUrl = `http://${host}:${mcpPort}`;

    // Docker 模式（用户决策 2026-09-06）：compose 托管 backend + mcp + wewe-rss
    if ((this.cfg.data.runtimeMode || 'python') === 'docker') {
      const backend = new DockerComposeService('backend', ['up', '-d', '--build'],
        `${this.backendUrl}/api/settings`, this.logger);
      const mcp = new DockerComposeService('mcp', [], `${this.mcpUrl}/health`, this.logger);
      this.services.backend = backend;
      this.services.mcp = mcp;

      if (!await backend.start()) {
        throw new Error(backend.fatal);
      }
      if (!await mcp.start()) {
        throw new Error(mcp.fatal);
      }
      return { backendUrl: this.backendUrl, mcpUrl: this.mcpUrl, mode: 'docker' };
    }

    const py = this.pythonExe();
    const budget = { restartBudget: this.cfg.data.restartBudget, restartWindowMs: this.cfg.data.restartWindowMs };

    // 1. Flask 后端
    const backend = new ManagedService('backend',
      [py, 'app.py', '--no-browser', '--port', String(backendPort), '--host', host],
      { cwd: this.projectRoot, readyUrl: `${this.backendUrl}/api/settings`,
        env: { WECHAT_MP_PORT: String(backendPort) },
        logger: this.logger, budget });
    // 2. MCP（注入实际后端地址，§5）
    const mcp = new ManagedService('mcp',
      [py, '-m', 'backend.mcp_server', '--port', String(mcpPort), '--host', host],
      { cwd: this.projectRoot, readyUrl: `${this.mcpUrl}/health`,
        env: { CONTENT_COLLECT_WORKBENCH_URL: this.backendUrl },
        logger: this.logger, budget });

    this.services.backend = backend;
    this.services.mcp = mcp;

    const backendOk = await backend.start();
    if (!backendOk) {
      throw new Error(`后端启动失败：请检查 Python 环境（${py}）与端口 ${backendPort} 占用情况`);
    }
    const mcpOk = await mcp.start();
    if (!mcpOk) {
      throw new Error(`MCP 服务启动失败：请检查端口 ${mcpPort} 占用情况`);
    }
    return { backendUrl: this.backendUrl, mcpUrl: this.mcpUrl };
  }

  async stopAll() {
    // Docker 模式：compose stop（容器内服务由 restart 策略托管）
    if (this.services.backend instanceof DockerComposeService) {
      await this.services.backend.stop();
      return;
    }
    Object.values(this.services).forEach((s) => s.stop());
  }

  status() {
    return Object.fromEntries(Object.entries(this.services).map(([k, s]) =>
      [k, { running: s.isRunning(), fatal: s.fatal, url: s.readyUrl || null }]));
  }
}

const fs = require('fs');
module.exports = { ServiceManager, ManagedService, fetchOk };
