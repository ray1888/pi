import { createModels, type Model } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";

/**
 * 可选。测试不会加载这个文件。
 * 密钥只从你自己注入的 OPENAI_API_KEY 读取，不打印、不写盘、不搜索文件。
 * 真实 provider 内部已有 retryProviderRequest；这里不再套 retryAssistantCall。
 */
export async function loadLiveModel(): Promise<{ model: Model<string>; streamFn: StreamFn }> {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("缺少 OPENAI_API_KEY。请自行注入环境变量。本 demo 不会读取密钥文件，也不会打印变量值。");
  }
  const { openaiProvider } = await import("@earendil-works/pi-ai/providers/openai");
  const models = createModels();
  models.setProvider(openaiProvider());
  const modelId = process.env.PI_OPS_DEMO_MODEL ?? "gpt-4.1-mini";
  const model = models.getModel("openai", modelId);
  if (!model) {
    throw new Error(`pi-ai 1.5.2 的 openai 目录里没有 ${modelId}。用 PI_OPS_DEMO_MODEL 指定一个目录中的 id。`);
  }
  const streamFn: StreamFn = (nextModel, context, options) => models.streamSimple(nextModel, context, options);
  return { model, streamFn };
}
