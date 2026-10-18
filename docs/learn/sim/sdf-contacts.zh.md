# SDF 接触（地面、骨头、四肢和球作为距离场）

## 直觉
给自己不处理接触的粒子求解器用的碰撞块。肉能碰到的每个形状都有一个有向距离：地面是平面 y = 0，骨头或四肢是胶囊（到线段的距离减半径），
球是球。软体走完一步后，每个离形状比余量还近的自由粒子沿距离场的梯度被推出去，去掉它朝形状里的速度，摩擦减慢它的滑动。它受到的冲量
还给它碰到的骨头或球，所以接触是双向的。

## 核心公式
线段 ab、半径 r 的胶囊：$d(\mathbf p) = |\mathbf p - \mathbf c| - r$，$\mathbf c$ 是 ab 上最近点，法向 $\mathbf n = (\mathbf p - \mathbf c)/|\mathbf p - \mathbf c|$。
重叠 $\delta = r + \text{余量} - |\mathbf p - \mathbf c| > 0$，相对速度 $\mathbf v_r = \mathbf v - \mathbf v_{骨}(\mathbf c)$：

$$v_n^{目标} = \max\!\big(\beta\,\delta/h,\; -e\,v_n\big), \qquad \Delta v_n = v_n^{目标} - v_n, \qquad |\Delta\mathbf v_t| \le \mu\,\Delta v_n$$

浅的重叠用分离速度在几步内消掉（Baumgarte，β = 0.3），肉靠在骨头上时，硬的求解器不会每步被猛推一下；超过余量的部分立即消掉。骨头在
接触点受到 $-m\,\Delta\mathbf v$。

在真奶蛙上有两点改进很关键：
- 一开始就在形状里的粒子（紧贴骨头的肉，或格子伸出表面的部分）只被阻止陷得比开始时更深；
- 四肢对身体在渲染表面上检测，而不是在粒子上（粒子相隔一个格距，手能卡在它们之间）：每个在四肢胶囊里的表面顶点，按重心坐标权重移动
  它所在单元的粒子，使顶点落到胶囊表面。

## 算法步骤
```ts
for (part of parts)
  胶囊：自己骨头的硬核 + 其它部分的四肢接触胶囊，按本步姿态
  for (自由粒子 i)
    地面：y < 余量 时 contact(n = 向上)
    胶囊：d < min(r + 余量, 静止距离) 时 contact(n, 骨头)
    球：按双方质量交换法向非弹性冲量
  surfaceContacts()：四肢胶囊对身体的嵌入表面，每个粒子取平均
```

## 参数
| 参数 | 含义 | 常用范围 | 调了会看到什么 |
|---|---|---|---|
| `contactMargin` | 粒子能靠多近，以半个格距为单位 | 0.3–1 | 大：肉离骨头和地面更远 |
| `restitution` | 弹性系数 e | 0–0.3 | 接触更弹 |
| `limbContact` | 四肢对身体 | 开 | 关：手会穿进肚子 |

## 何时用
配合库里任何粒子求解器（所有预置组合都用它）。它是步后投影，不在求解里：简单、可共享，但一步之内接触和很硬的弹力可能意见不一，所以浅
重叠要软处理。把手按进肚子，最后的深度随求解器在 4–28 mm（内置的在 Rapier 求解里处理：0–8 mm）。在自己求解里处理接触的求解器（比如在
XPBD 子步里当约束）应当覆盖 `collision` 槽。

在真奶蛙上用[索引](../sim-index.md)的同一套测量（都能站稳：头高 0.99，漂移 ≤ 5.4 cm；"摇"是索引里的抖动测量）：

| naiwa.glb，弯腰 50° | 偏离 cm | 翻转单元 | 身体体积 | 头误差 mm | 手入肚 mm | 每步 ms（软体） | 摇，默认：峰值 mm / 摆动 / 衰减 s | 摇，最软 |
|---|---|---|---|---|---|---|---|---|
| cpu-constraints (built-in) | 3.47 | 0 | 0.999 | 8.5 | 0.0 | 2.38 (in Rapier) | 32 / 3.5 / 0.47 | 25 / 3.5 / 0.50 |
| `mass-spring`, explicit | 2.04 | 6 | 0.942 | 9.1 | 14.7 | 1.07 (0.37) | 32 / 3.0 / 0.30 | 94 / 2.0 / 0.30 |
| `pbd` | 2.65 | 0 | 0.996 | 8.0 | 28.1 | 2.85 (1.97) | 80 / 2.5 / 0.38 | 81 / 3.0 / 0.38 |
| `xpbd` | 2.23 | 0 | 0.970 | 9.9 | 14.8 | 2.23 (1.45) | 34 / 1.5 / 0.13 | 71 / 5.0 / 0.18 |
| `shape-matching` | 4.50 | 4 | 0.995 | 15.9 | 19.3 | 1.10 (0.20) | 41 / 2.5 / 0.72 | 39 / 3.5 / 0.80 |
| `projective-dynamics` | 1.94 | 0 | 0.982 | 7.6 | 4.3 | 2.73 (1.84) | 63 / 6.5 / 0.87 | 104 / 5.5 / 1.07 |
| `implicit-fem`, corotational | 2.00 | 0 | 0.970 | 7.9 | 12.7 | 3.10 (2.21) | 60 / 7.0 / 0.85 | 104 / 7.0 / 1.38 |

## 在代码里
`src/algorithms/sim/sdfContacts.ts`，**collision**（碰撞）块。先试：给地面一个软度而不是余量；或者把接触搬进 XPBD 的子步（约束
$C = d(\mathbf p) \ge 0$）。

## 参考
- K. Erleben, J. Sporring, K. Henriksen, H. Dohlmann, *Physics-Based Animation*, Charles River Media 2005（第 7 章，接触）. https://iphys.wordpress.com/2020/01/12/free-book-physics-based-animation/
- M. Müller, N. Chentanez, T.-Y. Kim, M. Macklin, *Air Meshes for Robust Collision Handling*, SIGGRAPH 2015（步后投影留下的问题）. https://doi.org/10.1145/2766907
- E. Catto, *Iterative Dynamics with Temporal Coherence*, GDC 2005（Baumgarte 稳定化）. https://box2d.org/files/ErinCatto_IterativeDynamics_GDC2005.pdf
