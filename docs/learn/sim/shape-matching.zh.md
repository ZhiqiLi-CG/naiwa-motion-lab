# 形状匹配（把每一簇拉向它的最佳刚体运动）

## 直觉
不用单元：对一群粒子，求一个旋转加平移，使它们的静止形状最贴合现在的位置，再把每个粒子往拟合形状里它该在的位置拉一部分。一簇永远
不会塌或翻转，因为它的目标总是自己没有变形的拷贝。这里每个肉区（肚子、身体、头……）一簇，每簇再向外扩一圈邻居，相邻的簇因此重叠。

## 核心公式
簇的静止偏移 $\mathbf q_i = \mathbf x_i^0 - \mathbf c^0$，当前质心 $\mathbf c$：

$$A_{pq} = \sum_i m_i(\mathbf p_i - \mathbf c)\,\mathbf q_i^\top, \qquad A_{pq} = R\,S\;\text{（极分解）}, \qquad \mathbf g_i = R\,\mathbf q_i + \mathbf c, \qquad \mathbf p_i \mathrel{+}= \alpha(\mathbf g_i - \mathbf p_i)$$

R 是最佳拟合的旋转（极分解，迭代求得）。β > 0 时目标混向仿射拟合 $A = A_{pq}A_{qq}^{-1}$（$\det A = 1$ 保体积）：$G = \beta A + (1-\beta)R$。
属于几个簇的粒子取各簇拉动的平均。因为 $\sum m_i(\mathbf g_i - \mathbf p_i) = 0$，一簇的动量守恒。

## 算法步骤
```ts
p = x + h·v + h²g（自由粒子）                 // 挂着的粒子：在骨头上，参与拟合
for (it of iterations)
  for (cluster of clusters)
    c = 质心;  Apq = Σ m (p − c) qᵀ;  R = rotation(Apq)
    goal[i] += α (R q + c − p)
  自由粒子: p += 平均拉动;   挂着的粒子: reaction += m · 拉动 / h
v = (p − x) / h;  x = p
```

## 参数
| 参数 | 含义 | 常用范围 | 调了会看到什么 |
|---|---|---|---|
| `smStiffness` | 每步拉回比例 α（乘区域和材质） | 0.1–1 | 默认 0.25：慢悠悠（2 Hz）晃的果冻；1：各区域刚性，几乎不晃（拉回是隐式、耗散的修正） |
| `smIterations` | 每步拟合+拉动的遍数 | 1–4 | 多：更硬、阻尼更大 |
| `smLinear` | β，目标中的仿射部分 | 0–0.5 | 各区域可以拉伸、剪切 |

## 何时用
要便宜、无条件稳定时：库里最便宜的软体（每步约 0.2 ms）；默认偏软时晃得最像果冻，仅次于有限元（2 Hz，0.7–0.8 s 内摆 2.5–3.5 次）。代价：每区域一簇时，肉像几团软块一样动；弯腰时头偏离骨头
最多（16 mm，有限元是 8–9 mm），因为头那一簇也含着被胸拉动的脖子肉。更多、更小的簇（比如每个格子立方体连同邻居一簇）细节更好，也更贵。

在真奶蛙上用[索引](../sim-index.md)的同一套测量（都能站稳：头高 0.99，漂移 ≤ 5.4 cm；"摇"是索引里的抖动测量）：

| naiwa.glb，弯腰 50° | 偏离 cm | 翻转单元 | 身体体积 | 头误差 mm | 手入肚 mm | 每步 ms（软体） | 摇，默认：峰值 mm / 摆动 / 衰减 s | 摇，最软 |
|---|---|---|---|---|---|---|---|---|
| cpu-constraints (built-in) | 3.47 | 0 | 0.999 | 8.5 | 0.0 | 2.38 (in Rapier) | 32 / 3.5 / 0.47 | 25 / 3.5 / 0.50 |
| `shape-matching` | 4.50 | 4 | 0.995 | 15.9 | 19.3 | 1.10 (0.20) | 41 / 2.5 / 0.72 | 39 / 3.5 / 0.80 |

## 在代码里
`src/algorithms/sim/shapeMatching.ts`，**flesh** 块。先试：在构造函数里按格子区域而不是肉区分簇；或者设 β = 0.3 再戳肚子。

## 参考
- M. Müller, B. Heidelberger, M. Teschner, M. Gross, *Meshless Deformations Based on Shape Matching*, SIGGRAPH 2005. https://doi.org/10.1145/1073204.1073216
- A. R. Rivers, D. L. James, *FastLSM: Fast Lattice Shape Matching for Robust Real-Time Deformation*, SIGGRAPH 2007. https://doi.org/10.1145/1276377.1276480
