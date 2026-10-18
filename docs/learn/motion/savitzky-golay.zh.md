# Savitzky–Golay 滤波（局部多项式最小二乘）

## 直觉
把某一时刻前后的帧取平均能去掉抖动，但也会把快动作的峰值削平。Savitzky–Golay 在窗口内用最小二乘拟合一个小多项式（直线、抛物线、
三次曲线），取它在这一刻的值：多项式会跟着动作弯曲，峰值得以保留。视频用居中的窗口（无延迟）；摄像头只有过去的帧，就拟合到最新一帧为止。

## 核心公式
样本 $y_j$ 在时刻 $\tau_j$（相对于正在滤的帧），用最小二乘拟合 $q(\tau) = \sum_{k=0}^{n} c_k \tau^k$。Vandermonde 矩阵 $A_{jk} = \tau_j^k$：

$$c = (A^\top A)^{-1} A^\top y, \qquad \hat y = q(0) = c_0 = w^\top y, \quad w^\top = e_0^\top (A^\top A)^{-1} A^\top$$

权重 $w$ 只取决于窗口里的时刻，与数据无关：每种窗口形状算一次，用于全部 198 个坐标。次数 ≤ n 的多项式原样通过；0 次就是滑动平均。

## 算法步骤
```ts
recorded(frames, fps):
  half = round(window · fps / 2)
  对每段有人的连续帧（≤ 0.5 s 的空缺线性补齐）：
    对每帧 i：[lo, hi] = 以 i 为中心的整窗，在两端向内平移
              w = polyWeights([lo, hi] 的时刻 − tᵢ, order)   // 按形状缓存
              out[i] = Σ wⱼ · y[j]
live(frame, t):
  保留最近 liveWindow 秒的帧；w = polyWeights(它们的时刻 − t, liveOrder)；out = Σ wⱼ yⱼ
```

## 参数
| 参数 | 含义 | 常用范围 | 改变时看到什么 |
|---|---|---|---|
| `window` | 视频窗口长度（s） | 0.15–0.5 | 长：更平滑；太长会削平快动作 |
| `order` | 视频多项式次数 | 2–4 | 高：保留峰值，去噪变弱 |
| `liveWindow` | 摄像头窗口（s） | 0.1–0.25 | 长：更平滑，但窗口末端的直线跟不上弯曲 |
| `liveOrder` | 摄像头次数 | 0–1 | 2 以上会在窗口末端外推噪声，宜低 |

## 何时用
快节奏舞蹈的视频：低通滤波会把“卡点”磨圆，它不会。它是线性的，很便宜（实时每帧 0.06–0.12 ms），除了窗口没有模型要调。
在加噪声的舞蹈上（σ 11.5 mm，与卡尔曼页同一套测量）：

| 狗熊哆嗦毛 / Nae Nae / 科目三 | 实时 RMSE mm | 视频 RMSE mm | 实时 jerk | 视频 jerk |
|---|---|---|---|---|
| One Euro（内置） | 33.2 / 9.7 / 12.1 | 53.2 / 13.9 / 17.4 | 1455 / 484 / 695 | 932 / 241 / 494 |
| `savitzky-golay` | 18.2 / 9.3 / 9.6 | 11.9 / 6.4 / 6.1 | 1828 / 1202 / 1433 | 1198 / 429 / 578 |

在较平缓的舞上 RMSE 是三者中最好的；狗熊哆嗦毛抖得比 0.3 s 的三次曲线能跟上的还快，稍逊于卡尔曼/RTS。实时模式下窗口末端的拟合
跟不上弯曲、又会放进噪声：摄像头更适合 One Euro 或卡尔曼。

## 在代码里
`src/algorithms/motion/savitzkyGolay.ts`，**filter** 槽；`polyWeights` 生成权重（法方程用 Gauss–Jordan 消元）。可以先试：
不同关键点用不同窗口（手腕短、髋部长），或按可见度给拟合加权。

## 参考
- A. Savitzky, M. J. E. Golay, *Smoothing and Differentiation of Data by Simplified Least Squares Procedures*, Anal. Chem. 1964. https://doi.org/10.1021/ac60214a047
- R. W. Schafer, *What Is a Savitzky–Golay Filter?*, IEEE Signal Processing Magazine 2011. https://doi.org/10.1109/MSP.2011.941097
