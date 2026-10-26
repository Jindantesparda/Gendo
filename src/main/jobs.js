'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const { createPlan } = require('./recipes');

const VIDEO_EXT = new Set(['.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tif', '.tiff']);
const MODEL_EXT = new Set(['.obj', '.fbx', '.ply', '.glb', '.gltf', '.npz', '.usdz']);

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function clock() {
  return new Date().toLocaleTimeString([], { hour12: false });
}

function classify(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (VIDEO_EXT.has(ext)) return 'video';
  if (IMAGE_EXT.has(ext)) return 'image';
  if (MODEL_EXT.has(ext)) return 'model';
  if (ext === '.zip') return 'archive';
  return 'data';
}

function walkFiles(root, limit = 160) {
  const found = [];
  const skipDirs = new Set(['preprocess', '__pycache__', '.git', 'node_modules', 'fusion_work']);
  const stack = [root];
  while (stack.length && found.length < limit) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (found.length >= limit) break;
      if (entry.name.startsWith('.') && entry.name !== '.gitignore') continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) stack.push(full);
      } else if (entry.isFile()) {
        let size = 0;
        try { size = fs.statSync(full).size; } catch { /* ignore */ }
        found.push({
          path: full,
          relative: path.relative(root, full).replace(/\\/g, '/'),
          name: entry.name,
          ext: path.extname(entry.name).toLowerCase(),
          type: classify(entry.name),
          size
        });
      }
    }
  }
  const priority = { video: 0, image: 1, model: 2, archive: 3, data: 4 };
  found.sort((a, b) => (priority[a.type] ?? 9) - (priority[b.type] ?? 9) || a.relative.localeCompare(b.relative));
  return found;
}

class JobManager extends EventEmitter {
  constructor(getConfig) {
    super();
    this.getConfig = getConfig;
    this.jobs = new Map();
    this.plans = new Map();
    this.queue = [];
    this.activeCount = 0;
    this.shuttingDown = false;
    this.loadHistory();
  }

  loadHistory() {
    const { workspace } = this.getConfig();
    const jobsDir = path.join(workspace, 'jobs');
    let entries = [];
    try {
      entries = fs.readdirSync(jobsDir, { withFileTypes: true }).filter((e) => e.isDirectory());
    } catch {
      return;
    }
    for (const entry of entries) {
      const manifestPath = path.join(jobsDir, entry.name, 'job.json');
      try {
        const job = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        if (job.status === 'running' || job.status === 'queued') {
          job.status = 'failed';
          job.phase = 'Interrupted';
          job.error = 'Gendo closed before this job finished.';
          job.finishedAt = new Date().toISOString();
          if (job.startedAt) job.durationMs = Date.now() - Date.parse(job.startedAt);
          this.persist(job);
        }
        this.jobs.set(job.id, job);
      } catch {
        // Ignore malformed or partial jobs.
      }
    }
  }

  list() {
    return [...this.jobs.values()]
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .map((job) => this.publicJob(job));
  }

  get(id) {
    const job = this.jobs.get(id);
    return job ? this.publicJob(job) : null;
  }

  publicJob(job) {
    return {
      id: job.id,
      kind: job.kind,
      title: job.title,
      summary: job.summary,
      status: job.status,
      phase: job.phase,
      createdAt: job.createdAt,
      startedAt: job.startedAt || null,
      finishedAt: job.finishedAt || null,
      durationMs: job.durationMs || null,
      stageIndex: job.stageIndex || 0,
      stageCount: job.stageCount || 0,
      stageNames: job.stageNames || [],
      params: job.params || {},
      inputs: job.inputs || [],
      outputDir: job.outputDir,
      logPath: job.logPath,
      error: job.error || null,
      exitCode: job.exitCode ?? null,
      outputs: job.outputs || []
    };
  }

  persist(job) {
    try {
      fs.writeFileSync(path.join(job.jobDir, 'job.json'), JSON.stringify(job, null, 2), 'utf8');
    } catch (error) {
      console.error('Could not persist job:', error.message);
    }
  }

  emitUpdate(job) {
    this.emit('update', this.publicJob(job));
  }

