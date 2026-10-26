# Gendo

Gendo is a local Electron desktop workbench that puts six graphics and 3D tools behind one GUI, plus a combined head-fusion workflow:

- **DECA** — detailed animated FLAME head reconstruction
- **GVHMR** — world-grounded human motion reconstruction and FBX export
- **SHARP View** — single-image neural 3D Gaussian splatting and rendering
- **SAM 3D Body** — full-body mesh recovery from an image
- **DLSS 5 Visual Enhancer** — embedded upscaling/enhancement UI
- **Mazanoke** — embedded image compression UI
- **Head Fusion** — combines a GVHMR body with an animated DECA head

Everything runs locally. No media or model inputs are uploaded to a cloud service.

---

## 1. Quick start

### Launch

From `D:\Gendo`:

```bat
Start Gendo.bat
```

Or double-click the **Gendo** desktop/Start Menu shortcut. The icon is `assets\gendo.ico`.

`Gendo.vbs` launches without a console window.

### Requirements

- Windows 10/11
- Node.js 24+ and npm (only needed for development/reinstalling Electron)
- NVIDIA GPU with a working CUDA driver
- At least 6 GB VRAM recommended
- Free space on `D:` for models, Python environments and job outputs

### First launch

1. Open **Settings** in Gendo.
2. Check **Model runtimes** and run the filesystem health check.
3. Correct any missing path shown in red.
4. Make sure **Blender** points to Blender 5.1.
5. Start with one tool at a time. Native jobs are serialized so two GPU-heavy models do not run together.

---

## 2. Project location and layout

```text
D:\Gendo\
  main.js                    Electron main process and IPC
  preload.js                 Secure renderer bridge
  config.json                Persistent paths and app settings
  renderer\                  GUI (HTML, CSS, JS)
  src\main\                  Config, job manager, recipes, servers, health checks
  services\
    deca_runner.py           DECA/NumPy compatibility launcher
    deca_face_worker.py      Per-frame DECA face-sequence capture for Head Fusion
    blender_fuse_head.py     Blender head attachment and FBX/.blend export
    dlss_server.py           Managed DLSS Gradio launcher
  assets\                    App icon, logo mark and images
                              gendo.ico        Windows/Electron icon
                              gendo-logo.png   Rounded logo tile
                              gendo-mark.png   Transparent logo mark
                              gendo.png        512 px app image
  workspace\
    jobs\<job-id>\           Job inputs, outputs, log and manifest
    logs\                    Service logs
  Start Gendo.bat
  Gendo.vbs
```

### Workspace

Each job gets its own directory:

```text
D:\Gendo\workspace\jobs\<timestamp>-<tool>-<hash>\
  input\         Staged inputs
  output\        Generated files shown in Activity
  job.log        Full process log
  job.json       Persisted job manifest
```

Deleting a job folder removes it from history. Delete old jobs manually when disk space gets low.

---

## 3. Configured model runtimes

These are the paths currently stored in `D:\Gendo\config.json`. Change them in **Settings** if you move an install.

| Setting | Current path |
|---|---|
| Workspace | `D:\Gendo\workspace` |
| DECA root | `D:\Model\D\DECA` |
| DECA Python | `D:\Conda\envs\deca_py310\python.exe` |
| GVHMR root | `D:\Model\GVHMR` |
| GVHMR Python | `D:\Conda\envs\gvhmr\python.exe` |
| SHARP root | `D:\Model\ml-sharp` |
| SHARP executable | `D:\Conda\envs\sharp_gpu\Scripts\sharp.exe` |
| SHARP checkpoint | `D:\.cache\torch\hub\checkpoints\sharp_2572gikvuh.pt` |
| SAM 3D Body root | `C:\Users\Munya\repos\sam-3d-body` |
| SAM 3D Body Python | `D:\Conda\envs\sam_3d_body\python.exe` |
| SAM 3D Body checkpoint | `C:\Users\Munya\repos\sam-3d-body\checkpoints\sam-3d-body-dinov3\model.ckpt` |
| SAM 3D Body MHR model | `C:\Users\Munya\repos\sam-3d-body\checkpoints\sam-3d-body-dinov3\assets\mhr_model.pt` |
| DLSS root | `D:\Model\DLSS.5.Visual.Enhancer.v5.0` |
| DLSS Python | `D:\Model\DLSS.5.Visual.Enhancer.v5.0\bin\python-3.13.15-embed-amd64\python.exe` |
| Mazanoke root | `D:\Model\mazanoke-main` |
| Blender | `C:\Program Files\Blender Foundation\Blender 5.1\blender.exe` |

