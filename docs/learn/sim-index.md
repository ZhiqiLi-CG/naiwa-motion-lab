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
- **One material for all** (`material.ts`): the softness slider is Young's modulus (60 kPa → 6 kPa, 8.5 kPa at the
  default), the regions are up to 4 × firmer, density 190 kg/m³, bounciness the damping ratio.
  **统一材质**：软硬滑块就是杨氏模量，区域最多硬 4 倍。

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
  brackets (for `cpu-constraints` the flesh is solved inside Rapier's step, so it is in the total), Node on a laptop
  CPU, the fastest of three runs.

同一套测量：真奶蛙、默认材质、各自默认参数。自由站立 10 秒；驱动弯腰 50° 保持 3 秒；双手按进肚子 3 厘米；每步毫秒（括号内是软体块本身）。

| simulator | particles / cells | head height | lean ° | drift cm | jitter mm/s | bend: deviation cm | inverted | Body volume | head error mm | hands in belly mm | ms/step (flesh) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| cpu-constraints (built-in) | 417 / 1190 | 0.991 | 0.4 | 4.3 | 0.0 | 4.06 | 0 | 0.988 | 8.9 | 7.9 | 1.48 (in Rapier) |
| mass-spring, explicit | 444 / 1206 | 0.991 | 0.1 | 1.5 | 1.9 | 2.13 | 20 | 0.917 | 8.8 | 12.0 | 0.84 (0.30) |
| mass-spring, semi-implicit | 444 / 1206 | 0.991 | 0.1 | 1.6 | 1.6 | 2.14 | 6 | 0.941 | 9.1 | 11.1 | 1.15 (0.61) |
| pbd | 444 / 1206 | 0.991 | 0.1 | 1.4 | 2.1 | 2.19 | 0 | 0.991 | 6.4 | 0.0 | 1.34 (0.87) |
| xpbd | 444 / 1206 | 0.991 | 0.1 | 1.4 | 2.4 | 2.46 | 0 | **0.995** | 9.0 | 14.9 | 0.97 (0.51) |
| shape-matching | 444 / 1206 | 0.991 | 0.1 | 1.5 | 1.4 | 3.66 | 0 | 0.979 | 15.9 | 6.9 | **0.63 (0.15)** |
| projective-dynamics | 444 / 1206 | 0.992 | 0.0 | 1.4 | 0.5 | **1.75** | 0 | 0.980 | **7.6** | 28.0 | 1.74 (1.23) |
| implicit-fem, linear | 444 / 1206 | 0.991 | 0.2 | 4.9 | 0.6 | 2.94 | 0 | 1.152 | 25.4 | 28.9 | 1.27 (0.81) |
| implicit-fem, corotational | 444 / 1206 | 0.991 | 0.2 | 4.9 | 0.6 | 1.82 | 0 | 0.970 | 8.1 | 21.0 | 1.93 (1.48) |
| implicit-fem, neo-Hookean | 444 / 1206 | 0.991 | 0.0 | 1.4 | 0.7 | 1.89 | 0 | 0.984 | 8.5 | 10.2 | 2.64 (2.06) |
| fem-tethers | 444 / 1206 | 0.991 | 0.0 | 1.4 | 1.5 | 2.31 | 0 | 0.977 | 17.0 | 17.0 | 2.52 (1.86) |

Reading it · 怎么读:
- **Everything stands.** All simulators stand within 1 % of their height and come to rest within 5 cm (the built-in
  4 cm). The library's flesh blocks raise Rapier's internal PGS iterations to 2: with one, the rigid skeleton's stiff
  leg motors buzz and the frog creeps across the floor (the built-in soft bodies add their own iterations).
- **Volume and inversion are where the models differ.** Springs do not see volume: mass–spring loses 6–8 % of the Body
  and turns 6–20 cells inside out in the bend. Everything with a volume term (PBD, XPBD, PD, corotational and
  neo-Hookean FEM) has 0 inverted cells. Linear FEM is not rotation-invariant: the bent torso *grows* by 15 % and the
  head distorts (25 mm) — the classic reason for corotational FEM.
- **Following the bones.** Projective Dynamics and the FEM blocks keep the flesh closest to its bones (1.75–1.9 cm, the
  built-in 4.1 cm) and the head in shape (8 mm). Shape matching with one cluster per region is the loosest (3.7 cm,
  head 16 mm).
- **Hands in the belly.** The SDF contacts push the Body's surface off the hands' capsules after the flesh's step;
  how much of that survives the next step depends on how hard the solver pulls back: from 0–7 mm (PBD, shape matching)
  to 28 mm (PD, linear FEM). The built-in resolves contacts inside its solve (8 mm).
- **Cost.** Every simulator fits the page's 4 ms physics budget per frame at its defaults (1 step per frame at 60 Hz).
  Shape matching and XPBD are the cheapest, neo-Hookean FEM and fem-tethers the dearest. A busy machine doubles these
  numbers (the bench takes the fastest of three runs; in a loaded headless browser all simulators, the built-in
  included, ran 2–10 × slower).

## Not covered yet · 还没有
Contacts inside the solvers (XPBD contact constraints, FEM with barrier or penalty contacts); self-collision of the
Body's flesh; GPU versions (the `gpu` slot of the API is another agent's work); a skinned (multi-bone) target.
