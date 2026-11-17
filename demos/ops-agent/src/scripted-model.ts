import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type AssistantMessage,
  type FauxProviderHandle,
  type FauxResponseStep,
  type Model,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { PIN } from "./pin.js";

export const SCRIPTED_MODEL_ADAPTER = PIN.modelAdapter;

export interface ScriptedModel {
  readonly adapter: typeof SCRIPTED_MODEL_ADAPTER;
  readonly model: Model<string>;
  readonly streamFn: StreamFn;
  readonly faux: FauxProviderHandle;
}

/** fauxProvider 是 pi-ai 自带的脚本模型，不会发网络请求。它不是 LLM。 */
export function createScriptedModel(responses: readonly FauxResponseStep[]): ScriptedModel {
  const faux = fauxProvider({ tokensPerSecond: 0 });
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  faux.setResponses([...responses]);
  const streamFn: StreamFn = (nextModel, context, options) => models.streamSimple(nextModel, context, options);
  return { adapter: SCRIPTED_MODEL_ADAPTER, model, streamFn, faux };
}

export function toolCall(name: string, args: Record<string, string>, id: string): AssistantMessage {
  return fauxAssistantMessage([fauxToolCall(name, args, { id })], { stopReason: "toolUse" });
}

export function say(text: string): AssistantMessage {
  return fauxAssistantMessage(text, { stopReason: "stop" });
}

export function providerError(errorMessage: string): AssistantMessage {
  return fauxAssistantMessage("", { stopReason: "error", errorMessage });
}

export function repeat<T>(value: T, count: number): T[] {
  return Array.from({ length: count }, () => value);
}

export type ScriptStep = (context: TranscriptContext) => AssistantMessage;