Important:

- The working DECA copy is now **`D:\Model\D\DECA`**, moved from `C:\Users\Munya\DECA`. The weights (FLAME/chumpy) are included there.
- `D:\Model\sam-3d-objects-main\sam-3d-objects-main` is **not** the runtime Gendo uses. The working 3D body project is `C:\Users\Munya\repos\sam-3d-body`.
- Jobs call environment executables directly. They do not run `conda activate`.

### GPU job concurrency

`maxConcurrentJobs` is `1` by default. Keep it at 1 on a 6 GB GPU. Increasing it can cause CUDA out-of-memory failures.

---

## 4. The tools

### 4.1 DECA Head

Input: one or more portrait images.

What it does:

- Detects the face.
- Reconstructs a detailed FLAME head mesh.
- Exports OBJ/MTL geometry, detail mesh, depth maps, renders, normals and optional texture maps.

Gendo runs DECA through `services\deca_runner.py`. The runner injects the NumPy aliases that old chumpy/FLAME pickles expect and supports the installed PyTorch3D rasterizer.

DECA currently uses the **PyTorch3D** rasterizer. The original standard rasterizer needs a Visual Studio `cl.exe` environment and is not configured in Gendo.

**Best input:** close, frontal, evenly lit face with no sunglasses or heavy occlusion.

### 4.2 GVHMR Motion

Input: one video.

Camera modes:

- **Static** — fastest; assumes the camera does not move.
- **SimpleVO** — visual odometry for moving cameras.
- **DPVO** — heavier moving-camera tracking.

Deliverables can include:

- 2D/incam/global preview videos
- `hmr4d_results.pt`
- animated SMPL-X mesh cache (`.npz`)
- animated blendshape FBX (`animation_smplx.fbx`)
- T-pose rig data (`rig_data.npz`)
- rigged FBX (`rig_<video>.fbx`)

The rigged option uses:

```text
tools/demo/prepare_rig_data.py
tools/demo/blender_build_rig.py
```

Blender runs with `--factory-startup` to avoid startup add-on and permission noise.

For rigged/animated FBX export, Blender must be installed and reachable from Settings.

#### Pose bookends

GVHMR exports can optionally begin and end in a neutral pose:

- **None** — preserve the source start/end poses.
- **T-pose** — all body joints neutral with arms horizontal.
- **A-pose** — arms lowered 45° with straight elbows.

`Hold frames` controls how long the exact pose is held at each end. `Blend frames` controls how many frames are used to enter and leave the captured motion. Defaults are **15 hold + 15 blend frames at each end**, adding 60 frames total.

Bookends are baked into all exported animation data:

- `animation_smplx.npz`
- `animation_smplx.fbx`
- `rig_data.npz`
- `rig_<video>.fbx`

The first and last exported frames are the exact selected pose. Root position and facing are kept from the source's first/last frame so the character stays in place. Preview videos keep their original timing.

The scripts also accept direct CLI flags:

```bat
python tools/demo/export_mesh.py --results=<hmr4d_results.pt> --output=<mesh.npz> ^
  --bookend-pose=tpose --bookend-hold=15 --bookend-blend=15

python tools/demo/prepare_rig_data.py --results=<hmr4d_results.pt> --output=<rig_data.npz> ^
  --bookend-pose=apose --bookend-hold=15 --bookend-blend=15
```

### 4.3 SHARP View

Input: one or more images.

Outputs:

- `teaser.ply` — Gaussian splat
- `teaser.mp4` — rendered orbit/render video when **Render preview** is enabled
- `teaser.depth.mp4` — depth render when enabled

