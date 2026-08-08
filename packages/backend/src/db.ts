import { config } from "./config";
import { createDatabase } from "./db-core";

export type {
  DbIntentStatus,
  DenialRow,
  IntentRow,
  MerchantProfileRow,
  SettlementFilter,
  SettlementRow,
} from "./db-core";

const store = createDatabase(config.dbPath);

export const {
  insertIntentRow,
  getIntentRow,
  setIntentStatus,
  setIntentAgentPayer,
  insertSettlementRow,
  recentSettlements,
  settlementsAfter,
  listSettlements,
  countSettlements,
  getMerchantProfile,
  upsertMerchantProfile,
  insertDenial,
  listDenials,
  countDenials,
  clearCache,
  getCursor,
  setCursor,
} = store;
