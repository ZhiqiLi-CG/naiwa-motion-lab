# 投影动力学（局部投影 + 一个预分解的全局求解）

## 直觉
一步隐式欧拉就是一个能量（惯性 + 弹性）的最小值。投影动力学把弹性写成特殊形式，使这个最小值可以交替两个简单步骤求得。局部步：每个
单元找它"满意"的最近形状（它的旋转，以及保体积的自己）。全局步：所有粒子解一个线性方程组，尽量同时靠近这些形状和惯性要带它们去的地方。
这个方程组的矩阵从不变化，所以只分解一次，之后每次迭代只是两次三角求解。

## 核心公式
惯性目标 $\mathbf s = \mathbf x + h\mathbf v + h^2\mathbf g$，单元形变 $F = \sum_k \mathbf x_k \nabla N_k^\top$：

$$\min_{\mathbf x}\; \frac{1}{2h^2}\|\mathbf x - \mathbf s\|_M^2 + \sum_t \frac{w_t}{2}\,\|F_t(\mathbf x) - T_t\|^2$$

- 局部：$T_t$ = $F_t$ 的旋转 R（权重 $2\mu V$，"尽量刚性"）和 $F_t/\sqrt[3]{\det F_t}$（权重 $\lambda V$，体积）；
- 全局：$\big(M/h^2 + \sum_t w_t G_t^\top G_t\big)\,\mathbf x = M\mathbf s/h^2 + \sum_t w_t G_t^\top T_t$，x、y、z 用同一个标量矩阵。

矩阵只含自由粒子；挂着的粒子移到右边，挂上或松开一个（捏）时重新分解。稀疏 Cholesky 用包络（skyline）存储，按反向 Cuthill–McKee 排序。

## 算法步骤
```ts
if (dirty) factor();                        // 自由粒子上的 M/h² + Σ w GᵀG
x = s
for (it of iterations)
  local();                                   // 每个单元的 T：旋转和体积投影
  rhs = M s / h² + Σ w Gᵀ T − （挂着粒子的列）· x_挂着
  for (axis of x, y, z) chol.solve(rhs)     // 两次三角求解
v = (x − x_old) / h
reaction（挂着的）= −Σ w (F − T) ∇N · h
```

## 参数
| 参数 | 含义 | 常用范围 | 调了会看到什么 |
|---|---|---|---|
| `pdIterations` | 局部/全局迭代次数 | 2–10 | 多：更接近真正的隐式步（更硬，人为的软化更少） |
| `pdPoisson` | ν，体积权重相对形状权重 | 0.3–0.48 | 高：体积保持得更好 |

## 何时用
想要固定开销、无条件稳定的隐式步时：弯腰时偏离骨头是库里最小的（1.75 cm），0 个翻转单元。弱点：迭代少时材质比应有的软（每次迭代只走
一部分路），不是投影形式的材料（真正的 neo-Hookean）需要拟牛顿扩展。每步约 1.2 ms 软体时间；一次捏要重新分解一次。

在真奶蛙上用[索引](../sim-index.md)的同一套测量（都能站稳：头高 0.99，漂移 ≤ 5 cm）：

| naiwa.glb，弯腰 50° | 偏离 cm | 翻转单元 | 身体体积 | 头误差 mm | 手入肚 mm | 每步 ms（软体） |
|---|---|---|---|---|---|---|
| cpu-constraints (built-in) | 4.06 | 0 | 0.988 | 8.9 | 7.9 | 1.48 (in Rapier) |
| `projective-dynamics` | 1.75 | 0 | 0.980 | 7.6 | 28.0 | 1.74 (1.23) |

## 在代码里
`src/algorithms/sim/projectiveDynamics.ts`，**flesh** 块；`EnvelopeCholesky` 在 `linalg.ts`。先试：在 `local` 里加应变限制投影（截断 F 的
奇异值）；或者给迭代加 Chebyshev 加速。

## 参考
- S. Bouaziz, S. Martin, T. Liu, L. Kavan, M. Pauly, *Projective Dynamics: Fusing Constraint Projections for Fast Simulation*, SIGGRAPH 2014. https://doi.org/10.1145/2601097.2601116
- T. Liu, S. Bouaziz, L. Kavan, *Quasi-Newton Methods for Real-Time Simulation of Hyperelastic Materials*, ACM TOG 2017. https://doi.org/10.1145/3072959.2990496
