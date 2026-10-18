# Savitzky–Golay filter (local polynomial least squares)

## Intuition
Averaging the frames around a moment removes jitter but also flattens the peak of a fast move. Savitzky–Golay fits a
small polynomial (a line, a parabola, a cubic) to the frames in a window by least squares and takes its value at the
moment: the polynomial bends with the move, so peaks survive. For a recording the window is centred (no lag); the camera
has only past frames, so there the fit ends at the newest frame.

## The math
For samples $y_j$ at times $\tau_j$ (relative to the frame being filtered), fit $q(\tau) = \sum_{k=0}^{n} c_k \tau^k$ by
least squares. With the Vandermonde matrix $A_{jk} = \tau_j^k$:

$$c = (A^\top A)^{-1} A^\top y, \qquad \hat y = q(0) = c_0 = w^\top y, \quad w^\top = e_0^\top (A^\top A)^{-1} A^\top$$

The weights $w$ depend only on the window's times, not on the data: one set per window shape, applied to all 198
coordinates. A polynomial of degree ≤ n passes through unchanged; degree 0 is the moving average.

## Steps
```ts
recorded(frames, fps):
  half = round(window · fps / 2)
  for each run of frames with a person (gaps ≤ 0.5 s linearly bridged):
    for each frame i: [lo, hi] = the full window around i, shifted inwards at the ends
                      w = polyWeights(times in [lo, hi] − tᵢ, order)   // cached per shape
                      out[i] = Σ wⱼ · y[j]
live(frame, t):
  keep the frames of the last liveWindow s; w = polyWeights(their times − t, liveOrder); out = Σ wⱼ yⱼ
```

## Parameters
| Parameter | Meaning | Typical range | What you see when you change it |
|---|---|---|---|
| `window` | video window length (s) | 0.15–0.5 | longer: smoother; too long flattens fast moves |
| `order` | video polynomial degree | 2–4 | higher: keeps peaks, removes less noise |
| `liveWindow` | camera window (s) | 0.1–0.25 | longer: smoother, but the end of a fitted line lags curves |
| `liveOrder` | camera degree | 0–1 | 2+ extrapolates noise at the window's end: keep it low |

## When to use it
Recorded videos of fast dances, where a low-pass would round off the hits. It is linear and cheap (0.06–0.12 ms per
live frame), with no model to tune beyond the window. Measured on noisy dances (σ 11.5 mm, same harness as the
Kalman page):

| gouxiong / naenae / kemusan | RMSE live mm | RMSE recorded mm | jerk live | jerk recorded |
|---|---|---|---|---|
| One Euro (built-in) | 33.2 / 9.7 / 12.1 | 53.2 / 13.9 / 17.4 | 1455 / 484 / 695 | 932 / 241 / 494 |
| `savitzky-golay` | 18.2 / 9.3 / 9.6 | 11.9 / 6.4 / 6.1 | 1828 / 1202 / 1433 | 1198 / 429 / 578 |

Best RMSE of the three on the calmer dances, a little behind the Kalman/RTS smoother on 狗熊哆嗦毛, whose shaking is
faster than a 0.3 s cubic can follow. Live, the end-of-window fit lags curves and passes noise: One Euro or Kalman suit
the camera better.

## In the code
`src/algorithms/motion/savitzkyGolay.ts`, a **filter** block; `polyWeights` builds the weights (normal equations solved
by Gauss–Jordan). First things to try: a different window per landmark (short for wrists, long for hips), or weighting
the fit by visibility.

## References
- A. Savitzky, M. J. E. Golay, *Smoothing and Differentiation of Data by Simplified Least Squares Procedures*, Anal. Chem. 1964. https://doi.org/10.1021/ac60214a047
- R. W. Schafer, *What Is a Savitzky–Golay Filter?*, IEEE Signal Processing Magazine 2011. https://doi.org/10.1109/MSP.2011.941097
