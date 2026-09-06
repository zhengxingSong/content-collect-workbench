// 按服务落盘日志（5MB 轮转）+ 凭证脱敏（设计文档 §4 / §17 #11）。

const fs = require('fs');
const path = require('path');

const MAX_SIZE = 5 * 1024 * 1024;

// 与 backend/core/log_redact.py 的规则保持一致
const REDACT_PATTERNS = [
  [/([Cc]ookie\s*:\s*).{4,}/g, '$1***REDACTED***'],
  [/([Aa]uthorization\s*[:=]\s*[Bb]earer\s+)\S+/g, '$1***REDACTED***'],
  [/("?(?:token|access_token|refresh_token|sessionid|sessionid_ss|sid_guard|sessdata|api[_-]?key|secret|passw(?:or)?d|web_session|bilibili_cookie)"?"?\s*[:=]\s*")([A-Za-z0-9_\-*.]{4})[A-Za-z0-9_\-*.]+/g, '$1$2***REDACTED***'],
  [/([?&](?:token|sessionid|sign|signature|secret|key)=)[A-Za-z0-9_\-.]{5,}/g, '$1***REDACTED***'],
  [/([Uu]uid[=/])[A-Za-z0-9\-_]{8,}/g, '$1***REDACTED***'],
];

function redact(text) {
  let out = String(text);
  for (const [pattern, repl] of REDACT_PATTERNS) {
    out = out.replace(pattern, repl);
  }
  return out;
}

class ServiceLogger {
  constructor(logDir, name) {
    this.file = path.join(logDir, `${name}.log`);
    fs.mkdirSync(logDir, { recursive: true });
  }

  write(level, line) {
    try {
      if (fs.existsSync(this.file) && fs.statSync(this.file).size > MAX_SIZE) {
        fs.renameSync(this.file, `${this.file}.1`);
      }
      const ts = new Date().toISOString();
      fs.appendFileSync(this.file, `[${ts}] [${level}] ${redact(line)}\n`);
    } catch (_) { /* 日志失败不影响主流程 */ }
  }

  info(line) { this.write('info', line); }
  error(line) { this.write('error', line); }
}

module.exports = { ServiceLogger, redact };
