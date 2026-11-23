import { Code, ConnectError } from "@connectrpc/connect";
import { type Context } from "@earendil-works/chord/context";
import { type Models, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import { defineDoc, type Harness, type Tx } from "@earendil-works/pi-durable";

type Defaults = { model: { provider: string; modelId: string }; thinkingLevel: ModelThinkingLevel };

export const SubagentDefaultsDoc = defineDoc<Defaults>({
  kind: "anima.subagent-defaults", version: 1, scope: "session", checkpointWhen: () => false,
  initial: () => ({ model: { provider: "openai", modelId: "gpt-6-luna" }, thinkingLevel: "high" }),
});

export async function subagentDefaults(tx: Tx): Promise<Defaults> {
  const defaults = await tx.doc(SubagentDefaultsDoc);
  return { model: { ...defaults.model }, thinkingLevel: defaults.thinkingLevel };
}

export async function updateSubagentDefaults(
  harness: Harness,
  models: Models | undefined,
  request: { model?: Defaults["model"]; thinkingLevel: string },
  context: Context,
): Promise<Defaults> {
  if (!request.model?.provider || !request.model.modelId || !request.thinkingLevel) {
    throw new ConnectError("Model and thinking level are required", Code.InvalidArgument);
  }
  if (!models) throw new ConnectError("The server model catalog is unavailable", Code.FailedPrecondition);
  const { provider, modelId } = request.model;
  const available = await models.getAvailableOfType("chat", provider, { signal: context.abortSignal });
  const model = available.find(candidate => candidate.provider === provider && candidate.id === modelId);
  if (!model) throw new ConnectError("Chat model is not available on this server", Code.InvalidArgument);
  const level = getSupportedThinkingLevels(model).find(candidate => candidate === request.thinkingLevel);
  if (level === undefined) throw new ConnectError("Thinking level is not supported by the selected model", Code.InvalidArgument);
  return harness.commit(async tx => {
    const defaults = await tx.doc(SubagentDefaultsDoc);
    defaults.model = { provider, modelId };
    defaults.thinkingLevel = level;
    return { model: { provider, modelId }, thinkingLevel: level };
  }, context);
}
