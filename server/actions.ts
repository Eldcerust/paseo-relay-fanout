import type { ActionResult } from "../shared/status";
import type { FanoutConfig } from "./config";
import { addRelay, removeRelay, setPreference, type Change } from "./relays";

/** Where the actions read the current config from and send a new one to. */
export interface ActionHost {
  config(): FanoutConfig;
  /** Save the new config and apply it to the running proxy. May throw if it cannot be saved. */
  commit(next: FanoutConfig): void;
}

/**
 * The three changes the screen can make. Each checks the change, saves it, then applies it, and
 * answers with a message instead of throwing, so a refusal can be shown beside the field. Nothing
 * is applied if saving fails, so what is running never differs from what is on disk.
 */
export function createActions(host: ActionHost) {
  const run = (change: Change, name?: string): ActionResult => {
    if (!change.ok) return { ok: false, error: change.error };
    try {
      host.commit(change.config);
    } catch (error) {
      return { ok: false, error: `Could not save the config: ${(error as Error).message}` };
    }
    return name === undefined ? { ok: true } : { ok: true, name };
  };

  return {
    setPreference: (input: { mode: "auto" } | { mode: "preferred"; preferred: string }): ActionResult =>
      run(setPreference(host.config(), input)),
    addRelay: (input: { address: string; name?: string }): ActionResult => {
      const change = addRelay(host.config(), input);
      return run(change, change.ok ? change.upstream?.name : undefined);
    },
    removeRelay: (input: { name: string }): ActionResult => run(removeRelay(host.config(), input.name)),
  };
}
