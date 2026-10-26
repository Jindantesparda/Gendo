'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { findFreePort } = require('./ports');
const { startMazanokeServer } = require('./localServer');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function httpReady(url, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const request = http.get(url, { timeout: timeoutMs }, (response) => {
      response.resume();
      resolve(response.statusCode >= 200 && response.statusCode < 500);
    });
    request.once('timeout', () => {
      request.destroy();
      resolve(false);
    });
    request.once('error', () => resolve(false));
  });
}

class ServiceManager extends EventEmitter {
  constructor(getConfig, appRoot) {
    super();
    this.getConfig = getConfig;
    this.appRoot = appRoot;
    this.mazanokeServer = null;
    this.dlssProcess = null;
    this.dlssStopping = false;
    this.startPromises = new Map();
    const logsDir = path.join(getConfig().workspace, 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    this.statuses = {
      dlss: {
        name: 'dlss',
        label: 'DLSS 5 Visual Enhancer',
        state: 'stopped',
        url: null,
        port: null,
        message: 'Ready to launch',
        logPath: path.join(logsDir, 'dlss.log')
      },
      mazanoke: {
        name: 'mazanoke',
        label: 'Mazanoke',
        state: 'stopped',
        url: null,
        port: null,
        message: 'Ready to launch',
        logPath: path.join(logsDir, 'mazanoke.log')
      }
    };
  }

  getStatus(name) {
    return { ...this.statuses[name] };
  }

  getAll() {
    return Object.fromEntries(Object.entries(this.statuses).map(([key, value]) => [key, { ...value }]));
  }

  setStatus(name, patch) {
    this.statuses[name] = { ...this.statuses[name], ...patch };
    this.emit('update', { ...this.statuses[name] });
    return this.statuses[name];
  }

  appendServiceLog(name, text) {
    try {
      fs.appendFileSync(this.statuses[name].logPath, text, 'utf8');
    } catch {
      // ignore
    }
  }

  readLog(name) {
    const logPath = this.statuses[name]?.logPath;
    if (!logPath) return '';
    try {
      const stat = fs.statSync(logPath);
      const start = Math.max(0, stat.size - 120000);
      const fd = fs.openSync(logPath, 'r');
      const buffer = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      fs.closeSync(fd);
      return buffer.toString('utf8');
    } catch {
      return '';
    }
  }

  async start(name) {
    if (name !== 'dlss' && name !== 'mazanoke') throw new Error(`Unknown service: ${name}`);
    if (this.statuses[name].state === 'running' && this.statuses[name].url) return this.getStatus(name);
    if (this.startPromises.has(name)) return this.startPromises.get(name);
    const promise = (name === 'dlss' ? this.startDlss() : this.startMazanoke())
      .finally(() => this.startPromises.delete(name));
    this.startPromises.set(name, promise);
    return promise;
  }

  async startMazanoke() {
    const config = this.getConfig();
    this.setStatus('mazanoke', { state: 'starting', message: 'Serving local Mazanoke UI…', url: null });
    fs.writeFileSync(this.statuses.mazanoke.logPath, '', 'utf8');
    try {
      this.appendServiceLog('mazanoke', `[${new Date().toISOString()}] Starting Mazanoke from ${config.paths.mazanokeRoot}\n`);
      this.mazanokeServer = await startMazanokeServer(config.paths.mazanokeRoot);
      this.appendServiceLog('mazanoke', `[${new Date().toISOString()}] Running at ${this.mazanokeServer.url}\n`);
      return this.setStatus('mazanoke', {
        state: 'running',
        url: this.mazanokeServer.url,
        port: this.mazanokeServer.port,
        message: 'Running locally'
      });
    } catch (error) {
      this.appendServiceLog('mazanoke', `ERROR: ${error.stack || error.message}\n`);
      throw error;
    }
  }

  async startDlss() {
    const config = this.getConfig();
    const port = await findFreePort(7864, 20);
    const wrapper = path.join(this.appRoot, 'services', 'dlss_server.py');
    if (!fs.existsSync(config.paths.dlssPython)) {
      throw new Error(`DLSS Python runtime not found: ${config.paths.dlssPython}`);
    }
    if (!fs.existsSync(path.join(config.paths.dlssRoot, 'app.py'))) {
      throw new Error(`DLSS app.py not found: ${config.paths.dlssRoot}`);
    }

    fs.writeFileSync(this.statuses.dlss.logPath, '', 'utf8');
    this.setStatus('dlss', { state: 'starting', port, message: 'Loading DLSS 5 models…', url: null });
    this.appendServiceLog('dlss', `[${new Date().toISOString()}] Starting DLSS on 127.0.0.1:${port}\n`);

    const child = spawn(config.paths.dlssPython, [wrapper, '--project', config.paths.dlssRoot, '--port', String(port)], {
      cwd: config.paths.dlssRoot,
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1',
        PYTHONIOENCODING: 'utf-8',
        PYTHONNOUSERSITE: '1',
        PYTHONDONTWRITEBYTECODE: '1',
        GRADIO_ANALYTICS_ENABLED: 'False',
        TERM: 'dumb'
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    this.dlssProcess = child;
    this.dlssStopping = false;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.appendServiceLog('dlss', chunk));
    child.stderr.on('data', (chunk) => this.appendServiceLog('dlss', chunk));
    child.once('exit', (code) => {
      const wasStopping = this.dlssStopping;
      this.dlssProcess = null;
      this.dlssStopping = false;
      if (!wasStopping) {
        this.setStatus('dlss', {
          state: 'error',
          url: null,
          port: null,
          message: `DLSS stopped unexpectedly (exit ${code ?? 'unknown'}).`
        });
      } else {
        this.setStatus('dlss', {
          state: 'stopped',
          url: null,
          port: null,
          message: 'Stopped'
        });
      }
    });

    const url = `http://127.0.0.1:${port}/`;
    const deadline = Date.now() + 240000;
    while (Date.now() < deadline) {
      if (!this.dlssProcess) {
        throw new Error('DLSS exited while starting. Open the service log for details.');
      }
      if (await httpReady(url)) {
        this.appendServiceLog('dlss', `[${new Date().toISOString()}] Ready at ${url}\n`);
        return this.setStatus('dlss', {
          state: 'running',
          url,
          port,
          message: 'Running locally'
        });
      }
      await delay(750);
    }

    this.dlssStopping = true;
    try { child.kill(); } catch { /* ignore */ }
    this.setStatus('dlss', {
      state: 'error',
      url: null,
      port: null,
      message: 'DLSS did not become ready in time.'
    });
    throw new Error('DLSS did not become ready in time. Open the service log for details.');
  }

  async stop(name) {
    if (name === 'mazanoke') {
      if (this.mazanokeServer) {
        await this.mazanokeServer.close();
        this.mazanokeServer = null;
      }
      this.appendServiceLog('mazanoke', `[${new Date().toISOString()}] Stopped\n`);
      return this.setStatus('mazanoke', {
        state: 'stopped',
        url: null,
        port: null,
        message: 'Stopped'
      });
    }

    if (name === 'dlss') {
      if (!this.dlssProcess) {
        return this.setStatus('dlss', { state: 'stopped', url: null, port: null, message: 'Stopped' });
      }
      this.dlssStopping = true;
      const child = this.dlssProcess;
      const pid = child.pid;
      this.appendServiceLog('dlss', `[${new Date().toISOString()}] Stopping process ${pid}\n`);
      const exited = new Promise((resolve) => {
        if (child.exitCode !== null) {
          resolve();
          return;
        }
        const timer = setTimeout(resolve, 5000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
      if (pid) {
        if (process.platform === 'win32') {
          const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore'
          });
          killer.once('error', () => {
            try { child.kill(); } catch { /* ignore */ }
          });
        } else {
          try { child.kill('SIGTERM'); } catch { /* ignore */ }
        }
      }
      await exited;
      return this.getStatus('dlss');
    }

    throw new Error(`Unknown service: ${name}`);
  }

  async stopAll() {
    await this.stop('dlss');
    await this.stop('mazanoke');
  }
}

module.exports = { ServiceManager };
