# 卡尔曼滤波（匀速模型）与 RTS 平滑

## 直觉
姿态检测器的每个关键点每帧都会抖一厘米左右。卡尔曼滤波为每个关键点坐标同时估计**位置和速度**，并记着这个估计有多不确定。
每帧先预测它现在该在哪儿，再按“更信预测还是更信检测”把估计拉向检测值。上传的视频还能再跑一遍 Rauch–Tung–Striebel（RTS）平滑器：
从后往前，让未来的帧修正过去的估计，没有延迟。

## 核心公式
状态 $x = [p, v]$，帧间隔 $\Delta t$，$F = \begin{bmatrix}1 & \Delta t\\ 0 & 1\end{bmatrix}$，测量 $H = [1\ 0]$。

- 预测：$x^- = F x$，$P^- = F P F^\top + Q$，$Q = \sigma_a^2 \begin{bmatrix}\Delta t^4/4 & \Delta t^3/2\\ \Delta t^3/2 & \Delta t^2\end{bmatrix}$（每步一个大小约 $\sigma_a$ 的未知加速度）。
- 校正：$K = P^-H^\top / (HP^-H^\top + r)$，$x = x^- + K(z - Hx^-)$，$P = (I - KH)P^-$，其中 $r = \sigma_m^2 / \text{可见度}$。
- RTS 反向：$C_k = P_k F^\top (P^-_{k+1})^{-1}$，$\hat x_k = x_k + C_k(\hat x_{k+1} - x^-_{k+1})$。

稳态增益只取决于比值 $\sigma_a/\sigma_m$：(30 m/s², 15 mm) 与 (20 m/s², 10 mm) 滤出来一样。

## 算法步骤
```ts
live(frame, t):                       // 摄像头
  第一帧或空缺 > 0.5 s：init(z)          // 速度未知
  否则：predict(t - last, accel); measure(frame, z, noise)
recorded(frames, fps):                // 上传的视频，按有人的连续片段
  正向：predict；有人就 measure（空缺用预测补上）；记下 x⁻, P⁻, x, P
  反向：x̂ₖ = xₖ + Cₖ (x̂ₖ₊₁ − x⁻ₖ₊₁)
```
198 个坐标（33 个点 × 世界 xyz + 画面 xyz）各是一个 2 维状态的滤波器；画面坐标的 σ 乘 0.4（每米对应的画面比例）。

## 参数
| 参数 | 含义 | 常用范围 | 改变时看到什么 |
|---|---|---|---|
| `accel` | σa，每步的意外加速度（m/s²） | 10–80 | 大：跟得上快动作，也留下更多抖动；小：平滑，但急停时会冲过头、变慢 |
| `noise` | σm，检测器抖动（m），再除以该点的可见度 | 0.005–0.03 | 大：更信模型（更平滑）；小：更信检测 |

## 何时用
动作在帧率尺度上大体平滑、又想要有理有据的折中（附带不确定度）时用。加上 RTS 反向一遍，它是这里最强的视频滤波。用同一套测量代码，
在加了噪声的舞蹈上（±2 cm 均匀噪声，σ 11.5 mm；与干净轨迹的 RMSE；奶蛙的 jerk）：

| 狗熊哆嗦毛 / Nae Nae / 科目三 | 实时 RMSE mm | 视频 RMSE mm | 实时 jerk | 视频 jerk |
|---|---|---|---|---|
| One Euro（内置） | 33.2 / 9.7 / 12.1 | 53.2 / 13.9 / 17.4 | 1455 / 484 / 695 | 932 / 241 / 494 |
| `kalman-cv` | 11.0 / 10.4 / 10.4 | 9.0 / 7.3 / 7.1 | 2230 / 1971 / 1926 | 1296 / 550 / 707 |

狗熊哆嗦毛快速抖动时 One Euro 落后 3–5 cm，卡尔曼仍贴着真值；但实时模式传给奶蛙的抖动更多（jerk 更高），想要更稳的摄像头就调低
`accel`。每帧 0.04–0.1 ms。匀速模型在急停时会冲过头；常见的下一步是匀加速状态或自适应 σa。

## 在代码里
`src/algorithms/motion/kalmanFilter.ts`，**filter** 槽（`Bank` 用扁平数组存 198 个滤波器）。可以先试：`predict` 里的过程噪声 `Q`
（比如手腕的 σa 比髋部大），或 `measure` 里按可见度加权的方式。

## 参考
- R. E. Kalman, *A New Approach to Linear Filtering and Prediction Problems*, J. Basic Eng. 1960. https://doi.org/10.1115/1.3662552
- H. E. Rauch, F. Tung, C. T. Striebel, *Maximum likelihood estimates of linear dynamic systems*, AIAA J. 1965. https://doi.org/10.2514/3.3166
- G. Welch, G. Bishop, *An Introduction to the Kalman Filter*, UNC TR 95-041. https://www.cs.unc.edu/~welch/media/pdf/kalman_intro.pdf
