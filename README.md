# dsh-split-view（分屏插件）

中文 | [English](README.en.md)

[![npm version](https://img.shields.io/npm/v/dsh-split-view.svg?style=flat-square)](https://www.npmjs.com/package/dsh-split-view)

一个插件把 DeepSeek Harness 主窗口变成多个分屏，同时查看多个会话的状态。

有过【同时跑多个任务】经历的同学应该能感受这种痛苦：多个标签切来切去，很心累。

dsh-split-view 分屏插件借鉴了终端分屏的思想。将 DSH 主窗口变成一个可拖拽的分屏容器，每个分屏里跑一个完整的 DSH 客户端。

## 长什么样

![分屏实录](demo.gif)

上面是日常操作：向右分屏、向下分屏、拖动分割条调整大小、双击标题栏放大、关闭。



![两分屏](demo2.png)



![三分屏](demo3.png)

横竖任意嵌套。每个面板一条标题栏，左边实时显示当前会话标题，右边是向右分屏、向下分屏、放大还原、刷新、关闭五个按钮。点标题直接改名，双击放大，还能一键复制「会话 id + 会话标题」。

## 安装

```sh
dsh plugin --profile web add dsh-split-view
dsh web   # 重启生效
```

本地开发从源码装：`dsh plugin --profile web add -w /path/to/dsh-split-view`。

卸载用 `dsh plugin --profile web remove dsh-split-view`，重启恢复单窗口。插件本身如果出问题，boot 会停下来报错，不会静默白屏，所以卸载也就是紧急恢复的办法。

## 默认快捷键（支持在设置中自定义）

| 键（macOS ⌘，Windows/Linux Ctrl） | 动作 |
|---|---|
| ⇧⌘D | 向右分屏 |
| ⇧⌘V | 向下分屏 |
| ⇧⌘X | 关闭聚焦面板 |
| ⇧⌘Enter | 最大化 / 还原聚焦面板 |



## 设置

在任意面板里打开设置，左侧导航有一项「分屏」。

四组设置：

- **快捷键**：点某个动作的组合键进入录制，按新组合完成改绑，Esc 取消。绑什么由你决定：被浏览器或系统占用的组合、和别的动作撞车的组合照样能绑，只会给出提示；唯一的硬性要求是得带 ⌘/Ctrl。
- **选中高亮色**：聚焦面板的描边和标题栏染色。预设色板、自定义取色器，外加「跟随主题」——跟随当前皮肤的品牌色 token，换皮肤自动跟着变。
- **标题栏**：一个开关，隐藏所有面板的标题栏。注意标题栏上有复制会话信息、分屏、最大化、刷新、关闭按钮，双击放大、点标题重命名也走标题栏，隐藏后这些动作只能靠快捷键；点面板聚焦不受影响。
- **恢复默认**：一键把上面全部还原，点之前会弹确认。



## 供其它插件调用

分屏能力整体暴露成了一个 Cordis 服务：面板操作、面板×会话操作（加载指定会话、发消息、改名、换模型、取消回合）、查询与订阅。面向集成方的服务 API 见 [api.md](./api.md)。

## 协议

MIT © dsh-split-view contributors
