export {
  AGENT_CONTRACT_VERSION, AgentContractError,
} from './contract.js';
export type {
  ActionOutcome, AgentAction, AgentAnswer, AgentCapabilities, AgentCitation, AgentEvent,
  AgentPort, AgentQuestion, AgentRefusal, AgentTarget, AgentTurn, ViewerContext,
} from './contract.js';
export { AgentBridge } from './bridge.js';
export type { AskResult, ViewerCommands } from './bridge.js';
export { StubAgent } from './stub.js';
export { adaptM3xiAgent } from './m3xiAdapter.js';
export type { ExternalAgent, ExternalAskResult, M3xiAdapterOptions } from './m3xiAdapter.js';
