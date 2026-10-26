'use strict';

const api = window.gendo;
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const PAGE_META = {
  overview: { eyebrow: 'WORKSPACE', title: 'Overview', subtitle: 'Local graphics workspace' },
  dlss: { eyebrow: 'IMAGE', title: 'DLSS 5 Enhance', subtitle: 'Embedded enhancement service' },
  mazanoke: { eyebrow: 'IMAGE', title: 'Mazanoke', subtitle: 'Local image compression' },
  deca: { eyebrow: '3D', title: 'DECA Head', subtitle: 'Portrait head reconstruction' },
  gvhmr: { eyebrow: 'MOTION', title: 'GVHMR Motion', subtitle: 'Video-to-motion reconstruction' },
  sharp: { eyebrow: '3D', title: 'SHARP View', subtitle: 'Single-image Gaussian splats' },
  sam: { eyebrow: '3D', title: 'SAM 3D Body', subtitle: 'Image-to-body reconstruction' },
  fusion: { eyebrow: 'COMPOSITION', title: 'Head Fusion', subtitle: 'DECA face on GVHMR rig' },
  activity: { eyebrow: 'JOBS', title: 'Activity', subtitle: 'Jobs, outputs and logs' },
  settings: { eyebrow: 'SYSTEM', title: 'Settings', subtitle: 'Paths, runtimes and scheduling' }
};

const TOOL_META = [
  { id: 'deca', page: 'deca', icon: 'face', label: 'DECA Head', description: 'Animated FLAME head, expression and texture.', runtime: 'deca_py310' },
  { id: 'gvhmr', page: 'gvhmr', icon: 'motion', label: 'GVHMR Motion', description: 'Body motion, camera path and FBX export.', runtime: 'gvhmr' },
  { id: 'sharp', page: 'sharp', icon: 'sharp', label: 'SHARP View', description: 'Gaussian splats and camera render from an image.', runtime: 'sharp_gpu' },
  { id: 'sam', page: 'sam', icon: 'body', label: 'SAM 3D Body', description: 'Full-body mesh reconstruction from a photo.', runtime: 'sam_3d_body' },
  { id: 'dlss', page: 'dlss', icon: 'wand', label: 'DLSS 5 Enhance', description: 'Embedded DLSS enhancement workspace.', runtime: 'embedded' },
  { id: 'mazanoke', page: 'mazanoke', icon: 'compress', label: 'Mazanoke', description: 'Embedded image compression workspace.', runtime: 'local web' }
];

const KIND_META = {
  deca: { label: 'DECA Head', icon: 'face' },
  gvhmr: { label: 'GVHMR Motion', icon: 'motion' },
  sharp: { label: 'SHARP View', icon: 'sharp' },
  sam: { label: 'SAM 3D Body', icon: 'body' },
  fusion: { label: 'Head Fusion', icon: 'fuse' }
};

const PATH_GROUPS = [
  {
    title: 'DECA',
    fields: [
      { key: 'decaRoot', label: 'Install root', folder: true },
      { key: 'decaPython', label: 'Python executable', folder: false }
    ]
  },
  {
    title: 'GVHMR',
    fields: [
      { key: 'gvhmrRoot', label: 'Install root', folder: true },
      { key: 'gvhmrPython', label: 'Python executable', folder: false },
      { key: 'blender', label: 'Blender executable', folder: false }
    ]
  },
  {
    title: 'SHARP',
    fields: [
      { key: 'sharpRoot', label: 'Install root', folder: true },
      { key: 'sharpExe', label: 'SHARP executable', folder: false },
      { key: 'sharpCheckpoint', label: 'Model checkpoint', folder: false }
    ]
  },
  {
    title: 'SAM 3D Body',
    fields: [
      { key: 'samBodyRoot', label: 'Install root', folder: true },
      { key: 'samPython', label: 'Python executable', folder: false },
      { key: 'samCheckpoint', label: 'Body checkpoint', folder: false },
      { key: 'samMhr', label: 'MHR model', folder: false }
    ]
  },
  {
    title: 'DLSS 5',
    fields: [
      { key: 'dlssRoot', label: 'Install root', folder: true },
      { key: 'dlssPython', label: 'Embedded Python', folder: false }
    ]
  },
  {
    title: 'Mazanoke',
    fields: [
      { key: 'mazanokeRoot', label: 'App folder', folder: true }
    ]
  }
];

const state = {
  appInfo: null,
  config: null,
  defaults: null,
  models: [],
  system: null,
  services: {},
  jobs: [],
  selectedJobId: null,
  selectedJob: null,
  jobLog: '',
  logAutoScroll: true,
  jobFilter: 'all',
  currentPage: 'overview',
  files: { deca: [], gvhmr: [], sharp: [], sam: [], fusionBody: [], fusionFace: [] },
  embedded: { dlss: null, mazanoke: null },
  serviceLogRequests: new Set(),
  viewerOutput: null
};

function h(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char]));
}

function icon(name, className = '') {
  return `<svg class="${className}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
}

function formatElapsed(startIso) {
  if (!startIso) return '0s';
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(startIso)) / 1000));
  const minutes = Math.floor(seconds / 60);
  const remain = seconds % 60;
  if (minutes < 1) return `${remain}s elapsed`;
  if (minutes < 60) return `${minutes}m ${String(remain).padStart(2, '0')}s elapsed`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m elapsed`;
}

function cleanError(error) {
  return String(error?.message || error || 'Unknown error')
    .replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '')
    .replace(/^Error:\s*/, '');
}

function basename(filePath) {
  return String(filePath || '').split(/[\\/]/).pop() || '';
}

function extensionOf(filePath) {
  const name = basename(filePath);
  const index = name.lastIndexOf('.');
  return index >= 0 ? name.slice(index).toLowerCase() : '';
}

