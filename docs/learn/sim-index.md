# Simulation algorithms · 模拟算法

The library in `src/algorithms/sim/` (registered by `registerSimLibrary()`): well-known CPU soft-body algorithms, each a
block in one slot of the simulation loop (`docs/simulator-api.md`), with a page in Chinese and English, and simulators
that assemble them with the built-in blocks. The built-in CPU example `cpu-constraints` (Rapier soft bodies solved by
PGS, `src/sim/blocks/`) is the reference everything is compared with.

`src/algorithms/sim/` 里的算法库（由 `registerSimLibrary()` 注册）：常见的 CPU 软体算法，每个是模拟循环（`docs/simulator-api.md`）某个槽里
的一个块，各有一页中英文学习文档；预置的模拟器把它们和内置块组合起来。内置的 CPU 示例 `cpu-constraints`（Rapier 软体，PGS 求解）是比较的基准。

| Block · 块 | Slot · 槽 | Page · 学习页 | What it does · 做什么 |
|---|---|---|---|
| `mass-spring` | flesh | [en](sim/mass-spring.en.md) · [中](sim/mass-spring.zh.md) | a damped spring on every edge; explicit or semi-implicit (Baraff–Witkin) · 每条边一根阻尼弹簧，显式或半隐式 |
| `pbd` | flesh | [en](sim/pbd.en.md) · [中](sim/pbd.zh.md) | edge-length and volume constraints, projected · 边长和体积约束投影 |
| `xpbd` | flesh | [en](sim/xpbd.en.md) · [中](sim/xpbd.zh.md) | the same with compliance from Young's modulus, small steps · 加上来自杨氏模量的柔度，小步长 |
| `shape-matching` | flesh | [en](sim/shape-matching.en.md) · [中](sim/shape-matching.zh.md) | one cluster per region pulled to its best rigid motion · 每区域一簇拉向最佳刚体运动 |
| `projective-dynamics` | flesh | [en](sim/projective-dynamics.en.md) · [中](sim/projective-dynamics.zh.md) | local projections, prefactored global solve · 局部投影 + 预分解全局求解 |
| `implicit-fem` | flesh | [en](sim/implicit-fem.en.md) · [中](sim/implicit-fem.zh.md) | linear / corotational / neo-Hookean FEM, backward Euler, Newton–CG · 线性 / 共旋 / Neo-Hookean 有限元，后向欧拉 |
| `sdf-contacts` | collision | [en](sim/sdf-contacts.en.md) · [中](sim/sdf-contacts.zh.md) | floor, bones, limbs, balls as distance fields, two-way · 地面、骨头、四肢、球的距离场接触，双向 |
| `soft-tethers` | coupling | [en](sim/soft-tethers.en.md) · [中](sim/soft-tethers.zh.md) | every particle tied to its bone, strength falling with depth · 每个粒子系在骨头上，强度随深度衰减 |
| `particle-metrics` | metrics | — | the built-in metrics with the solvers' own particle velocities · 内置指标，速度取求解器自己的 |

Simulators · 预置模拟器: `mass-spring`, `pbd`, `xpbd`, `shape-matching`, `projective-dynamics`, `implicit-fem`
(each: rigid skeleton, the flesh block, bone-carried target, bone attachments, SDF contacts, push and pinch, embedded
surface, particle metrics) and `fem-tethers` (implicit FEM with soft tethers instead of bone attachments).

## What every flesh block shares · 所有软体块共用的部分
- **Cells** (`lattice.ts`): each closed part is filled the simple way, as Rapier does: a regular lattice of cubes,
  keeping those inside the surface or holding one of its vertices, each split into six tetrahedra along its main
  diagonal (a conforming mesh). The lattice step is chosen for a particle count (`bodyParticles`, `limbParticles`).
  The rendered surface is **embedded**: each vertex keeps its cell and barycentric weights and follows the cell.
  **单元**：像 Rapier 一样用规则立方体格子填满每块封闭的肉，保留在表面内或含表面顶点的立方体，每个沿主对角线切成六个四面体；渲染表面
  按重心坐标嵌在单元里。
