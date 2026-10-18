# 交接：Naiwa Motion Lab 进度与未完成任务（2026-10-18）

这页写给接着开发的人，包括新的 Claude / Codex 会话：用户的全部要求、每个模块的进度、已知问题和下一步都在这里。先读这一页，再读下面几份：

- `docs/BRIEF.md`：产品定位和协作规则
- `src/contracts.ts`：模块之间的接口
- `docs/simulator-api.md`、`docs/motion-api.md`：模拟和动作迁移两个插件接口
- `docs/soft-binding.md`：软体怎么绑到骨骼上

## 一句话现状

- **发布候选版**：标签 `rc-2026-10-18`，说明见 `docs/RELEASE-NOTES.md`。
  - `main` 能完整跑起来。
  - 端到端检查中，没过的项目全部是默认模拟器的质量指标，见下面“已知问题”。
  - 其余功能全部通过：摄像头、上传视频、录制、手机、中英切换、GPU 与 CPU 并行回退、代码实验室、本机 Lab、手感面板。
- **开发机已经换到 Windows 11**。原来在 Linux 上写的脚本都已经适配 Windows。机器配置：
  - AMD Radeon 880M 核显，WebGPU 可用；
  - Node 24、Chrome；
  - ffmpeg 用 winget 装；
  - Codex CLI 0.155.1，已登录。
- **旧标签 `runnable-2026-10-17`（`7a192ed`）只作对照**：它在自由模式下也会倒、会折。

## 跑起来

```bash
git clone git@github.com:ZhiqiLi-CG/naiwa-motion-lab.git && cd naiwa-motion-lab
npm ci                      # Node 18.19+；依赖版本都钉死在 package.json
npx vite                    # http://localhost:5180/（开发服务器带 COOP/COEP 头，页面是跨源隔离的）
npm run lab                 # 可选：本机 Lab 服务 127.0.0.1:5170；检测到 Codex CLI 已登录，页面才出现对话和“用 Codex 优化”入口
npx vitest run              # 单元测试（模拟的真实模型测试较慢，几分钟）
npm run test:lab            # 本机 Lab 服务的测试（node:test）
npm run e2e -- --head       # 端到端检查：构建最后一次提交，在无头 Chrome 里检查（约 14 分钟，同一时间只能跑一个）
node tests/tools/shot.mjs <url> <out.png> --wait 8000 [--eval "js"]   # 无头 Chrome 截图（自动找 Chrome，Windows 上用 D3D11）
```

Windows 上要注意三件事：

- **删目录**：不要递归删除带 `node_modules` 目录联接（junction）的目录，比如 worktree 或 `.cache/e2e/head`，否则会顺着联接把真正的 `node_modules` 删掉。端到端脚本已经改成只解除联接。万一坏了，用 `npm rebuild` 加 `npm install` 补回来；不要用 `npm ci`，它会打断正在跑的开发服务器。
- **换行**：`.gitattributes` 固定用 LF 换行。
- **给用户看的页面**：最好从一个已验证提交的 worktree 单独起服务，例如 `git worktree add ../naiwa-head <提交>`，再 `npx vite --port 5182`。不要让用户看到 subagent 正在改的工作区。

下面这些不在 git 里，需要时再准备：

| 东西 | 用途 | 怎么准备 |
|---|---|---|
| 舞蹈源视频（别人的视频，不进 git、不发布） | 重新提取 `public/dances/*.json` | `yt-dlp` + `node tools/dances/add.mjs <id>`；来源和时间段在 `tools/dances/dances.json` 和 `tools/dances/SOURCES.md` |
| HY-Motion 的 Python 环境 | 用文字生成舞蹈（`tools/dances/hy_motion.py`） | 新建 Python 环境；Hugging Face 的 token 存在用户机器上的 hf_key 文件里，只引用路径，不打印、不提交 |
| Blender 5.2.2 | 重建模型：`blender -b -P assets-src/naiwa/build_naiwa.py` | 这台机器没装；模型已经提交在 `public/models/naiwa.glb` |
| Genesis 1.4.2 的 Python 环境 | Genesis 高清渲染（已暂停，见要求 14） | — |

MediaPipe 的 wasm 和姿态模型自己托管在 `public/mediapipe/`。它自带的使用统计上报（`odml.pa.googleapis.com`）已经在 `src/motion/mediapipe.ts` 里拦掉，运行时不会访问 Google。

## 用户的要求（按提出顺序，都仍然有效）

1. **产品**：这是给“**动作迁移 + 软体模拟**”做的展示页面，不是小游戏（“我们只是给我们的动作迁移 + simulation 一个页面，不是再做一个小游戏”，
   “你现在这些有点太游戏了”）。名字 **Naiwa Motion Lab**，奶蛙是角色名。
