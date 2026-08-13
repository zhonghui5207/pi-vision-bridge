# pi-vision-bridge

让**没有视觉能力**的 Pi 模型（如 `deepseek-v4-flash`）也能"看懂"用户附加的图片。

当用户附带图片、但当前模型不支持图片输入时，本扩展会自动把图片交给一个**视觉子代理**（独立 pi 子进程 + 你指定的视觉模型）识别，再把识别结果注入当前会话——主模型就能基于图片内容正常回答。

**视觉模型没有内置默认值，完全由你在每台设备上自行配置**（不同设备可用的模型不同，扩展不做假设）。

## 安装

```bash
pi install git:github.com/zhonghui5207/pi-vision-bridge
```

或临时试用（单次运行）：

```bash
pi -e git:github.com/zhonghui5207/pi-vision-bridge
```

安装后 `/reload`（或重启 pi）生效。

## 配置视觉模型（必须，三选一）

### 方式一（推荐）：子代理定义文件 `~/.pi/agent/agents/vision.md`

创建该文件，`model:` 字段填你本机可用的视觉模型（`provider/model-id` 格式，可用 `pi --list-models | grep -i images` 查询本机哪些模型支持图片）：

```markdown
---
name: vision
description: 图像识别子代理：查看图片并描述内容/回答与图片相关的问题。
model: kimi-coding/k3
tools: none
no-session: true
---

你是专业的图像识别代理。查看用户附加的图片，然后：
1) 详细准确地描述图片内容（布局、元素、文字、颜色、风格等）；
2) 如果用户的问题与图片相关，直接基于图片回答。
```

改 `model:` 一行即可切换视觉模型。正文定义了子代理的角色。

### 方式二：环境变量

```bash
export PI_VISION_MODEL="openai-codex/gpt-5.4-mini"
```

### 方式三：命令指定（本会话临时）

```
/vision-bridge model <provider/model-id>
```

优先级：命令指定 > 环境变量 > agent 文件。三者都未配置时，扩展不会调用任何东西，只会提示你配置。

## 使用

什么都不用配（除了上面选一种方式指定视觉模型）。给不支持视觉的模型发图片，扩展自动接管：

- 触发时提示：`🖼 当前模型 ... 不支持图片，调用视觉子代理 (kimi-coding/k3) 识别...`
- 底部状态栏显示：`👁 视觉子代理 kimi-coding/k3 识别中...`
- 识别结果作为 `[vision-bridge]` 消息注入 LLM 上下文，主模型基于它回答

### 命令

| 命令 | 作用 |
| --- | --- |
| `/vision-bridge` | 查看状态（开关、当前生效模型及来源） |
| `/vision-bridge on` / `off` | 启用 / 禁用 |
| `/vision-bridge model <provider/model-id>` | 本会话指定视觉模型 |

## 工作原理

- 监听 `before_agent_start`，读取 `event.images`（base64 `ImageContent[]`）；
- 检查 `ctx.model.input` 是否包含 `"image"` 判断当前模型是否有视觉，有则直接跳过；
- 无视觉时把图片保存为临时文件，spawn 一个**视觉子代理**：`pi -p --no-extensions --model <你的视觉模型>`，任务里让子代理用 read 工具自行读取图片（pi 对支持图片的模型，read 工具会把图片数据直接交给模型）；
- 子代理正文（vision.md 的内容）通过 `--append-system-prompt` 注入子进程；
- 用纯 `-p`（print）模式而非 rpc/json 事件流模式——部分 provider（如 openai-codex）在 rpc/json 模式下工具调用链路会挂起，纯 `-p` 正常；
- 把子代理输出（stdout 即最终文本）作为 `{ message: { customType: "vision-bridge", ... } }` 注入会话（进入 LLM 上下文）。

## 多设备说明

每台设备安装后，各自配置本机可用的视觉模型：

```bash
# 查本机哪些模型支持图片
pi --list-models | grep -i images
# 写入本机配置
mkdir -p ~/.pi/agent/agents
# 编辑 ~/.pi/agent/agents/vision.md 的 model 字段
```

## 行为细节

- **去重缓存**：pi 在 compact 后自动重试 turn 时 `before_agent_start` 会带同一批图片再次触发。扩展对 60 秒内相同图片直接复用上一次的识别结果，避免重复调用视觉模型。
- **临时文件**：图片保存到系统临时目录（权限 0600，仅当前用户可读），识别完成后自动删除。
- **子代理会话**：子代理用 `--no-session` 启动，不会留下会话文件。

## 已知问题

- 视觉模型必须真实支持图片输入（`pi --list-models` 中 `images` 列为 `yes`），否则调用会失败。
- 某些供应商的视觉接口不稳定（超时/卡死），扩展默认 90s 超时并清理子进程；可换其他视觉模型重试。
- 主会话在 RPC 模式时部分 UI API 是 no-op，但 `before_agent_start` 事件与消息注入可用——本扩展在 Telegram Bridge 等 RPC 场景同样有效。

## License

MIT
