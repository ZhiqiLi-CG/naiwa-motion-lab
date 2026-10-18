# Naiwa Motion Lab

[中文](#中文) · [English](#english)

## 中文

Naiwa Motion Lab 是一个在浏览器里运行的动作迁移 + 模拟页面：把人的动作（摄像头、上传的视频，或从真实视频里采集的预设舞蹈）迁移到奶蛙身上；奶蛙的身体是挂在骨骼上的软体，可以戳、推、拖、扔，看它的肉怎么晃。每个身体部位的材质都能调，人和蛙可以并排对比，结果可以录下来。全部在浏览器里跑，不需要后端。

### 一键安装

**Windows**：双击 `install.cmd`。

**Linux**（macOS 同样适用）：

```bash
./install.sh
```

新机器上，一行命令就能克隆并安装：

```bash
git clone https://github.com/ZhiqiLi-CG/naiwa-motion-lab.git && cd naiwa-motion-lab && ./install.sh
```

```bat
git clone https://github.com/ZhiqiLi-CG/naiwa-motion-lab.git && cd naiwa-motion-lab && install.cmd
```

安装脚本会做三件事：

1. 检查 Node.js（需要 18.19 或更新）和 npm。如果没有或版本太旧，会先问你，再安装 Node.js LTS：
   - Windows 用 `winget install OpenJS.NodeJS.LTS`，Windows 可能会弹出管理员权限确认；
   - Linux 用 nvm 装到 `~/.nvm`，不需要 sudo。
2. 运行 `npm ci`，按 `package-lock.json` 装依赖。依赖已经是最新时会跳过。
3. 列出哪些已经就绪、哪些可选组件还没装，并告诉你怎么启动。

脚本可以重复运行。在哪个目录下运行都行，路径里有空格也没关系。失败时会说明原因，并以非零退出码结束。

可用选项：

- `--yes`（Windows：`-Yes`）：不询问，直接安装（无人值守）；
- `--skip-node`（`-SkipNode`）：不自动安装 Node；
- `--force`（`-Force`）：即使依赖已是最新，也重新 `npm ci`。

### 一键运行

**Windows**：双击 `start.cmd`。**Linux**：运行 `./start.sh`。也可以在任何平台上运行 `npm start`。

启动脚本的流程：

1. 依赖缺失时，先自动安装；
2. 启动页面，默认地址是 http://localhost:5180/ ；端口被占用时，自动换下一个空闲端口；
3. 如果 Codex CLI 已安装并且已登录，同时启动本机 Lab 服务；
4. 等页面能打开了，再打开默认浏览器；
5. 按 `Ctrl+C` 停止全部进程。Windows 上停止后如果出现“终止批处理操作吗(Y/N)?”，按 Y 或 N 都行。

可用选项：

| 选项 | 作用 |
| --- | --- |
| `--no-open` | 不打开浏览器。没有图形界面时（SSH、WSL）只打印地址 |
| `--no-lab` | 不启动本机 Lab |
| `--port N` | 使用指定端口 |
| `--host` | 让局域网里的其他设备（例如手机）也能访问。注意：局域网走的是普通 http，浏览器可能不给摄像头权限 |

用法示例：`start.cmd --no-open`、`./start.sh --host`、`npm start -- --port 5300`。

生产构建：`npm run start:prod`。它会先构建，再用 `vite preview` 运行构建结果，默认端口 5181。和开发服务器一样，响应带 COOP/COEP 头。

### 环境要求

- **必需**：
  - Node.js 18.19 或更新，以及 npm（安装脚本会处理）；
  - 一个较新的桌面浏览器，推荐 Chrome 或 Edge。有 WebGPU 时最好，没有也能用。
- **可选：本机 Lab**：需要 [Codex CLI](https://github.com/openai/codex)，并且已登录。
  - 安装和登录：`npm i -g @openai/codex`，然后 `codex login`。
  - 装好后，页面上会出现对话入口和“用 Codex 优化”入口；没有 Codex 时，这些入口保持隐藏，其余功能照常可用。
  - Lab 服务只监听 127.0.0.1（默认端口 5170），可以单独用 `npm run lab` 启动。
- **只有开发者需要**：Chrome（端到端检查和截图工具）、ffmpeg（录制检查）。

### 开发命令

```bash
npm run dev                 # 只启动 Vite 开发服务器（http://localhost:5180/）
npm run build               # 类型检查 + 生产构建（dist/）
npx vitest run              # 单元测试（模拟器的真实模型测试较慢，要几分钟）
npm run test:lab            # 本机 Lab 服务的测试
npm run e2e -- --head       # 端到端检查：在无头 Chrome 里检查最后一次提交（约 14 分钟）
node tests/tools/shot.mjs <url> <out.png> --wait 8000 [--eval "js"]   # 无头 Chrome 截图
```

### 项目结构

- `docs/HANDOFF.md`：进度、已知问题、下一步。接手开发先读这一页。
- `docs/BRIEF.md`：产品定位和协作规则。
- `docs/simulator-api.md`、`docs/motion-api.md`：模拟器和动作迁移的插件接口。
- `docs/learn/`：讲解模拟和动作迁移原理的学习笔记。

### 许可

- 本项目的代码和文档采用 Apache-2.0 许可，见 `LICENSE` 和 `NOTICE`。
- 第三方组件的许可见 `THIRD_PARTY_NOTICES.md`。
- 奶蛙这个角色，以及描绘它的文件（`public/models/`、`assets-src/naiwa/`），**不在**上述许可范围内。

## English

Naiwa Motion Lab is a motion-transfer + simulation page that runs in the browser. It transfers a person's motion onto 奶蛙 (Naiwa); the motion can come from the webcam, an uploaded video, or preset dances captured from real videos. Naiwa's body is soft flesh simulated over a skeleton, and you can poke, push, drag and throw it to see how the flesh responds. You can also set the material per body region, compare the person and the frog side by side, and record the result. No backend is needed.

### One-click install

**Windows**: double-click `install.cmd`.

**Linux** (also macOS):

```bash
./install.sh
```

On a fresh machine, clone and install in one line:

```bash
git clone https://github.com/ZhiqiLi-CG/naiwa-motion-lab.git && cd naiwa-motion-lab && ./install.sh
```

```bat
git clone https://github.com/ZhiqiLi-CG/naiwa-motion-lab.git && cd naiwa-motion-lab && install.cmd
```

The installer does three things:

1. Checks for Node.js (18.19 or newer) and npm. If they are missing or too old, it asks first, then installs Node.js LTS:
   - on Windows with `winget install OpenJS.NodeJS.LTS` (Windows may ask for administrator approval);
   - on Linux with nvm into `~/.nvm` (no sudo).
2. Runs `npm ci` to install the dependencies from `package-lock.json`. If they are already up to date, it skips this step.
3. Prints what is ready, which optional parts are missing, and how to start.

You can safely run it again. It works from any directory and with paths that contain spaces. If something fails, it says why and exits with a non-zero code.

Options:

- `--yes` (Windows: `-Yes`): install without asking (unattended);
- `--skip-node` (`-SkipNode`): never install Node automatically;
- `--force` (`-Force`): run `npm ci` again even when the dependencies are already up to date.

### One-click run

**Windows**: double-click `start.cmd`. **Linux**: run `./start.sh`. On any platform you can also run `npm start`.

What the start script does:

1. Installs the dependencies first if they are missing.
2. Starts the page on http://localhost:5180/ by default. If that port is busy, it uses the next free one.
3. If Codex CLI is installed and logged in, it also starts the local Lab server.
4. Waits until the page answers, then opens your default browser.
5. Stops everything when you press `Ctrl+C`. On Windows, if you then see "Terminate batch job (Y/N)?", either answer works.

Options:

| Option | What it does |
| --- | --- |
| `--no-open` | Don't open a browser. Without a display (SSH, WSL), the script only prints the address |
| `--no-lab` | Don't start the local Lab |
| `--port N` | Use port N |
| `--host` | Make the page reachable from other devices on your LAN, such as a phone. Over plain http on the LAN, browsers may block the camera |

Examples: `start.cmd --no-open`, `./start.sh --host`, `npm start -- --port 5300`.

Production build: `npm run start:prod` builds the app, then serves the build with `vite preview` on port 5181 by default. Like the dev server, it sends the COOP/COEP headers.

### Requirements

- **Required**:
  - Node.js 18.19 or newer, with npm (the installer takes care of this);
  - a recent desktop browser (Chrome or Edge recommended). WebGPU helps, but the page also works without it.
- **Optional, for the local Lab**: [Codex CLI](https://github.com/openai/codex), installed and logged in.
  - To set it up: `npm i -g @openai/codex`, then `codex login`.
  - With Codex, the page shows a chat entry and an "Optimize with Codex" entry. Without Codex, those stay hidden and everything else works as usual.
  - The Lab server listens on 127.0.0.1 only (port 5170 by default). You can also start it on its own with `npm run lab`.
- **Developers only**: Chrome (for the end-to-end checks and the screenshot tool) and ffmpeg (for checking recordings).

### Developer commands

```bash
npm run dev                 # just the Vite dev server (http://localhost:5180/)
npm run build               # type check + production build (dist/)
npx vitest run              # unit tests (the simulator's real-model tests take a few minutes)
npm run test:lab            # tests for the local Lab server
npm run e2e -- --head       # end-to-end checks of the last commit in headless Chrome (about 14 min)
node tests/tools/shot.mjs <url> <out.png> --wait 8000 [--eval "js"]   # headless Chrome screenshot
```

### Project layout

- `docs/HANDOFF.md`: progress, known issues and next steps. Read this first if you are taking over development.
- `docs/BRIEF.md`: what the product is and how we work on it.
- `docs/simulator-api.md`, `docs/motion-api.md`: the plugin interfaces for simulators and motion transfer.
- `docs/learn/`: notes that explain how the simulation and the motion transfer work.

### License

- The project's code and documentation are licensed under Apache-2.0. See `LICENSE` and `NOTICE`.
- Third-party components and their licenses are listed in `THIRD_PARTY_NOTICES.md`.
- The character 奶蛙 (Naiwa) and the files that depict it (`public/models/`, `assets-src/naiwa/`) are **not** covered by this license.