Gendo runs one `sharp predict` stage per input image. This avoids a Windows case-insensitive glob bug that previously processed the same image twice.

Rendering uses the prebuilt gsplat CUDA wheel installed in `sharp_gpu`.

### 4.4 SAM 3D Body

Input: one or more images.

Outputs include a reconstruction JPG and PLY body meshes.

The working runtime is **SAM 3D Body**, not SAM 3D Objects. It uses:

- the SAM 3D Body checkpoint
- the MHR model
- a Faster R-CNN person detector
- detectron2

Detector/FOV controls are in the form. Use the default detector unless you have a specific reason to change it.

### 4.5 DLSS 5 Visual Enhancer

The existing DLSS UI is embedded inside Gendo through a managed local Gradio server.

- Gendo starts the server when you click **Launch**.
- The port is selected automatically.
- Closing Gendo or pressing **Stop** shuts the service down.
- DLSS keeps its own controls and save behavior.

### 4.6 Mazanoke

The existing Mazanoke UI is embedded through a local static server.

- Default local port: `3474`; Gendo falls back if it is busy.
- Start/stop it from the Mazanoke page.
- Compression settings and output naming are controlled by Mazanoke itself.

---

## 5. Head Fusion (DECA + GVHMR)

Open **Head Fusion** under **Composition** in the sidebar.

This workflow builds one rigged character:

1. GVHMR recovers the body motion.
2. `prepare_rig_data.py` builds a T-pose body rig.
3. Blender builds the 55-bone body armature.
4. DECA captures a facial performance from the face video.
5. Blender removes the SMPL-X head, attaches the DECA head, transfers the face shape keys and exports the fused character.

### Source modes

**Same video**

One clip drives both the body skeleton and the DECA facial performance. Face timing is locked to 1:1.

**Separate face clip**

GVHMR reads the body clip and DECA reads a different face clip.

Timing options:

- **Stretch to body** — maps the whole face performance across the body timeline.
- **Frame offset** — starts the face performance at a chosen frame offset.

For separate clips, matching frame rate, framing and performance length will give the best result. There is no audio-based automatic sync.

### Head fit

- **Head scale** — maps the FLAME head joint to the SMPL-X head joint. Default `1.0`.
- **Vertical offset (m)** — raises or lowers the head.
- **Side offset (m)** — moves the head left/right.
- **Forward offset (m)** — moves the head forward/back.

Change these only if the neck seam needs adjustment. Large values can create gaps.

### What the fusion does

- Removes SMPL-X head vertices whose combined `head + jaw` skin weight is high.
- Attaches the DECA head at the GVHMR head/neck joint.
- Removes DECA's global head rotation so neck and head movement come from the GVHMR armature.
- Keeps DECA jaw and expression motion.
- Converts per-frame facial expressions into Blender shape keys.
- Adds the head to the armature with neck/head vertex groups.
- Exports a fused FBX and a Blender scene.

### Fusion outputs

```text
output\fused_<video>\
  fused_<video>.fbx              Rigged body + DECA head + facial animation
  fused_<video>.blend            Editable Blender scene
  fused_<video>_preview.png      Full-body preview
  fused_<video>_preview_head.png Head close-up preview
  fused_face_texture.png         Packed DECA face texture
```

The `.blend` keeps the body, DECA head and armature as separate objects for manual fixes. The FBX is exported with embedded textures, the armature, the body and the head.

### Fusion limitations

- DECA's face texture is only about 256 px, so face detail depends heavily on the source footage.
- Close, frontal, well-lit, unoccluded face video is essential. Small faces, sunglasses, motion blur and harsh shadows produce smeared or dark eye regions.
- The test source used during development had sunglasses and a small face; the geometry/rig was correct but the face texture was visibly source-limited.
- GVHMR does not produce a textured body. The body remains a clay/skin-toned mesh; only the DECA head has a face texture.
- FBX round-tripping can shift animation keys by one frame in some importers. The body and face are shifted together, so relative sync is preserved.

