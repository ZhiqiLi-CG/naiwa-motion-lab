# 扩展位置动力学 XPBD（柔度、拉格朗日乘子、小步长）

## 直觉
带物理刚度的 PBD。每个约束有一个柔度 α（弹簧刚度的倒数，来自杨氏模量），求解器保留它的拉格朗日乘子 λ，于是结果不再随迭代次数变：
它收敛到真实弹簧的一步隐式欧拉。很多个只迭代一次的小子步（"小步长"），比少数步、每步多次迭代收敛得更快。

## 核心公式
子步 $h_s$，$\tilde\alpha = \alpha/h_s^2$，一次迭代让 λ 变化

$$\Delta\lambda = \frac{-C - \tilde\alpha\,\lambda}{\sum_j w_j|\nabla_j C|^2 + \tilde\alpha}, \qquad \Delta\mathbf p_i = w_i\,\nabla_i C\,\Delta\lambda$$

（每个子步一次迭代，所以 λ 从 0 开始，$\Delta\lambda = -C/(\sum w|\nabla C|^2 + \tilde\alpha)$）。柔度来自材质：

- 边：$\alpha = 1/k$，$k = 16E\,V_e/L^2$（同质点–弹簧：弹簧网络要乘 16 才和连续体一样硬）；
- 单元：$C = V - V_0$，能量 $\tfrac{K}{2V_0}(V-V_0)^2$，所以 $\alpha = V_0/K$，体积模量 $K = E/(3(1-2\nu))$。

约束施加的力是 $\lambda\nabla C/h_s^2$；挂在骨头上的粒子受到的冲量 $\lambda\nabla C/h_s$ 交给骨头。

## 算法步骤
```ts
for (s of substeps)                       // xpbdSubsteps，hs = h / substeps
  prev = p;  v += hs·g（自由粒子）;  p += hs·v
  distances(hs);  volumes(hs);            // Δλ，α̃ = α / hs²，各一遍
  v = (p − prev) / hs                     // 自由粒子
x = p
```

## 参数
| 参数 | 含义 | 常用范围 | 调了会看到什么 |
|---|---|---|---|
| `xpbdSubsteps` | 每步子步数 | 5–20 | 多：更接近真实刚度，丢的晃动更少（20：最软时摇一下摆 6 次而不是 5 次）；开销线性增长 |
| `xpbdPoisson` | 体积柔度用的泊松比 ν | 0.3–0.49 | 接近 0.5：几乎不可压缩，肚子保体积 |
| 软硬滑块 | 杨氏模量 30 → 1 kPa | — | 同一个滑块在有限元块里也是同样的肉 |

## 何时用
刚度有物理意义，稳（弯腰时 0 个翻转单元，身体体积 0.97），奶蛙上每步软体时间约 1.5 ms。它比有限元更耗散：每个子步一遍高斯–赛德尔，硬的
体积和边约束没收敛，没解掉的部分像被阻尼吃掉（默认摇一下摆 1.5 次、0.13 s；有限元 7 次、0.85 s）；子步多一点会好，代价是开销。和有限元比，它用单独的约束
管体积，不是一个统一的材料模型；高斯–赛德尔每个子步只把一次推挤传出几个单元。

在真奶蛙上用[索引](../sim-index.md)的同一套测量（都能站稳：头高 0.99，漂移 ≤ 5.4 cm；"摇"是索引里的抖动测量）：

| naiwa.glb，弯腰 50° | 偏离 cm | 翻转单元 | 身体体积 | 头误差 mm | 手入肚 mm | 每步 ms（软体） | 摇，默认：峰值 mm / 摆动 / 衰减 s | 摇，最软 |
|---|---|---|---|---|---|---|---|---|
| cpu-constraints (built-in) | 3.47 | 0 | 0.999 | 8.5 | 0.0 | 2.38 (in Rapier) | 32 / 3.5 / 0.47 | 25 / 3.5 / 0.50 |
| `xpbd` | 2.23 | 0 | 0.970 | 9.9 | 14.8 | 2.23 (1.45) | 34 / 1.5 / 0.13 | 71 / 5.0 / 0.18 |

## 在代码里
`src/algorithms/sim/xpbd.ts`（块）和 `positionBased.ts`（`xpbd: true`），**flesh** 块。先试：在 `volumes` 旁边给每个单元加一个形状匹配
或应变约束；或者在最硬的软硬设置下比较 2 和 10 个子步。

## 参考
- M. Macklin, M. Müller, N. Chentanez, *XPBD: Position-Based Simulation of Compliant Constrained Dynamics*, MIG 2016. https://doi.org/10.1145/2994258.2994272
- M. Macklin, K. Storey, M. Lu, P. Terdiman, N. Chentanez, S. Jeschke, M. Müller, *Small Steps in Physics Simulation*, SCA 2019. https://doi.org/10.1145/3309486.3340247
