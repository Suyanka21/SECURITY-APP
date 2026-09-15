/**
 * Runs the production configuration check as a module side effect so it
 * executes in import order, ahead of any module that reads process.env at
 * load time (DB pool, auth middleware, CORS allowlist).
 */
import { assertProductionConfig } from "./production-config";

assertProductionConfig();
