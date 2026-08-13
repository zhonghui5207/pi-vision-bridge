/**
 * Vision Bridge
 *
 * 当用户附加图片、但当前模型没有视觉能力时，直接通过 Pi 的
 * modelRegistry 调用用户配置的视觉模型，并把识别结果注入当前会话。
 *
 * 视觉模型没有内置默认值——完全由配置指定（按优先级）：
 *   1. /vision-bridge model <provider/model-id>（本会话临时）
 *   2. PI_VISION_MODEL 环境变量
 *   3. ~/.pi/agent/agents/vision.md frontmatter 的 model 字段
 *
 * 该实现不启动 pi 子进程、不依赖 read 工具，也不走 rpc/json 子代理协议；
 * 图片以 base64 ImageContent 直接交给视觉 provider。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

interface ImageContentLike {
	type: "image";
	data: string;
	mimeType: string;
}

interface VisionAgentConfig {
	model: string;
	name: string;
	description?: string;
	systemPrompt?: string;
}

type RecognitionResult =
	| { ok: true; text: string }
	| { ok: false; error: string };

const DEFAULT_TIMEOUT_MS = 90_000;
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
const RECOGNITION_CACHE_MS = 60_000;
const IMAGE_PATH_RE = /[^\s"'`]+\.(?:png|jpe?g|gif|webp|bmp)/gi;
const AGENT_FILE = path.join(os.homedir(), ".pi", "agent", "agents", "vision.md");

const DEFAULT_SYSTEM_PROMPT = [
	"你是专业的图像识别代理。",
	"请直接查看消息中附带的图片，详细、准确地描述图片内容，并回答用户与图片相关的问题。",
	"关注布局、元素、文字、颜色、界面状态和重要细节。",
	"不要声称无法查看图片，也不要讨论文件路径或实现方式。",
].join("\n");

/** 从文本中提取存在的本地图片路径（macOS 剪贴板图片会以这种形式进入无视觉模型）。 */
function extractImagePaths(text: string): string[] {
	if (!text) return [];
	const matches = text.match(IMAGE_PATH_RE) ?? [];
	const seen = new Set<string>();
	const paths: string[] = [];
	for (const raw of matches) {
		const filePath = raw.trim();
		if (seen.has(filePath)) continue;
		seen.add(filePath);
		try {
			const stat = fs.statSync(filePath);
			if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) continue;
			paths.push(filePath);
		} catch {
			// 路径不存在时忽略。
		}
	}
	return paths;
}

function mimeTypeForPath(filePath: string): string {
	switch (path.extname(filePath).toLowerCase()) {
		case ".png":
			return "image/png";
		case ".gif":
			return "image/gif";
		case ".webp":
			return "image/webp";
		case ".bmp":
			return "image/bmp";
		default:
			return "image/jpeg";
	}
}

/** 把消息里的本地图片路径转换为 provider 可直接接收的 ImageContent。 */
function loadPathImages(imagePaths: string[]): ImageContentLike[] {
	const images: ImageContentLike[] = [];
	for (const filePath of imagePaths) {
		try {
			const data = fs.readFileSync(filePath);
			if (data.byteLength > MAX_IMAGE_BYTES) continue;
			images.push({
				type: "image",
				data: data.toString("base64"),
				mimeType: mimeTypeForPath(filePath),
			});
		} catch {
			// 文件可能已被剪贴板清理，忽略该图片。
		}
	}
	return images;
}

