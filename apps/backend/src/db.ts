import { config } from "./config";
import { createDatabase } from "./db-core";

export type { DbIntentStatus, IntentRow, SettlementRow } from "./db-core";

const store = createDatabase(config.dbPath);

export const {
  insertIntentRow,
  getIntentRow,
  setIntentStatus,
  setIntentAgentPayer,
  insertSettlementRow,
  recentSettlements,
  settlementsAfter,
  clearCache,
  getCursor,
  setCursor,
} = store;
