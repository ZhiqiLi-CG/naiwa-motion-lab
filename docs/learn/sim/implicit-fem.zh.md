# 隐式有限元（四面体单元，后向欧拉 + 牛顿–CG）

## 直觉
弹性肉的教科书模型：每个单元量出它的形变 F，材料律把 F 变成应力和能量，节点上的力就是能量的导数。时间步用后向欧拉——找步末惯性与
弹性平衡的位置——所以材料硬、步长大也稳。三种材料说明了当骨架会转动时，材料为什么重要：

- **线性**：小应变弹性。便宜、线性，但一个只是转动的单元会被当成拉伸，转动的肉就会长大（线性有限元的"鬼力"）；
- **共旋**：同一个材料律，在单元自己的旋转里量（F = RS）：旋转不变，每步仍只解一次线性方程组；
- **Neo-Hookean**（稳定版）：真正的大变形材料；被压扁或翻转的单元会被推回来。

## 核心公式
后向欧拉写成最小化，$\mathbf s = \mathbf x_n + h\mathbf v_n + h^2\mathbf g$：

$$\Phi(\mathbf x) = \frac{1}{2h^2}\|\mathbf x - \mathbf s\|_M^2 + \sum_t V_t\,\psi(F_t), \qquad (M/h^2 + H)\,\Delta\mathbf x = -\nabla\Phi$$

- 线性：$\psi = \mu|\varepsilon|^2 + \tfrac{\lambda}{2}\operatorname{tr}(\varepsilon)^2$，$\varepsilon = \operatorname{sym}F - I$；$P = \mu(F + F^\top - 2I) + \lambda\operatorname{tr}(F - I)I$
- 共旋：在 $R^\top F$ 里同上，$P = R\,P_{lin}(R^\top F)$，求解时 R 固定，$H_{ab} = R\,K_{ab}R^\top$
- 稳定 Neo-Hookean（Smith 等 2018）：$\psi = \tfrac{\mu}{2}(\operatorname{tr}F^\top F - 3) + \tfrac{\lambda'}{2}(J - \alpha)^2$，$\lambda' = \lambda + \mu$，$\alpha = 1 + \mu/\lambda'$；$P = \mu F + \lambda'(J - \alpha)\operatorname{cof}F$

节点力 $\mathbf f_k = -V\,P\,\nabla N_k$。H 在自由粒子上按 3 × 3 块组装；块 Jacobi 预条件的 CG 遇到负曲率就停（Neo-Hookean 的 H 可能不定），
Neo-Hookean 的一步再在 Φ 上回溯线搜索。

## 算法步骤
```ts
x = s
for (it of femNewton)
  rotations(x)                     // 共旋：每个单元的 R（极分解，热启动）
  forces(x)                        // f = −Σ V P ∇N
  b = f − M (x − s) / h²
  assemble(x)                      // M/h² + Σ V ∂P/∂x（线性/共旋用闭式，Neo-Hookean 由 dP 逐列）
  dx = CG(A, b, femCgIterations)
  x += step · dx                   // Neo-Hookean：在 Φ 上回溯线搜索
v = (x − x_old) / h;   reaction（挂着的）= f(x) · h
```

## 参数
| 参数 | 含义 | 常用范围 | 调了会看到什么 |
|---|---|---|---|
| `femMaterial` | 线性、共旋、Neo-Hookean | — | 线性：弯下的躯干会胀大（体积 1.15），头变形 |
| `femNewton` | 牛顿迭代次数 | 1–3 | 线性 1 次就精确，共旋几乎精确；Neo-Hookean 2 次略好 |
| `femCgIterations` | 每次牛顿的 CG 迭代 | 5–30 | 少：更软、更便宜 |
| `femPoisson` | ν | 0.3–0.48 | 高：几乎不可压缩，更难解 |

## 何时用
材料要有意义时：杨氏模量和泊松比是真的，共旋和 Neo-Hookean 在弯腰时让头和胸保持形状（头离刚性 8 mm，0 个翻转单元，身体体积误差 3% 和
1.6%）。是库里最贵的块（奶蛙上每步 1.5–2 ms 软体时间），CG 迭代次数是调节旋钮。线性材料放在这里是为了看清没有旋转不变性会出什么问题。

在真奶蛙上用[索引](../sim-index.md)的同一套测量（都能站稳：头高 0.99，漂移 ≤ 5 cm）：

| naiwa.glb，弯腰 50° | 偏离 cm | 翻转单元 | 身体体积 | 头误差 mm | 手入肚 mm | 每步 ms（软体） |
|---|---|---|---|---|---|---|
| cpu-constraints (built-in) | 4.06 | 0 | 0.988 | 8.9 | 7.9 | 1.48 (in Rapier) |
| `implicit-fem`, linear | 2.94 | 0 | 1.152 | 25.4 | 28.9 | 1.27 (0.81) |
| `implicit-fem`, corotational | 1.82 | 0 | 0.970 | 8.1 | 21.0 | 1.93 (1.48) |
| `implicit-fem`, neo-Hookean | 1.89 | 0 | 0.984 | 8.5 | 10.2 | 2.64 (2.06) |

## 在代码里
`src/algorithms/sim/implicitFem.ts`，**flesh** 块（材料就是文件开头的小 `Model` 对象）。先试：加你自己的材料（一组 `P`、`dP`、`psi`）；
或者用上一步的 Δx 给 CG 热启动。

## 参考
- M. Müller, M. Gross, *Interactive Virtual Materials*（共旋有限元）, Graphics Interface 2004. https://dl.acm.org/doi/10.5555/1006058.1006083
- B. Smith, F. de Goes, T. Kim, *Stable Neo-Hookean Flesh Simulation*, ACM TOG 2018. https://doi.org/10.1145/3180491
- E. Sifakis, J. Barbič, *FEM Simulation of 3D Deformable Solids: A Practitioner's Guide*, SIGGRAPH Course 2012. https://doi.org/10.1145/2343483.2343501
