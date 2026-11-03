# 桌面端 ↔ 手机端状态对照（唯一口径）

手机端不是桌面的小屏复刻，**状态必须一致**：桌面能看到的每一种「这条会话现在是什么情况」，
手机上都要有对应的表达；表达可以换形态（条、卡、徽标），但不许缺、不许错、不许长时间停在
一个假状态上（以前是「只要模型没停就一律显示回复中」）。

改代码前先看这张表：任何新增的会话状态，都要在这里补一行「手机怎么显示 + 哪个接口 + 怎么验收」，
否则不许上手机。

| # | 桌面端状态 | 数据来源（宿主） | 手机怎么显示 | 验收 |
|---|---|---|---|---|
| 1 | 空闲 | `turns` 为空 + `/api/state` | 输入框可发，头上无计时 | 发一句立即出现「回复中」 |
| 2 | 正在回（流式） | `turns[sid].busy` + `/api/poll` 帧 | 「回复中」占位 → 真文本逐步替换 | 占位不残留、不重复 |
| 3 | 思考/工具过程 | 转录里的 reasoning / bash / tool 条目 | **不显示**（折叠掉） | 页面上无「执行了命令」 |
| 4 | 待输入队列（下一轮/插话） | 投影 `inbox` 行 / `agent.inbox` | 输入框上方一行队列条，可撤回 | 桌面插的话在手机上能看到并撤 |
| 5 | 目标（运行中/暂停/完成） | 投影 `goal` 行 | 目标条：正文、图标、暂停/继续/完成/改/删 | 手机改完桌面同步变 |
| 6 | **待确认提问**（前台等答案） | 投影 `userQuestions.active[state=open]` | 卡片显示题干与选项，**不给**提交按钮，一行「这个话题在电脑上回答」 | 不再显示成「回复中」 |
| 7 | **待确认提问**（已踢回模型等回答） | `userQuestions.active[state=continued]` | 同一张卡片，选项可点即答，答完卡片消失 | 答完下一轮带上这条回答 |
| 8 | 权限审批（ask 策略） | 宿主 `dsh-user-approval` | 暂缺：卡片只显示「电脑上正在等你批准」，不给假按钮 | 明确是等批准，不是回复中 |
| 9 | 上下文压力 | 投影 `contextPressure`（`/api/state` → `context.percent`） | 输入框上方一行 `上下文已用 N%`，≥85% 换成强调色；宿主没给就不显示 | 桩改 percent，屏上跟着变 |
| 10 | 会话正在被别的端占用 | `turns` 里 `origin` | 队列条写「电脑上还在跑，这句排上了」 | 排队提示与真实落点一致 |

## 接口

- `GET /api/state`：会话列表、当前会话、目标、每会话 `turns`
- `GET /api/poll?sessionId=&cursor=`：流式帧（含工具/思考，只是不渲染）
- `GET /api/session?id=`：一页历史 + `goal` + `inbox` + `asks`
- `GET /api/asks?sessionId=` / `POST /api/answer`：第 6、7 行
- `GET /api/inbox` / `POST /api/inbox`：第 4 行
- `POST /api/goal`：第 5 行
- `POST /api/dispatch`：发话、排队、插话（`queued`/`steered` 决定第 10 行的文案）

## 已知没有的手机入口

- 第 8 行（权限审批）：宿主只给「客户端 UI 的按钮」这条路，插件目前没有稳定答口。
  写进表里当缺口，不拿「回复中」糊过去。
- 计划审批（`intent.kind = plan-review`）走第 7 行同一条路，只是「通过」项按 `approve` 排前面。

## 桌宠单实例与输入来源（2026-11-03 05:26）

- 桌宠只有一个进程、一个悬浮窗：`dumpsys window windows` 里 `com.pocketharness.app` 的无 Activity
  窗口恒为 1，`ps -A` 里也只有 1 个进程。旧 applicationId `com.whale.pet` 已卸载，
  不会再出现「两只宠物抢同一个气泡」。
- 悬浮窗要先给「显示在其他应用上层」：没给时点「叫出大肥鱼」会跳系统权限页，给了才真的浮出来。
- 重复点「叫出大肥鱼」不会多出第二个：2026-11-03 06:44–06:48 在真机上连点两次，
  每次 `Window{…com.pocketharness.app}` 计数都是 1、`ps -A` 里 `pocketharness` 也是 1，
  `FloatingPetService` 只有一份。验证时临时把 `bubble` 打开，验完已改回 `false`。
