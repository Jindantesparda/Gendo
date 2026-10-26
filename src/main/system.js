'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

function exists(filePath) {
  try {
    return Boolean(filePath) && fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function inspectModel({ id, label, description, root, requirements }) {
  const checks = requirements.map(([checkLabel, checkPath]) => ({
    label: checkLabel,
    path: checkPath,
    ok: exists(checkPath)
  }));
  const okCount = checks.filter((check) => check.ok).length;
  return {
    id,
    label,
    description,
    root,
    state: okCount === checks.length ? 'ready' : okCount === 0 ? 'missing' : 'partial',
    checks
  };
}

function modelStatus(config) {
  const p = config.paths;
  return [
    inspectModel({
      id: 'deca',
      label: 'DECA',
      description: 'Detailed 3D expression capture',
      root: p.decaRoot,
      requirements: [
        ['Python environment', p.decaPython],
        ['DECA weights', path.join(p.decaRoot, 'data', 'deca_model.tar')],
        ['FLAME model', path.join(p.decaRoot, 'data', 'generic_model.pkl')]
      ]
    }),
    inspectModel({
      id: 'gvhmr',
      label: 'GVHMR',
      description: 'World-grounded human motion',
      root: p.gvhmrRoot,
      requirements: [
        ['Python environment', p.gvhmrPython],
        ['GVHMR checkpoint', path.join(p.gvhmrRoot, 'inputs', 'checkpoints', 'gvhmr', 'gvhmr_siga24_release.ckpt')],
        ['Blender for FBX', p.blender]
      ]
    }),
    inspectModel({
      id: 'sharp',
      label: 'SHARP',
      description: 'Single-image Gaussian view synthesis',
      root: p.sharpRoot,
      requirements: [
        ['SHARP executable', p.sharpExe],
        ['Model checkpoint', p.sharpCheckpoint]
      ]
    }),
    inspectModel({
      id: 'sam',
      label: 'SAM 3D Body',
      description: 'Single-image full-body reconstruction',
      root: p.samBodyRoot,
      requirements: [
        ['Python environment', p.samPython],
        ['Body checkpoint', p.samCheckpoint],
        ['MHR asset', p.samMhr]
      ]
    }),
    inspectModel({
      id: 'dlss',
      label: 'DLSS 5',
      description: 'Image and video enhancement',
      root: p.dlssRoot,
      requirements: [
        ['Embedded Python', p.dlssPython],
        ['DLSS app', path.join(p.dlssRoot, 'app.py')]
      ]
    }),
    inspectModel({
      id: 'mazanoke',
      label: 'Mazanoke',
      description: 'Private image compression',
      root: p.mazanokeRoot,
      requirements: [
        ['Mazanoke app', path.join(p.mazanokeRoot, 'index.html')]
      ]
    })
  ];
}

function diskInfo(targetPath) {
  try {
    const stats = fs.statfsSync(targetPath);
    const total = Number(stats.blocks) * Number(stats.bsize);
    const free = Number(stats.bavail) * Number(stats.bsize);
    return { total, free, used: total - free };
  } catch {
    return null;
  }
}

async function gpuInfo() {
  try {
    const { stdout } = await execFileAsync('nvidia-smi', [
      '--query-gpu=name,memory.total,memory.used,utilization.gpu,temperature.gpu',
      '--format=csv,noheader,nounits'
    ], { windowsHide: true, timeout: 5000 });
    return stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => {
      const parts = line.split(',').map((value) => value.trim());
      const suffix = parts.slice(-4);
      return {
        name: parts.slice(0, -4).join(', '),
        memoryTotal: Number(suffix[0]),
        memoryUsed: Number(suffix[1]),
        utilization: Number(suffix[2]),
        temperature: Number(suffix[3])
      };
    });
  } catch {
    return [];
  }
}

async function systemInfo(config, appVersion) {
  const workspaceDisk = diskInfo(config.workspace);
  return {
    appVersion,
    hostname: os.hostname(),
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
    cpu: os.cpus()[0]?.model || 'Unknown CPU',
    cores: os.cpus().length,
    totalMemory: os.totalmem(),
    freeMemory: os.freemem(),
    uptime: os.uptime(),
    workspace: config.workspace,
    disk: workspaceDisk,
    gpus: await gpuInfo()
  };
}

module.exports = { modelStatus, systemInfo };
