# 阻尼最小二乘 IK（雅可比）

## 直觉
雅可比矩阵描述每个关节转一点点时，肢体末端怎么动。把它求逆，就知道该怎么转关节才能让末端朝目标走。肢体伸直时这个逆会爆掉
（无论关节怎么转，末端都无法沿肢体方向移动），关节会乱转；阻尼用一点收敛速度换来始终很小的步子。

目标是人的肢体方向按奶蛙肢长放出的手腕或脚踝位置，$W = S + \ell_1 u + \ell_2 f$（见 CCD 页）。

## 核心公式
两个球关节（肩、肘），共六个转动未知量 ω。关节 j 转 ω 时末端移动 $\omega \times r_j$（$r_j$ 从关节指向末端），所以
$J = [-[r_0]_\times\ \ -[r_1]_\times]$（3 × 6），

$$\Delta\omega = J^\top (J J^\top + \lambda^2 I)^{-1} e, \qquad J J^\top = \sum_j \left(|r_j|^2 I - r_j r_j^\top\right), \qquad \Delta\omega_j = r_j \times y$$

其中 $y = (JJ^\top + \lambda^2 I)^{-1} e$，e 是末端误差（截到 `dlsMaxStep`）。λ = 0 是伪逆（快，伸直时不稳）；λ 很大就是雅可比转置（稳，慢）。

## 算法步骤
```ts
let d = project(body, c, start, true);
for (let it = 0; it < iterations; it++) {
  const p = joints(c, d);
  if (!goOn(c, p[2], last)) break;
  const e = clip(target − p[2], maxStep);
  const r = [p[2] − p[0], p[2] − p[1]];
  const y = inverse(Σ (|rⱼ|² I − rⱼ rⱼᵀ) + λ² I) · e;      // 3 × 3
  const w0 = r[0] × y, w1 = r[1] × y;                     // 肩、肘的 Δω
  d = project(body, c, [rotate(d[0], w0), rotate(rotate(d[1], w0), w1)], true);
}
return project(body, c, d);
```

## 参数
| 参数 | 含义 | 常用范围 | 改变时看到什么 |
|---|---|---|---|
| `dlsDamping` | λ（m） | 0.01–0.1 | 小：收敛快，伸直时跳；大：稳，慢 |
| `dlsMaxStep` | 每轮末端最多朝目标走多远（m） | 0.02–0.1 | 小：更平滑，需要更多轮 |
| `dlsIterations` | 每条肢体每帧的轮数 | 4–15 | 多：贴身时更接近目标，更费时 |
| `dlsTolerance` | 末端离目标这么近就停（m） | 0.001–0.005 | 大：更省 |
| `dlsHint` | 从人的方向（1）还是上一帧（0）出发 | 0.5–1 | 这里 0 很糟：从过时的起点出发会落到另一个肘朝向（Nae Nae 保真度 39.4° 对 16.1°） |

## 何时用
想要通用的机制时：同一个步骤能处理任意多个关节、同时多个目标（把雅可比叠起来）、以及零空间里的次要目标。在狗熊哆嗦毛和 Nae Nae 上，它是三种 IK
里最贴近人的，在科目三上最差。naiwa.glb 实测（60 fps，内置输出；狗熊哆嗦毛 / Nae Nae / 科目三）：

| | 保真度 ° | jerk m/s³ | 穿透 mm | 求解 ms |
|---|---|---|---|---|
| 方向拷贝（内置） | 16.3 / 16.3 / 17.3 | 5131 / 383 / 1254 | 7.6 / 1.0 / 1.0 | 0.25 / 0.25 / 0.30 |
| `dls-ik` | 17.0 / 16.1 / 18.2 | 5837 / 542 / 1701 | 1.0 / 1.0 / 1.0 | 0.66 / 0.52 / 0.66 |

每轮一个 3 × 3 求逆，四条肢体加起来仍在 1 ms 以内。和所有末端 IK 一样，它不知道肘该朝哪：把人的肘作为第二个、较弱的任务加进来就能定住。

## 在代码里
`src/algorithms/motion/dlsSolver.ts`，**solver** 槽；目标和投影在 `src/algorithms/motion/limbs.ts`。可以先试：为肘加第二个任务行
（变成 6 × 6），或只在接近奇异时增大 λ（选择性阻尼最小二乘）。

## 参考
- C. W. Wampler, *Manipulator Inverse Kinematic Solutions Based on Vector Formulations and Damped Least-Squares Methods*, IEEE Trans. SMC 1986. https://doi.org/10.1109/TSMC.1986.4308957
- Y. Nakamura, H. Hanafusa, *Inverse Kinematic Solutions With Singularity Robustness for Robot Manipulator Control*, J. Dyn. Sys., Meas., Control 1986. https://doi.org/10.1115/1.3143764
- S. R. Buss, *Introduction to Inverse Kinematics with Jacobian Transpose, Pseudoinverse and Damped Least Squares methods*, 2004. https://mathweb.ucsd.edu/~sbuss/ResearchWeb/ikmethods/iksurvey.pdf
