# Antigravity 会话监控（`antigravity-session-monitor`）

**Antigravity 会话监控**是一款专为 Antigravity 桌面客户端打造的原生右侧边栏实时运行监控与健康诊断插件，直观呈现本地会话的运行状态、Token 生成速度、上下文窗口水位与长任务执行进度。

## 核心能力

1. **实时运行健康状态机（告别“假死”盲猜）**
   - 融合零侵入生命周期钩子、`transcript.jsonl` 实时轨迹与系统子进程 CPU 占用率检测：
   - 清晰区分 **模型思考中**、**深度推理中（>60s）**、**命令活跃运行（实时 PID 与 CPU 占用率）**、**接口波动重试中**、**等待确认/回答**、**命令零占用疑似挂起（>90s）** 与 **异常/配额中断**。
2. **核心指标总览、AGY 流量统计与上下文一键压缩**
   - 实时计算并展示 **生成速度（`t/s`）**、**本轮耗时与步数**、**当前上下文窗口水位（含真实窗口上限占比）**、**缓存命中率（累计与本轮）**、**AGY 服务端流量（实时速率 / 今日 / 历史累计）** 与 **累计词元总量**。
   - 新增独立 **「流量」统计页签**：
     - **AGY 服务端流量监控（macOS）**：基于原生 `nettop` 按 Antigravity 宿主自身进程（`language_server`、`Antigravity Network` 等）过滤套接字增量并持久化账本，严格排除本机其他应用、用户终端命令、插件 sidecar 与本地 IPC 回环流量（兼容本地代理识别），无损累计 AGY 与远端服务器的上传 / 下载字节数并支持按进程拆解与二次确认清零；
     - **接口全量遥测指标**：直接解析宿主 `conversations/<id>.db` 的 `gen_metadata` 与 `GetUserStatus` 接口，展示缓存命中率、缓存写入、思考/正文输出拆分、首字延迟（TTFT）、流式解码速率、接口重试次数、上下文窗口构成拆解与账号模型配额余量；
     - **全机已统计会话累计**：增量扫描汇总全部本地会话的「全部 / 今日」累计词元、全局缓存命中率与高消耗会话排行。
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

- 前端文件（`index.html` / `styles.css` / `app.js`）保存后约 `1.2s` 自动热刷新；后端文件（`main.mjs` / `state_engine.mjs` / `metrics_engine.mjs`）保存后约 `3s` 自动热重启。
- 运行状态机、轨迹解析与流量/缓存指标单元测试：

```bash
node --test sidecars/session_monitor/test/*.test.mjs
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
