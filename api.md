# 分屏服务（dsh-split-view）

dsh-split-view 把全部的分屏能力暴露成一个名为 `dsh-split-view` 的 Cordis 服务。通过它，其他插件可以增删和操作面板、管理面板里展示的会话，并观察布局变化。本文是这个服务的完整契约。

## 获取服务

### 必需依赖

在 `inject` 里声明，框架保证 `apply` 执行时服务已就绪：

```js
export const inject = ['dsh-split-view']

export function apply(ctx) {
  const sv = ctx['dsh-split-view']
  const panes = sv.panes()
}
```

服务不存在时（用户没有安装 dsh-split-view），你的插件不会加载。注意：框架层没有安装插件的 API（插件清单服务是只读投影），但运行时安装已有现成途径——插件市场（dshmarket）会把新装的插件热挂载进运行中的实例，不需要重启 dsh web，页面刷新一次即可；`dsh plugin --profile web add` 的 CLI 途径则仍需重启生效。依赖方插件依然不能自动安装本插件：安装涉及 pnpm、bundle 层同步与热挂载/重启回退，是市场的职责。所以除非你能接受「缺席即不加载」，请用下一节的可选依赖模式。

### 可选依赖

省略 `inject`，在使用处用 `ctx.get()` 查询：

```js
export function apply(ctx) {
  const sv = ctx.get('dsh-split-view')
  if (!sv) return // 分屏插件未安装，走单会话逻辑
  // ...
}
```

推荐可选依赖：分屏是增强能力，你的插件应当在它缺席时仍然可用。

### 顶层窗口约束

服务只由**顶层窗口** provide。每个面板是一个独立的 cordis 树（独立的完整 DSH 客户端），跑在面板里的插件拿不到这个服务。如果你的插件在顶层和面板都会加载，先分流：

```js
const isPane = new URLSearchParams(location.search).has('dshPane')
```

## 约定

