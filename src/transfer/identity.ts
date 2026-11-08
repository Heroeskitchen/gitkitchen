// Who is asking for a transfer command. No vscode imports, so it runs under Vitest.
// Callers cannot name their own class. The class comes from the process environment and from
// whether the command was invoked with arguments. Only a person at the editor (workbench) may
// check or apply. Agents are denied for client folders and link targets, so there is no
// "local agent" class that is allowed in this build.

export type Actor = 'workbench' | 'agent' | 'cloud' | 'unidentified';

/** Environment variables that mark an agent or a cloud session. A marker counts even when empty. */
export const AGENT_ENV_MARKERS = ['CURSOR_AGENT', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_SANDBOX'] as const;
export const CLOUD_ENV_MARKERS = ['CLAUDE_CODE_REMOTE', 'CURSOR_CLOUD_AGENT', 'CODESPACES'] as const;

export interface ActorInput {
  /** Process environment. Defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Arguments the command was invoked with. The palette and menus pass none. */
  args?: readonly unknown[];
}

export function resolveActor(input: ActorInput = {}): Actor {
  try {
    const env = input.env === undefined ? process.env : input.env;
    if (env === null || typeof env !== 'object') return 'unidentified';
    for (const key of CLOUD_ENV_MARKERS) if (Object.prototype.hasOwnProperty.call(env, key)) return 'cloud';
    for (const key of AGENT_ENV_MARKERS) if (Object.prototype.hasOwnProperty.call(env, key)) return 'agent';
    if (input.args !== undefined && !Array.isArray(input.args)) return 'unidentified';
    // A programmatic invoke carries arguments. A palette or menu click does not.
    if (input.args && input.args.length > 0) return 'agent';
    return 'workbench';
  } catch {
    return 'unidentified';
  }
}

export function mayCheckOrApply(actor: Actor): boolean {
  return actor === 'workbench';
}
