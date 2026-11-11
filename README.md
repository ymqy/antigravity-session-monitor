# Antigravity 会话监控（`antigravity-session-monitor`）

**Antigravity 会话监控**是一款专为 Antigravity 桌面客户端打造的原生右侧边栏实时运行监控与健康诊断插件，直观呈现本地会话的运行状态、Token 生成速度、上下文窗口水位与长任务执行进度。

## 核心能力

1. **实时运行健康状态机（告别“假死”盲猜）**
   - 融合零侵入生命周期钩子、`transcript.jsonl` 实时轨迹与系统子进程 CPU 占用率检测：
   - 清晰区分 **模型思考中**、**深度推理中（>60s）**、**命令活跃运行（实时 PID 与 CPU 占用率）**、**接口波动重试中**、**等待确认/回答**、**命令零占用疑似挂起（>90s）** 与 **异常/配额中断**。
2. **核心指标总览与上下文一键压缩**
   - 实时计算并展示 **生成速度（`t/s`）**、**本轮耗时（`s / m / h`）与步数**、**当前上下文窗口水位与总输出**。
   - 当活跃上下文窗口达到预设水位（默认 `16万 t` 建议压缩、`20万 t` 立即压缩）时，在状态栏右侧提供零高度占用的轻量化提示标签，支持**手动点击直接在当前会话触发 `/compact`**（绝不后台自动代执行，压缩完成后上下文回落自动消退）。
3. **阶段里程碑进度与并发子代理监控**
   - 自动解析会话产物目录下的阶段任务清单（`task.md` 中的 `- [ ]` / `- [/]` / `- [x]`），展示完成百分比进度条并支持一键打开原文档（100% 完成后自动折叠降噪）。
   - 自动汇总当前会话派发的子代理与后台驻留任务，以及本机所有并行运行会话，支持一键切窗跳转或发消息追问唤醒。

---

## 环境要求

- **客户端**：Antigravity 桌面客户端（支持本地项目 `This Computer`）
- **运行时**：Node.js `>= 18`（**零第三方依赖**，无需 `npm install` 或 `pip install`）
- **macOS 辅助功能权限（可选）**：如需点击「建议压缩 / 立即压缩」直接在输入框触发 `/compact`，在 macOS **系统设置 → 隐私与安全性 → 辅助功能** 中确保已勾选 Antigravity（直接调用 macOS 系统原生 `ApplicationServices` / `CoreGraphics` 框架实现）。

---

## 安装方式

### 方式一：全局安装（推荐，对本机所有本地项目生效）

直接克隆到全局插件目录 `~/.gemini/config/plugins/`，客户端会自动发现并启用：

```bash
mkdir -p ~/.gemini/config/plugins
git clone https://github.com/ymqy/antigravity-session-monitor.git \
  ~/.gemini/config/plugins/antigravity-session-monitor
```

如果你希望将源码放在自己的开发目录（支持修改后秒级自动热重载），使用软链接挂载即可：

```bash
git clone https://github.com/ymqy/antigravity-session-monitor.git
mkdir -p ~/.gemini/config/plugins
ln -s "$(pwd)/antigravity-session-monitor" \
  ~/.gemini/config/plugins/antigravity-session-monitor
```

### 方式二：工作区级安装（仅对单个项目生效）

将插件放入目标项目根目录下的 `.agents/plugins/` 目录：

```bash
mkdir -p .agents/plugins
git clone https://github.com/ymqy/antigravity-session-monitor.git \
  .agents/plugins/antigravity-session-monitor
```

---

## 启用与打开面板

1. 打开客户端左侧 **Customizations（自定义 / 插件管理）**，确认 **Antigravity 会话监控** 处于开启状态。
2. 在任意本地项目对话右上角点击 **`+`（新建标签页）→ 扩展面板 → 会话监控**。
3. 右键点击右侧边栏上的「会话监控」标签页选择固定（Pin），即可跨对话常驻显示。

## 开发与测试

- 前端文件（`index.html` / `styles.css` / `app.js`）保存后约 `1.2s` 自动热刷新；后端文件（`main.mjs` / `state_engine.mjs`）保存后约 `3s` 自动热重启。
- 运行状态机与轨迹解析单元测试：

```bash
node --test sidecars/session_monitor/test/state_engine.test.mjs
```

## 目录结构

```text
antigravity-session-monitor/
├── plugin.json                        # 插件清单定义
├── hooks.json                         # 零阻塞生命周期事件采集钩子配置
├── assets/logo.svg                    # 插件图标
├── rules/AGENTS.md                    # 复杂长任务阶段清单进度规范
├── scripts/                           # 毫秒级生命周期快照采集脚本
└── sidecars/session_monitor/          # 右侧常驻监控面板前后端服务与单测
```