- **Particles in typed arrays** (`flesh.ts`, `Piece`): positions, velocities, masses (a quarter of each cell's mass per
  node, scaled to the part's true mass) behind the `ParticleView` the built-in coupling, interaction, output and
  metrics blocks use. **粒子**放在普通类型数组里，实现内置块使用的 `ParticleView`。
- **Two-way attachments**: an attached particle is carried by its body (its position from the body's pose each step)
  and the impulse the flesh exerts on it goes back to that body (`reaction`). Its own mass rides on the body as a
  mass-only collider, so Rapier treats its weight and inertia implicitly (stable when the flesh outweighs a bone).
  The damping of the free flesh relative to its target hands the momentum it removes to the nearest bone, so a push
  on the belly moves the frog by the push's momentum (tested in `library.test.ts`).
  **双向附着**：挂着的粒子随刚体移动，肉施加给它的冲量还给刚体；它自身的质量以只有质量的碰撞体挂在刚体上；自由肉相对目标的阻尼把去掉的
  动量交给最近的骨头，所以戳肚子时整只奶蛙得到等量的动量。
- **One material for all** (`material.ts`): the softness slider is Young's modulus (30 kPa → 1 kPa, 1.7 kPa at the
  default; the belly then wobbles at 3–4 Hz in a shake, about 3 Hz at the softest), the regions are up to 4 × firmer,
  density 190 kg/m³. The bounciness slider is a **decay time**, 0.12 s (dough) → 3 s (a jelly that keeps going), 1 s at
  the default, applied as mass-proportional (Rayleigh) damping of the jiggle relative to the bones.
  **统一材质**：软硬滑块就是杨氏模量（30 kPa → 1 kPa），区域最多硬 4 倍；弹性滑块是晃动衰减到 1/e 的时间（0.12 s → 3 s），以质量比例阻尼施加。
- **Time integration that keeps the jiggle**: implicit FEM and Projective Dynamics step with BDF2 (`bdf2.ts`) instead
  of backward Euler, which shrinks a 4 Hz wobble by 8 % every step at 60 Hz (gone in 0.2 s) and faster ones sooner;
  BDF2 loses 0.4 % per step there and still damps the stiff, lattice-scale modes, so it stays stable at the firmest
  setting (Newmark's energy-conserving trapezoidal rule, tried first, blows up there through the explicit flesh–bone
  coupling). Spring networks (mass–spring, XPBD's edges) are 16 × stiffer than the modulus suggests (they have no
  Poisson effect and resist shear only through the cube diagonals) and mass–spring damps them by Rayleigh stiffness
  damping c = βk. A poke wakes the bones the flesh rides on, so they take their share of it.
  **保留晃动的时间积分**：有限元和投影动力学用 BDF2 代替后向欧拉（后者在 60 Hz 下每步吃掉 4 Hz 晃动的 8%）；BDF2 每步只损失 0.4%，又能压住
  格子尺度的高频，最硬时也稳定。

## Measured · 实测
One harness for all (`src/algorithms/sim/bench.ts`, the table printed by `npx vitest run src/algorithms/sim/bench.test.ts`)
on naiwa.glb with the app's default material (softness 0.85, bounciness 0.65), every simulator at its defaults:

- **free 10 s**: standing on its own from rest — head height against rest, lean of the hips, drift on the floor,
  jitter (mean particle speed relative to the target) at the end;
- **bend 50°**: driven, spine and chest 25° forward each and the head 17° more, held 3 s — deviation of the flesh from
  its bone-carried target (mean), inverted cells, the Body's volume, the head region's distance from where the head
  bone carries it rigidly;
- **hands in belly**: both hands driven 3 cm into the belly for 2 s — the deepest a limb's contact capsule reaches into
  the Body's surface;
- **ms/step**: the whole step (skeleton, flesh, contacts, coupling) during the bend, and the flesh block alone in
  brackets (for `cpu-constraints` the flesh is solved inside Rapier's step, so it is in the total), Node, the fastest
  of three runs.

The bench also runs every library simulator at the sliders' extremes (softness 0 and 1, bounciness 1): standing 3 s
and bending 2 s, nothing explodes, the volume stays within 30 % and the flesh within 12 cm of its bones.

同一套测量：真奶蛙、默认材质、各自默认参数。自由站立 10 秒；驱动弯腰 50° 保持 3 秒；双手按进肚子 3 厘米；每步毫秒（括号内是软体块本身）。
另外每个模拟器在滑块两端（最硬、最软，最弹）各跑一次：不炸、体积变化 < 30%。

| simulator | particles / cells | head height | lean ° | drift cm | jitter mm/s | bend: deviation cm | inverted | Body volume | head error mm | hands in belly mm | ms/step (flesh) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| cpu-constraints (built-in) | 417 / 1190 | 0.992 | 1.5 | 11.4 | 0.0 | 3.47 | 0 | 0.999 | 8.5 | 0.0 | 2.38 (in Rapier) |
| mass-spring, explicit | 444 / 1206 | 0.991 | 0.3 | 5.1 | 1.1 | 2.04 | 6 | 0.942 | 9.1 | 14.7 | 1.07 (0.37) |
| mass-spring, semi-implicit | 444 / 1206 | 0.992 | 0.1 | 1.5 | 1.2 | 2.04 | 6 | 0.942 | 9.1 | 13.9 | 1.68 (0.89) |
| pbd | 444 / 1206 | 0.991 | 0.3 | 4.7 | 3.0 | 2.65 | 0 | 0.996 | 8.0 | 28.1 | 2.85 (1.97) |
| xpbd | 444 / 1206 | 0.991 | 0.1 | 1.6 | 1.6 | 2.23 | 0 | 0.970 | 9.9 | 14.8 | 2.23 (1.45) |
| shape-matching | 444 / 1206 | 0.992 | 0.0 | 1.4 | 1.9 | 4.50 | 4 | 0.995 | 15.9 | 19.3 | 1.10 (0.20) |
| projective-dynamics | 444 / 1206 | 0.991 | 0.2 | 5.3 | 1.4 | **1.94** | 0 | 0.982 | **7.6** | 4.3 | 2.73 (1.84) |
| implicit-fem, linear | 444 / 1206 | 0.991 | 0.1 | 1.5 | 1.4 | 3.17 | 0 | 1.158 | 25.5 | 7.5 | 1.80 (1.06) |
| implicit-fem, corotational | 444 / 1206 | 0.991 | 0.3 | 5.4 | 1.4 | 2.00 | 0 | 0.970 | 7.9 | 12.7 | 3.10 (2.21) |
| implicit-fem, neo-Hookean | 444 / 1206 | 0.991 | 0.3 | 5.4 | 1.4 | 2.05 | 0 | 0.986 | 8.2 | 6.6 | 6.46 (5.40) |
| fem-tethers | 444 / 1206 | 0.991 | 0.1 | 4.5 | 4.9 | 2.53 | 0 | 0.976 | 16.3 | 14.5 | 3.24 (2.34) |

(The machine was busy during this run: the built-in step took 2.4 ms here against 1.5 ms on a quiet run.)

### Jiggle · 抖动
`src/algorithms/sim/jiggle.ts` (`npx vitest run src/algorithms/sim/jiggle.test.ts`): the frog stands 2 s, then
**poke** — the page's strongest poke into the belly (5 m/s, free mode) — or **shake** — driven, the torso swings
sideways ±20° at 3 Hz for half a second and stops dead. The signal is the belly's rendered surface around the poke
(or the belly's front) against where its bones carry it, about where it settles. Each cell: **peak mm / oscillations
(full swings above a tenth of the peak) / 1/e decay s / Hz**, at the default material (softness 0.85, bounciness 0.65)
and the softest the feel panel allows (softness 1, bounciness 1).

戳：页面上最强的一戳；摇：驱动模式下躯干左右摆 ±20°、3 Hz、半秒后急停。每格：峰值 mm / 摆动次数 / 衰减到 1/e 的秒数 / 频率。

| before (backward Euler, damping ratio from bounciness, 6–60 kPa) | poke, default | poke, softest | shake, default | shake, softest |
|---|---|---|---|---|
| cpu-constraints (built-in) | 12 / 4.0 / 1.35 / 1.4 | 25 / 2.5 / 0.25 / 1.0 | 32 / 3.5 / 0.47 / 1.2 | 25 / 3.5 / 0.50 / 1.1 |
| mass-spring | 16 / 0.5 / 0.03 / — | 19 / 0.5 / 0.05 / — | 24 / 1.0 / 0.17 / 3.3 | 50 / 1.0 / 0.22 / 2.7 |
| pbd | 9 / 0.0 / 0.03 / — | 9 / 0.0 / 0.05 / — | 32 / 1.0 / 0.08 / 2.7 | 48 / 1.5 / 0.22 / 2.3 |
| xpbd | 8 / 0.5 / 0.02 / — | 11 / 0.5 / 0.02 / — | 28 / 2.0 / 0.13 / 3.6 | 44 / 2.5 / 0.27 / 3.4 |
| shape-matching | 47 / 0.5 / 0.07 / — | 56 / 1.0 / 0.17 / 3.3 | 38 / 1.5 / 0.18 / 2.9 | 62 / 2.0 / 0.42 / 2.6 |
| projective-dynamics | 17 / 0.5 / 0.05 / — | 19 / 0.5 / 0.03 / — | 1 / 3.0 / 0.22 / 5.2 | 2 / 3.0 / 0.33 / 4.7 |
| implicit-fem (corotational) | 5 / 0.0 / 0.02 / — | 7 / 0.0 / 0.03 / — | 3 / 1.5 / 0.15 / 5.5 | 5 / 1.5 / 0.17 / 6.0 |
| implicit-fem, neo-Hookean | 4 / 0.0 / 0.02 / — | 6 / 0.0 / 0.03 / — | 60 / 3.0 / 0.08 / 1.1 | 73 / 5.0 / 2.53 / 1.6 |
| fem-tethers | 5 / 0.0 / 0.03 / — | 7 / 0.0 / 0.03 / — | 5 / 1.0 / 0.10 / 5.0 | 6 / 1.5 / 0.12 / 6.7 |

| after (BDF2, decay time from bounciness, 1–30 kPa) | poke, default | poke, softest | shake, default | shake, softest |
|---|---|---|---|---|
| mass-spring | 20 / 2.5 / 0.10 / 12.0 | 24 / 2.5 / 0.13 / 9.2 | 32 / 3.0 / 0.30 / 5.2 | 94 / 2.0 / 0.30 / 2.1 |
| pbd | 13 / 0.5 / 0.03 / — | 13 / 0.5 / 0.03 / — | 80 / 2.5 / 0.38 / 2.5 | 81 / 3.0 / 0.38 / 2.1 |
| xpbd | 16 / 1.5 / 0.05 / 15.0 | 21 / 1.5 / 0.07 / 10.0 | 34 / 1.5 / 0.13 / 5.0 | 71 / 5.0 / 0.18 / 3.6 |
| shape-matching | 53 / 1.5 / 0.25 / 2.6 | 39 / 2.0 / 0.28 / 2.3 | 41 / 2.5 / 0.72 / 2.1 | 39 / 3.5 / 0.80 / 1.9 |
| projective-dynamics | 28 / 1.5 / 0.12 / 6.0 | 34 / 2.5 / 0.13 / 4.1 | 63 / 6.5 / 0.87 / 3.4 | 104 / 5.5 / 1.07 / 2.8 |
| implicit-fem (corotational) | 20 / 1.5 / 0.08 / 6.7 | 27 / 1.5 / 0.10 / 5.5 | 60 / **7.0** / 0.85 / 3.6 | 104 / 7.0 / 1.38 / 2.9 |
| implicit-fem, neo-Hookean | 19 / 1.5 / 0.08 / 6.7 | 25 / 1.5 / 0.12 / 5.5 | 70 / 6.5 / 0.83 / 3.6 | 110 / **8.5** / **1.72** / 2.9 |
| fem-tethers | 20 / 1.0 / 0.03 / 7.5 | 25 / 1.0 / 0.12 / 6.0 | 60 / 3.5 / 0.28 / 3.3 | 101 / 3.0 / 0.33 / 2.8 |

Reading it · 怎么读:
- **The causes, per solver.** Backward Euler shrank every wobble by 1/√(1 + (hω)²) per step (FEM, PD: the shake died
  within 0.15–0.3 s whatever the sliders); the bounciness slider set a damping *ratio* at a stiff frequency, i.e. a
  damping rate of 7 /s (the jiggle's 1/e time 0.27 s at the default); the moduli were so stiff (8.5 kPa) that the
  wobble ran at 5–8 Hz and was gone before it showed; mass–spring's per-spring dampers added up to an overdamped
  body; PBD's projections and shape matching's pull are implicit position corrections that dissipate by
  construction; the soft tethers had damping ratio 0.7.
- **After.** FEM and PD shake 5.5–8.5 times over 0.8–1.7 s at 3–4 Hz (softest 2.8–2.9 Hz), more than the built-in
  (3.5 swings, 0.5 s); shape matching wobbles slowly (2 Hz, 0.7–0.8 s). XPBD with one Gauss–Seidel pass per substep,
  and PBD, remain the most dissipative: their unconverged projections damp what they do not resolve (more substeps
  help, at a cost). A **poke** is local: the dent rings 1–2.5 times at 4–7 Hz and spreads its energy into the whole
  body within 0.1–0.3 s; the built-in's slower 1–1.4 Hz sway after a poke is the flesh sloshing on its soft
  constraints.
- **Everything stands** within 1 % of its height (drift 1.4–5.4 cm; built-in 11 cm in this run); the linear FEM steps
  with backward Euler by default (its ghost forces would otherwise keep the frog fidgeting).
- **Volume and inversion.** Springs do not see volume: mass–spring loses 6 % of the Body and turns 6 cells inside out
  in the bend. Everything with a volume term (PBD, XPBD, PD, corotational and neo-Hookean FEM) has 0 inverted cells
  (shape matching 4, now that its pull is softer). Linear FEM is not rotation-invariant: the bent torso *grows* by
  16 % and the head distorts (25 mm).
- **Following the bones.** PD and the FEM blocks keep the flesh closest to its bones (1.9–2.1 cm, the built-in 3.5 cm)
  and the head in shape (8 mm).
- **Cost.** In Chrome on this laptop (all simulators in one page, the torso swaying, best of two rounds) a step took
  cpu-constraints 2.2 ms, shape-matching 0.9, mass-spring 1.2, xpbd 2.2, pbd 2.5, projective-dynamics 2.5,
  implicit-fem (corotational) 2.7 and fem-tethers 3.1 ms: all within the page's 4 ms physics budget per frame. The
  neo-Hookean material takes two Newton steps (one is not enough for it without backward Euler's damping) and about
  twice the corotational cost: it is not interactive on a busy machine.

## Not covered yet · 还没有
The belly pump (`bellySize`) inflates only PBD and XPBD (their volume constraints); the other solvers ignore it.
Contacts inside the solvers (XPBD contact constraints, FEM with barrier or penalty contacts); self-collision of the
Body's flesh; GPU versions (the `gpu` slot of the API is another agent's work); a skinned (multi-bone) target. A poke
excites the dent more than the whole belly (energy spreads into the body within a few tenths of a second); a
broader, slower wobble would need the poke spread wider or the belly's global mode targeted directly.
