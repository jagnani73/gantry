import { config } from "./config";
import { createDatabase } from "./db-core";

export type {
  DbIntentStatus,
  DenialRow,
  IntentRow,
  AgentWalletRow,
  MerchantRow,
  SettlementFilter,
  SettlementRow,
} from "./db-core";

const store = createDatabase(config.dbPath);

export const {
  insertIntentRow,
  getIntentRow,
  setIntentStatus,
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
  insertMerchant,
  setMerchantProfileRow,
  getMerchantRow,
  listMerchants,
  countMerchants,
  getCursor,
  setCursor,
} = store;
