import { stateStore } from "../state/store.js";

export {
  auditWrite,
  auditedMutation,
  backupBindingState,
  backupParameterState,
  PostSideEffectAuditError,
} from "../state/audit.js";
export function ensureStateDir(config: { stateDir: string }) {
  return stateStore(config.stateDir).ensureDirectory(config.stateDir);
}
