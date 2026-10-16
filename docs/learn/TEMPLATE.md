# Learning pages: the template

Every algorithm in the lab (motion transfer and simulation) has one short page, in Chinese and English:
`docs/learn/<core>/<algorithm-id>.zh.md` and `.en.md` (`<core>` is `motion` or `sim`). The page sits next to the
code in the in-page code lab, so a reader learns the idea and then edits the real implementation. One screen to two
screens long; plain words first, the few formulas that matter, no padding.

```markdown
# <Name> (<one-line what it is>)

## 直觉 / Intuition
Two or three sentences: what problem it solves and the idea, in plain words.

## 核心公式 / The math
Only the equations the code implements (KaTeX-style $...$ is fine), each followed by one line saying what it means.

## 算法步骤 / Steps
A short numbered list or pseudocode that matches the code's structure (same names).

## 参数 / Parameters
| Parameter | Meaning | Typical range | What you see when you change it |

## 何时用 / When to use it
Strengths, weaknesses, cost; how it compares with the neighbouring algorithms in the lab.

## 在代码里 / In the code
The file(s), the block slot it plugs into, and the one or two places worth changing first for an experiment.

## 参考 / References
One to three primary sources (paper or book chapter), with a link.
```