/** 解析 ~/.pi/agent/agents/vision.md 的 frontmatter 与正文。 */
function loadVisionAgent(): VisionAgentConfig | null {
	try {
		if (!fs.existsSync(AGENT_FILE)) return null;
		const source = fs.readFileSync(AGENT_FILE, "utf-8");
		const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
		if (!match) return null;
		const frontmatter = match[1] ?? "";
		const body = (match[2] ?? "").trim();
		const get = (key: string): string | undefined => {
			const line = frontmatter
				.split("\n")
				.map((value) => value.trim())
				.find(
					(value) =>
						value.startsWith(`${key}:`) || value.startsWith(`${key} :`),
				);
			if (!line) return undefined;
			const value = line.slice(line.indexOf(":") + 1).trim();
			return value ? value.replace(/^["']|["']$/g, "") : undefined;
		};
		const model = get("model");
		if (!model) return null;
		return {
			model,
			name: get("name") || "vision",
			description: get("description"),
			systemPrompt: body || undefined,
		};
	} catch {
		return null;
	}
}

function splitModelId(modelSpec: string): { provider: string; id: string } | null {
	const separator = modelSpec.indexOf("/");
	if (separator <= 0 || separator === modelSpec.length - 1) return null;
	return {
		provider: modelSpec.slice(0, separator),
		id: modelSpec.slice(separator + 1),
	};
}

/**
 * 使用 Pi 当前进程中的 modelRegistry 直接调用视觉模型。
 * modelRegistry 会复用当前设备已有的 provider、OAuth/API key 和代理配置。
 */
async function recognizeWithModel(
	registry: ExtensionContext["modelRegistry"],
	images: ImageContentLike[],
	userPrompt: string,
	modelSpec: string,
	systemPrompt: string | undefined,
	parentSignal: AbortSignal | undefined,
	timeoutMs: number,
): Promise<RecognitionResult> {
	const parsed = splitModelId(modelSpec);
	if (!parsed) {
		return { ok: false, error: `模型格式无效：${modelSpec}` };
	}

	const model = registry.find(parsed.provider, parsed.id);
	if (!model) {
		return { ok: false, error: `当前 Pi 找不到模型：${modelSpec}` };
	}
	if (!model.input?.includes("image")) {
		return { ok: false, error: `配置的模型不支持图片输入：${modelSpec}` };
	}
	if (images.length === 0) {
		return { ok: false, error: "没有可读取的图片数据" };
	}

	const controller = new AbortController();
	let resolveCancelled: (result: RecognitionResult) => void = () => {};
	const cancelled = new Promise<RecognitionResult>((resolve) => {
		resolveCancelled = resolve;
	});
	const onParentAbort = () => {
		controller.abort();
		resolveCancelled({ ok: false, error: "视觉识别已取消" });
	};
	if (parentSignal) {
		if (parentSignal.aborted) return { ok: false, error: "视觉识别已取消" };
		parentSignal.addEventListener("abort", onParentAbort, { once: true });
	}
	const timeout = setTimeout(() => {
		controller.abort();
		resolveCancelled({
			ok: false,
			error: `视觉模型调用超时（${Math.round(timeoutMs / 1000)}s）`,
		});
	}, timeoutMs);

	const prompt = userPrompt.trim()
		? `请查看附带的图片并回答用户的问题：\n${userPrompt}`
		: "请详细、准确地描述附带的图片。";

	const call = registry
		.complete(
			model,
			{
				systemPrompt: systemPrompt || DEFAULT_SYSTEM_PROMPT,
				messages: [
					{
						role: "user",
						content: [{ type: "text", text: prompt }, ...images],
						timestamp: Date.now(),
					},
				],
			},
			{
				signal: controller.signal,
				timeoutMs,
			},
		)
		.then<RecognitionResult>((message) => {
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				return {
					ok: false,
					error: message.errorMessage || `视觉模型返回 ${message.stopReason}`,
				};
			}
			const text = message.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("")
				.trim();
			return text
				? { ok: true, text }
				: { ok: false, error: "视觉模型未返回文本" };
		})
		.catch<RecognitionResult>((error: unknown) => ({
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		}));

	try {
		return await Promise.race([call, cancelled]);
	} finally {
		clearTimeout(timeout);
		if (parentSignal) {
			parentSignal.removeEventListener("abort", onParentAbort);
		}
	}
}

export default function (pi: ExtensionAPI) {
	let enabled = true;
	let cliModel: string | undefined;
	let lastRecognition: { key: string; at: number; result: string } | null = null;

	function imageFingerprint(images: ImageContentLike[]): string {
		const totalLength = images.reduce(
			(sum, image) => sum + (image.data?.length ?? 0),
			0,
		);
		const first = images[0]?.data?.slice(0, 64) ?? "";
		return `${totalLength}:${first}`;
	}

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
		const attachedImages = (event.images ?? []) as ImageContentLike[];
		const pathImages =
			attachedImages.length > 0 ? [] : extractImagePaths(event.prompt ?? "");
		if (!enabled || (attachedImages.length === 0 && pathImages.length === 0)) {
			return;
		}

		const currentModel = ctx.model;
		if (currentModel?.input?.includes("image")) return;

		const config = resolveVisionModel();
		if (!config) {
			if (ctx.hasUI) {
				ctx.ui.notify(
					"🖼 图片已收到，但未配置视觉模型。请使用 /vision-bridge model <provider/model-id>，或配置 ~/.pi/agent/agents/vision.md。",
					"warning",
				);
			}
			return;
		}

		const images =
			attachedImages.length > 0 ? attachedImages : loadPathImages(pathImages);
		if (images.length === 0) {
			if (ctx.hasUI) {
				ctx.ui.notify("⚠️ 无法读取图片数据，视觉识别未启动。", "error");
			}
			return;
		}

		const currentModelId = currentModel
			? `${currentModel.provider}/${currentModel.id}`
			: "unknown";
		const cacheKey = [
			config.model,
			event.prompt ?? "",
			imageFingerprint(images),
		].join("\u0000");

		if (
			lastRecognition?.key === cacheKey &&
			Date.now() - lastRecognition.at < RECOGNITION_CACHE_MS
		) {
			return {
				message: {
					customType: "vision-bridge",
					content: [
						`[vision-bridge] 当前模型 (${currentModelId}) 不支持图片输入。`,
						`以下内容由视觉模型 (${config.model}) 识别，请直接基于它回答：`,
						"",
						lastRecognition.result,
					].join("\n"),
					display: true,
				},
			};
		}

		if (ctx.hasUI) {
			ctx.ui.notify(
				`🖼 调用视觉模型 (${config.model}) 直接识别图片...`,
				"info",
			);
			ctx.ui.setStatus(
				"vision-bridge",
				`👁 视觉模型 ${config.model} 识别中...`,
			);
		}

		const result = await recognizeWithModel(
			ctx.modelRegistry,
			images,
			event.prompt ?? "",
			config.model,
			config.systemPrompt,
			ctx.signal,
			DEFAULT_TIMEOUT_MS,
		);

		if (ctx.hasUI) ctx.ui.setStatus("vision-bridge", undefined);

		if (!result.ok) {
			if (ctx.hasUI) {
				ctx.ui.notify(
					`⚠️ 视觉模型 (${config.model}) 识别失败：${result.error}`,
					"error",
				);
			}
			return;
		}

		lastRecognition = {
			key: cacheKey,
			at: Date.now(),
			result: result.text,
		};

		return {
			message: {
				customType: "vision-bridge",
				content: [
					`[vision-bridge] 当前模型 (${currentModelId}) 不支持图片输入。`,
					`以下内容由视觉模型 (${config.model}) 识别，请直接基于它回答：`,
					"",
					result.text,
				].join("\n"),
				display: true,
			},
		};
	});

	pi.registerCommand("vision-bridge", {
		description:
			"Vision bridge: 用视觉模型识别图片并注入会话。用法: /vision-bridge [on|off|model <provider/model-id>|status]",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const subcommand = parts[0]?.toLowerCase();

			if (subcommand === "off") {
				enabled = false;
				ctx.ui.notify("Vision bridge disabled.", "info");
			} else if (subcommand === "on") {
				enabled = true;
				ctx.ui.notify("Vision bridge enabled.", "info");
			} else if (subcommand === "model" && parts[1]) {
				cliModel = parts[1];
				ctx.ui.notify(`视觉模型已指定：${cliModel}（本会话生效）`, "info");
			} else {
				const envModel = process.env.PI_VISION_MODEL?.trim();
				const agent = loadVisionAgent();
				ctx.ui.notify(
					`Vision bridge: ${enabled ? "ON" : "OFF"}\n` +
						`当前生效模型: ${cliModel ?? envModel ?? agent?.model ?? "未配置"}\n` +
						`来源: ${cliModel ? "命令指定" : envModel ? "环境变量 PI_VISION_MODEL" : agent ? `agent 文件 ${AGENT_FILE}` : "无"}\n` +
						`调用方式: 进程内直连 provider（不启动子进程）`,
					"info",
				);
			}
		},
	});
}
