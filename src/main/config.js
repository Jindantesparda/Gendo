'use strict';

const fs = require('fs');
const path = require('path');

const APP_ROOT = path.resolve(__dirname, '..', '..');
const CONFIG_PATH = path.join(APP_ROOT, 'config.json');

const DEFAULT_CONFIG = {
  workspace: 'D:\\Gendo\\workspace',
  maxConcurrentJobs: 1,
  paths: {
    decaRoot: 'D:\\Model\\D\\DECA',
    decaPython: 'D:\\Conda\\envs\\deca_py310\\python.exe',
    gvhmrRoot: 'D:\\Model\\GVHMR',
    gvhmrPython: 'D:\\Conda\\envs\\gvhmr\\python.exe',
    sharpRoot: 'D:\\Model\\ml-sharp',
    sharpExe: 'D:\\Conda\\envs\\sharp_gpu\\Scripts\\sharp.exe',
    sharpCheckpoint: 'D:\\.cache\\torch\\hub\\checkpoints\\sharp_2572gikvuh.pt',
    samBodyRoot: 'C:\\Users\\Munya\\repos\\sam-3d-body',
    samPython: 'D:\\Conda\\envs\\sam_3d_body\\python.exe',
    samCheckpoint: 'C:\\Users\\Munya\\repos\\sam-3d-body\\checkpoints\\sam-3d-body-dinov3\\model.ckpt',
    samMhr: 'C:\\Users\\Munya\\repos\\sam-3d-body\\checkpoints\\sam-3d-body-dinov3\\assets\\mhr_model.pt',
    dlssRoot: 'D:\\Model\\DLSS.5.Visual.Enhancer.v5.0',
    dlssPython: 'D:\\Model\\DLSS.5.Visual.Enhancer.v5.0\\bin\\python-3.13.15-embed-amd64\\python.exe',
    mazanokeRoot: 'D:\\Model\\mazanoke-main',
    blender: 'C:\\Program Files\\Blender Foundation\\Blender 5.1\\blender.exe'
  }
};

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function merge(base, patch) {
  if (!isPlainObject(base)) return patch;
  const out = { ...base };
  if (!isPlainObject(patch)) return out;
  for (const [key, value] of Object.entries(patch)) {
    if (isPlainObject(value) && isPlainObject(base[key])) out[key] = merge(base[key], value);
    else if (value !== undefined) out[key] = value;
  }
  return out;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function loadConfig() {
  let userConfig = {};
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      userConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    }
  } catch (error) {
    console.error('Could not read Gendo config:', error.message);
  }

  const config = merge(DEFAULT_CONFIG, userConfig);
  config.maxConcurrentJobs = Math.max(1, Math.min(2, Number(config.maxConcurrentJobs) || 1));

  try {
    if (!fs.existsSync(CONFIG_PATH)) {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf8');
    }
  } catch (error) {
    console.error('Could not create Gendo config:', error.message);
  }

  try {
    ensureDir(config.workspace);
    ensureDir(path.join(config.workspace, 'jobs'));
    ensureDir(path.join(config.workspace, 'logs'));
  } catch (error) {
    console.error('Could not create Gendo workspace:', error.message);
  }

  return config;
}

function saveConfig(patch) {
  const current = loadConfig();
  const next = merge(current, patch || {});
  next.maxConcurrentJobs = Math.max(1, Math.min(2, Number(next.maxConcurrentJobs) || 1));
  ensureDir(next.workspace);
  ensureDir(path.join(next.workspace, 'jobs'));
  ensureDir(path.join(next.workspace, 'logs'));
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

module.exports = {
  APP_ROOT,
  CONFIG_PATH,
  DEFAULT_CONFIG,
  loadConfig,
  saveConfig,
  ensureDir
};