---

## 6. Activity page, outputs and logs

Open **Activity** in the sidebar.

- Left side: job queue, filters and status.
- Main pane: job title, status, duration, stage pills, outputs and process log.

### Output previews

- Image and video files show large aspect-ratio thumbnail cards.
- Video cards show a play overlay, duration badge and format badge.
- Click a thumbnail to open the **full-size in-app viewer**.
- The viewer includes native playback controls, `Open file`, and `Esc` to close.
- Click the external-link icon on a card to open the file in the operating system.
- Non-media files (`.fbx`, `.blend`, `.npz`, `.pt`, archives) show a type icon; clicking them opens the file externally.

The Activity gallery shows up to 24 output files per job. The **Outputs** button opens the full job folder.

### Logs

- Logs are streamed into the Process log panel.
- **Auto-scroll** keeps the newest line visible.
- **Copy** copies the currently displayed log.
- **Log file** opens the persisted `job.log`.
- ANSI colors and carriage-return progress spam are stripped for readability.

### Cancellation

Active jobs have a **Cancel** action. Gendo terminates the full Windows process tree with `taskkill /PID <pid> /T /F`.

### Interface theme

Gendo uses a Photoshop-inspired graphite workspace theme with restrained liquid-glass surfaces:

- Neutral dark-gray application chrome
- Dense property panels and compact controls
- A single blue selection/primary-action accent
- Subtle translucent panels, backdrop blur, edge highlights and soft ambient color
- Recent jobs, workstation telemetry and recent output files on Overview
- Completion checks in the Activity pipeline
- Dark glass media viewer

The base component styles are in `renderer/styles.css`; the final theme layer is `renderer/theme.css`. `theme.css` is loaded after the base stylesheet and contains the color tokens, density rules, glass material and responsive overrides.

---

## 7. Configuration reference

`D:\Gendo\config.json` stores:

- `workspace`
- all model roots, Python paths, checkpoints and Blender path
- `maxConcurrentJobs`
- DLSS/Mazanoke service settings
- window/application prefs

Use **Settings** to edit paths. Changes apply to new jobs immediately. **Reset defaults** restores the known working paths.

Do not edit `config.json` while Gendo is running; save through Settings or close Gendo first.

### Environment and compatibility fixes already applied

These are important if you recreate an environment:

- **DECA**
  - NumPy aliases (`np.int`, `np.bool`, etc.) are injected by `deca_runner.py` for old chumpy/FLAME pickles.
  - PyTorch3D must match the installed PyTorch. Current tested pairing: torch `2.6.0+cu124` with `pytorch3d==0.7.9+d9839a9pt2.6.0cu124`.
  - The older `0.7.8+pt2.0.1cu118` wheel fails to load `_C` DLLs.
- **SHARP**
  - Render needs a working gsplat CUDA extension.
  - A matching prebuilt wheel was installed for torch 2.6/cu124. If `gsplat` tries to compile with `cl.exe`, the environment no longer has the right prebuilt wheel.
- **SAM 3D Body**
  - `detectron2` is required. A matching prebuilt wheel was installed.
  - The checkpoint and MHR asset paths must remain valid.
- **GVHMR**
  - FBX export needs Blender.
  - Use `--factory-startup`; it is already applied by Gendo.

---

## 8. Troubleshooting

### Gendo does not start

Run from a terminal:

```bat
cd /d D:\Gendo
node_modules\electron\dist\electron.exe .
```

If Electron is missing:

```bat
npm install
```

### A tool reports a missing runtime

Open **Settings** and check:

- the root folder exists
- the Python/executable exists
- the checkpoint exists
- Blender exists for GVHMR FBX or Head Fusion

Then reopen the tool page or start a new job.

### CUDA out of memory

- Keep only one native job running.
- Close other GPU applications.
- Use shorter videos or fewer images.
- For GVHMR, start with **Static** camera mode.
- Do not change `maxConcurrentJobs` above 1 on a 6 GB card.

### DECA fails while loading FLAME/chumpy

