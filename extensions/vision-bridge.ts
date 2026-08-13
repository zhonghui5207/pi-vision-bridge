/**
 * Vision Bridge
 *
 * 当用户附加图片、但当前模型没有视觉能力（如 deepseek-v4-flash）时：
 * 自动把图片交给"有视觉的模型子进程"识别，把识别结果注入当前会话，
 * 让主模型能基于图片内容继续回答。
 *
 * 识别策略（依次回退）：
 *  1. 视觉模型链（spawn `pi --mode rpc` 子进程，逐个尝试，首个成功即用）
 *  2. macOS 本地 OCR（Vision 框架，离线可用，能提取图片中的中英文文字）
 *
 * 默认视觉模型链（可配置）：
 *    newlink/claude-sonnet-4-6   （公司网关，需飞连，快）
 *    kimi-coding/k3              （备用）
 *    kimi-coding/k3-256k         （备用）
 *
 * 配置方式：
 *   - 环境变量 PI_VISION_MODELS="a/b,c/d"（逗号分隔的模型链）
 *   - 命令 /vision-bridge on|off|model <id>|models <a,b,c>|ocr on|off|status
 *
 * 注意：RPC 子进程必须保持 stdin 打开直到拿到结果，否则 pi 会把
 * stdin 关闭当作 shutdown 信号提前退出。
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext, ImageContent } from "@earendil-works/pi-coding-agent";

// ---- 配置 ---------------------------------------------------------------

const DEFAULT_VISION_MODELS = [
	"newlink/claude-sonnet-4-6",
	"kimi-coding/k3",
	"kimi-coding/k3-256k",
];
const MODEL_TIMEOUT_MS = 60_000;
const OCR_TIMEOUT_MS = 60_000;
const OCR_HELPER_PATH = path.join(os.homedir(), ".pi", "agent", "extensions", "vision-bridge-ocr.swift");
const OCR_BIN_PATH = path.join(os.homedir(), ".pi", "agent", "extensions", "vision-bridge-ocr.bin");

// 内嵌的 macOS Vision OCR 辅助脚本（首次使用时写出）
const OCR_SWIFT_SOURCE = `import Vision
import AppKit

let path = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ""
guard let img = NSImage(contentsOfFile: path) else { print("__ERR__ load"); exit(1) }
var rect = NSRect(origin: .zero, size: img.size)
guard let cg = img.cgImage(forProposedRect: &rect, context: nil, hints: nil) else { print("__ERR__ cg"); exit(1) }
let req = VNRecognizeTextRequest { request, _ in
    let obs = request.results as? [VNRecognizedTextObservation] ?? []
    for o in obs {
        if let t = o.topCandidates(1).first { print(t.string) }
    }
}
req.recognitionLevel = .accurate
req.recognitionLanguages = ["zh-Hans", "en-US"]
req.usesLanguageCorrection = true
let handler = VNImageRequestHandler(cgImage: cg, options: [:])
try? handler.perform([req])
`;

const VISION_TASK_TEMPLATE = (userPrompt: string) =>
	[
		"你是一个图像识别代理。用户刚刚给主对话附加了图片，但主模型不支持图片输入。",
		"请仔细查看这张/这些图片，然后完成两件事：",
		"1) 详细、准确地描述图片内容（如无可描述内容则说明图片是什么）；",
		"2) 如果用户的问题与图片相关，直接基于图片回答用户的问题。",
		"",
		`用户的问题/上下文：${userPrompt || "(无，仅要求描述图片)"}`,
		"",
		"只输出最终内容，不要提及你看不到图片（你确实看到了）。",
	].join("\n");

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
 * 用单个视觉模型子进程识别图片，返回最终文本；失败/超时返回 null。
 * 关键：保持子进程 stdin 打开，拿到最终 assistant message 后再关。
 */
