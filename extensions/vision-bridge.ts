/**
 * Vision Bridge
 *
 * 当用户附加图片、但当前模型没有视觉能力时，把图片交给一个
 * **视觉子代理**（独立 pi 子进程 + 指定视觉模型）识别，并把识别结果
 * 注入当前会话，让主模型能基于图片内容继续回答。
 *
 * 视觉模型没有内置默认值——完全由配置指定（按优先级）：
 *   1. 命令指定：/vision-bridge model <provider/model-id>（本会话临时）
 *   2. 环境变量：PI_VISION_MODEL="provider/model-id"
 *   3. 子代理定义：~/.pi/agent/agents/vision.md 的 frontmatter `model:` 字段
 *      （推荐：跨会话持久，与 pi-subagents 生态一致，正文可定义代理角色）
 *
 * 如果三者都未配置：不调用任何东西，并提示先指定视觉模型。
 * 不同设备安装后，各自配置本机可用的视觉模型即可。
 *
 * 子代理调用：spawn `pi --mode rpc --no-extensions --model <视觉模型>`
 * 子进程，通过 RPC 协议把图片（base64）直接发给视觉模型。
 * 注意：RPC 子进程必须保持 stdin 打开直到拿到最终 message_end，
 * 否则 pi 会把 stdin 关闭当作 shutdown 信号提前退出。
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// 图片内容（与 pi RPC 协议的 ImageContent 形状一致）
interface ImageContent {
	type: "image";
	data: string; // base64 编码的图片数据
	mimeType: string; // 如 "image/png"
}

// ---- 配置 ---------------------------------------------------------------

const MODEL_TIMEOUT_MS = 90_000;
const AGENT_FILE = path.join(os.homedir(), ".pi", "agent", "agents", "vision.md");

const VISION_TASK_TEMPLATE = (userPrompt: string) =>
	[
		"你是一个图像识别代理。用户刚刚给主对话附加了图片，但主模型不支持图片输入。",
		"请仔细查看这张/这些图片，然后完成两件事：",
		"1) 详细、准确地描述图片内容（布局、元素、文字、颜色等）；",
		"2) 如果用户的问题与图片相关，直接基于图片回答用户的问题。",
		"",
		`用户的问题/上下文：${userPrompt || "(无，仅要求描述图片)"}`,
		"",
		"只输出最终内容，不要提及你看不到图片（你确实看到了）。",
	].join("\n");

// ---- 视觉代理配置解析 ----------------------------------------------------

interface VisionAgentConfig {
	model: string;
	name: string;
	description?: string;
	systemPrompt?: string;
}

/** 解析 ~/.pi/agent/agents/vision.md：frontmatter 的 model/name/description + 正文 */
function loadVisionAgent(): VisionAgentConfig | null {
	try {
		if (!fs.existsSync(AGENT_FILE)) return null;
		const src = fs.readFileSync(AGENT_FILE, "utf-8");
		const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
		if (!m) return null;
		const frontmatter = m[1] ?? "";
		const body = (m[2] ?? "").trim();
		const get = (key: string): string | undefined => {
			const line = frontmatter
				.split("\n")
				.map((l) => l.trim())
				.find((l) => l.startsWith(`${key}:`) || l.startsWith(`${key} :`));
			if (!line) return undefined;
			const v = line.slice(line.indexOf(":") + 1).trim();
			return v ? v.replace(/^["']|["']$/g, "") : undefined;
		};
		const model = get("model");
		const name = get("name");
		if (!model) return null;
		return {
			model,
			name: name || "vision",
			description: get("description"),
			systemPrompt: body || undefined,
		};
	} catch {
		return null;
	}
}

// ---- 工具函数 -----------------------------------------------------------

/** 复用当前 pi 的启动方式（参考官方 subagent 示例） */
function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}
	return { command: "pi", args };
}

/**
 * 用视觉模型子进程识别图片，返回最终文本；失败/超时返回 null。
 * 关键：保持子进程 stdin 打开，拿到最终 assistant message 后再关。
 */
function recognizeWithModel(
	images: ImageContent[],
	userPrompt: string,
	model: string,
	systemPrompt: string | undefined,
	signal: AbortSignal | undefined,
	timeoutMs: number,
): Promise<string | null> {
	return new Promise<string | null>((resolve) => {
		let settled = false;
		const finish = (value: string | null) => {
			if (!settled) {
				settled = true;
				resolve(value);
			}
		};

		const args = ["--mode", "rpc", "--no-extensions", "--model", model];

		// 视觉代理正文作为子代理的 system prompt
		let tmpPromptPath: string | null = null;
		if (systemPrompt) {
			try {
				tmpPromptPath = path.join(os.tmpdir(), `vision-agent-${process.pid}-${Date.now()}.md`);
				fs.writeFileSync(tmpPromptPath, systemPrompt, { encoding: "utf-8" });
				args.push("--append-system-prompt", tmpPromptPath);
			} catch {
				tmpPromptPath = null;
			}
		}

		const { command, args: fullArgs } = getPiInvocation(args);
		let proc: ReturnType<typeof spawn>;
		try {
			proc = spawn(command, fullArgs, { stdio: ["pipe", "pipe", "pipe"] });
		} catch {
			cleanupTmp();
			finish(null);
			return;
		}

		function cleanupTmp() {
			if (tmpPromptPath) {
				try {
					fs.unlinkSync(tmpPromptPath);
				} catch {
					/* ignore */
				}
			}
		}

		proc.stdin!.write(JSON.stringify({ type: "prompt", message: VISION_TASK_TEMPLATE(userPrompt), images }) + "\n");

		let buffer = "";
		const collected: string[] = [];

		proc.stdout!.on("data", (data: Buffer) => {
			buffer += data.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed) continue;
				let ev: any;
				try {
					ev = JSON.parse(trimmed);
				} catch {
					continue;
				}
				if (ev?.type !== "message_end") continue;
				const msg = ev.message;
				if (msg?.role !== "assistant") continue;
				const text = (msg.content ?? [])
					.filter((p: any) => p.type === "text")
					.map((p: any) => p.text)
					.join("");
				if (text) collected.push(text);
				if (["stop", "length", "error", "aborted"].includes(msg.stopReason)) {
					teardown();
				}
			}
		});

		proc.stderr!.on("data", () => {
			/* 忽略 */
		});

		const killProc = () => {
			try {
				proc.kill("SIGTERM");
			} catch {
				/* ignore */
			}
			setTimeout(() => {
				try {
					if (!proc.killed) proc.kill("SIGKILL");
				} catch {
					/* ignore */
				}
			}, 3000);
		};

		const timeout = setTimeout(() => {
			killProc();
			finish(null);
		}, timeoutMs);

		const onAbort = () => {
			killProc();
			finish(null);
		};

		function teardown() {
			clearTimeout(timeout);
			if (signal) signal.removeEventListener("abort", onAbort);
			try {
				proc.stdin!.end();
			} catch {
				/* ignore */
			}
			proc.once("exit", () => {
				cleanupTmp();
				finish(collected.join("\n").trim() || null);
			});
			setTimeout(() => {
				cleanupTmp();
				finish(collected.join("\n").trim() || null);
			}, 2000);
		}

		if (signal) {
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
		}

		proc.on("error", () => {
			clearTimeout(timeout);
			cleanupTmp();
			finish(null);
		});
	});
}

