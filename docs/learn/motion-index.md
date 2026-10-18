# Motion-transfer algorithms · 动作迁移算法

The library in `src/algorithms/motion/` (registered by `registerMotionLibrary()`): each algorithm is one block in one
slot of the retargeting loop (`docs/motion-api.md`), with a page in Chinese and English. The built-in direction copy
(`src/motion/blocks/`: `one-euro` → `frog-body` → `person-directions` → `projected-directions` → `planted-rotations`) is
the reference everything is compared with.

`src/algorithms/motion/` 里的算法库（由 `registerMotionLibrary()` 注册）：每个算法是 retarget 循环（`docs/motion-api.md`）某个槽里的一个块，
各有一页中英文学习文档。内置的方向拷贝（`src/motion/blocks/`）是比较的基准。

| Block · 块 | Slot · 槽 | Page · 学习页 | What it does · 做什么 |
|---|---|---|---|
| `kalman-cv` | filter | [en](motion/kalman-cv.en.md) · [中](motion/kalman-cv.zh.md) | constant-velocity Kalman filter, RTS smoother for videos · 匀速卡尔曼滤波，视频用 RTS 平滑 |
| `savitzky-golay` | filter | [en](motion/savitzky-golay.en.md) · [中](motion/savitzky-golay.zh.md) | local polynomial least squares, keeps peaks · 局部多项式最小二乘，保留峰值 |
| `ccd-ik` | solver | [en](motion/ccd-ik.en.md) · [中](motion/ccd-ik.zh.md) | cyclic coordinate descent IK · 循环坐标下降 IK |
| `fabrik-ik` | solver | [en](motion/fabrik-ik.en.md) · [中](motion/fabrik-ik.zh.md) | forward and backward reaching IK · 前后向迭代 IK |
| `dls-ik` | solver | [en](motion/dls-ik.en.md) · [中](motion/dls-ik.zh.md) | damped least squares on the Jacobian · 雅可比阻尼最小二乘 IK |
| `penalty-opt` | solver | [en](motion/penalty-opt.en.md) · [中](motion/penalty-opt.zh.md) | constrained optimisation, penalty Gauss–Newton · 罚函数 Gauss–Newton 约束优化 |
| `foot-plant` | output | [en](motion/foot-plant.en.md) · [中](motion/foot-plant.zh.md) | standing feet pinned to the floor · 着地的脚钉住不滑 |

Retargeters (assemblies, all with feet planted) · 预置组合（都带脚踩实）: `planted-feet`, `kalman-planted`,
`savgol-planted`, `ccd-ik`, `fabrik-ik`, `dls-ik`, `constrained-opt`.

## How the IK solvers get targets · IK 的目标从哪来
The goal carries limb directions, not positions (the frog's limbs are far shorter than a person's). The solvers put the
wrist target where those directions land on the frog's own limbs, $W = S + \ell_1 u + \ell_2 f$, blended towards the belly
for a belly hold and above the head for an overhead reach (`limbs.ts`); the ankle likewise from the hip. Every solver
then keeps the limbs out of the body with the same projection onto `scene.constraints` (clearance ≥ thickness, joint
limits, legs apart).

目标块给的是肢体方向而不是位置（奶蛙的四肢比人短得多）。求解器把方向按奶蛙自己的肢长放出手腕目标 $W = S + \ell_1 u + \ell_2 f$，捧肚子、
举过头顶时混向肚皮或头顶（`limbs.ts`）；脚踝同理。所有求解器都用同一个投影让四肢满足 `scene.constraints`（避让 ≥ 厚度、关节限制、两腿不交叉）。

## Measured · 实测
One harness for all (`src/algorithms/motion/bench.ts`, tables printed by `npx vitest run src/algorithms/motion/bench.test.ts`):
naiwa.glb, the dance played at 60 fps through `createRetargetPipeline`, the pipeline's own metrics averaged over three
two-second windows (penetration: the worst), one block swapped into the default retargeter at a time; costs timed on
their own on a laptop CPU (Node). Values are gouxiong / naenae / kemusan (狗熊哆嗦毛 / Nae Nae / 科目三).

同一套测量（`bench.ts`）：naiwa.glb，舞蹈以 60 fps 经过 `createRetargetPipeline`，指标取三个 2 秒窗口的平均（穿透取最大），每次只替换默认
retarget 的一个块。

### Solvers and output · 求解器与输出