  writeLog(job, text, stream = 'system') {
    let line = String(text)
      .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
      .replace(/\r$/, '');
    if (line.includes('\r')) {
      const segments = line.split('\r').filter((segment) => segment.trim() !== '');
      line = segments[segments.length - 1] || '';
    }
    if (line === '' && stream !== 'system') return;
    const stamped = `[${clock()}] ${line}`;
    try {
      fs.appendFileSync(job.logPath, `${stamped}\n`, 'utf8');
    } catch {
      // Ignore log write failures.
    }
    this.emit('log', { id: job.id, line: stamped, stream });
  }

  enqueue(kind, payload) {
    if (this.shuttingDown) throw new Error('Gendo is shutting down.');
    const config = this.getConfig();
    const safeKind = String(kind);
    const id = `${timestamp()}-${safeKind}-${Math.random().toString(16).slice(2, 6)}`;
    const jobDir = path.join(config.workspace, 'jobs', id);
    fs.mkdirSync(jobDir, { recursive: true });

    const plan = createPlan({ kind: safeKind, payload, jobDir, config });
    this.plans.set(id, plan);
    const createdAt = new Date().toISOString();
    const job = {
      id,
      kind: safeKind,
      title: plan.title,
      summary: plan.summary,
      status: 'queued',
      phase: 'Queued',
      createdAt,
      startedAt: null,
      finishedAt: null,
      durationMs: null,
      stageIndex: 0,
      stageCount: plan.stages.length,
      stageNames: plan.stages.map((s) => s.name),
      params: plan.params || payload,
      inputs: plan.inputs || [],
      jobDir,
      outputDir: path.join(jobDir, 'output'),
      logPath: path.join(jobDir, 'job.log'),
      error: null,
      exitCode: null,
      outputs: [],
      cancelRequested: false
    };

    fs.writeFileSync(job.logPath, '', 'utf8');
    this.jobs.set(id, job);
    this.queue.push(id);
    this.persist(job);
    this.emitUpdate(job);
    this.pump();
    return this.publicJob(job);
  }

  pump() {
    if (this.shuttingDown) return;
    const config = this.getConfig();
    const limit = Math.max(1, Math.min(2, Number(config.maxConcurrentJobs) || 1));
    while (this.activeCount < limit && this.queue.length > 0) {
      const id = this.queue.shift();
      const job = this.jobs.get(id);
      if (!job || job.status !== 'queued') continue;
      this.activeCount += 1;
      this.runJob(job)
        .catch((error) => console.error('Job runner error:', error))
        .finally(() => {
          this.activeCount -= 1;
          this.pump();
        });
    }
  }

  startProcess(job, stage) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let child;
      try {
        const env = {
          ...process.env,
          PYTHONUNBUFFERED: '1',
          PYTHONIOENCODING: 'utf-8',
          PYTHONNOUSERSITE: '1',
          GRADIO_ANALYTICS_ENABLED: 'False',
          ...(stage.env || {})
        };
        child = spawn(stage.command, stage.args, {
          cwd: stage.cwd,
          env,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe']
        });
      } catch (error) {
        reject(error);
        return;
      }

      job.currentChild = child;
      const forward = (stream) => {
        let buffer = '';
        stream.setEncoding('utf8');
        stream.on('data', (chunk) => {
          buffer += chunk;
          const parts = buffer.split(/\r?\n/);
          buffer = parts.pop();
          for (const line of parts) {
            if (line.trim() !== '') this.writeLog(job, line, stream === child.stdout ? 'stdout' : 'stderr');
          }
        });
        stream.on('end', () => {
          if (buffer.trim() !== '') this.writeLog(job, buffer, stream === child.stdout ? 'stdout' : 'stderr');
          buffer = '';
        });
      };
      forward(child.stdout);
      forward(child.stderr);

