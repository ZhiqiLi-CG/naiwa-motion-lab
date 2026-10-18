# 柔性系带（双向耦合，挂着的肉和自由的肉之间没有接缝）

## 直觉
内置的耦合让骨头附近的肉刚性地挂在骨头上，其余的自由。两者交界处有一道硬边界，而且固定比例的肉永远不会让一点点。柔性系带把每个粒子
用带阻尼的弹簧系到骨头会把它带到的位置，弹簧强度随深度平滑衰减：贴着骨头几乎刚性，到表面几乎自由。只有紧贴骨头的组织直接挂在骨头上。
每根系带拉肉多大，就以同样大小反拉骨头，所以动量只交换、不凭空产生（docs/soft-binding.md："no on/off seam"）。

## 核心公式
粒子 i 的深度 $u_i$（到骨头的距离除以那里肉的典型厚度），硬度 $\phi_i = 1.5 - $ 软度：

$$f_i = f_{近}\,\big(f_{远}/f_{近}\big)^{\,\mathrm{smoothstep}(0,\;r\phi_i,\;u_i)}, \qquad \omega_i = 2\pi f_i, \quad k_i = m_i\omega_i^2, \quad c_i = 2\zeta m_i\omega_i$$

对（粒子，骨头）这一对隐式求解，约化质量 $\mu = m M/(m + M)$，M 是骨头质量按系在它上面的粒子分摊的份额（Jacobi 拆分，多硬都稳），
$\mathbf d = \mathbf t - \mathbf x$，$\mathbf v_r = \mathbf v - \mathbf v_t$：

$$\mathbf J = \frac{\mu\,h\,\big(k\,\mathbf d - (c + hk)\,\mathbf v_r\big)}{\mu + hc + h^2k}$$

粒子得到 $+\mathbf J$，骨头在目标点得到 $-\mathbf J$（线和角）。

## 算法步骤
```ts
构造：每个粒子的深度；四肢和深度 < tetherCore·φ 的肉直接挂在骨头上（attach）
setSettings：由深度、硬度、近/远频率和衰减范围算出每根系带的 ω
afterStep（软体走完、目标更新之后）：
  share = 骨头质量 / 系在它上面的肉的质量
  for (自由粒子 i): J = 这一对的隐式冲量;  粒子 += J;  骨头在目标点 −= J
```

## 参数
| 参数 | 含义 | 常用范围 | 调了会看到什么 |
|---|---|---|---|
| `tetherCore` | 直接挂在骨头上的深度（× 肉厚） | 0.3–0.8 | 低：更多的肉能让；头和胸晃得更多 |
| `tetherNear` | 骨头旁的频率（Hz） | 10–40 | 低：快速动作时深层的肉跟不上 |
| `tetherFar` | 表面的频率（Hz） | 0.2–3 | 高：表面被拉回骨头的形状，晃动更少 |
| `tetherReach` | 强度衰减的深度范围 | 0.8–2 | 大：更硬、更贴骨形 |
| `tetherDamping` | 系带的阻尼比 ζ | 0.2–1 | 低：更弹；低于约 0.3 时系带对骨头的显式拉力会让站着的奶蛙一直小动 |

## 何时用
想让肉处处都能让一点、挂着和自由之间看不出分界时。它本身几乎不花时间；配共旋有限元，弯腰时身体跟随在 2.5 cm 内，0 个翻转单元；头上硬挂在颅骨上的肉少了，
让得更多（离刚性 17 mm，骨骼附着是 8 mm）。它在软体
一步之后施加（算子分裂）：系带和弹性不在同一个求解里，非常硬的系带会和硬的求解器打架；承重靠的是硬核。

在真奶蛙上用[索引](../sim-index.md)的同一套测量（都能站稳：头高 0.99，漂移 ≤ 5.4 cm；"摇"是索引里的抖动测量）：

| naiwa.glb，弯腰 50° | 偏离 cm | 翻转单元 | 身体体积 | 头误差 mm | 手入肚 mm | 每步 ms（软体） | 摇，默认：峰值 mm / 摆动 / 衰减 s | 摇，最软 |
|---|---|---|---|---|---|---|---|---|
| cpu-constraints (built-in) | 3.47 | 0 | 0.999 | 8.5 | 0.0 | 2.38 (in Rapier) | 32 / 3.5 / 0.47 | 25 / 3.5 / 0.50 |
| `implicit-fem`, corotational | 2.00 | 0 | 0.970 | 7.9 | 12.7 | 3.10 (2.21) | 60 / 7.0 / 0.85 | 104 / 7.0 / 1.38 |
| `fem-tethers` (soft tethers) | 2.53 | 0 | 0.976 | 16.3 | 14.5 | 3.24 (2.34) | 60 / 3.5 / 0.28 | 101 / 3.0 / 0.33 |

## 在代码里
`src/algorithms/sim/softTethers.ts`，**coupling**（耦合）块（预置的 `fem-tethers` 把它和 `implicit-fem` 组合）。先试：把系带放进软体
求解器的方程组（它的 Hessian 里多一项弹簧），而不是放在求解之后；或者按目标的蒙皮权重而不是最近的骨头来加权。

## 参考
- S. Capell, S. Green, B. Curless, T. Duchamp, Z. Popović, *Interactive Skeleton-Driven Dynamic Deformations*, SIGGRAPH 2002. https://doi.org/10.1145/566654.566622
- J. Kim, N. S. Pollard, *Fast Simulation of Skeleton-Driven Deformable Body Characters*, ACM TOG 2011. https://doi.org/10.1145/2019627.2019640
