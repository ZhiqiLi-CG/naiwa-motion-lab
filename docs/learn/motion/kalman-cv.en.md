# Kalman filter, constant velocity (and the RTS smoother)

## Intuition
The pose detector jitters by a centimetre or so per landmark. A Kalman filter keeps, for every landmark coordinate, a
guess of its position *and velocity* with an uncertainty. Each frame it predicts where the point should be now, then
corrects the guess towards the detection by an amount set by which of the two it trusts more. For a recorded video the
Rauch–Tung–Striebel (RTS) smoother runs back over the filtered frames and lets the future correct the past: no lag.

## The math
State $x = [p, v]$, frame step $\Delta t$, $F = \begin{bmatrix}1 & \Delta t\\ 0 & 1\end{bmatrix}$, measurement $H = [1\ 0]$.

- Predict: $x^- = F x$, $P^- = F P F^\top + Q$, with $Q = \sigma_a^2 \begin{bmatrix}\Delta t^4/4 & \Delta t^3/2\\ \Delta t^3/2 & \Delta t^2\end{bmatrix}$ (an unknown acceleration of size $\sigma_a$ per step).
- Correct: $K = P^-H^\top / (HP^-H^\top + r)$, $x = x^- + K(z - Hx^-)$, $P = (I - KH)P^-$, with $r = \sigma_m^2 / \text{visibility}$.
- RTS, backwards: $C_k = P_k F^\top (P^-_{k+1})^{-1}$, $\hat x_k = x_k + C_k(\hat x_{k+1} - x^-_{k+1})$.

Only the ratio $\sigma_a/\sigma_m$ sets the steady-state gain: (30 m/s², 15 mm) and (20 m/s², 10 mm) filter alike.

## Steps
```ts
live(frame, t):                       // the camera
  if first frame or gap > 0.5 s: init(z)            // velocity unknown
  else: predict(t - last, accel); measure(frame, z, noise)
recorded(frames, fps):                // an uploaded video, per run of frames with a person
  forwards:  predict; measure if the person is there (a gap is bridged by prediction); keep x⁻, P⁻, x, P
  backwards: x̂ₖ = xₖ + Cₖ (x̂ₖ₊₁ − x⁻ₖ₊₁)
```
Each of the 198 coordinates (33 landmarks × world xyz + image xyz) is its own 2-state filter; image coordinates scale σ by
0.4 (picture fractions per metre).

## Parameters
| Parameter | Meaning | Typical range | What you see when you change it |
|---|---|---|---|
| `accel` | σa, unexpected acceleration per step (m/s²) | 10–80 | higher: follows fast moves, keeps more jitter; lower: smooth but overshoots and lags on sudden moves |
| `noise` | σm, detector jitter (m), divided by the landmark's visibility | 0.005–0.03 | higher: trusts the model more (smoother); lower: trusts the detector |

## When to use it
When the motion is roughly smooth at the frame rate and you want a principled trade-off with an uncertainty to go with it.
The RTS pass makes it the strongest recorded-video filter here. Measured with the same harness on noisy versions of the
dances (±2 cm uniform noise, σ 11.5 mm; RMSE against the clean track; frog jerk):

| gouxiong / naenae / kemusan | RMSE live mm | RMSE recorded mm | jerk live | jerk recorded |
|---|---|---|---|---|
| One Euro (built-in) | 33.2 / 9.7 / 12.1 | 53.2 / 13.9 / 17.4 | 1455 / 484 / 695 | 932 / 241 / 494 |
| `kalman-cv` | 11.0 / 10.4 / 10.4 | 9.0 / 7.3 / 7.1 | 2230 / 1971 / 1926 | 1296 / 550 / 707 |

It stays near the truth on the fast shaking of 狗熊哆嗦毛 where One Euro lags by 3–5 cm, but live it passes more jitter
to the frog (higher jerk); lower `accel` for a calmer camera. 0.04–0.1 ms per frame. A constant-velocity model
overshoots at sharp stops; a constant-acceleration state or an adaptive σa are the usual next steps.

## In the code
`src/algorithms/motion/kalmanFilter.ts`, a **filter** block (`Bank` holds the 198 filters as flat arrays). First things
to try: the process noise `Q` in `predict` (e.g. a larger σa for the wrists than the hips), or the visibility weighting in
`measure`.

## References
- R. E. Kalman, *A New Approach to Linear Filtering and Prediction Problems*, J. Basic Eng. 1960. https://doi.org/10.1115/1.3662552
- H. E. Rauch, F. Tung, C. T. Striebel, *Maximum likelihood estimates of linear dynamic systems*, AIAA J. 1965. https://doi.org/10.2514/3.3166
- G. Welch, G. Bishop, *An Introduction to the Kalman Filter*, UNC TR 95-041. https://www.cs.unc.edu/~welch/media/pdf/kalman_intro.pdf
