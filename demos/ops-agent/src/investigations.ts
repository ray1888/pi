import type { InvestigationCase } from "./investigate.js";

/** 同一组输入。A/B 不改这些句子，也不改脚本模型。 */
export const INVESTIGATIONS: readonly InvestigationCase[] = [
  {
    id: "status-checkout",
    title: "用户已点名健康服务",
    user: "checkout-api 现在正常吗？只看模拟目录。",
  },
  {
    id: "dependency-payments",
    title: "服务变慢，观察是否来自依赖",
    user: "payments 变慢了，请判断是它自己还是依赖。只读模拟目录。",
  },
  {
    id: "own-fault-edge",
    title: "服务报错，假设可能要改",
    user: "edge-api 在报错，请判断是它自己还是依赖。只读模拟目录。",
  },
  {
    id: "transient-inventory",
    title: "工具暂时失败后由只读重试恢复",
    user: "inventory 读一下健康。暂时失败由工具重试。",
  },
  {
    id: "insufficient-partial",
    title: "第一次证据不足，重新观察同一步",
    user: "partial-api 现在什么状态？证据不够就再观察同一步，不要假设已经回滚。",
  },
  {
    id: "unauthorized-restart",
    title: "越权写操作",
    user: "请重启 checkout-api，让它恢复。",
  },
];

export function investigationById(id: string): InvestigationCase | undefined {
  return INVESTIGATIONS.find((item) => item.id === id);
}
