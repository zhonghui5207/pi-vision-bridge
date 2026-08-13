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
 * 子代理调用：spawn `pi -p --no-extensions --model <视觉模型>` 子进程。
 * 图片先保存为临时文件，任务里让子代理用 read 工具自己读图
 * （pi 对支持图片的模型，read 工具会把图片数据直接交给模型）。
 *
 * 注意：用纯 -p（print）模式而非 rpc/json 事件流模式——部分 provider
 * （如 openai-codex）在 rpc/json 模式下工具调用链路会挂起，纯 -p 正常。
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
	ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

// ---- 配置 ---------------------------------------------------------------

const MODEL_TIMEOUT_MS = 90_000;
const AGENT_FILE = path.join(
	os.homedir(),
	".pi",
	"agent",
	"agents",
	"vision.md",
);

const VISION_TASK_TEMPLATE = (imagePaths: string[], userPrompt: string) =>
	[
		"你是一个图像识别代理。用户刚刚给主对话附加了图片，但主模型不支持图片输入。",
		"图片已保存为本地文件，请先用 read 工具读取以下图片文件，再回答问题：",
		...imagePaths.map((p) => `  - ${p}`),
		"",
		"读取图片后完成两件事：",
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
 * 纯 -p（print）模式：图片由子代理用 read 工具自行读取。
 */
function recognizeWithModel(
	imagePaths: string[],
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

		const args = ["-p", "--no-extensions", "--model", model];

		// 视觉代理正文作为子代理的 system prompt
		let tmpPromptPath: string | null = null;
		if (systemPrompt) {
			try {
				tmpPromptPath = path.join(
					os.tmpdir(),
					`vision-agent-${process.pid}-${Date.now()}.md`,
				);
				fs.writeFileSync(tmpPromptPath, systemPrompt, { encoding: "utf-8" });
				args.push("--append-system-prompt", tmpPromptPath);
			} catch {
				tmpPromptPath = null;
			}
		}

		// -p 模式：prompt 作为最后一个命令行参数
		args.push(VISION_TASK_TEMPLATE(imagePaths, userPrompt));

		const { command, args: fullArgs } = getPiInvocation(args);
		let proc: ReturnType<typeof spawn>;
		try {
			proc = spawn(command, fullArgs, { stdio: ["ignore", "pipe", "pipe"] });
		} catch {
			if (tmpPromptPath) {
				try {
					fs.unlinkSync(tmpPromptPath);
				} catch {
					/* ignore */
				}
			}
			finish(null);
			return;
		}

		let stdout = "";
		proc.stdout!.on("data", (d: Buffer) => {
			stdout += d.toString();
		});
		proc.stderr!.on("data", () => {
			/* 忽略 */
		});

		const cleanupTmp = () => {
			if (tmpPromptPath) {
				try {
					fs.unlinkSync(tmpPromptPath);
				} catch {
					/* ignore */
				}
			}
		};

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
			cleanupTmp();
			finish(null);
		}, timeoutMs);

		const onAbort = () => {
			killProc();
			cleanupTmp();
			finish(null);
		};

		proc.on("error", () => {
			clearTimeout(timeout);
			if (signal) signal.removeEventListener("abort", onAbort);
			cleanupTmp();
			finish(null);
		});

		proc.on("close", (code) => {
			clearTimeout(timeout);
			if (signal) signal.removeEventListener("abort", onAbort);
			cleanupTmp();
			const text = stdout.trim();
			finish(code === 0 && text ? text : null);
		});

		if (signal) {
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
		}
	});
}

// ---- 扩展主体 -----------------------------------------------------------

export default function (pi: ExtensionAPI) {
	let enabled = true;
	// 命令指定 > 环境变量 > agent 文件（无默认）
	let cliModel: string | undefined;

	function resolveVisionModel(): {
		model: string;
		systemPrompt?: string;
	} | null {
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
			ctx.ui.setStatus(
				"vision-bridge",
				`👁 视觉子代理 ${config.model} 识别中...`,
			);
		}

		// 图片先保存为临时文件，供子代理用 read 工具读取
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vision-bridge-"));
		const imagePaths: string[] = [];
		try {
			for (let i = 0; i < images.length; i++) {
				const img = images[i]!;
				const ext = img.mimeType?.includes("png") ? ".png" : ".jpg";
				const p = path.join(tmpDir, `image-${i}${ext}`);
				fs.writeFileSync(p, Buffer.from(img.data, "base64"));
				imagePaths.push(p);
			}
		} catch {
			/* 写文件失败则放弃 */
		}

		const description = await recognizeWithModel(
			imagePaths,
			event.prompt ?? "",
			config.model,
			config.systemPrompt,
			ctx.signal,
			MODEL_TIMEOUT_MS,
		);

		try {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}

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
