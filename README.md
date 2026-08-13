# pi-vision-bridge

让**没有视觉能力**的 Pi 模型（如 `deepseek-v4-flash`）也能"看懂"用户附加的图片。

当用户附带图片、但当前模型不支持图片输入时，本扩展会自动：

1. 把图片交给**有视觉能力的模型子进程**（`pi --mode rpc` 子代理）识别；
2. 全部视觉模型失败时，回退到 **macOS 本地 OCR**（Vision 框架，离线可用，中英文）；
3. 把识别结果作为一条 `[vision-bridge]` 消息注入当前会话，主模型就能基于图片内容正常回答。

## 安装

```bash
pi install git:github.com/zhonghui5207/pi-vision-bridge
```

或临时试用（单次运行）：

```bash
pi -e git:github.com/zhonghui5207/pi-vision-bridge
```

安装后 `/reload`（或重启 pi）生效。扩展放在 `~/.pi/agent/extensions/` 自动发现。

## 使用

什么都不用配。给不支持视觉的模型发一张图片，扩展会自动接管：

```
🖼 当前模型 deepseek/deepseek-v4-flash 不支持图片，自动交给视觉代理识别...
```

识别结果会作为 `[vision-bridge]` 消息进入 LLM 上下文，主模型基于它继续回答。

### 命令

| 命令 | 作用 |
| --- | --- |
| `/vision-bridge` | 查看状态（开关、模型链、OCR 兜底） |
| `/vision-bridge on` / `off` | 启用 / 禁用 |
| `/vision-bridge model <provider/model>` | 只用指定模型 |
| `/vision-bridge models <a,b,c>` | 设置模型链（逗号分隔） |
| `/vision-bridge ocr on` / `off` | 启用 / 禁用 OCR 兜底 |

### 环境变量

- `PI_VISION_MODELS="newlink/claude-sonnet-4-6,kimi-coding/k3"` — 覆盖默认模型链

## 识别策略（依次回退）

1. **视觉模型链**（默认）：`newlink/claude-sonnet-4-6` → `kimi-coding/k3` → `kimi-coding/k3-256k`。每个模型超时 60s，失败即切下一个。
2. **macOS 本地 OCR**：预编译的 arm64 二进制（`extensions/vision-bridge-ocr.bin`），提取图片中的中英文文字。适合截图、文档等文字为主的图片。

如果当前模型本身支持视觉（`input` 包含 `image`），扩展会直接跳过，不做任何额外调用。

## 工作原理

- 监听 `before_agent_start` 事件，读取 `event.images`（base64 `ImageContent[]`）；
- 检查 `ctx.model.input` 是否包含 `"image"` 判断当前模型是否有视觉；
- 无视觉时 spawn `pi --mode rpc --no-extensions --model <视觉模型>` 子进程，通过 RPC 协议把图片（base64）直接发给视觉模型（这正是 Pi 官方 `pi-subagents` 的同款"子代理"模式：独立进程 + 独立上下文 + `--model` 覆盖）；
- RPC 子进程的 **stdin 必须保持打开**直到拿到最终 `message_end`，否则 Pi 会把 stdin 关闭当作 shutdown 信号提前退出；
- 把子代理输出作为 `{ message: { customType: "vision-bridge", ... } }` 注入会话（进入 LLM 上下文）。

## 已知问题与注意事项

- **macOS 专用**：OCR 兜底依赖 macOS Vision 框架；预编译的 `vision-bridge-ocr.bin` 是 **arm64** 架构。如需重新编译（如换机器/系统更新后）：

  ```bash
  swiftc -O extensions/vision-bridge-ocr.swift -o extensions/vision-bridge-ocr.bin
  ```

- **Rosetta 环境**：如果 pi 在 Rosetta（x86_64 翻译）下运行，`swift`/`xcrun` 子进程会因 CommandLineTools 缺少 x86_64 切片而失败——因此扩展优先使用预编译的 arm64 二进制（原生 Mach-O 不受影响），并保留 `arch -arm64 swift` 与 `swift` 两级回退。
- **RPC 模式下的 UI 限制**：主会话在 RPC 模式时 `setWorkingMessage`/`setWorkingIndicator` 是 no-op，但 `before_agent_start` 事件与消息注入**可用**——所以本扩展在 Telegram Bridge 等 RPC 场景下同样有效。
- 视觉模型链需要对应 provider 已配置且可用（如 `newlink` 网关需要飞连/VPN 可达）。

## License

MIT