2. **两个核心都是数值算法**：动作迁移（retarget）和 simulation。
3. **角色**：严格是 `assets-src/naiwa/references/` 里那只奶蛙（黄色梨形身体、米色肚皮、两侧小绿眼、深橄榄色手脚、捧腹大笑），
   “不要搞成其他的形象”。mesh 和骨骼由 Codex（Blender）建，用户要求 ultra effort、“争取最后出一个更好的”；用户认可的基准版本是
   `assets-src/naiwa/versions/naiwa-1540-ultra-a.glb`（对照图 01）。
4. **软体是特色**，而且是**全身**的（身体、头、四肢），可以分部位设不同参数；**穿模很严重**是用户点名的最大问题。
5. **物理优先**：用户问过“肉相对蒙皮目标的偏差”会不会“不太物理”——默认必须是物理模型（超弹性、旋转不变的单元，骨骼作边界条件，
   双向耦合、动量守恒）；蒙皮目标只作为有物理解释的选项（结缔组织拉索或随姿态变化的静止形状），权重默认 0。见 `docs/soft-binding.md`。
6. **模拟器是 Lab**：核心代码很简单，周围按板块模块化（碰撞、软体求解、耦合……），每个板块都能单独换成别人自己的；接口公开，
   用户能改代码做实验；“所以这就要求了你现在的simulation的代码要干净”。**约束求解给 CPU 一个示例，MPM/FEM 给 GPU 一个示例**，
   模拟器作为选项提供。
7. **retarget 也是 Lab**：它是数值算法，同样做成可编辑、可替换的板块。
8. **算法库 + 学习文档**：两个核心都提供多种常用算法示例，每个配一页简洁的学习文档（模板 `docs/learn/TEMPLATE.md`）。
9. **渐进展开**：模拟器、参数、读数、代码编辑器默认隐藏在“实验室 / Lab”后面；第一眼看到的是好玩的部分（奶蛙在动、选舞蹈、开摄像头、
   传视频、戳它拖它）。
   **2026-10-17 补充**：实验室收起时也要有不需要专业知识的调控——材质一键切换、“软↔硬 / 晃得久↔很快停 / 肚子小↔肚子大”滑块、慢动作和月球重力开关、恢复默认；和实验室里的精确参数是同一份状态。
10. **画面干净**：不要“噗！”“DUANG~”之类的漫画字、爆点、震屏、气泡、计数器；**波点地面和荷叶背景可以保留**。声音默认关闭。
11. **UI 风格**：学 RobotGen Studio 的规范（token、明暗主题、对比度、紧凑精确的控件），但不能照抄（“太重了”）。
12. **动作来源**：摄像头、用户上传视频（先整段分析再同步播放，可存为“我的舞蹈”，录“真人 vs 奶蛙”并排视频并带原声）、预设动作。
    第一个动作迁移是**狗熊哆嗦毛**，Nae Nae 等也要。视频只在本地用来提取动作，发布的只有姿态数据。
13. **语言**：中英文切换（`src/i18n.ts`，所有文案 `{ zh, en }`）。
14. **渲染**：浏览器实时为主，另加 **Genesis 离线高清版**（导出一段表演，在 Genesis 里重新模拟并渲染成 1080p）。**2026-10-17 用户决定：Genesis 高清版暂时不要**，不进这次发布，代码（`src/session`、`tools/genesis-hd`）留着不动。
15. **本机 Lab 模式（2026-10-17 用户改为这次就做上）**：本机 Lab 模式——像 RobotGen 那样的 Codex 对话界面 +“优化手感”“生成新舞蹈”按钮（方案见 `docs/next/lab.md`）。
16. **协作规则**：提交信息不加 AI 署名（Co-Authored-By / Generated with）；GitHub 操作（push、remote 等）由用户授权后通过 Codex CLI
    会话执行；向用户汇报用中文；并行要多（“尽量多启动几个subagent”）。
17. **检测 GPU**（2026-10-17）：页面检测有没有可用的 GPU（非软件 / fallback 的 WebGPU 适配器）。没有 GPU 时 MPM / FEM
    **不禁用**，改走 CPU 并行（Web Worker + SharedArrayBuffer，需要 COOP/COEP 头）；同一个算法两套后端，页面显示当前用的是哪个。
18. **检测本地 Codex CLI 登录**（2026-10-17）：本机 Lab 服务检测 Codex CLI 是否安装并登录（`codex login status`）；登录了就在
    很多地方提供“用 Codex 优化”（模拟参数 / 分部位软度、retarget 参数和指标、代码实验室里用户的板块、舞蹈）；没有就隐藏这些入口
    并说明怎么登录。见 `docs/next/lab.md`。

