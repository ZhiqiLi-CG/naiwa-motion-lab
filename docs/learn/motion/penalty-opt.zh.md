# 约束优化（罚函数 Gauss–Newton）

## 直觉
把想要的东西写成式子，让求解器去找：肢体方向尽量接近人的方向，同时肢体不进奶蛙的身体、肘和膝的弯曲不超限。内置的方向拷贝一段一段地修
违反；这个求解器把一条肢体的两段放在一起权衡，可以让上臂稍让一点、省下前臂一大截。

## 核心公式
每条肢体求单位方向 $d_0, d_1$（上段、下段）：

$$\min_{d}\ \sum_i |d_i - g_i|^2 + w_{reach}\,|\ell_0 d_0 + \ell_1 d_1 - T|^2 + \mu \sum_k \min(0,\ c_k(d) - m_k)^2 \quad \text{s.t. } |d_i| = 1,\ \angle(d_0, d_1) \le \text{limit}$$

g 是人的方向，T 是捧肚子或举过头顶的目标（只有那时才有 reach 项），$c_k$ 是肢体点 k 的避让距离（`constraints.check`），$m_k$ 是它需要的
距离加 3 mm；腿还要求膝、脚踝离中线足够远。每轮把每个约束在当前点线性化：$c_k(p + \Delta) \approx c_k + n_k\cdot\Delta$（$n_k$ 是
`constraints.pushOut` 给出的外法向）；某段方向变化 δ 时，点移动 $\Delta = a\,\delta$（a 是它到该段起点的距离；肘带着前臂移动 $\ell_0\delta_0$）。
于是所有残差对 $\delta = (\delta_0, \delta_1)$ 都是线性的，Gauss–Newton 一步解一个 6 × 6 方程 $H\delta = -\nabla$。

## 算法步骤
```ts
let d = project(body, c, start, true);                    // 起点：上一帧的解（hint 0）
for (let it = 0; it < iterations; it++) {
  H, g = 保真项 + 切向项（让 δᵢ ⊥ dᵢ）+ reach 项
  rows = 接近边界的约束，在 d 处线性化                      // r = c − m, n, k₀, k₁
  active = 已违反的，或之前激活且离边界 5 mm 以内的
  最多 3 次：step = solve6(H + μ Σ JᵀJ, −(g + μ Σ r Jᵀ))，截到 0.25
            加入这一步会违反的约束
  d = normalise(d + step)；限制弯曲
}
return project(body, c, d);                                // 去掉罚函数剩下的穿透
```

## 参数
| 参数 | 含义 | 常用范围 | 改变时看到什么 |
|---|---|---|---|
| `optPenalty` | μ（1/m²） | 300–3000 | 大：约束更硬，但激活集来回切换让动作发抖（μ = 10⁵ 时 Nae Nae 的 jerk 8700，对 471）；小：更软，最后的投影做得更多 |
| `optReach` | 肚子/头顶目标的权重（1/m²） | 30–300 | 大：手够到肚子或头顶的位置，方向让步 |
| `optIterations` | 每条肢体每帧的 Gauss–Newton 步数 | 5–15 | 多：更接近最优，更费时 |
| `optTolerance` | （肢体链共用参数；方向变化小于 10⁻³ 时停止） | | |
| `optHint` | 从上一帧（0）还是人（1）出发 | 0–0.5 | 0 是热启动：最优解帧间变化小，几步就够，动作平滑 |

## 何时用
想要按明确标准“最接近的可行姿态”，或者想加新项（肘的朝向、对称、姿态先验）而不必另想一套流程时。它是这里最贴近人的求解器。
naiwa.glb 实测（60 fps，内置输出；狗熊哆嗦毛 / Nae Nae / 科目三）：

| | 保真度 ° | jerk m/s³ | 穿透 mm | 求解 ms |
|---|---|---|---|---|
| 方向拷贝（内置） | 16.3 / 16.3 / 17.3 | 5131 / 383 / 1254 | 7.6 / 1.0 / 1.0 | 0.25 / 0.25 / 0.30 |
| `penalty-opt` | 16.1 / 15.2 / 15.8 | 6463 / 471 / 1615 | 1.2 / 0.9 / 1.0 | 0.90 / 0.95 / 0.84 |

它最贵（每步都要对每个肢体点查询身体），激活集变化处稍抖。做它时学到两点：约束平面每步都要重新线性化（在弯曲的身体上沿用旧位置的平面，
会把胳膊越推越远）；罚系数太硬会让激活集闪烁，中等的 μ 加最后一次投影比巨大的 μ 更好。

## 在代码里
`src/algorithms/motion/penaltyOptSolver.ts`，**solver** 槽（`rows` 做线性化，`solveChain` 迭代）；目标和投影在
`src/algorithms/motion/limbs.ts`。可以先试：加肘朝向项（人的肘作为软目标），或把罚函数换成增广拉格朗日（乘子在帧间延续）。

## 参考
- J. Nocedal, S. J. Wright, *Numerical Optimization*, 2nd ed., Springer 2006, ch. 10 (Gauss–Newton) and 17 (penalty methods). https://doi.org/10.1007/978-0-387-40065-5
