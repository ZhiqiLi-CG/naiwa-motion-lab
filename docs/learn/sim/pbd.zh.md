# 位置动力学 PBD（投影约束，由位移得速度）

## 直觉
不算力，而是先猜每个粒子这一步会到哪，再挪动这些猜测直到约束成立：每条边回到原长，每个单元回到原体积，一次处理一个约束。速度就是
粒子走了多远。它不会炸，所以游戏爱用；但肉有多硬取决于你迭代几遍、时间步多长，而不是某个材料常数。

## 核心公式
约束 $C(\mathbf p) = 0$，梯度 $\nabla_i C$，逆质量 $w_i$，一次投影移动

$$\Delta\mathbf p_i = -\,k'\,\frac{C}{\sum_j w_j\,|\nabla_j C|^2}\;w_i\,\nabla_i C, \qquad k' = 1 - (1-k)^{1/n}$$

（n 次迭代，使 n 遍合起来是刚度 k）。两种约束：

- 距离 $C = |\mathbf p_i - \mathbf p_j| - L$，$\nabla_i C = \mathbf n$，$\nabla_j C = -\mathbf n$；
- 体积 $C = V(\mathbf p_0..\mathbf p_3) - V_0$，$\nabla_1 V = (\mathbf p_2 - \mathbf p_0)\times(\mathbf p_3 - \mathbf p_0)/6$（其余轮换），$\nabla_0 V = -\sum$。

体积带符号，翻转的单元会被推回来。最后 $\mathbf v = (\mathbf p - \mathbf x)/h$。

## 算法步骤
```ts
p = x + h·v（自由粒子再加 h²g）              // 挂着的粒子：按骨头的运动
for (it of iterations)
  distances(): 每条活动边投影；挂着的一端 w = 0，把 λ∇C/h 交给骨头
  volumes():   每个活动单元投影
v = (p − x) / h;  x = p
```
（`positionBased.ts`，与 XPBD 共用；PBD 是 `xpbd: false` 分支。）

## 参数
| 参数 | 含义 | 常用范围 | 调了会看到什么 |
|---|---|---|---|
| `pbdIterations` | 每步高斯–赛德尔遍数 | 4–20 | 多：肉更硬（没错，材质变了），也更贵 |
| `pbdStiffness` | 边刚度 k（乘以材质模量相对默认的比） | 0.2–1 | 低：更软、更下垂 |
| `pbdVolumeStiffness` | 体积刚度 | 0.3–1 | 0：挤肚子时体积变小 |

## 何时用
要求永不爆、可以凭眼睛调的时候：稳、简单，50° 弯腰时 0 个翻转单元，身体体积误差 1% 以内。代价：刚度不是物理的——迭代翻倍或步长减半，
奶蛙就变硬。XPBD 保留了 PBD 的好处，去掉了这一点。

在真奶蛙上用[索引](../sim-index.md)的同一套测量（都能站稳：头高 0.99，漂移 ≤ 5 cm）：

| naiwa.glb，弯腰 50° | 偏离 cm | 翻转单元 | 身体体积 | 头误差 mm | 手入肚 mm | 每步 ms（软体） |
|---|---|---|---|---|---|---|
| cpu-constraints (built-in) | 4.06 | 0 | 0.988 | 8.9 | 7.9 | 1.48 (in Rapier) |
| `pbd` | 2.19 | 0 | 0.991 | 6.4 | 0.0 | 1.34 (0.87) |

## 在代码里
`src/algorithms/sim/pbd.ts`（块）和 `positionBased.ts`（求解器），**flesh** 块。先试：关掉体积约束（`pbdVolumeStiffness` 0）挤肚子；
或者比较 4 次和 20 次迭代。

## 参考
- M. Müller, B. Heidelberger, M. Hennix, J. Ratcliff, *Position Based Dynamics*, VRIPHYS 2006 / JVCIR 2007. https://doi.org/10.1016/j.jvcir.2007.01.005
- J. Bender, M. Müller, M. Macklin, *A Survey on Position Based Dynamics*, Eurographics Tutorials 2017. https://doi.org/10.2312/egt.20171034
