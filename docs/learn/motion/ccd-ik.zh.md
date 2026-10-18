# CCD 逆运动学（循环坐标下降）

## 直觉
逆运动学（IK）转动肢体的关节，让末端（手腕或脚踝）够到目标。CCD 一次只转一个关节：从最靠近末端的关节开始，把“关节 → 末端”这条线
转向目标，再转下一个更靠根部的关节，如此循环。每一步只是一次旋转，好懂，也好加约束。

**目标从哪里来。** 目标块（`person-directions`）给的是肢体**方向**，因为奶蛙的四肢比人短得多。目标点就是这些方向按奶蛙自己的肢长放出的
手腕位置：$W = S + \ell_1 u + \ell_2 f$（肩 S，目标方向 u、f，奶蛙肢长 ℓ）；捧肚子时混向肚皮上的一点，举过头顶时混向头顶上方。
脚踝同理，从髋出发。没有约束时目标姿态正好够到 W；IK 的作用在身体挡路时显现：肘绕开肚子时，它让**手**留在人的方向给出的位置，而方向拷贝
（内置求解器）保持的是**方向**，手会跟着移开。

## 核心公式
关节 j 在 $P_j$，末端 E，目标 T：

$$q_j = \text{把 } \frac{E - P_j}{|E - P_j|} \text{ 转到 } \frac{T - P_j}{|T - P_j|} \text{ 的旋转}, \qquad P_k \leftarrow P_j + q_j (P_k - P_j)\ \ (k > j)$$

每轮之后把肢体投影到约束上：每段转到最深的点离开身体 `needed + 3 mm`（`constraints.pushOut`），弯曲限制在
`constraints.limit("elbow" | "knee")` 之内，膝和脚踝不进中线（`constraints.spread`）。

## 算法步骤
```ts
let p = joints(c, project(body, c, start, true));          // 起点：人的方向（hint 1）
for (let it = 0; it < iterations && goOn(c, p[2], last); it++) {
  for (const j of [1, 0]) {                                // 先肘，后肩
    q.setFromUnitVectors(norm(p[2] − p[j]), norm(target − p[j]));
    for (k > j) p[k] = p[j] + q·(p[k] − p[j]);
  }
  p = joints(c, project(body, c, dirsOf(p), true));        // 每轮轻量投影
}
return project(body, c, dirsOf(p));                        // 最后完整投影
```
`goOn` 在末端进入 `ccdTolerance` 时停止；或者一轮下来末端靠近不到它的十分之一时停止（身体挡着、够不到的目标）。

## 参数
| 参数 | 含义 | 常用范围 | 改变时看到什么 |
|---|---|---|---|
| `ccdIterations` | 每条肢体每帧的轮数 | 4–15 | 多：贴身时更接近目标，更费时 |
| `ccdTolerance` | 末端离目标这么近就停（m） | 0.001–0.005 | 大：更省，手的位置更粗 |
| `ccdHint` | 从人的方向（1）还是上一帧的解（0）出发 | 0.5–1 | 0：肘的朝向逐渐偏离人（企鹅踢腿保真度 22° 对 13°） |

## 何时用
长链（尾巴、脊柱、手指）：每关节一次旋转，简单稳健。两节的肢体上 CCD 偏向转靠近末端的关节，肘干了大部分活，帧与帧之间来回折：
它是这里最抖的 IK 求解器。naiwa.glb 实测（60 fps，内置输出；狗熊哆嗦毛 / Nae Nae / 科目三）：

| | 保真度 ° | jerk m/s³ | 穿透 mm | 求解 ms |
|---|---|---|---|---|
| 方向拷贝（内置） | 16.3 / 16.3 / 17.3 | 5131 / 383 / 1254 | 7.6 / 1.0 / 1.0 | 0.25 / 0.25 / 0.30 |
| `ccd-ik` | 18.9 / 17.6 / 17.2 | 6258 / 1184 / 1835 | 1.0 / 1.0 / 1.0 | 0.59 / 0.52 / 0.62 |

保真度衡量的是与人的**方向**的差距，IK 并不追求它；它更好地让手离开头和肚子（处处 1 mm 穿透）。对比 FABRIK（更平滑、代价相近）
和 DLS（在平缓的舞上更平滑）。

## 在代码里
`src/algorithms/motion/ccdSolver.ts`，**solver** 槽；共用的肢体链准备（目标、`project`、组装姿态）在 `src/algorithms/motion/limbs.ts`。
可以先试：改成从根部往末端扫，或给每次旋转加阻尼（只转一部分），让来回折变小。

## 参考
- L.-C. T. Wang, C. C. Chen, *A combined optimization method for solving the inverse kinematics problem of mechanical manipulators*, IEEE Trans. Robotics and Automation 1991. https://doi.org/10.1109/70.86079
- S. R. Buss, *Introduction to Inverse Kinematics with Jacobian Transpose, Pseudoinverse and Damped Least Squares methods*, 2004. https://mathweb.ucsd.edu/~sbuss/ResearchWeb/ikmethods/iksurvey.pdf
