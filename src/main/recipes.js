'use strict';

const fs = require('fs');
const path = require('path');

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.mkv', '.avi', '.webm', '.m4v']);
const DECA_RUNNER = path.resolve(__dirname, '..', '..', 'services', 'deca_runner.py');
const DECA_FACE_WORKER = path.resolve(__dirname, '..', '..', 'services', 'deca_face_worker.py');
const BLENDER_FUSE_HEAD = path.resolve(__dirname, '..', '..', 'services', 'blender_fuse_head.py');

function toPosix(value) {
  return String(value).replace(/\\/g, '/');
}

function sanitizeStem(name) {
  const ext = path.extname(name);
  const stem = path.basename(name, ext)
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 70);
  return (stem || 'input') + ext.toLowerCase();
}

function assertFile(filePath, label = 'Input file') {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error(`${label} not found: ${filePath || '(none)'}`);
  }
  if (!fs.statSync(filePath).isFile()) {
    throw new Error(`${label} is not a file: ${filePath}`);
  }
}

function copyOrLink(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  try {
    fs.linkSync(source, destination);
  } catch {
    fs.copyFileSync(source, destination);
  }
}

function stageFiles(filePaths, destinationDir) {
  fs.mkdirSync(destinationDir, { recursive: true });
  const staged = [];
  const used = new Set();
  for (const source of filePaths || []) {
    assertFile(source);
    let base = sanitizeStem(path.basename(source));
    let candidate = base;
    let counter = 2;
    while (used.has(candidate.toLowerCase())) {
      candidate = `${path.basename(base, path.extname(base))}_${counter}${path.extname(base)}`;
      counter += 1;
    }
    used.add(candidate.toLowerCase());
    const destination = path.join(destinationDir, candidate);
    copyOrLink(source, destination);
    staged.push(destination);
  }
  if (staged.length === 0) throw new Error('Choose at least one input file.');
  return staged;
}

function commandExists(filePath) {
  return Boolean(filePath) && fs.existsSync(filePath);
}

function imageLabel(files) {
  return files.length === 1 ? path.basename(files[0]) : `${files.length} images`;
}