| gouxiong / naenae / kemusan | fidelity ° | jerk m/s³ | penetration mm | foot slide cm/s | solve + output ms |
|---|---|---|---|---|---|
| direction copy (built-in) | 16.3 / 16.3 / 17.3 | 5131 / 383 / 1254 | 7.6 / 1.0 / 1.0 | 117.3 / 11.9 / 7.2 | 0.25 / 0.25 / 0.30 |
| foot-plant | 16.3 / 16.3 / 17.3 | 5294 / 408 / 1267 | 7.6 / 2.0 / 1.0 | **9.1 / 5.7 / 4.7** | 0.29 / 0.24 / 0.32 |
| ccd-ik | 18.9 / 17.6 / 17.2 | 6258 / 1184 / 1835 | 1.0 / 1.0 / 1.0 | 118.9 / 11.9 / 7.2 | 0.59 / 0.52 / 0.62 |
| fabrik-ik | 17.5 / 16.4 / 17.6 | 4746 / 456 / 1743 | 1.0 / 1.0 / 1.0 | 117.9 / 11.9 / 7.2 | 0.50 / 0.50 / 0.73 |
| dls-ik | 17.0 / 16.1 / 18.2 | 5837 / 542 / 1701 | 1.0 / 1.0 / 1.0 | 115.9 / 11.9 / 7.2 | 0.66 / 0.52 / 0.66 |
| penalty-opt | **16.1 / 15.2 / 15.8** | 6463 / 471 / 1615 | 1.2 / 0.9 / 1.0 | 123.0 / 12.2 / 7.3 | 0.90 / 0.95 / 0.84 |

- Foot slide is the output's business: `foot-plant` cuts it 13× on 狗熊哆嗦毛 and leaves the limbs alone; the solvers do
  not change it (they keep the built-in output in this table; the registered assemblies add `foot-plant`).
- Fidelity is measured against the person's directions. Direction copy and `penalty-opt` aim at exactly that; the IK
  solvers aim at the hand and ankle positions and give a little of it up, in exchange for hands kept off the head and
  belly (the built-in lets a hand touch the head by 7.6 mm on 狗熊哆嗦毛).
- Jerk at 60 fps is dominated by the 30 fps recordings' corners (all rows share them); compare rows, not dances.
- All solve within the 1 ms budget; `penalty-opt` is closest to it.

### Filters · 滤波
On the same dances with seeded detector noise (uniform ±2 cm, σ 11.5 mm), at the recordings' 30 fps: RMSE of the
filtered world landmarks against the clean track, and the frog's jerk driven by them, live (causal) and recorded (whole
video).

| gouxiong / naenae / kemusan | RMSE live mm | RMSE recorded mm | jerk live m/s³ | jerk recorded m/s³ | live ms |
|---|---|---|---|---|---|
| one-euro (built-in) | 33.2 / 9.7 / 12.1 | 53.2 / 13.9 / 17.4 | **1455 / 484 / 695** | **932 / 241 / 494** | 0.06 |
| kalman-cv | **11.0** / 10.4 / 10.4 | **9.0** / 7.3 / 7.1 | 2230 / 1971 / 1926 | 1296 / 550 / 707 | 0.04–0.10 |
| savitzky-golay | 18.2 / **9.3 / 9.6** | 11.9 / **6.4 / 6.1** | 1828 / 1202 / 1433 | 1198 / 429 / 578 | 0.06–0.12 |

One Euro is the smoothest but lags fast shaking by 3–5 cm (and its zero-phase video mode over-smooths at its defaults);
Kalman/RTS and Savitzky–Golay stay within the noise of the truth, at the cost of more jitter passed on live.

## Direction copy · 方向拷贝
The built-in solver (`src/motion/blocks/projectedDirections.ts`) is not an optimiser: it copies the person's segment
directions and projects each segment out of the body in turn, closed-form, with two-bone IK only for belly holds and
overhead reaches. It is the cheapest (0.25 ms) and the baseline for fidelity; read its header comment for the steps.
The library's solvers share its constraint projection (`limbs.ts`, `project`) so that they differ only in their own idea.

内置求解器不是优化：它拷贝人的各段方向，再逐段闭式地投影到身体之外，只在捧肚子、举过头顶时用两骨 IK。它最便宜，是保真度的基准；
步骤见其文件头注释。本库的求解器共用同一个约束投影（`limbs.ts` 的 `project`），彼此只差在各自的核心思路。