      child.once('error', (error) => {
        if (settled) return;
        settled = true;
        job.currentChild = null;
        reject(error);
      });
      child.once('close', (code, signal) => {
        if (settled) return;
        settled = true;
        job.currentChild = null;
        resolve({ code, signal });
      });
    });
  }

  killCurrentProcess(job) {
    const child = job.currentChild;
    if (!child || !child.pid) return;
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
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

  async runJob(job) {
    const config = this.getConfig();
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    job.phase = 'Preparing';
    this.persist(job);
    this.emitUpdate(job);

    try {
      if (job.cancelRequested) throw new Error('__CANCELLED__');
      const plan = this.plans.get(job.id)
        || createPlan({ kind: job.kind, payload: job.params, jobDir: job.jobDir, config });
      job.stageNames = plan.stages.map((s) => s.name);
      job.stageCount = plan.stages.length;

      for (let i = 0; i < plan.stages.length; i += 1) {
        if (job.cancelRequested) throw new Error('__CANCELLED__');
        const stage = plan.stages[i];
        job.stageIndex = i + 1;
        job.phase = stage.name;
        this.persist(job);
        this.emitUpdate(job);
        this.writeLog(job, `=== ${stage.name} (${i + 1}/${plan.stages.length}) ===`, 'system');
        const result = await this.startProcess(job, stage);
        job.exitCode = result.code;
        if (job.cancelRequested) throw new Error('__CANCELLED__');
        if (result.code !== 0) {
          throw new Error(`${stage.name} exited with code ${result.code}${result.signal ? ` (${result.signal})` : ''}.`);
        }
      }

      job.status = 'completed';
      job.phase = 'Complete';
      job.finishedAt = new Date().toISOString();
      job.durationMs = Date.now() - Date.parse(job.startedAt);
      job.outputs = walkFiles(job.outputDir);
      this.writeLog(job, `Job complete · ${job.outputs.length} output file(s)`, 'system');
    } catch (error) {
      job.finishedAt = new Date().toISOString();
      job.durationMs = job.startedAt ? Date.now() - Date.parse(job.startedAt) : null;
      if (job.cancelRequested || String(error.message) === '__CANCELLED__') {
        job.status = 'cancelled';
        job.phase = 'Cancelled';
        job.error = 'Cancelled by user.';
        this.writeLog(job, 'Job cancelled.', 'system');
      } else {
        job.status = 'failed';
        job.phase = 'Failed';
        job.error = error.message;
        this.writeLog(job, `ERROR: ${error.message}`, 'stderr');
      }
      job.outputs = walkFiles(job.outputDir);
    } finally {
      job.currentChild = null;
      job.cancelRequested = false;
      this.plans.delete(job.id);
      this.persist(job);
      this.emitUpdate(job);
    }
  }

  cancel(id) {
    const job = this.jobs.get(id);
    if (!job) return false;

    if (job.status === 'queued') {
      this.queue = this.queue.filter((queuedId) => queuedId !== id);
      this.plans.delete(id);
      job.status = 'cancelled';
      job.phase = 'Cancelled';
      job.error = 'Cancelled before starting.';
      job.finishedAt = new Date().toISOString();
      this.writeLog(job, 'Job cancelled before starting.', 'system');
      this.persist(job);
      this.emitUpdate(job);
      return true;
    }

    if (job.status === 'running') {
      job.cancelRequested = true;
      job.phase = 'Cancelling';
      this.persist(job);
      this.emitUpdate(job);
      this.writeLog(job, 'Cancellation requested…', 'system');
      this.killCurrentProcess(job);
      return true;
    }

    return false;
  }

  readLog(id, maxBytes = 220000) {
    const job = this.jobs.get(id);
    if (!job) return '';
    try {
      const stat = fs.statSync(job.logPath);
      const start = Math.max(0, stat.size - maxBytes);
      const length = stat.size - start;
      const fd = fs.openSync(job.logPath, 'r');
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, start);
      fs.closeSync(fd);
      return buffer
        .toString('utf8')
        .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
        .split(/\r?\n/)
        .map((line) => {
          const segments = line.split('\r').filter((segment) => segment.trim() !== '');
          return segments[segments.length - 1] || line;
        })
        .join('\n');
    } catch {
      return '';
    }
  }

  async shutdown() {
    this.shuttingDown = true;
    const waits = [];
    for (const job of this.jobs.values()) {
      if (job.status === 'running') {
        const child = job.currentChild;
        job.cancelRequested = true;
        if (child && child.exitCode === null) {
          waits.push(new Promise((resolve) => {
            const timer = setTimeout(resolve, 5000);
            child.once('close', () => {
              clearTimeout(timer);
              resolve();
            });
          }));
        }
        this.killCurrentProcess(job);
      }
    }
    await Promise.all(waits);
  }
}

module.exports = { JobManager };
