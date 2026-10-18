# 质点–弹簧（每条边一根带阻尼的弹簧）

## 直觉
最简单的软体：单元的每个节点放一个质点，每条边放一根弹簧。肉被拉长，弹簧就把它拉回来；沿弹簧的阻尼把晃动消掉。代码好读、每步便宜，
但弹簧只管长度：它不管单元的体积，也不阻止单元翻转；显式积分时，硬弹簧还逼着时间步变小。

## 核心公式
质点 i、j 之间的弹簧，静长 L、刚度 k、阻尼 c，$\mathbf n = (\mathbf x_j - \mathbf x_i)/l$：

$$\mathbf f_i = \big(k\,(l - L) + c\,(\mathbf v_j - \mathbf v_i)\cdot\mathbf n\big)\,\mathbf n, \qquad \mathbf f_j = -\mathbf f_i$$

刚度来自材质：$k = 2E\,V_e/L^2$，$V_e$ 是这条边分到的周围单元体积（每个单元的六分之一，乘以区域刚度）；$c = 2\zeta\sqrt{k\,m}$。

**显式**（辛欧拉，子步 $h_s$）：$\mathbf v \mathrel{+}= h_s(\mathbf g + \mathbf f/m)$，再 $\mathbf x \mathrel{+}= h_s\mathbf v$。只有最快的粒子满足 $h_s\,\omega < 2$ 时才稳定，
$\omega^2 \approx \sum k/m$：代码至少取 $\lceil h\,\omega\rceil$ 个子步。

**半隐式**（Baraff & Witkin 1998，线性化的一步后向欧拉），$K = -\partial\mathbf f/\partial\mathbf x$，$C = -\partial\mathbf f/\partial\mathbf v$：

$$(M + hC + h^2K)\,\Delta\mathbf v = h\,(\mathbf f_0 - hK\mathbf v)$$

用共轭梯度求解；弹簧的横向刚度 $k(1 - L/l)$ 截到不小于 0，矩阵保持正定。

## 算法步骤
```ts
// 挂在骨头上的粒子从步首出发，按骨头的速度移动
if (implicit) implicitStep(h, g);           // 在自由粒子上组装 M + hC + h²K，CG 解 Δv
else for (s of substeps)                    // max(springSubsteps, ⌈h·ω⌉)
  forces(X, V);                             // 活动边上的弹簧和阻尼
  自由粒子: V += hs * (g + f / m)
  挂着的粒子: reaction += f * hs            // 弹簧的拉力交给骨头
  X += hs * V
```

## 参数
| 参数 | 含义 | 常用范围 | 调了会看到什么 |
|---|---|---|---|
| `integrator` | 显式或半隐式 | — | 半隐式更稳、翻转单元更少，多一次 CG 求解 |
| `springSubsteps` | 显式每步至少的子步数 | 5–20 | 少则便宜；稳定性限制会自动加上去 |
| `springDamping` | 每根弹簧的阻尼比 ζ | 0.1–0.6 | 太低：肉一直颤，站着的奶蛙停不下来 |
| `springCgIterations` | CG 迭代次数（半隐式） | 10–50 | 少：这一步比应有的软 |
| `bodyParticles` | 身体的格点数 | 150–600 | 越细越慢；显式子步也会变多（小单元更硬） |

## 何时用
用来学习和做基准。很便宜（奶蛙上每步约 0.3 ms 软体时间），但躯干弯曲时肉会丢体积（身体只剩静止的 0.92），单元也会翻转
（50° 弯腰时 20 个），因为没有任何东西在量单元的体积。XPBD 和有限元正好解决这个。实测见[索引](../sim-index.md)。

在真奶蛙上用[索引](../sim-index.md)的同一套测量（都能站稳：头高 0.99，漂移 ≤ 5 cm）：

| naiwa.glb，弯腰 50° | 偏离 cm | 翻转单元 | 身体体积 | 头误差 mm | 手入肚 mm | 每步 ms（软体） |
|---|---|---|---|---|---|---|
| cpu-constraints (built-in) | 4.06 | 0 | 0.988 | 8.9 | 7.9 | 1.48 (in Rapier) |
| `mass-spring`, explicit | 2.13 | 20 | 0.917 | 8.8 | 12.0 | 0.84 (0.30) |
| `mass-spring`, semi-implicit | 2.14 | 6 | 0.941 | 9.1 | 11.1 | 1.15 (0.61) |

## 在代码里
`src/algorithms/sim/massSpring.ts`，**flesh**（软体）块（粒子、格子和双向附着来自 `flesh.ts`）。先试：在 `forces` 里给每个单元加一根
体积弹簧；或者戳肚子时比较 `springDamping` 0.1 和 0.6。

## 参考
- D. Baraff, A. Witkin, *Large Steps in Cloth Simulation*, SIGGRAPH 1998. https://doi.org/10.1145/280814.280821
- A. Nealen et al., *Physically Based Deformable Models in Computer Graphics*, Computer Graphics Forum 2006（§3 质点–弹簧）. https://doi.org/10.1111/j.1467-8659.2006.01000.x