- **面板寻址处处可省**：所有方法的目标面板都可以省略，省略时操作聚焦面板。显式传入不存在的 `paneId` 会抛错（查询类方法例外，返回 `null`）。
- **带载荷的动词**（`open` / `newSession` / `send` / `rename` / `configure`）通过 `options.pane` 指定目标面板；**只作用于面板的动词**（`close` / `focus` / `maximize` / `wake` / `reload` / `cancel`）按位置传 `paneId`。
- **变更器都是 async，查询都是同步快照**。查询方法反映调用瞬间的状态，不做缓存。
- **错误统一抛 `Error("dsh-split-view: …")`**，消息可直接展示给用户。常见错误见[错误处理](#错误处理)。
- **能力探测**：服务对象带 `version` 字段（当前为 `2`）。老版本只有 `split`，按成员存在性探测即可：

```js
if (typeof sv.open === 'function') {
  // 新 API 可用
}
```

## 面板描述符

查询方法返回的面板描述符形状如下：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | `string` | 面板 id，即布局树的叶子 id，所有方法的寻址键 |
| `session` | `string \| null` | 面板当前展示的会话；来自面板自己的上报，面板未就绪时为 `null` |
| `title` | `string \| null` | 会话标题（面板上报的 displayTitle） |
| `focused` | `boolean` | 是否为聚焦面板 |
| `maximized` | `boolean` | 是否为最大化面板 |
| `ready` | `boolean` | 面板客户端是否已就绪并上报 |
| `dormant` | `boolean` | 是否休眠（LRU 预算外，无 iframe，唤醒后恢复） |

## 查询

```js
const sv = ctx.get('dsh-split-view')

sv.panes()        // 面板描述符数组，布局树序
sv.pane(paneId?)  // 单个描述符，找不到返回 null（省略 paneId 时取聚焦面板）
sv.focused()      // 聚焦面板的 id，没有则 null
sv.layout()       // { tree, focused, maximized } 深拷贝
```

`layout()` 返回的 `tree` 就是 `applyLayout()` 接受的形状，可以先取出来改再写回。

## 面板生命周期

### 拆分面板

`split()` 一次调用开一个新面板，面板落在一个全新的会话上，会话按传入的参数搭好。所有参数可省，省略时等同于快捷键分屏。

```js
const { paneId, sessionId } = await sv.split({
  pane: 'pXXXX',          // 从哪个面板拆，默认聚焦面板
  direction: 'right',     // 'right'（默认）向右，'down' 向下
  prompt: '帮我跑一遍测试', // 会话的第一条消息
  title: '回归测试',       // 会话标题
  model: 'deepseek/deepseek-v4',
  workspaceId: 'ws-123',
  cwd: '/path/to/project',
  mode: 'cordis',         // agent preset id
  session: 'session-…',   // 钉一个已有会话进新面板（跳过创建/配置）
})
```

参数说明：

| 参数 | 类型 | 说明 |
|---|---|---|
| `pane` | `string` | 锚点面板，默认聚焦面板 |
| `direction` | `'right' \| 'down'` | 新面板出现在锚点的右侧 / 下方，默认 `'right'` |
| `prompt` | `string` | 会话的第一条消息，创建后作为第一回合发出 |
| `title` | `string` | 会话标题，创建后重命名 |
| `model` | `string \| { provider, model, reasoningEffort? }` | 模型，字符串用 `provider/model` 简写 |
| `workspaceId` | `string` | 工作区，与 `cwd` 二选一 |
| `cwd` | `string` | 工作目录，与 `workspaceId` 二选一 |
| `mode` | `string` | agent preset id |
| `session` | `string` | 已有会话 id：新面板直接钉到它，跳过创建和配置 |

搭会话的顺序是固定的：先按 `workspaceId` 或 `cwd` 建会话（都没有就在默认工作目录建），再选模式、选模型、改标题，最后把 `prompt` 作为第一条消息发出。没传的参数跳过对应步骤。

返回 `{ paneId, leafId, sessionId }`：`paneId` 是新面板的 id，`sessionId` 是搭好的会话（未做创建/配置时为 `null`，面板会自建空白会话）。`leafId` 是 `paneId` 的旧名别名，保留给既有调用方。

### 关闭与焦点

```js
await sv.close(paneId?)           // 关闭面板，相邻面板继承其空间和焦点
await sv.focus(paneId?)           // 聚焦：布局焦点与浏览器焦点一起转移
await sv.maximize(paneId?, on?)   // on 为 true/false 时显式设置，省略时在聚焦面板上 toggle
await sv.restore()                // 退出最大化
```

关闭最后一个面板不会清空布局：独苗面板被替换成一个新的空白面板。

### 唤醒与重载

```js
await sv.wake(paneId?)    // 唤醒休眠面板，重新进入活面板预算
await sv.reload(paneId?)  // 活面板原地重载其客户端；休眠面板等价于 wake
```

### 替换布局树

`applyLayout(tree)` 是逃生舱：整树校验替换，移动面板、调整比例、任意重排都走它。

```js
const lay = sv.layout()
lay.tree.children.reverse()   // 左右交换两个面板
await sv.applyLayout(lay.tree)
```

树只有两种节点：

- **叶子**：`{ kind: 'leaf', id?, session?, origin? }`
- **分支**：`{ kind: 'branch', id?, dir: 'h' | 'v', children: 节点[], fractions?: number[] }`

校验规则：分支至少两个孩子；`fractions` 缺失或不合法时均分；`dir` 的 `right/down/left/up/v` 等写法统一折叠为 `h/v`；id 缺失或冲突时重新生成。**复用原有叶子 id 的面板不会重载**（iframe 存活，面板内的对话状态保留）；新 id 启动新面板。

## 面板 × 会话

这一组动词回答「哪个面板展示哪个会话」以及「对那个会话做什么」。

### 加载已有会话

```js
await sv.open('session-…', { pane: paneId })
```

活面板**热切换**：顶层通过 postMessage 通知面板自己执行 `sessions.open`，不重载 iframe，面板内的客户端状态保留。休眠面板更新启动种子，下次唤醒时生效。会话不在列表里会抛错（列表基线未就绪时跳过校验，由面板侧兜底）。

### 新建会话

```js
await sv.newSession({
  pane: paneId,        // 省略时在聚焦面板中新建
  cwd: '/path',        // 会话参数同 split()：workspaceId / cwd / title / model / mode / prompt
  title: '…',
  prompt: '…',
})
```

创建并配置好会话后，把它加载进目标面板（机制同 `open`），替换面板原来的会话。

### 发送消息

```js
await sv.send('继续', { pane: paneId })
await sv.send('停一下，换个方向', { pane: paneId, mode: 'steer' })
await sv.send([{ type: 'text', text: '…' }], { pane: paneId })
```

`content` 接受字符串或 prompt 内容块数组。`mode` 省略为 `'queue'`（追加一个回合）；`'steer'` 打断进行中的回合。

实现上，会话是后端的，面板只是它的显示器：顶层窗口用自己的客户端绑定该会话执行 `prompt`，面板经后端事件流看到这一回合——休眠面板同样适用，无需唤醒。

### 重命名与切换模型

```js
await sv.rename('新标题', { pane: paneId })
await sv.configure({ model: 'deepseek/deepseek-v4', mode: 'cordis' }, { pane: paneId })
```

`rename` 对空白会话（标题为工作区名的占位会话）抛错，与标题栏编辑器的行为一致。`configure` 的 `model` / `mode` 至少给一个，语义同 `split()` 的同名参数。

### 取消回合

```js
await sv.cancel(paneId?)
```

取消面板展示的会话正在进行的回合；已排队的消息保留，按原顺序继续。

### 一个时序边界

面板的 `session` 字段来自面板自己的上报。刚 `split()` 出来的面板还没上报时，对它调这组动词会抛错。要随拆分带第一条消息，直接用 `split({ prompt })`——会话在顶层搭好再交给面板，没有时序窗口。

## 观察变化

```js
const off = sv.subscribe((state) => {
  // state: { panes, focused, maximized }，panes 同 sv.panes()
})
off() // 取消订阅
```

布局结构、焦点、面板会话、标题、就绪与休眠状态任一变化都会触发；相同状态合并，监听器拿到的总是与上次不同的快照。监听器抛出的异常不会影响其他订阅者。

## 错误处理

所有变更器失败时抛 `Error`，消息以 `dsh-split-view: ` 前缀开头。常见的几种：

| 消息 | 原因 |
|---|---|
| `no such pane: X` | paneId 不存在（已关闭，或传了分支节点 / 布局树的 id） |
| `unknown session: X` | `open` 的会话不在会话列表里 |
| `the pane has no session yet (…)` | 面板还没上报会话，见[时序边界](#一个时序边界) |
| `cannot bind session X` | 顶层客户端无法绑定该会话（通常已不在列表） |
| `preset select failed: …` / `model select failed: …` | 后端拒绝了 preset / 模型切换，冒号后是后端给出的原因 |
| `prompt failed: …` / `cancel failed: …` | 后端拒绝的业务错误，同样冒号后是原因 |

## 完整示例

一个「并行跑任务」插件的骨架：开两个面板、各发一条消息、盯着它们跑完：

```js
export const inject = ['dsh-split-view']

export function apply(ctx) {
  const sv = ctx['dsh-split-view']

  const off = sv.subscribe(({ panes }) => {
    const running = panes.filter((p) => p.session && !p.dormant)
    // 按你的业务消费面板状态…
  })

  ctx.effect(() => off) // 卸载时取消订阅

  // 用法示例（真实场景里由你的业务触发）：
  // const a = await sv.split({ title: '前端', cwd: '/repo/web' })
  // const b = await sv.split({ title: '后端', cwd: '/repo/api', direction: 'down' })
  // await sv.send('跑一遍单测', { pane: a.paneId })
  // await sv.send('跑一遍集成测试', { pane: b.paneId })
}
```

## 开发调试

给 localStorage 设 `dsh-split:debug` 后，服务会镜像到 `window.__dshSplitView`，可以在 devtools 控制台直接敲 API。默认关闭；插件间集成请走 `inject` / `ctx.get`。

## URL 契约（给做原生壳的人）

原生壳不走分屏容器、直接开独立窗口/标签加载单个面板时，用这组查询参数：

- `/?dshPane=<id>` 进入 pane 模式，不套分屏
- `/?dshPane=<id>&dshSession=<sessionId>` 启动即钉到该会话
- `/?dshPane=<id>&dshWorkspace=<workspaceId>` 新建并钉到该工作区的会话，空白会话复用
- `/?dshPane=<id>&dshCwd=<path>` 按工作目录新建会话
- `/?dshPane=<id>&dshNew=1>` 启动进入无会话空态

跨 origin 面板和顶层之间只走 postMessage，referrer 推导 targetOrigin，加 origin 白名单校验，不读 contentDocument，所以 origin 轮换对面板行为是透明的。

## 已知限制

- 顶层窗口不再是 AppFrame，设置面板这类 modal 在顶层打不开，要进任意一个面板里开（「分屏」设置项也一样，在面板的设置里）
- 每个面板都是完整客户端，内存和连接数跟面板数成正比；休眠的面板没有 iframe，内存也跟着释放
- 连接预算是浏览器 profile 级 per-origin 共享的，同一个浏览器里别的标签页也开着这个端口的话会挤占名额，九个可能开不满
- 依赖 DSH 内部接口，slot shadow、ctx.sessions、localStorage 键，DSH 没有稳定承诺，升级后要回归验证

## 下一步

- [README](./README.md) — 安装、快捷键与设置
- [第一个插件](https://deepseek-harness.github.io/deepseek-harness/develop/basic/) — Harness 官方插件开发教程
- [服务与依赖](https://deepseek-harness.github.io/deepseek-harness/develop/framework/service) — Cordis 服务的 provide / inject 机制