function formatBytes(bytes, decimals = 1) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / (1024 ** index)).toFixed(index === 0 ? 0 : decimals)} ${units[index]}`;
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatClock(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.max(1, Math.round(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function timeAgo(iso) {
  if (!iso) return '—';
  const diff = Math.max(0, Date.now() - Date.parse(iso));
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function statusLabel(status) {
  return {
    queued: 'Queued',
    running: 'Running',
    completed: 'Complete',
    failed: 'Failed',
    cancelled: 'Cancelled'
  }[status] || status;
}

function isActiveJob(job) {
  return job && (job.status === 'running' || job.status === 'queued');
}

function modelById(id) {
  return state.models.find((model) => model.id === id);
}

function modelReadinessClass(model) {
  if (!model) return 'missing';
  return model.state === 'ready' ? 'ready' : model.state === 'partial' ? 'warn' : 'error';
}

function modelReadinessLabel(model) {
  if (!model) return 'Checking';
  if (model.state === 'ready') return 'Ready';
  if (model.state === 'partial') return 'Partial';
  return 'Missing';
}

function toast(message, type = 'ok') {
  const stack = $('#toastStack');
  const item = document.createElement('div');
  item.className = `toast ${type === 'error' ? 'error' : ''}`;
  item.innerHTML = `${icon(type === 'error' ? 'alert' : 'check')}<span>${h(message)}</span>`;
  stack.appendChild(item);
  setTimeout(() => {
    item.classList.add('hide');
    setTimeout(() => item.remove(), 260);
  }, 4200);
}

function updateJobBadge() {
  const active = state.jobs.filter(isActiveJob);
  const running = active.find((job) => job.status === 'running');
  const topAction = $('.top-action');
  const topText = $('#topActionText');
  const navCount = $('#navJobCount');
  const pill = $('#jobsPill');

  topAction.classList.toggle('running', active.length > 0);
  if (running) topText.textContent = `${running.phase || 'Running'} · ${running.title.split('·')[0].trim()}`;
  else if (active.length) topText.textContent = `${active.length} job${active.length === 1 ? '' : 's'} queued`;
  else topText.textContent = 'No active jobs';

  navCount.hidden = active.length === 0;
  navCount.textContent = String(active.length);

  pill.hidden = active.length === 0;
  if (running) {
    $('#jobsPillText').textContent = `${running.title.split('·')[0].trim()} · ${running.phase}`;
    pill.querySelector('.spinner').hidden = false;
  } else if (active.length) {
    $('#jobsPillText').textContent = `${active.length} job${active.length === 1 ? '' : 's'} queued`;
    pill.querySelector('.spinner').hidden = false;
  }
}

function renderServiceDots() {
  for (const name of ['dlss', 'mazanoke']) {
    const dot = document.querySelector(`[data-service-dot="${name}"]`);
    if (!dot) continue;
    const status = state.services[name];
    dot.className = 'nav-dot';
    if (status?.state === 'running') dot.classList.add('running');
    if (status?.state === 'error') dot.classList.add('error');
    dot.title = status?.state === 'running'
      ? 'Service running'
      : status?.state === 'starting'
        ? 'Service starting'
        : status?.state === 'error'
          ? 'Service error'
          : 'Service stopped';
  }
}

function renderStats() {
  const active = state.jobs.filter(isActiveJob);
  const running = state.jobs.filter((job) => job.status === 'running');
  const queued = active.length - running.length;
  const completed = state.jobs.filter((job) => job.status === 'completed').length;
  const readyModels = state.models.filter((model) => model.state === 'ready').length;

  $('#statRunning').textContent = String(active.length);
  $('#statQueue').textContent = queued > 0 ? `${queued} queued` : running.length ? 'in progress' : 'queue clear';
  $('#statCompleted').textContent = String(completed);
  $('#statReady').textContent = state.models.length ? `${readyModels} / ${state.models.length}` : '—';
  $('#statReadyNote').textContent = readyModels === state.models.length && state.models.length
    ? 'all systems go'
    : `${state.models.length - readyModels} need attention`;
  $('#statDisk').textContent = state.system?.disk ? formatBytes(state.system.disk.free) : '—';
  $('#heroReadyModels').textContent = state.models.length
    ? `${readyModels}/${state.models.length} runtimes ready`
    : 'Checking runtimes…';
  if (state.system?.gpus?.[0]) {
    $('#heroRuntime').textContent = `${state.system.gpus[0].name.replace('NVIDIA GeForce ', '')} · local`;
  } else {
    $('#heroRuntime').textContent = 'Local only';
  }
}

function renderToolGrid() {
  const grid = $('#toolGrid');
  if (!grid) return;
  grid.innerHTML = TOOL_META.map((tool) => {
    const model = modelById(tool.id);
    const led = modelReadinessClass(model);
    const label = modelReadinessLabel(model);
    return `
      <article class="tool-card">
        <div class="tool-card-head">
          <div class="tool-icon">${icon(tool.icon)}</div>
          <span class="tool-status"><i class="status-led ${led}"></i>${h(label)}</span>
        </div>
        <h4>${h(tool.label)}</h4>
        <p>${h(tool.description)}</p>
        <div class="tool-footer">
          <span class="tool-runtime">${h(tool.runtime)}</span>
          <button type="button" class="tool-open" data-page="${tool.page}" title="Open ${h(tool.label)}">${icon('chevron')}</button>
        </div>
      </article>
    `;
  }).join('');

  $('#toolboxNote').textContent = 'Select a module to open its job setup.';
}

function renderRecentJobs() {
  const container = $('#recentJobs');
  if (!container) return;
  const recent = state.jobs.slice(0, 4);
  if (recent.length === 0) {
    container.innerHTML = '<div class="empty-mini">No jobs yet. Start with a tool above.</div>';
    return;
  }
  container.innerHTML = recent.map((job) => {
    const meta = KIND_META[job.kind] || { icon: 'file' };
    return `
      <button type="button" class="recent-row" data-job-open="${h(job.id)}">
        <span class="job-mini-icon">${icon(meta.icon)}</span>
        <span class="recent-copy">
          <strong>${h(job.title)}</strong>
          <span>${h(timeAgo(job.createdAt))} · ${h(job.summary || '')}</span>
        </span>
        <span class="job-state ${h(job.status)}">${h(statusLabel(job.status))}</span>
      </button>
    `;
  }).join('');
}

function renderRecentOutputs() {
  const container = $('#recentOutputs');
  if (!container) return;
  const items = [];
  for (const job of state.jobs) {
    if (job.status !== 'completed') continue;
    for (const output of job.outputs || []) {
      items.push({ job, output });
      if (items.length >= 6) break;
    }
    if (items.length >= 6) break;
  }
  if (!items.length) {
    container.innerHTML = '<div class="empty-mini">Outputs from completed jobs appear here.</div>';
    return;
  }
  container.innerHTML = items.map(({ job, output }) => {
    const url = outputMediaUrl(output.path);
    const tag = output.ext.replace('.', '').toUpperCase().slice(0, 5) || 'FILE';
    const isFile = output.type !== 'image' && output.type !== 'video';
    const glyph = output.type === 'model' ? 'box' : output.type === 'archive' ? 'compress' : 'file';
    const media = output.type === 'video'
      ? `<video src="${h(url)}" muted loop playsinline preload="metadata"></video><span class="recent-output-play">${icon('play')}</span>`
      : output.type === 'image'
        ? `<img src="${h(url)}" alt="" loading="lazy">`
        : `<span class="recent-output-glyph">${icon(glyph)}</span><span class="recent-output-watermark">${h(tag)}</span>`;
    return `
      <button type="button" class="recent-output" data-job-open="${h(job.id)}" title="${h(output.relative)}">
        <span class="recent-output-thumb${isFile ? ' is-file' : ''}">
          ${media}
          <span class="recent-output-type">${h(tag)}</span>
        </span>
        <span class="recent-output-copy">
          <strong>${h(output.name)}</strong>
          <span>${h(formatBytes(output.size))}</span>
        </span>
      </button>
    `;
  }).join('');
  container.querySelectorAll('video').forEach((video) => {
    const reveal = () => {
      if (Number.isFinite(video.duration) && video.duration > 0) {
        try {
          video.currentTime = Math.min(0.2, video.duration * 0.04);
        } catch {
          // Wait for more data if the container cannot seek yet.
        }
      }
    };
    video.addEventListener('loadedmetadata', reveal, { once: true });
    if (video.readyState >= 1) reveal();
  });
}

function renderSystem() {
  const sys = state.system;
  const gpu = sys?.gpus?.[0];
  if (gpu) {
    $('#miniGpu').textContent = gpu.name.replace('NVIDIA GeForce ', '');
    const pct = gpu.memoryTotal ? (gpu.memoryUsed / gpu.memoryTotal) * 100 : 0;
    $('#miniVramBar').style.width = `${Math.min(100, pct)}%`;
    $('#miniVramBar').classList.toggle('hot', pct >= 70);
    $('#miniVramText').textContent = `VRAM ${Math.round(gpu.memoryUsed / 1024 * 10) / 10}/${Math.round(gpu.memoryTotal / 1024 * 10) / 10} GB`;
    $('#miniDiskText').textContent = sys.disk ? `Disk ${formatBytes(sys.disk.free)}` : '—';
  } else {
    $('#miniGpu').textContent = sys ? 'No NVIDIA GPU reported' : 'Detecting GPU…';
    $('#miniVramBar').style.width = '0%';
    $('#miniVramBar').classList.remove('hot');
    $('#miniVramText').textContent = '—';
    $('#miniDiskText').textContent = sys?.disk ? `Disk ${formatBytes(sys.disk.free)}` : '—';
  }

  const snapshot = $('#systemSnapshot');
  if (!snapshot) return;
  if (!sys) {
    snapshot.innerHTML = '<div class="empty-mini">Reading system information…</div>';
    return;
  }

  const memoryUsed = sys.totalMemory - sys.freeMemory;
  const memoryPct = sys.totalMemory ? (memoryUsed / sys.totalMemory) * 100 : 0;
  const diskPct = sys.disk?.total ? (sys.disk.used / sys.disk.total) * 100 : 0;
  const gpuPct = gpu?.memoryTotal ? (gpu.memoryUsed / gpu.memoryTotal) * 100 : 0;
  const meterClass = (pct) => pct >= 90 ? 'hot' : pct >= 75 ? 'warn' : '';
  const gpuBlock = gpu ? `
    <div class="sys-block">
      <div class="sys-line"><span>GPU</span><strong>${h(gpu.name.replace('NVIDIA GeForce ', ''))}</strong></div>
      <div class="meter ${meterClass(gpuPct)}"><span style="width:${Math.min(100, gpuPct)}%"></span></div>
      <div class="sys-sub"><span>${Math.round(gpu.memoryUsed / 1024 * 10) / 10} / ${Math.round(gpu.memoryTotal / 1024 * 10) / 10} GB VRAM</span><span>${gpu.utilization}% · ${gpu.temperature}°C</span></div>
    </div>
  ` : '<div class="sys-block"><div class="sys-line"><span>GPU</span><strong>not reported</strong></div></div>';

  snapshot.innerHTML = `
    ${gpuBlock}
    <div class="sys-block">
      <div class="sys-line"><span>Workspace disk</span><strong>${formatBytes(sys.disk?.used || 0)} / ${formatBytes(sys.disk?.total || 0)}</strong></div>
      <div class="meter ${meterClass(diskPct)}"><span style="width:${Math.min(100, diskPct)}%"></span></div>
      <div class="sys-sub"><span>${formatBytes(sys.disk ? sys.disk.free : 0)} free</span><span>${Math.round(diskPct)}% used</span></div>
    </div>
    <div class="sys-block">
      <div class="sys-line"><span>System memory</span><strong>${formatBytes(memoryUsed)} / ${formatBytes(sys.totalMemory)}</strong></div>
      <div class="meter ${meterClass(memoryPct)}"><span style="width:${Math.min(100, memoryPct)}%"></span></div>
      <div class="sys-sub"><span>${Math.round(memoryPct)}% used</span><span>${h(sys.cpu)}</span></div>
    </div>
    <div class="sys-block">
      <div class="sys-line"><span>Gendo</span><strong>v${h(sys.appVersion)}</strong></div>
      <div class="sys-sub"><span>${state.models.filter((model) => model.state === 'ready').length}/${state.models.length} runtimes ready</span><span>${h(sys.platform)} ${h(sys.arch)}</span></div>
    </div>
  `;
}

function renderPageModelStates() {
  for (const id of ['deca', 'gvhmr', 'sharp', 'sam']) {
    const dot = document.querySelector(`[data-model-dot="${id}"]`);
    if (!dot) continue;
    const model = modelById(id);
    dot.className = 'nav-dot';
    if (model?.state === 'ready') dot.classList.add('ready');
    else if (model?.state === 'partial') dot.classList.add('warn');
    else dot.classList.add('error');
    dot.title = model
      ? `${model.label}: ${modelReadinessLabel(model)}`
      : `${id}: checking`;
  }

  const fusionDot = document.querySelector('[data-model-dot="fusion"]');
  if (fusionDot) {
    const deca = modelById('deca');
    const gvhmr = modelById('gvhmr');
    const ready = deca?.state === 'ready' && gvhmr?.state === 'ready';
    fusionDot.className = 'nav-dot';
    fusionDot.classList.add(ready ? 'ready' : 'warn');
    fusionDot.title = ready ? 'DECA + GVHMR ready' : 'DECA or GVHMR needs attention';
  }

  const map = {
    deca: '#decaModelState',
    gvhmr: null,
    sharp: '#sharpModelState',
    sam: '#samModelState'
  };
  for (const [id, selector] of Object.entries(map)) {
    if (!selector) continue;
    const element = $(selector);
    if (!element) continue;
    const model = modelById(id);
    element.textContent = model ? modelReadinessLabel(model) : 'checking…';
    element.style.color = model?.state === 'ready' ? 'var(--success)' : model?.state === 'partial' ? 'var(--warning)' : 'var(--danger)';
  }
  const gvhmr = modelById('gvhmr');
  if (gvhmr) {
    const fbxLabel = gvhmr.checks.find((check) => check.label.includes('Blender'));
    const fbxNote = $('#gvhmrFbxNote');
    if (fbxNote) fbxNote.textContent = fbxLabel?.ok ? 'Blender found' : 'Blender missing';
  }
}

function renderOverview() {
  renderStats();
  renderToolGrid();
  renderRecentJobs();
  renderRecentOutputs();
  renderSystem();
}

function renderHealthList(target) {
  if (!target) return;
  target.innerHTML = state.models.map((model) => {
    const stateClass = model.state === 'ready' ? 'ready' : model.state === 'partial' ? 'partial' : 'missing';
    const checks = model.checks.map((check) => `${check.ok ? '✓' : '×'} ${h(check.label)}`).join(' · ');
    return `
      <div class="health-row">
        <div class="health-head">
          <strong>${h(model.label)}</strong>
          <span class="health-state ${stateClass}">${h(modelReadinessLabel(model))}</span>
        </div>
        <div class="health-checks">${checks}</div>
      </div>
    `;
  }).join('') || '<div class="empty-mini">Checking runtimes…</div>';
}

function renderAllModels() {
  renderToolGrid();
  renderStats();
  renderPageModelStates();
  renderHealthList($('#settingsHealth'));
  const sharpCheckpoint = state.config?.paths?.sharpCheckpoint;
  if (sharpCheckpoint && $('#sharpCheckpointName')) {
    $('#sharpCheckpointName').textContent = basename(sharpCheckpoint);
  }
}

function renderJobs() {
  const sorted = [...state.jobs].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  state.jobs = sorted;
  updateJobBadge();
  renderStats();
  renderRecentJobs();
  renderRecentOutputs();
  renderJobList();
  renderJobDetail();
}

function filteredJobs() {
  if (state.jobFilter === 'running') return state.jobs.filter((job) => job.status === 'running' || job.status === 'queued');
  if (state.jobFilter === 'completed') return state.jobs.filter((job) => job.status === 'completed');
  if (state.jobFilter === 'failed') return state.jobs.filter((job) => job.status === 'failed' || job.status === 'cancelled');
  return state.jobs;
}

function renderJobList() {
  const list = $('#jobList');
  if (!list) return;
  $$('#jobFilters .filter').forEach((button) => {
    button.classList.toggle('active', button.dataset.filter === state.jobFilter);
  });
  const jobs = filteredJobs();
  if (jobs.length === 0) {
    list.innerHTML = state.jobs.length
      ? '<div class="job-list-empty">No jobs match this filter.</div>'
      : `<div class="empty-state job-list-empty-state">
           <div class="empty-icon">${icon('activity')}</div>
           <h3>No jobs yet</h3>
           <p>Pick a tool and start a local run. Its progress and outputs will appear here.</p>
           <button type="button" class="button small ghost" data-page="overview">${icon('grid')}Browse tools</button>
         </div>`;
    return;
  }
  list.innerHTML = jobs.map((job) => {
    const meta = KIND_META[job.kind] || { icon: 'file', label: 'Job' };
    return `
      <button type="button" class="job-list-item ${job.id === state.selectedJobId ? 'active' : ''}" data-job-id="${h(job.id)}">
        <span class="job-mini-icon">${icon(meta.icon)}</span>
        <span class="job-list-copy">
          <strong title="${h(job.title)}">${h(job.title)}</strong>
          <span>${h(timeAgo(job.createdAt))} · ${h(meta.label)} · ${h(job.id.slice(-4).toUpperCase())}</span>
        </span>
        <span class="job-state ${h(job.status)}">${h(statusLabel(job.status))}</span>
      </button>
    `;
  }).join('');
}

function outputMediaUrl(filePath) {
  if (!state.appInfo?.mediaBase) return '';
  return `${state.appInfo.mediaBase}/media?path=${encodeURIComponent(filePath)}`;
}

function outputCard(output, index) {
  const url = outputMediaUrl(output.path);
  const tag = output.ext.replace('.', '').slice(0, 8) || 'FILE';
  const previewable = output.type === 'image' || output.type === 'video';
  let preview = '';
  let overlays = '';
  if (output.type === 'image') {
    preview = `<img src="${h(url)}" alt="${h(output.name)}" loading="lazy">`;
  } else if (output.type === 'video') {
    preview = `<video src="${h(url)}" muted loop playsinline preload="metadata"></video>`;
    overlays = `
      <span class="video-play">${icon('play')}</span>
      <span class="video-duration" data-video-duration>0:00</span>`;
  } else {
    const glyph = output.type === 'model' ? 'box' : output.type === 'archive' ? 'compress' : 'file';
    preview = `<span class="file-glyph">${icon(glyph)}</span>`;
  }
  const previewAction = previewable
    ? `data-output-preview="${index}" title="Preview ${h(output.name)}"`
    : `data-output-open="${index}" title="Open ${h(output.name)}"`;
  return `
    <div class="output-card">
      <button type="button" class="output-preview output-preview-button" ${previewAction} aria-label="${previewable ? 'Preview' : 'Open'} ${h(output.name)}">
        ${preview}
        <span class="type-tag">${h(tag)}</span>
        ${overlays}
      </button>
      <div class="output-body">
        <div class="output-copy">
          <strong title="${h(output.relative)}">${h(output.name)}</strong>
          <span>${h(formatBytes(output.size))}</span>
        </div>
        <button type="button" class="output-open" data-output-open="${index}" title="Open file">${icon('external')}</button>
      </div>
    </div>
  `;
}

function hydrateOutputMedia() {
  $$('#jobDetail .output-preview video').forEach((video) => {
    const card = video.closest('.output-preview');
    const duration = card?.querySelector('[data-video-duration]');
    const seekToPreviewFrame = () => {
      if (Number.isFinite(video.duration) && video.duration > 0) {
        if (duration) duration.textContent = formatClock(video.duration);
        try {
          video.currentTime = Math.min(0.25, Math.max(0.02, video.duration * 0.04));
        } catch {
          // Some containers reject seeking until more data is buffered.
        }
      }
    };
    video.addEventListener('loadedmetadata', seekToPreviewFrame, { once: true });
    video.addEventListener('loadeddata', () => {
      if (duration && (!duration.textContent || duration.textContent === '0:00')) {
        seekToPreviewFrame();
      }
    }, { once: true });
    if (video.readyState >= 1) seekToPreviewFrame();
  });
}

function openMediaViewer(output) {
  if (!output || !['image', 'video'].includes(output.type)) return;
  const viewer = $('#mediaViewer');
  const video = $('#mediaViewerVideo');
  const image = $('#mediaViewerImage');
  const stage = $('.media-viewer-stage');
  if (!viewer || !video || !image || !stage) return;
  const url = outputMediaUrl(output.path);
  if (!url) return;

  state.viewerOutput = output;
  video.pause();
  video.removeAttribute('src');
  video.hidden = true;
  image.hidden = true;
  image.removeAttribute('src');
  stage.classList.toggle('is-video', output.type === 'video');

  $('#mediaViewerTitle').textContent = output.name;
  $('#mediaViewerMeta').textContent = `${output.ext.replace('.', '').toUpperCase() || 'FILE'} · ${formatBytes(output.size)}`;
  $('#mediaViewerPath').textContent = output.relative;
  if (output.type === 'video') {
    video.src = url;
    video.hidden = false;
    video.load();
    video.play().catch(() => {});
  } else {
    image.src = url;
    image.alt = output.name;
    image.hidden = false;
  }
  viewer.hidden = false;
  document.body.classList.add('media-viewer-open');
  $('#mediaViewerClose')?.focus();
}

function closeMediaViewer() {
  const viewer = $('#mediaViewer');
  const video = $('#mediaViewerVideo');
  const image = $('#mediaViewerImage');
  if (!viewer || viewer.hidden) return;
  if (video) {
    video.pause();
    video.removeAttribute('src');
    video.load();
    video.hidden = true;
  }
  if (image) {
    image.removeAttribute('src');
    image.hidden = true;
  }
  viewer.hidden = true;
  document.body.classList.remove('media-viewer-open');
  state.viewerOutput = null;
}

function wireMediaViewer() {
  $('#mediaViewerClose')?.addEventListener('click', closeMediaViewer);
  $('#mediaViewer')?.addEventListener('click', (event) => {
    if (event.target.closest('[data-media-close]')) closeMediaViewer();
  });
  $('#mediaViewerOpen')?.addEventListener('click', async () => {
    if (state.viewerOutput) await api.openPath(state.viewerOutput.path);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !$('#mediaViewer')?.hidden) {
      event.preventDefault();
      closeMediaViewer();
    }
  });
}

function renderJobDetail() {
  const detail = $('#jobDetail');
  if (!detail) return;
  const job = state.selectedJob;
  if (!job) {
    detail.innerHTML = `
      <div class="empty-state tall">
        <div class="empty-icon">${icon('activity')}</div>
        <h3>No job selected</h3>
        <p>Run any tool or pick a job from the queue to see its outputs and logs.</p>
      </div>
    `;
    return;
  }

  const meta = KIND_META[job.kind] || { label: 'Job', icon: 'file' };
  const active = isActiveJob(job);
  const stages = (job.stageNames || []).map((name, index) => {
    let className = '';
    if (job.status === 'completed') className = 'done';
    else if (job.status === 'running' && index + 1 < job.stageIndex) className = 'done';
    else if (job.status === 'running' && index + 1 === job.stageIndex) className = 'active';
    return `<span class="stage-pill ${className}">${index + 1}. ${h(name)}</span>`;
  }).join('');

  const previewOutputs = (job.outputs || []).slice(0, 24);
  const hiddenCount = Math.max(0, (job.outputs || []).length - previewOutputs.length);

  detail.innerHTML = `
    <div class="job-detail-head">
      <div>
        <div class="eyebrow">${h(meta.label.toUpperCase())}</div>
        <h2>${h(job.title)}</h2>
        <div class="job-detail-sub">${h(job.summary || '')}</div>
      </div>
      <div class="job-actions">
        ${active ? `<button type="button" class="button small ghost" data-job-action="cancel">${icon('stop')}Cancel</button>` : ''}
        <button type="button" class="button small ghost" data-job-action="open-output">${icon('folder')}Outputs</button>
        <button type="button" class="button small ghost" data-job-action="open-log">${icon('log')}Log file</button>
      </div>
    </div>
    <div class="job-meta-row">
      <span class="job-state ${h(job.status)}">${h(statusLabel(job.status))}</span>
      <span>${icon('clock')}<span ${active ? `data-elapsed-start="${h(job.startedAt || job.createdAt)}"` : ''}>${h(job.durationMs ? formatDuration(job.durationMs) : active ? formatElapsed(job.startedAt || job.createdAt) : timeAgo(job.finishedAt || job.createdAt))}</span></span>
      <span>${h(formatDate(job.startedAt || job.createdAt))}</span>
      <span>${h(job.id)}</span>
    </div>
    ${stages ? `<div class="job-progress">${stages}</div>` : ''}
    ${job.error ? `<div class="job-error">${h(job.error)}</div>` : ''}
    <div class="job-section">
      <div class="job-section-head">
        <h3>Outputs</h3>
        <span>${job.outputs?.length || 0} file${job.outputs?.length === 1 ? '' : 's'}</span>
      </div>
      ${previewOutputs.length
        ? `<div class="output-grid">${previewOutputs.map((output, index) => outputCard(output, index)).join('')}</div>
           ${hiddenCount ? `<div class="empty-note">${hiddenCount} more file${hiddenCount === 1 ? '' : 's'} in the output folder.</div>` : ''}`
        : `<div class="empty-mini">${active ? 'Outputs will appear when files are written.' : 'No output files were generated.'}</div>`}
    </div>
    <div class="job-section">
      <div class="job-section-head">
        <h3>Process log</h3>
        <div class="log-toolbar">
          <label class="log-toggle"><input type="checkbox" id="logAutoScroll" ${state.logAutoScroll ? 'checked' : ''}>Auto-scroll</label>
          <button type="button" class="button small ghost" data-job-action="copy-log">${icon('copy')}Copy</button>
        </div>
      </div>
      <pre class="log-console" id="jobLog"></pre>
    </div>
  `;

  const logElement = $('#jobLog');
  if (logElement) {
    logElement.textContent = state.jobLog || '';
    if (state.logAutoScroll) logElement.scrollTop = logElement.scrollHeight;
  }
  hydrateOutputMedia();
}

async function selectJob(jobId) {
  state.selectedJobId = jobId;
  renderJobList();
  try {
    const [job, log] = await Promise.all([api.getJob(jobId), api.getJobLog(jobId)]);
    if (state.selectedJobId !== jobId) return;
    state.selectedJob = job;
    state.jobLog = log || '';
    renderJobDetail();
  } catch (error) {
    toast(cleanError(error), 'error');
  }
}

function upsertJob(job) {
  const index = state.jobs.findIndex((item) => item.id === job.id);
  if (index >= 0) state.jobs[index] = job;
  else state.jobs.unshift(job);
  state.jobs.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

function handleJobUpdate(job) {
  const previous = state.jobs.find((item) => item.id === job.id);
  upsertJob(job);
  if (state.selectedJobId === job.id) state.selectedJob = job;
  renderJobs();
  if (previous && previous.status !== job.status) {
    if (job.status === 'completed') toast(`Complete · ${job.title}`);
    else if (job.status === 'failed') toast(`Failed · ${job.title}`, 'error');
    else if (job.status === 'cancelled') toast(`Cancelled · ${job.title}`, 'error');
  }
}

function handleJobLog(entry) {
  if (state.selectedJobId !== entry.id) return;
  state.jobLog += `${entry.line}\n`;
  if (state.jobLog.length > 320000) state.jobLog = state.jobLog.slice(-280000);
  const logElement = $('#jobLog');
  if (!logElement) return;
  logElement.textContent += `${entry.line}\n`;
  if (state.logAutoScroll) logElement.scrollTop = logElement.scrollHeight;
}

async function refreshJobs() {
  try {
    state.jobs = await api.listJobs();
    if (state.selectedJobId) {
      const selected = state.jobs.find((job) => job.id === state.selectedJobId);
      if (selected) {
        state.selectedJob = selected;
      } else {
        state.selectedJobId = null;
        state.selectedJob = null;
      }
    }
    renderJobs();
  } catch (error) {
    toast(cleanError(error), 'error');
  }
}

async function refreshModels() {
  state.models = await api.getModelStatus();
  renderAllModels();
}

async function refreshSystem() {
  try {
    state.system = await api.getSystemInfo();
    renderSystem();
    renderStats();
  } catch {
    // System information is optional.
  }
}

async function refreshServices() {
  state.services = await api.listServices();
  renderServiceDots();
  renderDlss();
  renderMazanoke();
}

function navigate(page) {
  if (!PAGE_META[page]) return;
  state.currentPage = page;
  $$('.page').forEach((section) => section.classList.toggle('active', section.id === `page-${page}`));
  $$('.nav-item').forEach((button) => button.classList.toggle('active', button.dataset.page === page));
  $('#pageEyebrow').textContent = PAGE_META[page].eyebrow;
  $('#pageTitle').textContent = PAGE_META[page].title;
  $('#pageSubtitle').textContent = PAGE_META[page].subtitle;
  const topNewJob = $('#topNewJobBtn');
  if (topNewJob) topNewJob.hidden = page !== 'overview';
  $('#content').scrollTop = 0;

  if (page === 'overview') renderOverview();
  if (page === 'activity') {
    if (!state.selectedJobId && state.jobs.length > 0) {
      selectJob(state.jobs[0].id);
    } else {
      renderJobList();
      renderJobDetail();
    }
  }
  if (page === 'settings') fillSettings();
  if (page === 'dlss') renderDlss();
  if (page === 'mazanoke') {
    renderMazanoke();
    const service = state.services.mazanoke;
    if (!service || service.state === 'stopped' || service.state === 'error') {
      startEmbedded('mazanoke');
    }
  }
}

function renderServiceStatus(name) {
  const status = state.services[name] || { state: 'stopped', message: 'Not running' };
  const map = {
    dlss: { dot: '#dlssDot', text: '#dlssStatusText', start: '#dlssStartBtn', stop: '#dlssStopBtn', reload: '#dlssReloadBtn' },
    mazanoke: { dot: '#mazanokeDot', text: '#mazanokeStatusText', start: '#mazanokeStartBtn', reload: '#mazanokeReloadBtn' }
  }[name];
  const dot = $(map.dot);
  const text = $(map.text);
  dot.className = `service-dot ${status.state}`;
  if (status.state === 'running') text.textContent = `Running locally · port ${status.port}`;
  else if (status.state === 'starting') text.textContent = status.message || 'Starting…';
  else if (status.state === 'error') text.textContent = status.message || 'Service error';
  else text.textContent = 'Not running';
  $(map.start).hidden = status.state === 'running' || status.state === 'starting';
  if (map.stop) $(map.stop).hidden = status.state !== 'running' && status.state !== 'starting';
  if (map.reload) $(map.reload).hidden = status.state !== 'running';
}

function setWebviewSource(webview, url, key) {
  if (!url) return;
  if (state.embedded[key] !== url) {
    state.embedded[key] = url;
    webview.setAttribute('src', url);
  }
  webview.hidden = false;
}

function renderDlss() {
  if (!document.getElementById('page-dlss')) return;
  const status = state.services.dlss || { state: 'stopped', url: null, message: 'Ready to launch' };
  renderServiceStatus('dlss');
  const running = status.state === 'running' && status.url;
  const starting = status.state === 'starting';
  const empty = $('#dlssEmpty');
  const loading = $('#dlssLoading');
  const webview = $('#dlssWebview');
  const errorLog = $('#dlssErrorLog');
  if (!empty) return;
  empty.hidden = running || starting;
  loading.hidden = !starting;
  if (running) {
    setWebviewSource(webview, status.url, 'dlss');
  } else {
    webview.hidden = true;
  }
  if (status.state === 'error') {
    errorLog.hidden = false;
    errorLog.textContent = status.message || 'The service stopped unexpectedly.';
    loadServiceLogPreview('dlss', errorLog);
  } else {
    errorLog.hidden = true;
  }
}

function renderMazanoke() {
  if (!document.getElementById('page-mazanoke')) return;
  const status = state.services.mazanoke || { state: 'stopped', url: null, message: 'Ready to launch' };
  renderServiceStatus('mazanoke');
  const running = status.state === 'running' && status.url;
  const starting = status.state === 'starting';
  const empty = $('#mazanokeEmpty');
  const loading = $('#mazanokeLoading');
  const webview = $('#mazanokeWebview');
  if (!empty) return;
  empty.hidden = running || starting;
  loading.hidden = !starting;
  if (running) {
    setWebviewSource(webview, status.url, 'mazanoke');
  } else {
    webview.hidden = true;
  }
}

async function loadServiceLogPreview(name, element) {
  if (!element || state.serviceLogRequests.has(name)) return;
  state.serviceLogRequests.add(name);
  try {
    const log = await api.getServiceLog(name);
    if (log) {
      const lines = log.trim().split(/\r?\n/).slice(-8).join('\n');
      element.textContent = lines;
    }
  } catch {
    // ignore
  } finally {
    state.serviceLogRequests.delete(name);
  }
}

async function startEmbedded(name) {
  const current = state.services[name] || { state: 'stopped' };
  if (current.state === 'starting') return current;
  if (current.state === 'running') {
    if (name === 'dlss') renderDlss();
    if (name === 'mazanoke') renderMazanoke();
    return current;
  }
  state.services[name] = {
    ...current,
    state: 'starting',
    message: name === 'dlss' ? 'Loading DLSS 5 models…' : 'Serving Mazanoke locally…'
  };
  if (name === 'dlss') renderDlss();
  if (name === 'mazanoke') renderMazanoke();
  renderServiceDots();

  try {
    const result = await api.startService(name);
    state.services[name] = result;
    renderServiceDots();
    if (name === 'dlss') renderDlss();
    if (name === 'mazanoke') renderMazanoke();
    toast(`${result.label || name} is ready`);
    return result;
  } catch (error) {
    const message = cleanError(error);
    state.services[name] = {
      ...state.services[name],
      state: 'error',
      url: null,
      message
    };
    renderServiceDots();
    if (name === 'dlss') renderDlss();
    if (name === 'mazanoke') renderMazanoke();
    toast(message, 'error');
    return null;
  }
}

async function stopEmbedded(name) {
  try {
    await api.stopService(name);
    state.services[name] = {
      ...(state.services[name] || {}),
      state: 'stopped',
      url: null,
      port: null,
      message: 'Stopped'
    };
    renderServiceDots();
    if (name === 'dlss') renderDlss();
    if (name === 'mazanoke') renderMazanoke();
    toast(`${name === 'dlss' ? 'DLSS 5' : 'Mazanoke'} stopped`);
  } catch (error) {
    toast(cleanError(error), 'error');
  }
}

function handleServiceUpdate(status) {
  if (!status?.name) return;
  state.services[status.name] = status;
  renderServiceDots();
  if (status.name === 'dlss') renderDlss();
  if (status.name === 'mazanoke') renderMazanoke();
}

function addFiles(store, paths) {
  const zone = document.querySelector(`.dropzone[data-store="${store}"]`);
  if (!zone) return;
  const kind = zone.dataset.kind;
  const single = zone.dataset.single === 'true';
  const allowed = kind === 'image'
    ? new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff'])
    : new Set(['.mp4', '.mov', '.mkv', '.avi', '.webm', '.m4v']);
  const valid = [];
  let rejected = 0;
  for (const filePath of paths || []) {
    if (!filePath) continue;
    if (allowed.has(extensionOf(filePath))) valid.push(filePath);
    else rejected += 1;
  }
  if (rejected) toast(`${rejected} unsupported file${rejected === 1 ? '' : 's'} ignored.`, 'error');
  if (single) state.files[store] = valid.slice(-1);
  else {
    const seen = new Set(state.files[store].map((item) => item.toLowerCase()));
    for (const filePath of valid) {
      if (!seen.has(filePath.toLowerCase())) {
        seen.add(filePath.toLowerCase());
        state.files[store].push(filePath);
      }
    }
  }
  renderFileList(store);
}

function renderFileList(store) {
  const list = document.getElementById(`${store}Files`);
  const count = document.getElementById(`${store}FileCount`);
  if (!list) return;
  const files = state.files[store];
  if (count) count.textContent = String(files.length);
  list.innerHTML = files.map((filePath, index) => {
    const kind = store === 'gvhmr' || store.startsWith('fusion') ? 'film' : 'image';
    return `
      <div class="file-row">
        ${icon(kind)}
        <span class="file-copy">
          <span class="file-name">${h(basename(filePath))}</span>
          <span class="file-path">${h(filePath)}</span>
        </span>
        <button type="button" class="file-remove" data-remove-file="${store}" data-remove-index="${index}" title="Remove">${icon('x')}</button>
      </div>
    `;
  }).join('');
  updateFormSummaries(store);
}

function updateFormSummaries(changedStore) {
  if (changedStore === 'deca') {
    const count = state.files.deca.length;
    $('#decaSummary').innerHTML = count
      ? `<span><strong>${count}</strong> portrait${count === 1 ? '' : 's'} ready for reconstruction.</span>`
      : 'No images selected.';
    $('#decaRunBtn').disabled = count === 0;
    const outputParts = [];
    if ($('#decaSaveObj').checked) outputParts.push('OBJ');
    if ($('#decaSaveDepth').checked) outputParts.push('depth');
    if ($('#decaUseTex').checked) outputParts.push('FLAME map');
    if ($('#decaExtractTex').checked) outputParts.push('input map');
    $('#decaOutputSpec').textContent = outputParts.length ? outputParts.join(' · ') : 'renders only';
  }

  if (changedStore === 'gvhmr') {
    const file = state.files.gvhmr[0];
    $('#gvhmrSummary').innerHTML = file
      ? `<span><strong>${h(basename(file))}</strong> is ready for motion recovery.</span>`
      : 'No video selected.';
    $('#gvhmrRunBtn').disabled = !file;
    updateGvhmrSpecs();
  }

  if (changedStore === 'sharp') {
    const count = state.files.sharp.length;
    $('#sharpSummary').innerHTML = count
      ? `<span><strong>${count}</strong> scene${count === 1 ? '' : 's'} will be generated.</span>`
      : 'No images selected.';
    $('#sharpRunBtn').disabled = count === 0;
    updateSharpSpecs();
  }

  if (changedStore === 'sam') {
    const count = state.files.sam.length;
    $('#samSummary').innerHTML = count
      ? `<span><strong>${count}</strong> image${count === 1 ? '' : 's'} ready for body reconstruction.</span>`
      : 'No images selected.';
    $('#samRunBtn').disabled = count === 0;
  }

  if (changedStore === 'fusionBody' || changedStore === 'fusionFace') {
    updateFusionSpecs();
  }
}

function updateGvhmrSpecs() {
  const mode = document.querySelector('input[name="gvhmrCamera"]:checked')?.value || 'static';
  const label = mode === 'static' ? 'Static camera' : mode === 'dpvo' ? 'DPVO tracking' : 'SimpleVO tracking';
  $('#gvhmrCameraSpec').textContent = label;
  const exportFbx = $('#gvhmrExportFbx').checked;
  const exportRig = $('#gvhmrExportRig').checked;
  const deliverables = ['2 videos'];
  if (exportFbx) deliverables.push('animated FBX');
  if (exportRig) deliverables.push('rigged FBX');
  $('#gvhmrOutputSpec').textContent = deliverables.join(' · ');

  const bookendPose = document.querySelector('input[name="gvhmrBookend"]:checked')?.value || 'none';
  const bookendLabels = { none: 'None', tpose: 'T-pose', apose: 'A-pose' };
  const hold = Math.max(1, Math.round(Number($('#gvhmrBookendHold').value) || 15));
  const blend = Math.max(0, Math.round(Number($('#gvhmrBookendBlend').value) || 0));
  const bookendSpec = $('#gvhmrBookendSpec');
  if (bookendSpec) {
    bookendSpec.textContent = bookendPose === 'none'
      ? 'None'
      : `${bookendLabels[bookendPose]} · ${hold}+${blend}f`;
    bookendSpec.title = bookendPose === 'none'
      ? 'No pose bookends'
      : `${hold} hold + ${blend} blend frames at each end; ${2 * (hold + blend)} frames added total.`;
  }
  const timeline = $('#gvhmrBookendTimeline');
  if (timeline) {
    timeline.textContent = bookendPose === 'none'
      ? 'No bookend frames will be added.'
      : `Hold ${hold} → Blend ${blend} → Motion → Blend ${blend} → Hold ${hold}. Adds ${2 * (hold + blend)} frames total.`;
  }
  const bookendDisabled = bookendPose === 'none' || (!exportFbx && !exportRig);
  $('#gvhmrBookendHold').disabled = bookendDisabled;
  $('#gvhmrBookendBlend').disabled = bookendDisabled;
}

function updateSharpSpecs() {
  const render = $('#sharpRender').checked;
  $('#sharpOutputSpec').textContent = render ? 'PLY · MP4' : 'PLY splats';
}

function updateSamSpecs() {
  const detector = $('#samDetector').value;
  const labels = { fasterrcnn: 'Faster R-CNN', vitdet: 'ViTDet', sam3: 'SAM 3' };
  $('#samDetectorSpec').textContent = labels[detector] || detector;
}

function fusionUsesSameSource() {
  return document.querySelector('input[name="fusionSource"]:checked')?.value !== 'separate';
}

function updateFusionSpecs() {
  const same = fusionUsesSameSource();
  const facePanel = $('#fusionFaceSourcePanel');
  const sync = $('#fusionSync');
  const offset = $('#fusionFaceOffset');
  if (facePanel) facePanel.hidden = same;
  if (sync) {
    sync.disabled = same;
    if (same) sync.value = 'fit';
  }
  if (offset) offset.disabled = same || sync?.value !== 'offset';

  const body = state.files.fusionBody[0];
  const face = state.files.fusionFace[0];
  const ready = Boolean(body && (same || face));
  const run = $('#fusionRunBtn');
  if (run) run.disabled = !ready;

  const spec = $('#fusionSyncSpec');
  if (spec) {
    spec.textContent = same ? 'Same video · 1:1' : sync?.value === 'offset' ? 'Frame offset' : 'Stretch to body';
  }

  const note = $('#fusionSourceNote');
  if (note) {
    note.textContent = same
      ? 'One clip drives both the body skeleton and the DECA facial performance.'
      : 'GVHMR reads the body clip. DECA reads the face clip; Stretch maps the full face performance across the body timeline.';
  }

  const summary = $('#fusionSummary');
  if (summary) {
    if (!body) summary.textContent = 'No video selected.';
    else if (!same && !face) summary.innerHTML = `<span><strong>${h(basename(body))}</strong> is ready. Choose a face clip.</span>`;
    else if (same) summary.innerHTML = `<span>Body + face: <strong>${h(basename(body))}</strong></span>`;
    else summary.innerHTML = `<span>Body: <strong>${h(basename(body))}</strong><br>Face: <strong>${h(basename(face))}</strong></span>`;
  }
}

function setupDropzones() {
  $$('.dropzone[data-store]').forEach((zone) => {
    const store = zone.dataset.store;
    zone.addEventListener('click', async () => {
      const paths = await api.pickFiles({
        kind: zone.dataset.kind,
        title: zone.dataset.title || (zone.dataset.kind === 'video' ? 'Choose a motion video' : 'Choose images')
      });
      if (paths?.length) addFiles(store, paths);
    });
    zone.addEventListener('dragover', (event) => {
      event.preventDefault();
      zone.classList.add('dragover');
    });
    zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
    zone.addEventListener('drop', (event) => {
      event.preventDefault();
      zone.classList.remove('dragover');
      const paths = [...event.dataTransfer.files].map((file) => api.getPathForFile(file)).filter(Boolean);
      addFiles(store, paths);
    });
  });

  document.addEventListener('click', (event) => {
    const remove = event.target.closest('[data-remove-file]');
    if (!remove) return;
    const store = remove.dataset.removeFile;
    const index = Number(remove.dataset.removeIndex);
    if (!Number.isInteger(index)) return;
    state.files[store].splice(index, 1);
    renderFileList(store);
  });
}

function validateModelForLaunch(id, extraCheck = null) {
  const model = modelById(id);
  if (!model) return true;
  if (model.state === 'missing') {
    toast(`${model.label} is not installed at the configured path. Check Settings.`, 'error');
    return false;
  }
  if (extraCheck) {
    const check = model.checks.find((item) => item.label.includes(extraCheck));
    if (check && !check.ok) {
      toast(`${model.label}: ${check.label} is missing. Check Settings.`, 'error');
      return false;
    }
  }
  return true;
}

async function launchJob(kind, payload, button) {
  const original = button.innerHTML;
  button.disabled = true;
  button.innerHTML = '<span class="spinner"></span>Queuing…';
  try {
    const job = await api.startJob(kind, payload);
    upsertJob(job);
    state.selectedJobId = job.id;
    state.selectedJob = job;
    state.jobLog = '';
    navigate('activity');
    await selectJob(job.id);
    toast(`Queued · ${job.title}`);
  } catch (error) {
    toast(cleanError(error), 'error');
  } finally {
    button.disabled = false;
    button.innerHTML = original;
  }
}

function wireForms() {
  $('#decaSaveObj').addEventListener('change', () => updateFormSummaries('deca'));
  $('#decaForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!state.files.deca.length) return;
    if (!validateModelForLaunch('deca')) return;
    await launchJob('deca', {
      files: [...state.files.deca],
      saveObj: $('#decaSaveObj').checked,
      saveDepth: $('#decaSaveDepth').checked,
      useTex: $('#decaUseTex').checked,
      extractTex: $('#decaExtractTex').checked,
      rasterizer: $('#decaRasterizer').value,
      device: $('#decaDevice').value
    }, $('#decaRunBtn'));
  });

  $('#gvhmrForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const video = state.files.gvhmr[0];
    if (!video) return;
    const exportFbx = $('#gvhmrExportFbx').checked;
    const exportRig = $('#gvhmrExportRig').checked;
    if (!validateModelForLaunch('gvhmr', exportFbx || exportRig ? 'Blender' : null)) return;
    await launchJob('gvhmr', {
      video,
      cameraMode: document.querySelector('input[name="gvhmrCamera"]:checked')?.value || 'static',
      focalMm: $('#gvhmrFocal').value,
      exportFbx,
      exportRig,
      verbose: $('#gvhmrVerbose').checked,
      bookendPose: document.querySelector('input[name="gvhmrBookend"]:checked')?.value || 'none',
      bookendHold: Math.max(1, Math.round(Number($('#gvhmrBookendHold').value) || 15)),
      bookendBlend: Math.max(0, Math.round(Number($('#gvhmrBookendBlend').value) || 0))
    }, $('#gvhmrRunBtn'));
  });
  $$('input[name="gvhmrCamera"]').forEach((input) => input.addEventListener('change', updateGvhmrSpecs));
  $$('input[name="gvhmrBookend"]').forEach((input) => input.addEventListener('change', updateGvhmrSpecs));
  $('#gvhmrBookendHold').addEventListener('input', updateGvhmrSpecs);
  $('#gvhmrBookendBlend').addEventListener('input', updateGvhmrSpecs);
  $('#gvhmrExportFbx').addEventListener('change', updateGvhmrSpecs);
  $('#gvhmrExportRig').addEventListener('change', updateGvhmrSpecs);

  $('#sharpForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!state.files.sharp.length) return;
    if (!validateModelForLaunch('sharp')) return;
    await launchJob('sharp', {
      files: [...state.files.sharp],
      render: $('#sharpRender').checked,
      device: $('#sharpDevice').value
    }, $('#sharpRunBtn'));
  });
  $('#sharpRender').addEventListener('change', updateSharpSpecs);
  $('#sharpDevice').addEventListener('change', () => {
    if ($('#sharpDevice').value === 'cpu') {
      $('#sharpRender').checked = false;
      updateSharpSpecs();
    }
  });

  $('#samForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!state.files.sam.length) return;
    if (!validateModelForLaunch('sam')) return;
    await launchJob('sam', {
      files: [...state.files.sam],
      detector: $('#samDetector').value,
      fov: $('#samFov').value,
      bboxThreshold: Number($('#samBbox').value)
    }, $('#samRunBtn'));
  });
  $('#samDetector').addEventListener('change', updateSamSpecs);
  $('#samBbox').addEventListener('input', () => {
    const value = Number($('#samBbox').value);
    $('#samBboxValue').textContent = value.toFixed(2);
    $('#samBbox').style.setProperty('--range', `${((value - 0.1) / 0.85) * 100}%`);
  });
  $('#samBbox').style.setProperty('--range', '47.06%');
  $('#decaSaveDepth').addEventListener('change', () => updateFormSummaries('deca'));
  $('#decaUseTex').addEventListener('change', () => updateFormSummaries('deca'));
  $('#decaExtractTex').addEventListener('change', () => updateFormSummaries('deca'));

  $$('input[name="fusionSource"]').forEach((input) => input.addEventListener('change', updateFusionSpecs));
  $('#fusionSync').addEventListener('change', updateFusionSpecs);
  $('#fusionForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const bodyVideo = state.files.fusionBody[0];
    const sameSource = fusionUsesSameSource();
    const faceVideo = state.files.fusionFace[0];
    if (!bodyVideo) return;
    if (!sameSource && !faceVideo) {
      toast('Choose a face performance video or switch to Same video.', 'error');
      return;
    }
    if (!validateModelForLaunch('deca')) return;
    if (!validateModelForLaunch('gvhmr', 'Blender')) return;
    const numberOr = (selector, fallback) => {
      const value = Number($(selector).value);
      return Number.isFinite(value) ? value : fallback;
    };
    await launchJob('fusion', {
      sameSource,
      bodyVideo,
      faceVideo: sameSource ? bodyVideo : faceVideo,
      cameraMode: document.querySelector('input[name="fusionCamera"]:checked')?.value || 'static',
      syncMode: sameSource ? 'fit' : $('#fusionSync').value,
      faceOffset: numberOr('#fusionFaceOffset', 0),
      headScale: numberOr('#fusionHeadScale', 1),
      headOffsetX: numberOr('#fusionHeadX', 0),
      headOffsetY: numberOr('#fusionHeadY', 0),
      headOffsetZ: numberOr('#fusionHeadZ', 0)
    }, $('#fusionRunBtn'));
  });
}

function configValue(key) {
  if (key === 'workspace') return state.config?.workspace || '';
  if (key.startsWith('paths.')) return state.config?.paths?.[key.slice(6)] || '';
  return state.config?.[key] ?? '';
}

function renderPathGroups() {
  const container = $('#settingsPathGroups');
  if (!container) return;
  container.innerHTML = PATH_GROUPS.map((group) => `
    <div class="path-group">
      <h4>${h(group.title)}</h4>
      ${group.fields.map((field) => `
        <div class="path-field">
          <label>
            <span>${h(field.label)}</span>
            <input id="path-${h(field.key)}" data-config-path="paths.${h(field.key)}" value="${h(configValue(`paths.${field.key}`))}" spellcheck="false">
            <button type="button" class="path-browse" data-browse-path="path-${h(field.key)}" data-folder="${field.folder ? 'true' : 'false'}" title="Browse">${icon('folder')}</button>
          </label>
        </div>
      `).join('')}
    </div>
  `).join('');
}

function fillSettings() {
  if (!state.config) return;
  $('#setWorkspace').value = state.config.workspace || '';
  $('#setConcurrency').value = String(state.config.maxConcurrentJobs || 1);
  renderPathGroups();
  renderHealthList($('#settingsHealth'));
}

async function saveSettings(event) {
  event?.preventDefault();
  const paths = {};
  $$('[data-config-path^="paths."]').forEach((input) => {
    paths[input.dataset.configPath.slice(6)] = input.value.trim();
  });
  const patch = {
    workspace: $('#setWorkspace').value.trim() || state.config.workspace,
    maxConcurrentJobs: Number($('#setConcurrency').value) || 1,
    paths: { ...state.config.paths, ...paths }
  };
  const button = $('#saveSettingsBtn');
  const original = button.innerHTML;
  button.disabled = true;
  button.innerHTML = '<span class="spinner"></span>Saving…';
  try {
    state.config = await api.saveConfig(patch);
    await refreshModels();
    fillSettings();
    toast('Settings saved for new jobs.');
  } catch (error) {
    toast(cleanError(error), 'error');
  } finally {
    button.disabled = false;
    button.innerHTML = original;
  }
}

async function browseForPath(inputId, isFolder) {
  if (!inputId) return;
  let selected;
  if (isFolder) selected = await api.pickFolder({ title: 'Choose folder' });
  else {
    const files = await api.pickFiles({ kind: 'any', title: 'Choose file' });
    selected = files?.[0] || null;
  }
  if (selected) {
    const input = document.getElementById(inputId);
    if (input) input.value = selected;
  }
}

function wireSettings() {
  $('#settingsForm').addEventListener('submit', saveSettings);
  $('#resetPathsBtn').addEventListener('click', async () => {
    try {
      if (!state.defaults) state.defaults = await api.getDefaults();
      state.config = { ...state.config, workspace: state.defaults.workspace, paths: { ...state.defaults.paths } };
      fillSettings();
      toast('Default paths loaded. Click Save changes to apply.');
    } catch (error) {
      toast(cleanError(error), 'error');
    }
  });
  document.addEventListener('click', async (event) => {
    const browse = event.target.closest('[data-browse-path]');
    if (browse) {
      event.preventDefault();
      await browseForPath(browse.dataset.browsePath, browse.dataset.folder === 'true');
    }
    const openPath = event.target.closest('[data-open-path]');
    if (openPath) {
      event.preventDefault();
      if (openPath.dataset.openPath === 'workspace') {
        await api.openWorkspace();
      } else {
        const target = configValue(openPath.dataset.openPath);
        if (target) await api.openPath(target);
      }
    }
  });
}

function wireActivity() {
  $('#jobFilters').addEventListener('click', (event) => {
    const button = event.target.closest('[data-filter]');
    if (!button) return;
    state.jobFilter = button.dataset.filter;
    renderJobList();
  });
  $('#jobList').addEventListener('click', (event) => {
    const item = event.target.closest('[data-job-id]');
    if (item) selectJob(item.dataset.jobId);
  });
  $('#refreshJobsBtn').addEventListener('click', refreshJobs);

  $('#jobDetail').addEventListener('click', async (event) => {
    const action = event.target.closest('[data-job-action]')?.dataset.jobAction;
    if (!action) {
      const outputIndex = event.target.closest('[data-output-open]')?.dataset.outputOpen;
      if (outputIndex !== undefined && state.selectedJob) {
        const output = state.selectedJob.outputs[Number(outputIndex)];
        if (output) await api.openPath(output.path);
        return;
      }
      const previewIndex = event.target.closest('[data-output-preview]')?.dataset.outputPreview;
      if (previewIndex !== undefined && state.selectedJob) {
        const output = state.selectedJob.outputs[Number(previewIndex)];
        if (output) openMediaViewer(output);
      }
      return;
    }
    const job = state.selectedJob;
    if (!job) return;
    if (action === 'cancel') {
      await api.cancelJob(job.id);
      toast('Cancellation requested.');
    }
    if (action === 'open-output') {
      const error = await api.openFolder(job.outputDir);
      if (error) toast(error, 'error');
    }
    if (action === 'open-log') {
      await api.openPath(job.logPath);
    }
    if (action === 'copy-log') {
      try {
        await navigator.clipboard.writeText(state.jobLog || '');
        toast('Log copied to clipboard.');
      } catch {
        toast('Could not copy the log.', 'error');
      }
    }
  });

  $('#jobDetail').addEventListener('change', (event) => {
    if (event.target.id === 'logAutoScroll') {
      state.logAutoScroll = event.target.checked;
    }
  });
}

function wireNavigation() {
  document.addEventListener('click', (event) => {
    const page = event.target.closest('[data-page]');
    if (page) {
      event.preventDefault();
      navigate(page.dataset.page);
      return;
    }
    const jobOpen = event.target.closest('[data-job-open]');
    if (jobOpen) {
      navigate('activity');
      selectJob(jobOpen.dataset.jobOpen);
    }
  });
  $('#openWorkspaceBtn').addEventListener('click', () => api.openWorkspace());
  $('#refreshSystemBtn').addEventListener('click', refreshSystem);
  $('#jobsPill').addEventListener('click', () => navigate('activity'));
}

function wireServices() {
  $('#dlssStartBtn').addEventListener('click', () => startEmbedded('dlss'));
  $('#dlssLaunchBtn').addEventListener('click', () => startEmbedded('dlss'));
  $('#dlssStopBtn').addEventListener('click', () => stopEmbedded('dlss'));
  $('#dlssReloadBtn').addEventListener('click', () => {
    const webview = $('#dlssWebview');
    if (!webview.hidden) webview.reload();
  });
  $('#dlssOpenOutputsBtn').addEventListener('click', () => {
    const root = state.config?.paths?.dlssRoot;
    if (root) api.openFolder(`${root}\\outputs`);
  });

  $('#mazanokeLaunchBtn').addEventListener('click', () => startEmbedded('mazanoke'));
  $('#mazanokeStartBtn').addEventListener('click', () => startEmbedded('mazanoke'));
  $('#mazanokeReloadBtn').addEventListener('click', () => {
    const webview = $('#mazanokeWebview');
    if (!webview.hidden) webview.reload();
  });
  $('#mazanokeOpenFolderBtn').addEventListener('click', () => {
    const root = state.config?.paths?.mazanokeRoot;
    if (root) api.openFolder(root);
  });

  for (const [name, id] of [['dlss', 'dlssWebview'], ['mazanoke', 'mazanokeWebview']]) {
    const webview = document.getElementById(id);
    webview.addEventListener('did-fail-load', (event) => {
      if (event.errorCode === -3) return;
      toast(`${name === 'dlss' ? 'DLSS' : 'Mazanoke'} failed to load: ${event.errorDescription || 'unknown error'}`, 'error');
    });
    webview.addEventListener('dom-ready', () => {
      const loading = document.getElementById(name === 'dlss' ? 'dlssLoading' : 'mazanokeLoading');
      if (loading) loading.hidden = true;
    });
  }
}

function wireGlobal() {
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'r' && state.currentPage === 'activity') {
      event.preventDefault();
      refreshJobs();
    }
  });
  $('#appVersion').textContent = `v${state.appInfo?.version || '0.1'}`;
}

async function loadEverything() {
  state.appInfo = await api.getAppInfo();
  const [config, models, services, jobs] = await Promise.all([
    api.getConfig(),
    api.getModelStatus(),
    api.listServices(),
    api.listJobs()
  ]);
  state.config = config;
  state.models = models;
  state.services = services;
  state.jobs = jobs;
  renderAllModels();
  renderOverview();
  renderJobs();
  renderServiceDots();
  renderDlss();
  renderMazanoke();
  fillSettings();
  refreshSystem();
}

async function init() {
  try {
    if (!api) throw new Error('The Gendo preload bridge did not load.');
    await loadEverything();
    api.onJobUpdate(handleJobUpdate);
    api.onJobLog(handleJobLog);
    api.onServiceUpdate(handleServiceUpdate);
    api.onConfigUpdate((config) => {
      state.config = config;
    });
    wireNavigation();
    wireForms();
    wireSettings();
    wireActivity();
    wireMediaViewer();
    wireServices();
    wireGlobal();
    setupDropzones();
    renderFileList('deca');
    renderFileList('gvhmr');
    renderFileList('sharp');
    renderFileList('sam');
    renderFileList('fusionBody');
    renderFileList('fusionFace');
    updateGvhmrSpecs();
    updateSharpSpecs();
    updateSamSpecs();
    updateFusionSpecs();
    $('#appLoading').classList.add('hidden');
    $('#appShell').classList.add('ready');
    navigate('overview');
    setInterval(() => {
      if (document.hidden) return;
      $$('[data-elapsed-start]').forEach((element) => {
        element.textContent = formatElapsed(element.dataset.elapsedStart);
      });
    }, 1000);
    setInterval(() => {
      if (!document.hidden) {
        renderRecentJobs();
        renderJobList();
        updateJobBadge();
      }
    }, 30000);
  } catch (error) {
    console.error(error);
    const status = $('#loadingStatus');
    if (status) status.textContent = cleanError(error);
    toast(cleanError(error), 'error');
    $$('.app-shell, #appLoading').forEach((element) => element.classList.remove('hidden'));
    $('#appLoading').style.opacity = '0';
    $('#appLoading').style.visibility = 'hidden';
    $('#appShell').classList.add('ready');
  }
}

document.addEventListener('DOMContentLoaded', init);
