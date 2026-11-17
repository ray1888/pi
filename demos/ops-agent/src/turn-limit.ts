import type { AgentTurnDecision, FinishTurn } from "@earendil-works/pi-agent-core";
import { BOUNDS } from "./pin.js";

export interface TurnLimit {
  readonly maxTurns: number;
  readonly onTurn: (index: number, stopReason: string) => void;
  readonly onCap: (turns: number) => void;
  hitCap: boolean;
}

/** finishTurn 在工具结果写完、下一轮模型请求之前。返回 end 时循环停止，不再排下一轮。 */
export function createTurnLimit(limit: TurnLimit): FinishTurn {
  if (!Number.isInteger(limit.maxTurns) || limit.maxTurns < 1 || limit.maxTurns > BOUNDS.maxTurns) {
    throw new Error(`maxTurns 必须是 1 到 ${BOUNDS.maxTurns} 的整数`);
  }
  let turns = 0;
  return async (turn): Promise<AgentTurnDecision | undefined> => {
    if (turn.message.stopReason === "error" || turn.message.stopReason === "aborted") return undefined;
    turns += 1;
    limit.onTurn(turns, turn.message.stopReason);
    if (turns >= limit.maxTurns) {
      limit.hitCap = true;
      limit.onCap(turns);
      return { action: "end" };
    }
    return undefined;
  };
}
