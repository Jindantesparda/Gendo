'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { findFreePort } = require('./ports');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.ply': 'application/octet-stream',
  '.obj': 'text/plain; charset=utf-8',
  '.fbx': 'application/octet-stream',
  '.zip': 'application/zip',
  '.txt': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8'
};

function mimeFor(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function sendError(res, status, message) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(message);
}

function serveFile(req, res, filePath, options = {}) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    sendError(res, 404, 'Not found');
    return;
  }
  if (!stat.isFile()) {
    sendError(res, 404, 'Not found');
    return;
  }

  const headers = {
    'Content-Type': mimeFor(filePath),
    'Accept-Ranges': 'bytes',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': options.cacheControl || 'no-cache'
  };

  const range = req.headers.range;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match) {
      sendError(res, 416, 'Invalid range');
      return;
    }
    let start = match[1] === '' ? null : Number(match[1]);
    let end = match[2] === '' ? null : Number(match[2]);
    if (start === null && end !== null) {
      start = Math.max(0, stat.size - end);
      end = stat.size - 1;
    } else {
      start = start ?? 0;
      end = end === null ? stat.size - 1 : Math.min(end, stat.size - 1);
    }
    if (start > end || start >= stat.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      res.end();
      return;
    }
    headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
    headers['Content-Length'] = end - start + 1;
    res.writeHead(206, headers);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(filePath, { start, end }).pipe(res);
    return;
  }

  headers['Content-Length'] = stat.size;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  fs.createReadStream(filePath).pipe(res);
}

function startMediaServer() {
  const server = http.createServer((req, res) => {
    if (!['GET', 'HEAD'].includes(req.method)) {
      sendError(res, 405, 'Method not allowed');
      return;
    }
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname !== '/media') {
      sendError(res, 404, 'Not found');
      return;
    }
    const filePath = url.searchParams.get('path');
    if (!filePath) {
      sendError(res, 400, 'Missing path');
      return;
    }
    serveFile(req, res, path.normalize(filePath), { cacheControl: 'private, max-age=0, must-revalidate' });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ port: 0, host: '127.0.0.1' }, () => {
      resolve({
        server,
        port: server.address().port,
        close: () => new Promise((done) => server.close(() => done()))
      });
    });
  });
}

function startMazanokeServer(rootDir) {
  const root = path.resolve(rootDir);
  if (!fs.existsSync(path.join(root, 'index.html'))) {
    throw new Error(`Mazanoke index.html not found in ${root}`);
  }

  const server = http.createServer((req, res) => {
    if (!['GET', 'HEAD'].includes(req.method)) {
      sendError(res, 405, 'Method not allowed');
      return;
    }

    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
    } catch {
      sendError(res, 400, 'Bad URL');
      return;
    }

    if (pathname === '/') pathname = '/index.html';
    const relative = pathname.replace(/^\/+/, '');
    let candidate = path.resolve(root, relative);
    if (candidate !== root && !candidate.startsWith(root + path.sep)) {
      sendError(res, 403, 'Forbidden');
      return;
    }

    try {
      if (fs.statSync(candidate).isDirectory()) candidate = path.join(candidate, 'index.html');
    } catch {
      sendError(res, 404, 'Not found');
      return;
    }

    serveFile(req, res, candidate, {
      cacheControl: path.extname(candidate) === '.html' ? 'no-cache' : 'public, max-age=300'
    });
  });

  return findFreePort(3474).then((port) => new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ port, host: '127.0.0.1' }, () => {
      resolve({
        server,
        port,
        url: `http://127.0.0.1:${port}/`,
        close: () => new Promise((done) => server.close(() => done()))
      });
    });
  }));
}

module.exports = { startMediaServer, startMazanokeServer, serveFile };
