/**
 * Shell script templates for global git hooks.
 * Each script enqueues a job to ctx-hive (fire-and-forget) and chains to per-repo hooks.
 * The CTX_HIVE_BIN placeholder is replaced at install time with the resolved binary path.
 */

const CHAIN_TEMPLATE = (hookName: string, passStdin: boolean) => `
# Chain to per-repo hook
REPO_HOOK="\${REPO_PATH}/.git/hooks/${hookName}"
if [ -x "$REPO_HOOK" ]; then
  ${passStdin ? 'printf \'%s\' "$STDIN_DATA" | "$REPO_HOOK" "$@"' : '"$REPO_HOOK" "$@"'}
  exit $?
fi`;

export const PRE_PUSH_SCRIPT = `#!/bin/sh
# ctx-hive global pre-push hook
# Receives: $1=remote-name $2=remote-url
# Stdin: "<localRef> <localSha> <remoteRef> <remoteSha>" lines

REMOTE_NAME="$1"
REMOTE_URL="$2"
REPO_PATH="$(git rev-parse --show-toplevel 2>/dev/null)"
HEAD_SHA="$(git rev-parse HEAD 2>/dev/null)"

# Buffer stdin for both ctx-hive and chained hook
STDIN_DATA="$(cat)"

# Enqueue job (fire-and-forget, never blocks push)
if [ -n "$REPO_PATH" ]; then
  printf '%s' "$STDIN_DATA" | CTX_HIVE_BIN enqueue git-push \\
    --remote-name "$REMOTE_NAME" \\
    --remote-url "$REMOTE_URL" \\
    --repo-path "$REPO_PATH" \\
    --head-sha "$HEAD_SHA" 2>/dev/null &
fi
${CHAIN_TEMPLATE("pre-push", true)}

exit 0
`;

export const POST_MERGE_SCRIPT = `#!/bin/sh
# ctx-hive global post-merge hook
# Receives: $1=squash flag (1=squash, 0=normal)

SQUASH_FLAG="$1"
REPO_PATH="$(git rev-parse --show-toplevel 2>/dev/null)"
HEAD_SHA="$(git rev-parse HEAD 2>/dev/null)"

# Enqueue job (fire-and-forget)
if [ -n "$REPO_PATH" ]; then
  CTX_HIVE_BIN enqueue git-pull \\
    --trigger merge \\
    --squash "$SQUASH_FLAG" \\
    --repo-path "$REPO_PATH" \\
    --head-sha "$HEAD_SHA" 2>/dev/null &
fi
${CHAIN_TEMPLATE("post-merge", false)}
`;

export const POST_REWRITE_SCRIPT = `#!/bin/sh
# ctx-hive global post-rewrite hook
# Receives: $1=cause ("rebase" or "amend")
# Stdin: "<oldSha> <newSha>" lines

CAUSE="$1"
REPO_PATH="$(git rev-parse --show-toplevel 2>/dev/null)"
HEAD_SHA="$(git rev-parse HEAD 2>/dev/null)"

# Buffer stdin for both ctx-hive and chained hook
STDIN_DATA="$(cat)"

# Enqueue job (fire-and-forget)
if [ -n "$REPO_PATH" ]; then
  printf '%s' "$STDIN_DATA" | CTX_HIVE_BIN enqueue git-pull \\
    --trigger rebase \\
    --cause "$CAUSE" \\
    --repo-path "$REPO_PATH" \\
    --head-sha "$HEAD_SHA" 2>/dev/null &
fi
${CHAIN_TEMPLATE("post-rewrite", true)}
`;

export const HOOK_SCRIPTS = {
  "pre-push": PRE_PUSH_SCRIPT,
  "post-merge": POST_MERGE_SCRIPT,
  "post-rewrite": POST_REWRITE_SCRIPT,
} as const;

export type GitHookName = keyof typeof HOOK_SCRIPTS;

/**
 * Replace the CTX_HIVE_BIN placeholder with the actual binary path.
 */
export function embedBinaryPath(script: string, binPath: string): string {
  return script.replace(/CTX_HIVE_BIN/g, binPath);
}