function createPlan({ kind, payload, jobDir, config }) {
  const paths = config.paths;
  const inputDir = path.join(jobDir, 'input');
  const outputDir = path.join(jobDir, 'output');
  fs.mkdirSync(outputDir, { recursive: true });

  if (kind === 'deca') {
    const files = payload.files || [];
    const staged = stageFiles(files, inputDir);
    const args = [
      DECA_RUNNER,
      '--project', paths.decaRoot,
      '-i', inputDir,
      '-s', outputDir,
      '--device', payload.device === 'cpu' ? 'cpu' : 'cuda',
      '--iscrop', 'True',
      '--rasterizer_type', payload.rasterizer === 'standard' ? 'standard' : 'pytorch3d',
      '--render_orig', 'True',
      '--useTex', payload.useTex ? 'True' : 'False',
      '--extractTex', payload.extractTex === false ? 'False' : 'True',
      '--saveVis', 'True',
      '--saveImages', 'True',
      '--saveObj', payload.saveObj === false ? 'False' : 'True',
      '--saveDepth', payload.saveDepth ? 'True' : 'False',
      '--saveKpt', 'False',
      '--saveMat', 'False'
    ];
    return {
      title: `DECA Head · ${imageLabel(files)}`,
      summary: payload.saveObj === false ? 'Geometry maps only' : 'Detailed head mesh + render maps',
      inputs: files,
      stages: [{
        name: 'Reconstruct 3D head',
        command: paths.decaPython,
        args,
        cwd: paths.decaRoot
      }]
    };
  }

  if (kind === 'gvhmr') {
    const source = payload.video;
    assertFile(source, 'Video');
    const staged = stageFiles([source], inputDir)[0];
    const cameraMode = payload.cameraMode === 'dpvo'
      ? 'dpvo'
      : payload.cameraMode === 'simplevo'
        ? 'simplevo'
        : 'static';
    const bookendPose = payload.bookendPose === 'tpose' || payload.bookendPose === 'apose'
      ? payload.bookendPose
      : 'none';
    const holdRaw = Number(payload.bookendHold);
    const blendRaw = Number(payload.bookendBlend);
    const bookendHold = Number.isFinite(holdRaw) ? Math.max(1, Math.min(120, Math.round(holdRaw))) : 15;
    const bookendBlend = Number.isFinite(blendRaw) ? Math.max(0, Math.min(120, Math.round(blendRaw))) : 15;
    const bookendLabel = bookendPose === 'tpose' ? 'T-pose' : bookendPose === 'apose' ? 'A-pose' : 'none';
    const bookendArgs = bookendPose === 'none'
      ? []
      : ['--bookend-pose', bookendPose, '--bookend-hold', String(bookendHold), '--bookend-blend', String(bookendBlend)];
    const args = [
      'tools/demo/demo.py',
      '--video', toPosix(staged),
      '--output_root', toPosix(outputDir)
    ];
    if (cameraMode === 'static') args.push('--static_cam');
    if (cameraMode === 'dpvo') args.push('--use_dpvo');
    if (payload.verbose) args.push('--verbose');
    if (payload.focalMm !== '' && payload.focalMm !== null && payload.focalMm !== undefined) {
      const mm = Number(payload.focalMm);
      if (Number.isFinite(mm) && mm > 0) args.push('--f_mm', String(Math.round(mm)));
    }

    const stem = path.basename(staged, path.extname(staged));
    const resultDir = path.join(outputDir, stem);
    const stages = [{
      name: cameraMode === 'static' ? 'Recover motion · static camera' : 'Recover motion · moving camera',
      command: paths.gvhmrPython,
      args,
      cwd: paths.gvhmrRoot
    }];

    const resultsPath = path.join(resultDir, 'hmr4d_results.pt');
    if (payload.exportFbx) {
      const npzPath = path.join(resultDir, 'animation_smplx.npz');
      const fbxPath = path.join(resultDir, 'animation_smplx.fbx');
      stages.push({
        name: bookendPose === 'none' ? 'Bake SMPL-X mesh cache' : `Bake SMPL-X mesh cache · ${bookendLabel} bookends`,
        command: paths.gvhmrPython,
        args: [
          'tools/demo/export_mesh.py',
          '--results', resultsPath,
          '--output', npzPath,
          ...bookendArgs
        ],
        cwd: paths.gvhmrRoot
      });
      stages.push({
        name: 'Export animated FBX',
        command: paths.blender,
        args: [
          '--factory-startup',
          '--background',
          '--python', 'tools/demo/blender_export_fbx.py',
          '--', npzPath, fbxPath
        ],
        cwd: paths.gvhmrRoot
      });
    }

    if (payload.exportRig) {
      const rigDataPath = path.join(resultDir, 'rig_data.npz');
      const rigFbxPath = path.join(resultDir, `rig_${stem}.fbx`);
      stages.push({
        name: bookendPose === 'none' ? 'Build rig data' : `Build rig data · ${bookendLabel} bookends`,
        command: paths.gvhmrPython,
        args: [
          'tools/demo/prepare_rig_data.py',
          '--results', resultsPath,
          '--output', rigDataPath,
          '--betas', 'mean',
          '--fps', '30',
          ...bookendArgs
        ],
        cwd: paths.gvhmrRoot
      });
      stages.push({
        name: 'Export rigged FBX',
        command: paths.blender,
        args: [
          '--factory-startup',
          '--background',
          '--python', 'tools/demo/blender_build_rig.py',
          '--', rigDataPath, rigFbxPath
        ],
        cwd: paths.gvhmrRoot
      });
    }

    const deliverables = ['world-grounded motion video'];
    if (payload.exportFbx) deliverables.push('animated FBX');
    if (payload.exportRig) deliverables.push('rigged FBX');
    if (bookendPose !== 'none') deliverables.push(`${bookendLabel} bookends · ${bookendHold}+${bookendBlend}f`);

    return {
      title: `GVHMR Motion · ${path.basename(source)}`,
      summary: deliverables.join(' + '),
      inputs: [source],
      stages
    };
  }

  if (kind === 'fusion') {
    const sameSource = payload.sameSource !== false;
    const bodyVideo = payload.bodyVideo;
    assertFile(bodyVideo, 'Body video');
    const faceVideo = sameSource ? bodyVideo : payload.faceVideo;
    if (!sameSource) assertFile(faceVideo, 'Face video');
    const staged = stageFiles(sameSource ? [bodyVideo] : [bodyVideo, faceVideo], inputDir);
    const stagedBody = staged[0];
    const stagedFace = sameSource ? staged[0] : staged[1];
    const bodyStem = path.basename(stagedBody, path.extname(stagedBody));
    const bodyLabel = path.basename(bodyVideo);
    const faceLabel = path.basename(faceVideo);

    const workDir = path.join(outputDir, 'fusion_work');
    const gvhmrOut = path.join(workDir, 'gvhmr');
    const gvhmrResult = path.join(gvhmrOut, bodyStem);
    const rigDataPath = path.join(workDir, 'rig_data.npz');
    const bodyRigPath = path.join(workDir, 'body_rig.fbx');
    const faceDir = path.join(workDir, 'deca_face');
    const faceTemp = path.join(workDir, 'deca_frames');
    const finalDir = path.join(outputDir, `fused_${bodyStem}`);
    const fusedFbx = path.join(finalDir, `fused_${bodyStem}.fbx`);
    const fusedBlend = path.join(finalDir, `fused_${bodyStem}.blend`);
    const previewPath = path.join(finalDir, `fused_${bodyStem}_preview.png`);

    const cameraMode = payload.cameraMode === 'dpvo'
      ? 'dpvo'
      : payload.cameraMode === 'simplevo'
        ? 'simplevo'
        : 'static';
    const gvhmrArgs = [
      'tools/demo/demo.py',
      '--video', toPosix(stagedBody),
      '--output_root', toPosix(gvhmrOut)
    ];
    if (cameraMode === 'static') gvhmrArgs.push('--static_cam');
    if (cameraMode === 'dpvo') gvhmrArgs.push('--use_dpvo');

    const syncMode = sameSource ? 'fit' : (payload.syncMode === 'offset' ? 'offset' : 'fit');
    const numberOr = (value, fallback) => {
      const number = Number(value);
      return Number.isFinite(number) ? number : fallback;
    };
    const faceOffset = Math.round(numberOr(payload.faceOffset, 0));
    const headScale = Math.min(2, Math.max(0.5, numberOr(payload.headScale, 1)));
    const headOffsetX = numberOr(payload.headOffsetX, 0);
    const headOffsetY = numberOr(payload.headOffsetY, 0);
    const headOffsetZ = numberOr(payload.headOffsetZ, 0);

    const stages = [
      {
        name: 'Recover body motion',
        command: paths.gvhmrPython,
        args: gvhmrArgs,
        cwd: paths.gvhmrRoot
      },
      {
        name: 'Build body rig data',
        command: paths.gvhmrPython,
        args: [
          'tools/demo/prepare_rig_data.py',
          '--results', path.join(gvhmrResult, 'hmr4d_results.pt'),
          '--output', rigDataPath,
          '--betas', 'mean',
          '--fps', '30'
        ],
        cwd: paths.gvhmrRoot
      },
      {
        name: 'Build body armature',
        command: paths.blender,
        args: [
          '--factory-startup',
          '--background',
          '--python', 'tools/demo/blender_build_rig.py',
          '--', rigDataPath, bodyRigPath
        ],
        cwd: paths.gvhmrRoot
      },
      {
        name: 'Capture DECA face sequence',
        command: paths.decaPython,
        args: [
          DECA_FACE_WORKER,
          '--video', stagedFace,
          '--output', faceDir,
          '--temp', faceTemp,
          '--device', 'cuda',
          '--identity', 'reference'
        ],
        cwd: paths.decaRoot
      },
      {
        name: 'Fuse DECA head to GVHMR rig',
        command: paths.blender,
        args: [
          '--factory-startup',
          '--background',
          '--python', BLENDER_FUSE_HEAD,
          '--',
          '--body-rig', bodyRigPath,
          '--head-data', path.join(faceDir, 'deca_face.npz'),
          '--texture', path.join(faceDir, 'deca_face_texture.png'),
          '--out-fbx', fusedFbx,
          '--out-blend', fusedBlend,
          '--preview', previewPath,
          '--sync', syncMode,
          '--face-offset', String(faceOffset),
          '--head-scale', String(headScale),
          '--head-offset-x', String(headOffsetX),
          '--head-offset-y', String(headOffsetY),
          '--head-offset-z', String(headOffsetZ)
        ],
        cwd: paths.gvhmrRoot
      }
    ];

    return {
      title: sameSource
        ? `Head Fusion · ${bodyLabel}`
        : `Head Fusion · body ${bodyLabel} + face ${faceLabel}`,
      summary: sameSource
        ? 'DECA face and GVHMR body from one video'
        : 'DECA face and GVHMR body from separate clips',
      inputs: sameSource ? [bodyVideo] : [bodyVideo, faceVideo],
      stages,
      params: {
        sameSource,
        bodyVideo,
        faceVideo,
        cameraMode,
        syncMode,
        faceOffset,
        headScale,
        headOffsetX,
        headOffsetY,
        headOffsetZ
      }
    };
  }

  if (kind === 'sharp') {
    const files = payload.files || [];
    const staged = stageFiles(files, inputDir);
    const stages = staged.map((stagedFile) => {
      const args = [
        'predict',
        '-i', stagedFile,
        '-o', outputDir,
        '--device', payload.device === 'cpu' ? 'cpu' : 'cuda'
      ];
      if (commandExists(paths.sharpCheckpoint)) args.push('-c', paths.sharpCheckpoint);
      if (payload.render) args.push('--render');
      return {
        name: `${payload.render ? 'Splat + render' : 'Predict splat'} · ${path.basename(stagedFile)}`,
        command: paths.sharpExe,
        args,
        cwd: paths.sharpRoot
      };
    });
    return {
      title: `SHARP View · ${imageLabel(files)}`,
      summary: payload.render ? '3D Gaussian splat + trajectory render' : '3D Gaussian splat',
      inputs: files,
      stages
    };
  }

  if (kind === 'sam') {
    const files = payload.files || [];
    const staged = stageFiles(files, inputDir);
    const detector = ['fasterrcnn', 'vitdet', 'sam3'].includes(payload.detector)
      ? payload.detector
      : 'fasterrcnn';
    const fovName = payload.fov === 'moge2' ? 'moge2' : '';
    const args = [
      'demo.py',
      '--image_folder', inputDir,
      '--output_folder', outputDir,
      '--checkpoint_path', paths.samCheckpoint,
      '--mhr_path', paths.samMhr,
      '--detector_name', detector,
      '--fov_name', fovName,
      '--bbox_thresh', String(payload.bboxThreshold ?? 0.5)
    ];
    return {
      title: `SAM 3D Body · ${imageLabel(files)}`,
      summary: detector === 'fasterrcnn'
        ? 'Full-body mesh · Faster R-CNN detector'
        : `Full-body mesh · ${detector} detector`,
      inputs: files,
      stages: [{
        name: 'Reconstruct human meshes',
        command: paths.samPython,
        args,
        cwd: paths.samBodyRoot
      }]
    };
  }

  throw new Error(`Unknown job type: ${kind}`);
}

module.exports = {
  IMAGE_EXTENSIONS,
  VIDEO_EXTENSIONS,
  createPlan,
  sanitizeStem,
  toPosix
};
