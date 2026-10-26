# Gendo

### A unified AI workbench for computer graphics.

Gendo is a local-first desktop application that brings multiple AI-powered graphics and 3D reconstruction tools into a single workspace. Built with Electron, it provides a unified interface for facial reconstruction, human motion capture, 3D Gaussian splatting, body reconstruction, visual enhancement, and image compression.

Instead of managing each tool independently, Gendo provides a common environment for configuring model runtimes, running processing jobs, monitoring execution, and managing generated assets.

**Its core idea is simple: bring specialized graphics models together and make them work within a unified production workflow.**

---

## Features

- **Unified workspace** — Access multiple graphics tools through a single desktop interface.
- **3D facial reconstruction** — Recover detailed FLAME head geometry and facial expressions using DECA.
- **Human motion reconstruction** — Reconstruct world-grounded human motion from video using GVHMR.
- **Single-image 3D reconstruction** — Generate 3D Gaussian splats from images using SHARP.
- **Full-body reconstruction** — Recover human body meshes from images using SAM 3D Body.
- **Head Fusion** — Combine a DECA facial performance with a GVHMR body rig to produce an animated character.
- **Integrated utilities** — Access the DLSS 5 Visual Enhancer and Mazanoke through embedded local interfaces.
- **Job management** — Track processing stages, monitor logs, inspect outputs, and cancel running jobs.
- **Media previews** — Preview generated images and videos directly inside the application.
- **Local-first execution** — Run model workflows on your own workstation without uploading media to a Gendo cloud service.
- **Configurable runtimes** — Manage model paths, Python environments, checkpoints, and Blender through Settings.

## Integrated tools

| Tool | Purpose | Primary output |
|---|---|---|
| DECA | Facial reconstruction and expression capture | 3D head geometry, facial data and renders |
| GVHMR | Human motion reconstruction | Motion data, animated meshes and FBX exports |
| SHARP | Single-image 3D Gaussian splatting | `.ply` Gaussian splats and optional render videos |
| SAM 3D Body | Full-body mesh reconstruction | Reconstruction previews and PLY meshes |
| DLSS 5 Visual Enhancer | Visual enhancement | Outputs managed by the embedded application |
| Mazanoke | Image compression | Compressed images managed by the embedded application |

Each tool retains its own underlying model and runtime. Gendo provides the desktop interface and orchestration layer that brings them together.

## Head Fusion: combining facial performance and body motion

Head Fusion is Gendo's multi-model character reconstruction workflow.

It combines **DECA's facial reconstruction** with **GVHMR's reconstructed body motion**, using Blender to assemble the final character.

### Workflow

1. Supply a body video and, optionally, a separate face video.
2. GVHMR reconstructs the body motion and prepares the body rig.
3. DECA captures facial geometry and per-frame expression data.
4. Blender attaches the reconstructed head to the body, transfers facial expression data into shape keys, and prepares the final character.
5. Export the fused character as an animated FBX and an editable Blender scene.

### Output

- Rigged character with body and facial animation
- Animated FBX with embedded textures
- Editable Blender scene (`.blend`)
- Full-body and head-close-up previews
- Packed facial texture

Head Fusion supports using the same video for body and face capture or separate clips with configurable timing alignment.

**Current limitations:** The reconstructed body is not automatically textured, and facial texture quality depends on the source footage and DECA's UV resolution. Separate face and body videos do not have automatic audio-based synchronization.

## Interface

Gendo uses a dark, Photoshop-inspired graphite theme with restrained liquid-glass styling, compact controls, and a focused blue accent.

The workspace includes:

- **Overview** — Recent jobs, workstation information, and recent outputs.
- **Tool pages** — Dedicated interfaces for configuring and running each model.
- **Composition** — Access to the Head Fusion workflow.
- **Activity** — Job queue, processing stages, logs, output previews, and cancellation controls.
- **Settings** — Model paths, checkpoints, runtime configuration, and application preferences.

Generated assets are organized by job, making it easier to trace results back to their source inputs and execution logs.

## Architecture

Gendo is built around a desktop orchestration layer that connects the graphical interface to independently installed graphics models.

| Component | Responsibility |
|---|---|
| Electron | Desktop application and main process |
| HTML, CSS and JavaScript | Renderer and user interface |
| IPC bridge | Communication between the renderer and main process |
| Job manager | Input staging, process execution, queueing, logging and output discovery |
| Python environments | Isolated model execution and dependency management |
| Blender | Rig construction, character fusion and FBX export |
| Local services | Embedded interfaces for supported tools and local media serving |