Run DECA through Gendo, not directly with `python demo.py`. The runner is required for the NumPy alias compatibility shim.

### SHARP render fails with gsplat/cl.exe errors

The gsplat CUDA extension is missing or incompatible. Reinstall the matching prebuilt wheel for the current torch/CUDA version; do not rely on JIT compilation unless Visual Studio C++ Build Tools is configured.

### SAM 3D Body fails on detectron2

The `sam_3d_body` environment is missing detectron2 or the installed wheel does not match torch. Reinstall the matching detectron2 wheel.

### DLSS page is blank or stuck

- Check the DLSS service log.
- Press **Stop**, then **Launch** again.
- First launch can take longer while Gradio starts.
- The UI is embedded from a local server; a network-disconnected state should not affect it.

### Mazanoke page will not load

- Check whether port `3474` is in use.
- Press **Stop**, then **Reload**.
- Check `workspace\logs\mazanoke.log`.

### Fusion head texture looks bad

This is almost always source quality, not the rig. Use:

- a close face crop
- frontal framing
- even lighting
- no sunglasses or hands over the face
- minimal motion blur
- a face large enough to cover a good portion of the frame

The generated `.blend` and `.fbx` can be opened in Blender for manual texture or material fixes.

### Fusion neck seam or head position is wrong

Use the Head fit controls, starting with small vertical/forward offsets. Do not use large scale changes. Re-run with the same sources after adjusting.

### Jobs are slow or disk fills up

- Delete old folders in `D:\Gendo\workspace\jobs`.
- The workspace is not automatically garbage-collected.
- Keep at least 10–15 GB free on `D:` for large videos and fusion outputs.

---

## 9. Development

Install dependencies:

```bat
cd /d D:\Gendo
npm install
```

Run in development:

```bat
npm start
```

Syntax checks used during development:

```bat
node --check main.js
node --check renderer\app.js
node --check src\main\recipes.js
node --check src\main\jobs.js
python -m py_compile services\deca_face_worker.py services\blender_fuse_head.py
```

Useful files:

| File | Purpose |
|---|---|
| `main.js` | Electron window, media server, IPC, service startup |
| `preload.js` | `window.gendo` API bridge |
| `src/main/config.js` | Defaults and persistent config |
| `src/main/recipes.js` | Command plans and tool stages |
| `src/main/jobs.js` | Queue, staging, processes, logs, output scanning |
| `src/main/services.js` | DLSS and Mazanoke lifecycle |
| `src/main/localServer.js` | Range-capable local media server and Mazanoke static server |
| `src/main/system.js` | Filesystem health, GPU, disk and system info |
| `renderer/app.js` | GUI state, forms, Activity viewer and IPC use |
| `renderer/styles.css` | Base component styles and layout |
| `renderer/theme.css` | Photoshop-style graphite/liquid-glass theme layer |
| `services/deca_runner.py` | DECA compatibility launcher |
| `services/deca_face_worker.py` | DECA per-frame face capture |
| `services/blender_fuse_head.py` | Blender head fusion and export |

---

## 10. Privacy and local services

- All model execution is local.
- The media server binds to loopback only.
- DLSS and Mazanoke are served on local loopback ports.
- No Gendo telemetry or cloud upload is implemented.
- Model licenses and terms remain with their original projects. Review each upstream project's license before redistributing models or generated content.

---

## 11. Known limitations

- Gendo is not packaged as an installer; it runs from `D:\Gendo` with the installed Electron runtime.
- The supported SAM runtime is **SAM 3D Body**, not SAM 3D Objects.
- The DECA standard rasterizer is not configured; use PyTorch3D.
- Fusion facial texture quality is limited by DECA's UV resolution and the source video.
- Separate face/body clips have no audio sync; use Stretch or Frame offset.
- The GVHMR body is not textured.
- DLSS and Mazanoke retain their original embedded UIs and their own save locations.
- Job outputs are not automatically deleted.

---

## 12. Version

Gendo `0.1.0`

Built as a local Electron desktop workbench. Relaunch Gendo after changing source files so the main process and renderer load the latest version.
