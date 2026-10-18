# 隐式有限元（四面体单元，隐式 BDF2 步 + 牛顿–CG）

## 直觉
弹性肉的教科书模型：每个单元量出它的形变 F，材料律把 F 变成应力和能量，节点上的力就是能量的导数。时间步是隐式的——找步末惯性与
弹性平衡的位置——所以材料硬、步长大也稳；用 BDF2 而不是后向欧拉，晃动不会被数值阻尼吃掉。三种材料说明了当骨架会转动时，材料为什么重要：

- **线性**：小应变弹性。便宜、线性，但一个只是转动的单元会被当成拉伸，转动的肉就会长大（线性有限元的"鬼力"）；
- **共旋**：同一个材料律，在单元自己的旋转里量（F = RS）：旋转不变，每步仍只解一次线性方程组；
- **Neo-Hookean**（稳定版）：真正的大变形材料；被压扁或翻转的单元会被推回来。

## 核心公式
隐式步写成最小化：

$$\Phi(\mathbf x) = \frac{1}{2h'^2}\|\mathbf x - \mathbf s\|_M^2 + \sum_t V_t\,\psi(F_t), \qquad (M/h'^2 + H)\,\Delta\mathbf x = -\nabla\Phi$$

- 后向欧拉：$h' = h$，$\mathbf s = \mathbf x_n + h\mathbf v_n + h^2\mathbf g$，$\mathbf v_{n+1} = (\mathbf x_{n+1} - \mathbf x_n)/h$——频率 ω 的模态每步乘 $1/\sqrt{1 + (h\omega)^2}$：
  60 Hz 下 4 Hz 的晃动每步损失 8%，0.2 s 就没了；
- BDF2（`bdf2.ts`，默认）：$h' = \tfrac23 h$，$\mathbf s = \tfrac43\mathbf x_n - \tfrac13\mathbf x_{n-1} + h'(\tfrac43\mathbf v_n - \tfrac13\mathbf v_{n-1}) + h'^2\mathbf g$，
  $\mathbf v_{n+1} = (\mathbf x_{n+1} - \tfrac43\mathbf x_n + \tfrac13\mathbf x_{n-1})/h'$——同样的晃动每步只损失约 $(h\omega)^4/8$（0.4%），又能压住格子尺度的高频，
  最硬时也稳定。（先试过能量守恒的 Newmark 梯形法，最硬时经肉–骨的显式耦合炸掉了。）

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
  b = f − M (x − s) / h'²
  assemble(x)                      // M/h'² + Σ V ∂P/∂x（线性/共旋用闭式，Neo-Hookean 由 dP 逐列）
  dx = CG(A, b, femCgIterations)
  x += step · dx                   // Neo-Hookean：在 Φ 上回溯线搜索
v 由 BDF2 得到（或 (x − x_old)/h）;   reaction（挂着的）= f(x) · h
```

## 参数
| 参数 | 含义 | 常用范围 | 调了会看到什么 |
|---|---|---|---|
| `femMaterial` | 线性、共旋、Neo-Hookean | — | 线性：弯下的躯干会胀大（体积 1.15），头变形 |
| `femIntegrator` | 自动、BDF2、后向欧拉 | — | 自动：BDF2，线性材料用后向欧拉（它的鬼力不断注入能量，只有后向欧拉能耗掉）；后向欧拉：摇一下 0.15 s 就停 |
| `femNewton` | 牛顿迭代次数 | 1–3 | 线性 1 次就精确，共旋几乎精确；Neo-Hookean 至少 2 次（1 次留下的误差在快速摇动中 BDF2 压不住） |
| `femCgIterations` | 每次牛顿的 CG 迭代 | 5–30 | 少：更软、更便宜 |
| `femPoisson` | ν | 0.3–0.48 | 高：几乎不可压缩，更难解 |

## 何时用
材料要有意义时：杨氏模量和泊松比是真的，共旋和 Neo-Hookean 在弯腰时让头和胸保持形状（头离刚性 8 mm，0 个翻转单元，身体体积误差 3% 和
1.6%）。用 BDF2 后摇一下摆 7 次、0.85 s（最软 1.4–1.7 s），后向欧拉只有 1.5 次、0.15 s。共旋在 Node 里每步约 2.2 ms 软体时间（浏览器里约为
内置的 1.3 倍）；Neo-Hookean 要两次牛顿迭代，5.4 ms，机器忙时不够交互。CG 迭代次数是调节旋钮。线性材料放在这里是为了看清没有旋转不变性会出什么问题。

在真奶蛙上用[索引](../sim-index.md)的同一套测量（都能站稳：头高 0.99，漂移 ≤ 5.4 cm；"摇"是索引里的抖动测量）：

| naiwa.glb，弯腰 50° | 偏离 cm | 翻转单元 | 身体体积 | 头误差 mm | 手入肚 mm | 每步 ms（软体） | 摇，默认：峰值 mm / 摆动 / 衰减 s | 摇，最软 |
|---|---|---|---|---|---|---|---|---|
| cpu-constraints (built-in) | 3.47 | 0 | 0.999 | 8.5 | 0.0 | 2.38 (in Rapier) | 32 / 3.5 / 0.47 | 25 / 3.5 / 0.50 |
| `implicit-fem`, linear | 3.17 | 0 | 1.158 | 25.5 | 7.5 | 1.80 (1.06) | — | — |
| `implicit-fem`, corotational | 2.00 | 0 | 0.970 | 7.9 | 12.7 | 3.10 (2.21) | 60 / 7.0 / 0.85 | 104 / 7.0 / 1.38 |
| `implicit-fem`, neo-Hookean | 2.05 | 0 | 0.986 | 8.2 | 6.6 | 6.46 (5.40) | 70 / 6.5 / 0.83 | 110 / 8.5 / 1.72 |

## 在代码里
`src/algorithms/sim/implicitFem.ts`，**flesh** 块（材料就是文件开头的小 `Model` 对象）。先试：加你自己的材料（一组 `P`、`dP`、`psi`）；
或者用上一步的 Δx 给 CG 热启动。

## 参考
- M. Müller, M. Gross, *Interactive Virtual Materials*（共旋有限元）, Graphics Interface 2004. https://dl.acm.org/doi/10.5555/1006058.1006083
- B. Smith, F. de Goes, T. Kim, *Stable Neo-Hookean Flesh Simulation*, ACM TOG 2018. https://doi.org/10.1145/3180491
- E. Sifakis, J. Barbič, *FEM Simulation of 3D Deformable Solids: A Practitioner's Guide*, SIGGRAPH Course 2012. https://doi.org/10.1145/2343483.2343501