// ---- 扩展主体 -----------------------------------------------------------

export default function (pi: ExtensionAPI) {
	let enabled = true;
	// 命令指定 > 环境变量 > agent 文件（无默认）
	let cliModel: string | undefined;

	function resolveVisionModel(): { model: string; systemPrompt?: string } | null {
		if (cliModel) return { model: cliModel };
		const envModel = process.env.PI_VISION_MODEL?.trim();
		if (envModel) return { model: envModel };
		const agent = loadVisionAgent();
		if (agent) return { model: agent.model, systemPrompt: agent.systemPrompt };
		return null;
	}

	pi.on("before_agent_start", async (event, ctx) => {
		const images = event.images;
		if (!enabled || !images || images.length === 0) return;

		const model = ctx.model;
		const hasVision = model?.input?.includes("image");
		if (hasVision) return; // 当前模型本身能看图，无需桥接

		const config = resolveVisionModel();
		if (!config) {
			if (ctx.hasUI) {
				ctx.ui.notify(
					"🖼 图片已收到，但未配置视觉模型。请先指定：\n" +
						"  · /vision-bridge model <provider/model-id>\n" +
						"  · 或编辑 ~/.pi/agent/agents/vision.md 的 model 字段\n" +
						"  · 或设置环境变量 PI_VISION_MODEL",
					"warning",
				);
			}
			return; // 未配置：不调用任何东西
		}

		const currentModel = model ? `${model.provider}/${model.id}` : "unknown";

		if (ctx.hasUI) {
			ctx.ui.notify(
				`🖼 当前模型 ${currentModel} 不支持图片，调用视觉子代理 (${config.model}) 识别...`,
				"info",
			);
			ctx.ui.setStatus("vision-bridge", `👁 视觉子代理 ${config.model} 识别中...`);
		}

		const description = await recognizeWithModel(
			images,
			event.prompt ?? "",
			config.model,
			config.systemPrompt,
			ctx.signal,
			MODEL_TIMEOUT_MS,
		);

		if (ctx.hasUI) {
			ctx.ui.setStatus("vision-bridge", undefined);
		}

		if (!description) {
			if (ctx.hasUI) {
				ctx.ui.notify(
					`⚠️ 视觉子代理 (${config.model}) 识别失败或超时（${MODEL_TIMEOUT_MS / 1000}s）。可换模型重试：/vision-bridge model <id>`,
					"error",
				);
			}
			return;
		}

		return {
			message: {
				customType: "vision-bridge",
				content: [
					`[vision-bridge] 用户附带了图片，但当前模型 (${currentModel}) 不支持图片输入。`,
					`以下内容由视觉子代理 (${config.model}) 识别图片后生成，请直接使用：`,
					"",
					description,
				].join("\n"),
				display: true,
			},
		};
	});

	pi.registerCommand("vision-bridge", {
		description:
			"Vision bridge: 用视觉子代理识别图片并注入会话。用法: /vision-bridge [on|off|model <provider/model-id>|status]",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const sub = parts[0]?.toLowerCase();

			if (sub === "off") {
				enabled = false;
				ctx.ui.notify("Vision bridge disabled.", "info");
			} else if (sub === "on") {
				enabled = true;
				ctx.ui.notify("Vision bridge enabled.", "info");
			} else if (sub === "model" && parts[1]) {
				cliModel = parts[1];
				ctx.ui.notify(`视觉模型已指定: ${cliModel}（本会话生效）`, "info");
			} else {
				const envModel = process.env.PI_VISION_MODEL?.trim();
				const agent = loadVisionAgent();
				ctx.ui.notify(
					`Vision bridge: ${enabled ? "ON" : "OFF"}\n` +
						`当前生效模型: ${cliModel ?? envModel ?? agent?.model ?? "未配置"}\n` +
						`来源: ${cliModel ? "命令指定" : envModel ? "环境变量 PI_VISION_MODEL" : agent ? `agent 文件 ${AGENT_FILE}` : "无"}\n` +
						`配置方法: /vision-bridge model <provider/model-id>，或编辑 ${AGENT_FILE}`,
					"info",
				);
			}
		},
	});
}