19. **2026-10-17/18 的其他决定**：
    - 捧腹大笑的笑声先不加。
    - 公开发布前要处理版权：协议只能管用户自己写的代码，奶蛙形象需要授权或者换成原创角色（见 `docs/RELEASE-NOTES.md`）。
    - 头型检查不算脖子交界那一圈。
    - 先出发布候选版，模拟质量问题之后接着改。

版权提醒：奶蛙是 2024 年从奶龙二创出来的梗，奶龙是第七印象的商业 IP。仓库目前是私有的，公开发布前需要用户决定。

## 架构速览

- **分工**：模块按文件夹分工，接口全部在 `src/contracts.ts`。`src/main.ts` 负责总装：帧循环、模式切换、手势、事件、挂载各个面板。
- **状态**：`src/store.ts` 是唯一的状态，包括模式、材质参数、回放、读数、模拟器和 retarget 的选择与列表、语言等。
- **模拟**（`src/sim`，`docs/simulator-api.md`）：
  - 结构：小核心 `core.ts` 按槽位 `skeleton, flesh, target, coupling, collision, interaction, output, metrics` 依次调用各个板块；一个模拟器就是一组板块，在 `registry.ts` 里注册。
  - 内置 CPU 示例：`cpu-constraints`（`src/sim/blocks/`）。
  - GPU 示例：`gpu-mpm`（`src/sim/gpu/`）。同一个算法两套后端：有 GPU 时用 WebGPU 计算着色器，没有时用 Web Worker 加 SharedArrayBuffer 做 CPU 并行。`initPhysics` 启动时检测设备。
  - 算法库：7 个模拟器（`src/algorithms/sim/`）——质点弹簧、PBD、XPBD、形状匹配、Projective Dynamics、隐式 FEM、FEM 加拉索。
  - 和动作的衔接：换动作来源时调用 `FrogSim.transition()` 平滑过渡；`PoseFrame.contacts` 把正踩在地上的脚传给骨骼，让骨骼钉住它。
- **动作迁移**（`src/motion`，`docs/motion-api.md`）：
  - 槽位：`filter → constraints → goal → solver → output`。
  - 默认 retarget：`planted-feet`，即方向拷贝加身体约束，再让脚踩住地面。
  - 算法库（`src/algorithms/motion/`）：Kalman、Savitzky–Golay、CCD、FABRIK、阻尼最小二乘、带约束优化、脚踩地。
  - 上传视频：分析时估计镜头运动和切镜（`cameraMotion.ts`），自动去掉镜头运动，并在切镜处衔接（`src/algorithms/motion/coherence/`）。
- **代码实验室**（`src/labcode`）：入口是实验室 → 编辑代码。可以按槽位看源码、复制为“我的”，按 Ctrl+S 编译并热替换，出错自动回退；能和内置板块对比，旁边显示学习页。
- **本机 Lab**（`lab/` 和 `src/lab`）：
  - `npm run lab` 在 127.0.0.1:5170 起服务，由它驱动 `codex exec --json`。
  - Codex 通过 `lab/bin/naiwa.mjs` 操作页面，说明写在 `lab/AGENTS.md`。
  - 任务框架在 `lab/jobs/`，现有三个任务：优化手感、改进模块、优化这段动作。
  - 服务没启动或 Codex 没登录时，页面上不显示任何相关入口。
- **学习页**：每个板块一页，在 `docs/learn/{motion,sim}/<板块 id>.{zh,en}.md`；对比表在 `docs/learn/motion-index.md` 和 `docs/learn/sim-index.md`。

## 各模块进度

