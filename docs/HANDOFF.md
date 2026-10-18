# 交接：Naiwa Motion Lab 进度与未完成任务（2026-10-17）

给换到另一台电脑后继续开发的人（包括新的 Claude / Codex 会话）。原来那台机器上的长期记忆和各个 subagent 的上下文带不过来，
所以用户的全部要求、每个模块的进度和下一步都写在这里。先读这一页，再读 `docs/BRIEF.md`（产品与协作规则）、
`src/contracts.ts`（模块间接口）、`docs/soft-binding.md`（软体绑定设计）。

## 一句话现状

- **能跑的最新版本是标签 `runnable-2026-10-17`（提交 `7a192ed`）**：模拟实验页的新界面、真模型、全身软体（Rapier 体积软体 +
  刚体骨骼）、预设舞蹈 / 摄像头 / 上传视频的动作迁移、录制、中英切换都在。截图：`docs/handoff/runnable-7a192ed.png`。
  已知问题：自由模式下奶蛙开局就倒地；跳舞时有穿模；模拟面板默认展开（应收进“实验室”）；模拟器列表显示“加载中”。
- **`main` 的最新提交是各模块做到一半的 WIP，打开是白屏**：模拟模块正在重构成“核心 + 板块”，`src/sim/frog.ts` 引用的
  `./skeleton` 已被挪进 `src/sim/blocks/skeleton.ts` 改写，路径和接口没改完，页面加载时这个文件 404。单元测试
  （`npx vitest run`，9 个文件 86 个测试）全部通过；`npx tsc --noEmit` 有 29 处报错，集中在 `src/sim/blocks/`、`src/sim/flesh.ts`、
  `src/motion/api.ts`、`src/main.ts`。
- 停下的原因：所有 Claude subagent 在 2026-10-16 晚上撞上每周额度（10-21 早上 5 点太平洋时间恢复），13 路同时停在半路。

## 在新电脑上跑起来

```bash
git clone git@github.com:ZhiqiLi-CG/naiwa-motion-lab.git && cd naiwa-motion-lab
npm ci                      # Node 18.19+；依赖版本都钉死在 package.json
git checkout runnable-2026-10-17 && npx vite --port 5180    # 能跑的版本；回到开发：git checkout main
npx vitest run              # 单元测试
npm run e2e                 # 端到端检查（puppeteer-core，需要本机 Chrome：CHROME=/path/to/chrome）
node tests/tools/shot.mjs <url> <out.png> --wait 8000        # 无头 Chrome 截图（用 GPU 跑 WebGL2）
```

不在 git 里、需要时再准备的东西：

| 东西 | 用途 | 怎么准备 |
|---|---|---|
| 舞蹈源视频（别人的视频，不进 git、不发布） | 重新提取 `public/dances/*.json` | `yt-dlp` + `node tools/dances/add.mjs <id>`（来源和时间段在 `tools/dances/dances.json`、`tools/dances/SOURCES.md`） |
| HY-Motion 的 Python 环境 | 文字生成舞蹈（`tools/dances/hy_motion.py`） | 新建 conda 环境，Hugging Face 下载需自己的 `HF_TOKEN` |
| Blender 5.2.2 | 重建模型 `blender -b -P assets-src/naiwa/build_naiwa.py` | 模型已提交在 `public/models/naiwa.glb`，平时不用 |
| Genesis 1.4.2 的 Python 环境 | Genesis 高清渲染 `python tools/genesis-hd/render.py session.json -o out.mp4 [--renderer nyx\|raster]` | 原机器用的是 `genesis-world` 的 venv |

MediaPipe 的 wasm 和姿态模型已自托管在 `public/mediapipe/`（运行时不访问 Google，国内可用）。

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

版权提醒：奶蛙是 2024 年从奶龙（第七印象的商业 IP）二创出来的梗；仓库目前是私有的，公开发布前需要用户决定。

## 架构速览

- 模块按文件夹分工，接口全部在 `src/contracts.ts`，`src/main.ts` 是总装（帧循环、模式切换、手势到工具、事件到表情和声音）。
- `src/store.ts`：唯一的状态；`AppState` 含 `playback`（暂停 / 单步 / 慢放）、`stats`（帧率、步进耗时、粒子、单元、体积比）、
  `simulator` / `simulators`、`retargeter` / `retargeters`、`lang` 等。
- 模拟器插件接口：`SimulatorInfo` 声明参数（`SimParameter`），页面据此生成控件；`src/sim/api.ts` 设计为核心循环 + 槽位
  `skeleton, flesh, target, coupling, collision, interaction, output, metrics`，一个模拟器 = 一组板块。
- 动作迁移插件接口：`src/motion/api.ts`，槽位 `filter → constraints → solver → output`，外加指标（贴合度、平滑度、四肢入体、脚滑）。

## 各模块进度与下一步