function recognizeWithModel(
	images: ImageContent[],
	userPrompt: string,
	model: string,
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

		const { command, args } = getPiInvocation([
			"--mode",
			"rpc",
			"--no-extensions",
			"--model",
			model,
		]);
		let proc: ReturnType<typeof spawn>;
		try {
			proc = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
		} catch {
			finish(null);
			return;
		}

		proc.stdin.write(JSON.stringify({ type: "prompt", message: VISION_TASK_TEMPLATE(userPrompt), images }) + "\n");

		let buffer = "";
		let collected: string[] = [];
		let done = false;

		proc.stdout.on("data", (data: Buffer) => {
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
					done = true;
					teardown();
				}
			}
		});

		proc.stderr.on("data", () => {
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
				proc.stdin.end();
			} catch {
				/* ignore */
			}
			proc.once("exit", () => finish(collected.join("\n").trim() || null));
			setTimeout(() => finish(collected.join("\n").trim() || null), 2000);
		}

		if (signal) {
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
		}

		proc.on("error", () => {
			clearTimeout(timeout);
			finish(null);
		});
	});
}

/** 确保 OCR 辅助脚本已写出 */
function ensureOcrHelper(): string | null {
	try {
		if (!fs.existsSync(OCR_HELPER_PATH)) {
			fs.writeFileSync(OCR_HELPER_PATH, OCR_SWIFT_SOURCE, { encoding: "utf-8", mode: 0o644 });
		}
		return OCR_HELPER_PATH;
	} catch {
		return null;
	}
}

/**
 * 本地 OCR 兜底：提取图片中的文字（中英文）。返回 null 表示失败。
 * 优先用预编译的 arm64 二进制（避开扩展宿主 Rosetta 下 xcrun/swift 的架构问题），
 * 失败再回退到 swift 脚本（arch -arm64 强制原生架构）。
 */