- 输入来源只有两条，都要人主动：聊天框里的输入/粘贴，和配对页的「粘贴配对链接」。
  后者只认 `PetConfig.parsePairPayload`（链接或配对串），不把任意剪贴板文本当消息发。
  之前记录里看到的 `Symate/temp/…` 是手动粘进去的调试文本，不是自动注入。

## 验收记录

只在真机上看到对应状态才算过。场景都用 `192.168.51.19:18765` 的桩（stub）切换，
设备 `15ca9736`，装的是 `com.pocketharness.app` 0.9.149（versionCode 219）。

### 第 10 行 · 排队落点（2026-11-03 02:21）

- 场景：桩 `busy`，`GET /api/state` → `turns.stub-session.busy=true`、`origin=desktop`
- 操作：输入 `queued probe 11` → 发送
- 回包：`POST /api/dispatch` 200，体里 `{ok:true, queued:true, sessionId:"stub-session"}`
- 机上看到：运行条 `#chatRunText` = `电脑上还在跑，这句排上了`；`#chatTyping` 不在；
  没有「没收到回复，重试」那一行
- 应用日志：`files/net.log` 里 `02:21:21 POST /api/dispatch http=200`，
  紧接着 `queued=true，按排队收尾`、`finishTurn queuedNote=true hostQueued=true err=null`
- 截图：`docs/evidence/item10-runbar.png`

这条以前是假状态：回包的 `queued` 只被轮询帧用，`PetTurn` 从 dispatch 回包读不到，
`finishTurn` 又把这一轮当「没出字」，于是运行条退回「深度求索中 · 用时 …」。
现在 `PetTurn` 把回包里的 `queued` 记成 `hostQueued`，`finishTurn` 直接按排队收尾。

### 第 2 行 · 流式占位到真文本（2026-11-03 04:04）

- 场景：桩 `stream`，`/api/poll` 依次给 `start` → 4 个 `delta` → `final` → `end` 共 7 帧，
  帧之间夹空帧（配合 `IDLE_POLL_FLOOR_MS=400`，一整轮约 6–8 秒，中间态能看清）
- 操作：输入 `流式探针 seed24` → 发送；发送后 1.7 秒截屏
- 机上看到：
  - 中间态：运行条 `正在想`，助手气泡只有占位、没有正文；右下角发送键变成停止键
  - 收尾：只剩 **一条** 助手气泡 `先看一眼第 6 轮真机状态：回复中先占位，再逐段换成真文本。`，
    「回复中 / 正在想」不残留，没有第二条重复气泡
- 截图：`docs/evidence/item2-streaming-placeholder.jpg`（占位）、`item2-streaming-live.jpg`（逐段）

以前这里的问题是：帧来得太快，占位和终稿几乎同一帧落屏，等于「假流式」；
桩按真实节奏放帧后，占位 → 逐段 → 终稿三段都能在屏幕上看到，且不重复、不残留。

### 第 4 行 · 队列条撤回 / 上移 / 下移（2026-11-03 04:10–04:14）

- 场景：桩 `queue`，`inbox` 三条（`q1` 第一条 / `q2` 第二条 / `q3` 第三条）
- 机上看到：输入框上方一行队列条，三行都是 `待输入 · <正文>`，每行尾巴带 `直接发送`、`撤掉`
- 长按第二行 → 弹出 `上移 / 下移 / 撤掉`
- 点 `上移`：桩记 `inbox action=up id=q2`，屏上顺序变成 二 / 一 / 三
  （截图 `docs/evidence/item4-queue-menu.jpg`、`item4-queue-reordered.jpg`）
- 点 `下移`：桩记 `inbox action=down id=q1`，顺序变成 二 / 三 / 一
- 撤回：此前同一条队列条上点 `撤掉`，55ms 内行消失，桩记 `inbox action=remove`
  （截图 `docs/evidence/item4-after-withdraw.jpg`）

以前这条卡在「点了没反应」：空帧轮询是热循环，`adb_tap` 的落点还没生效界面就被重绘。
`IDLE_POLL_FLOOR_MS` 把空帧压到 400ms 后，点击、长按、拖动都能落在真实控件上。