| 模块（文件夹） | 已完成（已提交） | 做到一半（WIP 提交里） | 下一步 |
|---|---|---|---|
| 模型（`assets-src/naiwa`, `public/models`） | 最新版 `7a192ed`：在用户认可的基准上改；Body + 四肢共 5 个封闭网格，`_softness`，关节环线和平滑权重，41 个双四元数蒙皮测试姿态通过；表情 laugh / tongue / surprise / blink | — | 线性蒙皮在举手时肩根仍有重叠（见 `assets-src/naiwa/NOTES.md`）；随模拟需要继续调权重 |
| 模拟（`src/sim`） | 第一版 FrogSim（`21cc7d4`）：Rapier 体积软体身体 + 带马达球铰的刚体骨骼、不倒翁回正、戳 / 拍 / 抓 / 球、事件 | 全身软体（`flesh.ts`：每块肉一个体积软体、按部位分簇、深层粒子挂骨头）；重构成核心 + 板块（`api.ts`、`core.ts`、`registry.ts`、`parts.ts`、`blocks/skeleton.ts`）——停在“写核心循环”这一步，导致 main 白屏 | ① 先把重构收尾、让 main 重新能跑；② 修穿模（四肢与身体的接触、关节限位）、弯腰时头胸塌陷（换旋转不变的超弹性单元 / FEM 求解、头胸挂骨头的粒子数）、开局倒地；③ CPU 示例 `cpu-constraints` 插件声明参数；④ 写 `docs/simulator-api.md`（含一个自定义板块的最小例子）；⑤ 暴露形变质量指标和动量 / 能量漂移 |
| GPU 示例（`src/sim/gpu`） | 无 | 刚开工，没有文件 | WebGPU 上的 MLS-MPM（及 GPU FEM / XPBD），按板块写、声明参数；先解决原机器无头 Chrome 拿不到 WebGPU 适配器的问题 |
| 算法库（`src/algorithms/{motion,sim}`, `docs/learn`） | 文档模板 | 两个库刚开工，没有文件 | retarget：方向拷贝、两骨 IK、CCD、FABRIK、阻尼最小二乘、带约束优化、One Euro / Kalman / Savitzky–Golay、脚接触清理；simulation：质点弹簧、PBD/XPBD、形状匹配、Projective Dynamics、线性 / 共旋 / neo-Hookean FEM（隐式）、各种碰撞板块、两向耦合；每个配学习页 |
| 代码编辑器（`src/labcode`） | 无 | 开了个头（`compile.ts`、`loader.ts` 及测试） | 在页面里按板块编辑、热替换、出错回退、和内置算法同场景对比、旁边显示学习页；挂在“实验室”下 |
| 角色（`src/character`） | 加载 GLB（缺文件时用代码拼的替身）、焊接成封闭网格交给模拟、软体变形渲染、四肢软体、五官跟随表面局部坐标、克制的生命感（眨眼、呼吸、视线、强戳时短暂惊讶）；每帧约 0.76 ms | 替身和 dev 页的小改动 | 给 `FleshPart` 填 `skinIndices` / `skinWeights`；和模拟的 output 板块划清边界；眼睛在大变形时贴住表面 |
| 动作迁移（`src/motion`） | MediaPipe 摄像头 / 上传视频（先分析、非因果平滑、同步播放、存“我的舞蹈”）、程序舞蹈 + 视频舞蹈轨迹、按 dt 推进（暂停和慢放可用）、四肢避开身体、中英状态文案 | 插件接口 `api.ts`（核心还没写） | 写核心；默认 retarget 换成清楚的数值方法（带约束优化 / IK）；暴露指标；写 `docs/motion-api.md` |
| 舞蹈素材（`tools/dances`, `public/dances`） | 狗熊哆嗦毛（明文军示范，1.46 s 循环）、提取工具一条命令重建 | Nae Nae、科目三、肚皮舞、企鹅舞轨迹及工具更新；HY-Motion 文字生成舞蹈 | 检查新轨迹的效果，补英文名 |
| 舞台（`src/stage`） | 完成：干净画面（天空渐变 + 波点地面 + 荷叶），能看清凹陷的侧向主光，软阴影，跟随相机，手势识别（点 / 拖 / 划 / 双指），`setInsets`；每帧 CPU 约 0.4 ms | — | 无 |
| UI（`src/ui`, `src/styles`） | 模拟实验页布局（动作面板、模拟面板、回放 / 交互条、读数、按插件声明生成参数）、中英切换 | 通用插件区（模拟器和 retarget 共用）、回放条、读数 | 把技术面板全部收进默认关闭的“实验室”；接上模拟器 / retarget 列表；去掉剩下的游戏化元素 |
| 媒体（`src/media`） | 完成：轻微的肉感碰撞音（默认静音）、录制（仅奶蛙 / 画中画 / 真人 vs 奶蛙并排，带视频原声）、分享、配置链接、图标和 manifest | — | 无 |
| 端到端测试（`tests/e2e`） | `npm run e2e` 构建并检查真实页面：暂停 / 单步 / 慢放、模拟器组合、每支舞的穿模和头形、中英两种语言；CC BY 测试视频 | 场景编排还在改 | 跑通并接上模拟的质量指标 |
| Genesis 高清（`src/session`, `tools/genesis-hd`） | 会话录制格式和播放器，Genesis 全身 FEM 肉 + 记录的骨骼渲染 | 场景和表面的改进，准备换成 Genesis 的隐式 FEM | 跑通一段真实会话的 1080p 渲染，和浏览器同一时刻对比 |
| 部署 | `vercel.json`、`public/_headers` | — | 用户决定是否、何时发布（不要自动部署） |

## 建议的继续顺序

1. 让 `main` 重新能跑：收尾模拟重构（`src/sim/blocks/skeleton.ts` 的导入路径和接口，`frog.ts` 改用新核心或暂时继续走旧路径）。
2. 穿模、头胸塌陷、开局倒地（软体是特色，这是用户最在意的问题）。
3. UI 的“实验室”默认收起，接上 `store.simulators` / `store.retargeters`。
4. 插件接口和文档定稿（`docs/simulator-api.md`、`docs/motion-api.md`），再并行铺开 GPU 示例、两个算法库和代码编辑器。
5. Genesis 高清和端到端测试收尾；之后再做推迟的 Lab 对话模式。
