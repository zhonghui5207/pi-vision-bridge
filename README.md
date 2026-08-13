# pi-vision-bridge

让**没有视觉能力**的 Pi 模型（如 `deepseek-v4-flash`）也能看懂用户附加或粘贴的图片。

当当前模型不支持图片输入时，本扩展会通过 Pi 的 `modelRegistry` 直接调用你配置的视觉模型，把识别结果注入当前会话，再由主模型回答。

- 不启动 `pi` 子进程
- 不依赖 OCR 或 `read` 工具
- 不走容易挂起的 RPC/json 子代理协议
- 直接传递 base64 图片给视觉 provider
- 没有内置默认视觉模型；每台设备自行配置

## 安装

```bash
pi install git:github.com/zhonghui5207/pi-vision-bridge
```

或临时试用：

```bash
pi -e git:github.com/zhonghui5207/pi-vision-bridge
```

安装后执行 `/reload`，或重启 Pi。

## 配置视觉模型（必须，三选一）

### 方式一（推荐）：`~/.pi/agent/agents/vision.md`

```markdown
---
name: vision
description: 图像识别代理：查看图片并描述内容/回答相关问题。
model: openai-codex/gpt-5.4-mini
tools: read
no-session: true
---

你是专业的图像识别代理。查看用户附加的图片，然后：
1) 详细准确地描述图片内容；
2) 直接回答用户与图片相关的问题。
```

扩展只读取 `model:` 和正文提示词。`tools: read` 不是扩展运行所必需，但保留它可以让你在 Pi 里手动调用这个 `vision` roster agent 读取图片路径。

使用本机真实可用、且支持图片输入的模型。可通过下面的命令查找：

```bash
pi --list-models | grep -i images
```

### 方式二：环境变量

```bash
export PI_VISION_MODEL="openai-codex/gpt-5.4-mini"
```

### 方式三：会话命令

```text
/vision-bridge model <provider/model-id>
```

优先级：会话命令 > `PI_VISION_MODEL` > `vision.md`。三者都未配置时，扩展不会擅自选择模型。

## 使用

给无视觉模型发送图片即可。扩展支持两种实际输入形式：

1. Pi 事件中的 `event.images` 图片附件；
2. 无视觉模型下，Pi TUI 粘贴图片产生的本地路径文本，例如：

```text
/var/folders/.../pi-clipboard-xxxx.png 帮我分析这张图
```

触发后：

- 状态栏显示 `👁 视觉模型 ... 识别中...`
- 视觉结果以 `[vision-bridge]` 消息注入上下文
- 主模型直接基于识别结果回答

### 命令

| 命令 | 作用 |
| --- | --- |
| `/vision-bridge` | 查看状态、当前模型及配置来源 |
| `/vision-bridge on` / `off` | 启用 / 禁用 |
| `/vision-bridge model <provider/model-id>` | 本会话指定视觉模型 |

## 工作原理

1. 监听 `before_agent_start`；
2. 读取 `event.images`，或从消息文本中提取存在的 `.png/.jpg/.jpeg/.gif/.webp/.bmp` 文件路径；
3. 检查主模型的 `input` 是否包含 `image`，有视觉能力则直接跳过；
4. 用 `ctx.modelRegistry.find()` 解析用户配置的视觉模型；
5. 用 `ctx.modelRegistry.complete()` 在当前进程中复用 Pi 已有的 provider、OAuth/API key、代理和模型配置；
6. 把图片作为标准 `{ type: "image", data, mimeType }` 内容直接交给视觉模型；
7. 把视觉模型返回的文字注入主会话。

这种方式避开了嵌套 Pi 进程、CLI 参数传图、子代理工具权限及 RPC provider 兼容性问题。

## 行为细节

- **去重缓存**：相同视觉模型、用户问题和图片在 60 秒内重复触发时直接复用识别结果。
- **文件限制**：文本路径图片必须是真实文件，单张最大 50 MB。
- **调用超时**：默认 90 秒；超时或取消时会中止 provider 请求并给出错误提示。
- **隐私**：图片只发给你显式配置的视觉模型/provider，不会调用任何内置备用服务。
- **无 OCR fallback**：视觉调用失败时会明确报错，不会用本地 OCR 冒充视觉理解。

## 多设备配置

每台设备安装后，分别把 `vision.md` 的 `model:` 设置为该设备可用的视觉模型。扩展不会硬编码或自动选择其他模型。

## 已知限制

- 配置的模型必须真实支持图片输入；仅模型名称看起来像视觉模型并不够。
- provider 自身网络、鉴权或服务异常仍会导致失败。
- 视觉调用期间当前回合会等待结果；扩展会显示状态，但不会打开独立子代理终端窗格。

## License

MIT