### 第 5 行 · 目标暂停 / 继续（2026-11-03 04:17–04:19）

- 场景：桩 `goal`，目标正文 `把手机 App 与桌面端的状态逐项对齐`，第 4/40 轮
- 机上看到：`#goalState=目标进行中`、`#goalText=…对齐`、`#goalAction=第 4/40 轮 · 暂停`，
  右侧 `改目标`、`删目标`
- 点 `暂停`：桩记 `goal action=pause -> paused`，屏上变 `目标已暂停` + `继续`
  （截图 `docs/evidence/item5-goal-paused.jpg`）
- 点 `继续`：桩记 `goal action=resume -> active`，屏上回到 `目标进行中` + `第 4/40 轮 · 暂停`
  （截图 `docs/evidence/item5-goal-resumed.jpg`）

三态都在真机上走了一遍，且状态行文字与宿主 `goal.status` 一一对应，不是本地猜的。

### 第 6 行 · 前台提问只读（2026-11-03 04:31）

- 场景：桩 `ask_open`，`userQuestions.active[0].state=open`
- 机上看到一张卡片：`要你定一下` / `这次要不要顺带把旧包名卸掉？` /
  `这个话题在电脑上回答` / 两个选项 `卸掉`、`留着`
- 可点性：5 个文本控件全部没有点击标记（`adb_find` 里无 `*`），选项置灰、不可聚焦；
  卡片上没有提交按钮，也没有任何按钮能把答案发回去
- 回包：`GET /api/asks http=200`
- 截图：`docs/evidence/item6-ask-open.jpg`

这条的要害是「别给假按钮」：宿主还没把问题踢回模型时，手机上只能看，不能答。

### 第 7 行 · 已踢回提问可答（2026-11-03 04:22–04:29）

- 场景：桩 `ask_continued`，`state=continued`
- 机上看到：`已经答过一轮` / `发版前还要不要再跑一遍真机？` / 选项 `再跑一遍`、`直接发`，
  两个选项都带点击标记（`adb_find` 有 `*`）
- 点 `再跑一遍`：桩立刻收到 `POST /pet-voice/api/answer`，卡片 166ms 内从屏上消失
  （截图 `docs/evidence/item7-ask-continued.jpg` 答前、`item7-ask-answered.jpg` 答后）
- 答完桩重启（`__answered` 复位）后，卡片按 `GET /api/asks` 重新出现，说明显隐完全跟宿主状态走

### 第 8 行 · 权限审批只读卡（2026-11-03 03:42）

- 场景：宿主 `dsh-user-approval` 抛出的审批请求（桩里以 ask 卡片形态给）
- 机上看到：`需要批准` / `执行 rm -rf build 被策略拦下了` / `电脑上正在等你批准` /
  `批准一次`（置灰、不可点）
- 没有 `拒绝` 按钮，也没有 `这个话题在电脑上回答` 那一行：审批不是「回答问题」，
  手机上只能看到「在等批准」，不能凭空代按
- 截图：`docs/evidence/item8-approval.jpg`

这一行仍然是缺口（宿主没给稳定的客户端答口），但**不再用「回复中」糊过去**：
界面说得很清楚是等批准。

### 第 1 行 · 空闲 / 刚发出（2026-11-03 05:00）

- 场景：桩 `idle`，宿主没有在跑的轮次（`turns` 为空）
- 机上看到：标题行没有「用时」，没有运行条，输入框可写，发送键是纸飞机
- 发一句 `流式探针 seed24`（假流式，帧之间有间隔）之后 1 秒内：
  - 助手侧出现 `···` 占位气泡
  - 输入框上方状态行 `思考中 · 用时 0s`
  - 发送键变成停止键（可中断）
- 截图：`docs/evidence/item1-busy-status.jpg`（发出去的状态）、`item2-streaming-placeholder.jpg`（占位）

空闲态的判据是「没有计时、没有运行条、能发」，不是「一定停在某一帧画面」：
本轮验证里，一条消息发出去 600ms 内状态行就位，说明它确实在跟着真实轮次走，而不是常驻一个假状态。

### 第 3 行 · 思考 / 工具过程不进转录（2026-11-03 04:41）

- 场景：桩 `tools`，`/api/poll` 依次给 `start` → `reasoning{执行了命令 rm -rf build…}` →
  `delta` → `tool{name:bash}` → `final` → `end`
