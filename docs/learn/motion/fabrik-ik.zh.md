# FABRIK 逆运动学（前后向迭代）

## 直觉
FABRIK 处理的是关节**位置**而不是角度。后向：把末端放到目标上，然后把每个关节拉向它后面的那个，直到骨头恢复原长。前向：把根部放回原位，
再把每个关节从前一个往外推。每次移动都是“点落在一条直线上”，所以便宜、不会冲过头，几轮就收敛。

目标是人的肢体方向按奶蛙自己的肢长放出的手腕或脚踝位置，$W = S + \ell_1 u + \ell_2 f$（捧肚子、举过头顶时混向肚皮或头顶）；为什么 IK
保住的是手的位置、而方向拷贝保住的是方向，见 CCD 页。

## 核心公式
骨长 $\ell_j$：

- 后向：$P_2 \leftarrow T$，然后对 j = 1, 0：$P_j \leftarrow P_{j+1} + \ell_j \dfrac{P_j - P_{j+1}}{|P_j - P_{j+1}|}$
- 前向：$P_0 \leftarrow S$，然后对 j = 1, 2：$P_j \leftarrow P_{j-1} + \ell_{j-1} \dfrac{P_j - P_{j-1}}{|P_j - P_{j-1}|}$

够不到的目标，最后肢体伸直指向它。每轮之后把肢体投影回身体约束（推出身体、弯曲不超限、两腿不交叉）：循环内轻量，结束时完整。

## 算法步骤
```ts
let p = joints(c, project(body, c, start, true));
for (let it = 0; it < iterations && goOn(c, p[2], last); it++) {
  p[2].copy(target);   for (j = 1; j >= 0; j--) reach(p[j], p[j + 1], len[j]);      // 后向
  p[0].copy(root);     for (j = 1; j <= 2; j++) reach(p[j], p[j - 1], len[j - 1]);  // 前向
  p = joints(c, project(body, c, dirsOf(p), true));
}
return project(body, c, dirsOf(p));
```
`reach(p, anchor, len)` 把 p 移到从 anchor 经过 p 的直线上、离 anchor 为 len 的位置。

## 参数
| 参数 | 含义 | 常用范围 | 改变时看到什么 |
|---|---|---|---|
| `fabrikIterations` | 每条肢体每帧的前后向轮数 | 3–10 | 多：贴身时更接近目标，更费时 |
| `fabrikTolerance` | 末端离目标这么近就停（m） | 0.001–0.005 | 大：更省，手的位置更粗 |
| `fabrikHint` | 从人的方向（1）还是上一帧（0）出发 | 0.5–1 | 0：肘的朝向漂移（Nae Nae 保真度 18.8° 对 16.4°） |

## 何时用
游戏里位置 IK 的首选：快、稳、不用矩阵，容易加每个关节的锥形限制。它把修正分摊到各关节，比 CCD 更均匀，因而更平滑。
naiwa.glb 实测（60 fps，内置输出；狗熊哆嗦毛 / Nae Nae / 科目三）：

| | 保真度 ° | jerk m/s³ | 穿透 mm | 求解 ms |
|---|---|---|---|---|
| 方向拷贝（内置） | 16.3 / 16.3 / 17.3 | 5131 / 383 / 1254 | 7.6 / 1.0 / 1.0 | 0.25 / 0.25 / 0.30 |
| `fabrik-ik` | 17.5 / 16.4 / 17.6 | 4746 / 456 / 1743 | 1.0 / 1.0 / 1.0 | 0.50 / 0.50 / 0.73 |

在狗熊哆嗦毛上 jerk 是几种求解器里最低的，其他舞上接近方向拷贝，手也不进身体。它的弱点与所有末端 IK 一样：肘的朝向是自由的，
需要人的肘作为提示。

## 在代码里
`src/algorithms/motion/fabrikSolver.ts`，**solver** 槽；目标和投影共用 `src/algorithms/motion/limbs.ts`。可以先试：把弯曲限制放进
前后向迭代里（FABRIK 的锥形约束）而不是放在投影里，或者每轮后加一步把肘转向人的肘（pole）。

## 参考
- A. Aristidou, J. Lasenby, *FABRIK: A fast, iterative solver for the Inverse Kinematics problem*, Graphical Models 2011. https://doi.org/10.1016/j.gmod.2011.05.003
