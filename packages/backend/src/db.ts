import { config } from "./config";
import { createDatabase } from "./db-core";

export type {
  DbIntentStatus,
  DenialRow,
  DisplayFloor,
  IntentRow,
  AgentWalletRow,
  SettlementFilter,
  SettlementRow,
} from "./db-core";

const store = createDatabase(config.dbPath);

export const {
  insertIntentRow,
  getIntentRow,
  setIntentStatus,
  setIntentAgentPayer,
  insertAgentWallet,
  agentWalletsBySigner,
  insertSettlementRow,
  recentSettlements,
  settlementsAfter,
  listSettlements,
  countSettlements,
  insertDenial,
  listDenials,
  countDenials,
  getDisplayFloor,
  setDisplayFloor,
  getCursor,
  setCursor,
} = store;