- 机上看到：
  - `reasoning` 那段话**一个字节都没上屏**（页面上搜不到「执行了命令」）
  - `tool` 只在状态行短暂路过（`调用工具：bash`），不进消息列表
  - 最后只落一条助手气泡 `工具那一段不该进转录，状态行只是路过。`
- 截图：`docs/evidence/item3-tool-status.jpg`

代码侧对应 `PetTurn.handleEvent` 的 `when`：没有 `reasoning` 分支（未知事件直接丢），
`tool` 只走 `onStatus`，没有任何一条路径把这两类帧追加成转录条目。

### 桩侧顺手修的两处噪声（不影响状态口径）

- `POST /api/render` 在桩里 404，客户端每渲染一条气泡就重试一次，`net.log` 十分钟里刷了 700 多条。
  桩补了 `render:` 处理（转义后包 `<p>`），日志恢复安静。
- 流式帧文本里带 `|` 会被 Markdown 渲染吃掉，改成无竖线的模板，截图里才读得出完整句子。

### 第 9 行 · 上下文压力（2026-11-03 06:20–06:30）

- 数据来源：插件读宿主投影缓存里的 `contextPressure` 行（和桌面端顶栏同一个数），
  `/api/state` 里给 `context: { percent, used, window }`；拿不到就是 `null`。
- 场景：桩 `idle` + `context.percent=45` → 机上 `#chatPressure` = `上下文已用 45%`
- 场景：桩改 `percent=92` → 一行内变成 `上下文已用 92%`，颜色切到强调色（`pet_accent`）
- 场景：桩去掉 `context` → 这一行整行消失，不留空壳、不留旧数字
- 截图：`docs/evidence/item9-context-pressure.png`（45%）

手机端只显示百分比，不做桌面端那个「点开看明细」的面板：明细里是系统/工具/消息三段
token 拆分，手机上点不出第二层，展示了也没法用。

这一行以前在表里写「暂缺」，是因为插件没把宿主的投影带出来；现在补在 `/api/state` 上，
App 只是一个显示面，数字完全跟着宿主走，不在本地估算。

### 观感项的核查结论（不是缺陷）

- **历史列表顶部那行空白**：`#itemRow` 里只有一条 `流式探针 seed22` 的旧测试气泡，
  `adb_ui within_rect` 看这块区域只有 2 个节点（行容器 + 气泡文本），没有独立空行。
  屏上剩下的 `seed22–seed29` 是之前几轮验收自己发进去的测试数据，不是运行时重复插入。
- **桌宠气泡会不会重放上一句**：`FloatingPetService` 里没有把气泡文本落盘再重发的路径；
  `sayCursor` 恢复的是「听到哪了」，目的正是不重念已经念过的句子。
  `hintOnce("配对失效了 · 打开鲸灵重新扫码")` 是配对上失效时的一次性提示，不是陈旧气泡。
- **`pet_history.xml`**：只有 `PetHistory.kt` 引用的本地转录缓存，没有布局、没有页面入口，
  不参与上屏，不需要清理。

### 会话列表与图片落点（2026-11-03 13:17，0.9.149 / 219）

- 会话列表走 `GET /api/sessions?projectId=ef76a38a-8d4f-40e0-8e7c-f05734c1178a&limit=100`：
  真机上返回 46 条、`hasMore:false`。手机选择器连滑 8 次到底，最后一行是 `在的`（meta `10-24 16:05`），
  往上依次 `鲸灵在线` ×3、`AI助手自我介绍`… 与接口返回的最旧几条一一对上，没有截断。
  截图：`docs/evidence/item11-picker-46-rows.jpg`
- 不带 `projectId` 的全局 `/api/sessions` 只有 50 条窗口，Pet 的行会落在窗口外——
  这正是以前「Pet 下只看到 pet voice」的成因，App 现在必须带 `projectId` 取。
- 图片落点：在 `Pet voice`（`1ca8e13b-5b29-4020-9caa-2c580cb5cb6f`）里从相册选一张照片直接发送，
  宿主 `turn.log` 记的是 `dispatch status=200 … chars=0 want=1ca8e13b used=1ca8e13b`，
  宿主会话转录里出现 `IMG_20261030_162054`，`/api/sessions` 仍是 46 条、没有新建空白会话。
  截图：`docs/evidence/item12-image-stays-in-session.jpg`