The application stores configuration and job data locally. Native GPU-heavy jobs are serialized by default to reduce VRAM contention.

## Requirements

- Windows 10 or Windows 11
- NVIDIA GPU with a working CUDA driver
- At least 6 GB of VRAM recommended
- Sufficient disk space for model weights, Python environments, source media, and generated assets
- Blender 5.1 for workflows requiring Blender integration
- Node.js 24+ and npm for development and dependency installation

Individual models have additional runtime, dependency, and checkpoint requirements.

**Hardware note:** A 6 GB GPU is the current target configuration, but performance and model compatibility vary. Large inputs and GPU-intensive workloads may require shorter videos, fewer images, or additional memory.

## Installation and setup

Gendo is currently distributed as a local Electron application rather than a packaged installer.

### 1. Obtain the project

Clone the repository and navigate to the project directory.

```bash
git clone <your-repository-url>
cd Gendo
```

### 2. Install application dependencies

```bash
npm install
```

### 3. Configure model runtimes

Open Gendo and navigate to **Settings → Model runtimes**.

Verify that the configured paths point to valid installations of:

- DECA and its Python environment
- GVHMR and its Python environment
- SHARP and its Python environment
- SAM 3D Body and its Python environment
- DLSS Visual Enhancer
- Mazanoke
- Blender 5.1

Ensure that all required model checkpoints and assets are present.

### 4. Launch Gendo

For development, run:

```bash
npm start
```

For the existing local installation, launch Gendo using the supplied Windows batch file or desktop shortcut.

### 5. Run your first job

Start with one tool at a time. Check the Activity page for execution progress, process logs, and generated outputs.

> The GitHub repository does not automatically include every upstream model, checkpoint, Python environment, or external application. These must be installed and configured separately.

## Project structure

```text
Gendo/
├── main.js
├── preload.js
├── config.json
├── renderer/
│   ├── app.js
│   ├── styles.css
│   └── theme.css
├── src/
│   └── main/
│       ├── config.js
│       ├── jobs.js
│       ├── recipes.js
│       ├── services.js
│       ├── localServer.js
│       └── system.js
├── services/
│   ├── deca_runner.py
│   ├── deca_face_worker.py
│   ├── blender_fuse_head.py
│   └── dlss_server.py
├── assets/
└── workspace/
    ├── jobs/
    └── logs/
```

The workspace contains per-job inputs, outputs, logs, and manifests. Generated files can be inspected from the Activity page or opened directly in the operating system.

## Privacy

Gendo is designed for local execution.

- Model inference runs on the local workstation.
- Media serving is restricted to the local machine.
- Embedded DLSS and Mazanoke interfaces use local services.
- Gendo telemetry and cloud media uploads are not implemented.

Individual dependencies may have their own network behavior, licensing terms, or usage conditions. Review the relevant upstream documentation before deployment or redistribution.

## Current status

**Version:** `0.1.0`

Gendo is an actively developed desktop workbench. Its current implementation includes multiple integrated graphics tools, job orchestration, local runtime configuration, media previews, and the DECA + GVHMR Head Fusion workflow.

Some tools retain their original interfaces and output conventions, and the application is not yet distributed as a standalone installer.

## Roadmap

Potential future directions include:

- Expand multi-model workflows beyond Head Fusion.
- Improve interoperability between generated assets.
- Add more graphics models and reconstruction pipelines.
- Improve runtime diagnostics and dependency validation.
- Refine output management and project organization.
- Develop a packaged installation and distribution workflow.

This roadmap describes potential directions, not features currently guaranteed to be implemented.

## Credits and acknowledgements

Gendo builds on the work of the researchers and developers behind its integrated models and tools.

Please consult and cite the original projects when using their work:

- [DECA](https://github.com/YadiraF/DECA)
- [GVHMR](https://github.com/zju3dv/GVHMR)
- [SHARP](https://github.com/apple/ml-sharp)
- [SAM 3D Body](https://github.com/facebookresearch/sam-3d-body)
- [Blender](https://www.blender.org/)

The DLSS Visual Enhancer and Mazanoke integrations also remain subject to their respective projects' licenses and terms.

Gendo is an integration project; inclusion of an upstream tool does not imply endorsement by its authors.

## License

A project license has not yet been specified. Before publishing the repository, add a `LICENSE` file and verify the redistribution terms of the application and its dependencies.

---

**Gendo — one workspace, multiple models, connected graphics workflows.**