| 模块（文件夹） | 现状 |
|---|---|
| 模型（`assets-src/naiwa`, `public/models`） | 基于用户认可的基准修改，版本 `7a192ed`。资产里舌头的 shape key 放错了位置（悬在脸前 5.6 cm），现在由 `src/character/tongue.ts` 在加载时贴回下唇。以后在 `build_naiwa.py` 里改正后，这段运行时修正会自动不生效 |
| 模拟（`src/sim`） | 核心加板块的结构已完成。开局能站稳（10 秒漂移约 3 cm），弯腰时头不塌，切换动作不再撕裂（`switch.test.ts`）。四肢由骨骼携带（实验室里可以切回“解算”），腿靠肉的凸包和肚子接触，支撑脚可以钉住。用真实模型跑的测试：`sim.test.ts`、`switch.test.ts`、`tracking.test.ts` |
| GPU 示例（`src/sim/gpu`） | `gpu-mpm`：MLS-MPM（neo-Hookean 加粘性）。WebGPU 约 2.6 ms/步，CPU 并行 7–18 ms/步。粒子出现非有限值或飞远会被复位，不会把 NaN 交给渲染。还没有 GPU 版 FEM |
| 算法库和学习页 | 两个库都完成，每个板块一页中英学习文档，附实测对比表。FEM 和 PD 改用 BDF2，不像后向欧拉那样把晃动吃掉；“弹性”滑块控制的是衰减时间 |
| 代码实验室（`src/labcode`） | 完成。已保存的实验，刷新页面后要在实验室里重新选一次 |
| 角色（`src/character`） | 完成。舌头贴住脸，跳舞时最远离脸 2.9 cm，接近 3 cm 的检查上限 |
| 动作迁移（`src/motion`） | 完成。端到端测得的视频跟随度：竖屏 0.78–0.95，横屏 0.58–0.79。慢放同步、镜头运动补偿、“优化这段动作”任务都可用 |
| UI（`src/ui`, `src/styles`） | 实验室默认收起；有手感面板，不需要专业知识也能调；手机上触控区不小于 40 px；中英双语 |
| 媒体（`src/media`） | 录制前先预热编码器；MP4 没画面时自动换成 WebM；声音默认关闭 |
| 本机 Lab（`lab/`, `src/lab`） | 完成。“优化动作迁移”和“生成新舞蹈”目前只是对话模板，不是带前后指标的正式任务 |
| 端到端测试（`tests/e2e`） | Windows 和 Linux 都能跑，场景覆盖上面所有功能 |
| Genesis 高清 | 用户决定暂停 |
| 部署 | `vercel.json` 和 `public/_headers` 已配好（含 COOP/COEP）。是否发布、何时发布由用户决定；公开前先处理版权（见 `docs/RELEASE-NOTES.md`） |

## 已知问题（发布候选版，按重要程度排序）

1. **默认模拟器的四肢还会插进身体 1–4 cm**：腿 1.1–3.8 cm，部分舞蹈里手臂 2–3.9 cm（原来最深 11 cm）。给手臂也加凸包可以解决，但每帧要多花 1.7–3 ms。
2. **物理耗时 p95 约 4.9–5.1 ms**，超过 4 ms 的预算（画面仍是 60 fps）。耗时来自三处：腿的凸包、关节附近的体积修正、骨骼的 2 次内部 PGS 迭代。
3. **狗熊哆嗦毛抬脚时脚尖擦地**：屏幕上的脚滑约 21 cm/s，标准是 5，原来是 117。
   - retarget 给出的目标已经不滑了，问题在模拟里：抬脚慢半拍，落地又冲过头。
   - 钉脚只管脚踩住的那一段，抬脚和落地时管不到。
   - 加硬马达反而更糟，需要换一种抬脚的做法。
4. **个别舞蹈里有少量翻转单元**：青蛙跳 6 个，狗熊哆嗦毛 5 个，其余 0–1 个。狗熊哆嗦毛的左臂体积掉到 0.83。
5. **默认果冻戳一下晃得不够久**：不可压缩的肉更符合物理，但凹坑变浅了。下一步应该把剪切调软，而不是让肉可压缩。
6. **隐式 FEM 和 FEM 加拉索每步超过 4 ms**；neo-Hookean 在负载高的机器上达不到实时。
7. **跳舞时少数头部顶点变形 3–8 cm**：头型检查已经去掉脖子交界那一圈（用户决定）。去掉后，站立和捧腹大笑通过；其余 13 支舞的整体误差（rms 0.5–1.1 cm）基本达标，但个别顶点的最大偏差超过 2.5 cm 的上限。

## 建议的继续顺序

1. **用户验收**：用户验收发布候选版，决定版权怎么处理、要不要公开（见 `docs/RELEASE-NOTES.md`）。
2. **模拟质量**：
   - 修抬脚（已知问题 3）；
   - 把手臂凸包和物理预算放在一起权衡（已知问题 1、2）；
   - 把剪切调软，让果冻多晃一会儿（已知问题 5）。
3. **四肢外层软肉**：四肢的核心继续跟着骨骼走，只解算外面一薄层肉，让手臂和大腿也能晃、能戳出坑，同时守住耗时预算。
4. **本机 Lab**：
   - 把“优化动作迁移”和“生成新舞蹈”做成带前后指标的正式任务。
   - 世界坐标的视频转动作模型（GVHMR / WHAM）需要 Python 环境，最好有 NVIDIA 显卡。
5. **GPU FEM 示例**；Genesis 高清等用户决定恢复时再做。
