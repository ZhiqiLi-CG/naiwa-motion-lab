# 脚踩实（让着地的脚不打滑）

## 直觉
默认的 retarget 把人的朝向直接拷贝到奶蛙的根节点。舞者原地扭身（狗熊哆嗦毛左右转 ±0.68 rad）时，奶蛙踩在地上的脚就跟着在地上“拧”，
滑动速度约 1.2 m/s。脚踩实先判断哪只脚踩在地上，把它钉在落地的位置，再摆放整体位置让脚留在那里；脚做不到的转动交给上半身扭转。

## 核心公式
一只脚离较低那只脚不到 `contactHeight`、且没有在跳，就算着地。根节点绕 +Y 转 ψ、在地面上平移 o 时，脚（奶蛙坐标 p）在
$R(\psi)\,p + o$。

- 双脚着地，锚点 $A_L, A_R$：朝向由两脚连线决定，$\psi = \angle(A_R - A_L) - \angle(p_R - p_L)$；平移取最小二乘
  $o = \tfrac12 \sum_s (A_s - R(\psi)p_s)$。
- 单脚着地：$o = A_s - R(\psi)p_s$ 精确成立，于是任何转动都是绕这只脚转。
- 目标朝向剩下的部分由上半身承担：扭转 $\tau = \mathrm{clamp}(\psi_{goal} - \psi, \pm\tau_{max})$，作用在脊柱及以上，绕脊柱关节。

## 算法步骤
```ts
const stance = SIDES.filter((s) => frog.lift < 0.005 && feet[s].y - lowest < contact);
if (planted.length === 2) yaw = heading(B - A) - heading(pR - pL);        // 两只脚决定朝向
else yaw = this.yaw + (free - this.yaw) * smoothstep(swingHeight / releaseHeight); // 另一只脚真抬起来才转身
yaw = home(yaw, frog.yaw, dt, homing / halfStance);                        // 慢慢回到目标朝向
this.twist = clamp(frog.yaw - yaw, ±twistLimit);                           // 剩下的扭给上半身
offset = 着地脚上 anchor[s] - R(yaw)·foot[s] 的平均;                        // 让脚留在原地
offset → 目标位置：弹簧，有脚着地时最快 homing m/s，跳在空中时不限
着地的脚 anchor[s] = R(yaw)·foot[s] + offset，抬起的脚清空
```

## 参数
| 参数 | 含义 | 常用范围 | 改变时看到什么 |
|---|---|---|---|
| `contactHeight` | 离较低那只脚这么近就算着地（m） | 0.01–0.03 | 小：脚更早“松开”；大：抬起的脚也被当成踩着 |
| `twistLimit` | 上半身相对腿最多扭多少（rad） | 0.6–1.0 | 小：大转身时脚又会滑；大：奶蛙扭成麻花 |
| `releaseHeight` | 另一只脚抬到多高才允许绕站立脚转身（m） | 0.03–0.08 | 小：蹭地也算迈步，奶蛙会走远；大：要大步才转身 |
| `blend` | 抬脚后扭转还给整体的时间常数（s） | 0.1–0.4 | 小：迈步转身更利落；大：更柔和 |
| `homing` | 有脚着地时回位的最大速度（m/s），即允许的最大脚滑 | 0.02–0.1 | 0：脚绝不滑，但转身迈步会走远；大：不离家，滑得多 |

## 何时用
在地上跳的舞都该用。它不改四肢（保真度、穿透不变），只改整只奶蛙站在哪儿。naiwa.glb 上实测（60 fps，狗熊哆嗦毛 / Nae Nae /
科目三，测量代码 `src/algorithms/motion/bench.ts`）：

| | 脚滑 cm/s | 保真度 ° | jerk m/s³ |
|---|---|---|---|
| 内置输出（`planted-rotations`） | 117.3 / 11.9 / 7.2 | 16.3 / 16.3 / 17.3 | 5131 / 383 / 1254 |
| `foot-plant` | 9.1 / 5.7 / 4.7 | 16.3 / 16.3 / 17.3 | 5294 / 408 / 1267 |

每帧约 0.02 ms。局限：它移动的是整只奶蛙而不是腿。两只着地的脚在奶蛙自身坐标里相互靠近或分开时，最小二乘只能折中（少量滑动）；
有脚着地时，目标要求的侧步速度被限制在 `homing`。下一步是用腿部 IK 把摆动脚放到该落的地方（本库的 IK 求解器可以用上）。
会跳的舞在空中迈步转身，奶蛙在空中被拉回原位，这时不产生脚滑。

## 在代码里
`src/algorithms/motion/footPlant.ts`，**output** 槽，包着内置的 `planted-rotations`。它就地修改 FrogPose（朝向、平移、上半身扭转），
所以指标看到的就是画面上的。最值得先改的：单脚分支里的转身规则（`releaseHeight`），或者把双脚的最小二乘换成腿部 IK。
核心目前还不给 output 块传 `dt`，在那之前按 1/60 s 计算。

## 参考
- L. Kovar, J. Schreiner, M. Gleicher, *Footskate cleanup for motion capture editing*, SCA 2002. https://doi.org/10.1145/545261.545277