async function runOcr(images: ImageContent[]): Promise<string | null> {
	const helper = ensureOcrHelper();
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vision-bridge-ocr-"));
	const results: string[] = [];

	for (const img of images) {
		const ext = img.mimeType?.includes("png") ? ".png" : ".jpg";
		const filePath = path.join(tmpDir, `img-${results.length}${ext}`);
		try {
			fs.writeFileSync(filePath, Buffer.from(img.data, "base64"));
		} catch {
			continue;
		}

		let text: string | null = null;
		if (fs.existsSync(OCR_BIN_PATH)) {
			text = await runProcessCapture([OCR_BIN_PATH, filePath], OCR_TIMEOUT_MS);
		}
		if (!text && helper) {
			text = await runProcessCapture(["arch", "-arm64", "swift", helper, filePath], OCR_TIMEOUT_MS);
		}
		if (!text && helper) {
			text = await runProcessCapture(["swift", helper, filePath], OCR_TIMEOUT_MS);
		}
		if (text) results.push(text);
	}

	try {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
	return results.length > 0 ? results.join("\n\n---\n\n") : null;
}

/**
 * 识别入口：依次尝试模型链，全部失败后走 OCR。返回 { source, text } 或 null。
 */
async function recognizeImages(
	images: ImageContent[],
	userPrompt: string,
	models: string[],
	signal: AbortSignal | undefined,
	useOcr: boolean,
): Promise<{ source: string; text: string } | null> {
	for (const model of models) {
		const text = await recognizeWithModel(images, userPrompt, model, signal, MODEL_TIMEOUT_MS);
		if (text) return { source: model, text };
	}
	if (useOcr) {
		const ocrText = await runOcr(images);
		if (ocrText) return { source: "macOS 本地 OCR", text: ocrText };
	}
	return null;
}

/** 运行外部命令并捕获 stdout 文本行；失败/超时返回 null。 */
function runProcessCapture(command: string[], timeoutMs: number): Promise<string | null> {
	return new Promise<string | null>((resolve) => {
		let proc;
		try {
			proc = spawn(command[0]!, command.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
		} catch {
			resolve(null);
			return;
		}
		let out = "";
		let timer: ReturnType<typeof setTimeout> | null = null;
		proc.stdout.on("data", (d: Buffer) => (out += d.toString()));
		proc.stderr.on("data", () => {
			/* 忽略 stderr */
		});
		proc.on("error", () => {
			if (timer) clearTimeout(timer);
			resolve(null);
		});
		proc.on("close", () => {
			if (timer) clearTimeout(timer);
			const lines = out.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("__ERR__"));
			resolve(lines.length > 0 ? lines.join("\n") : null);
		});
		timer = setTimeout(() => {
			try {
				proc.kill("SIGTERM");
			} catch {
				/* ignore */
			}
			resolve(null);
		}, timeoutMs);
	});
}

// ---- 扩展主体 -----------------------------------------------------------

export default function (pi: ExtensionAPI) {
	let enabled = true;
	let useOcr = true;
	let visionModels = process.env.PI_VISION_MODELS
		?.split(",")
		.map((s) => s.trim())
		.filter(Boolean) ?? [...DEFAULT_VISION_MODELS];

	pi.on("before_agent_start", async (event, ctx) => {
		const images = event.images;
		if (!enabled || !images || images.length === 0) return;

		const model = ctx.model;
		const hasVision = model?.input?.includes("image");
		if (hasVision) return; // 当前模型本身能看图，无需桥接

		const currentModel = model ? `${model.provider}/${model.id}` : "unknown";

		if (ctx.hasUI) {
			ctx.ui.notify(
				`🖼 当前模型 ${currentModel} 不支持图片，自动交给视觉代理识别...`,
				"info",
			);
		}

		const result = await recognizeImages(images, event.prompt ?? "", visionModels, ctx.signal, useOcr);
		if (!result) {
			return; // 全部失败，保持现状（图片会被 pi 自动省略）
		}

		return {
			message: {
				customType: "vision-bridge",
				content: [
					`[vision-bridge] 用户附带了图片，但当前模型 (${currentModel}) 不支持图片输入。`,
					`以下内容由 ${result.source} 识别图片后生成，请直接使用：`,
					"",
					result.text,
				].join("\n"),
				display: true,
			},
		};
	});

	pi.registerCommand("vision-bridge", {
		description:
			"Vision bridge: 用视觉模型/本地OCR识别图片并注入会话。用法: /vision-bridge [on|off|model <id>|models <a,b,c>|ocr on|off|status]",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const sub = parts[0]?.toLowerCase();

			if (sub === "off") {
				enabled = false;
				ctx.ui.notify("Vision bridge disabled.", "info");
			} else if (sub === "on") {
				enabled = true;
				ctx.ui.notify(`Vision bridge enabled. Models: ${visionModels.join(", ")}`, "info");
			} else if (sub === "model" && parts[1]) {
				visionModels = [parts[1]];
				ctx.ui.notify(`Vision model set to: ${parts[1]}`, "info");
			} else if (sub === "models" && parts[1]) {
				visionModels = parts[1].split(",").map((s) => s.trim()).filter(Boolean);
				ctx.ui.notify(`Vision models: ${visionModels.join(", ")}`, "info");
			} else if (sub === "ocr") {
				if (parts[1] === "off") {
					useOcr = false;
					ctx.ui.notify("OCR fallback disabled.", "info");
				} else if (parts[1] === "on") {
					useOcr = true;
					ctx.ui.notify("OCR fallback enabled.", "info");
				} else {
					ctx.ui.notify(`OCR fallback: ${useOcr ? "ON" : "OFF"}`, "info");
				}
			} else {
				ctx.ui.notify(
					`Vision bridge: ${enabled ? "ON" : "OFF"}\n` +
						`Models: ${visionModels.join(", ")}\n` +
						`OCR fallback: ${useOcr ? "ON" : "OFF"}\n` +
						`用法: /vision-bridge [on|off|model <id>|models <a,b,c>|ocr on|off]`,
					"info",
				);
			}
		},
	});
}
