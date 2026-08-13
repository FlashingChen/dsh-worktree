// @ts-check
/**
 * dsh-worktree — Codex-style permanent git worktrees for DeepSeek Harness.
 *
 * What this plugin gives a DSH profile:
 *
 * 1. Agent tools `worktree_create`, `worktree_list`, `worktree_remove` — the
 *    model can create a permanent detached worktree (like `codex worktree
 *    create --permanent`), list them, and remove them.
 * 2. A human `/worktree` command (`create | list | open | remove`) — the
 *    Codex CLI surface, in the DSH chat.
 * 3. Durable registration: every worktree is a real `git worktree add
 *    --detach` checkout under `<repo>/.dsh-worktrees/<name>`, recorded in a
 *    per-repo manifest, and registered in `ctx.workspaceRegistry` (the DSH
 *    workspace list) so new sessions can be started inside it.
 * 4. Session context: when a session runs inside a registered permanent
 *    worktree, the agent is told so once per session.
 *
 * @module dsh-worktree
 */
import crypto from "node:crypto";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { WorktreeManager, WorktreeError } from "./manager.js";

const name = "worktree";
const inject = ["tools", "commands", "subprocess"];

/**
 * Plugin configuration.
 * - `dirName`: directory (inside each git repo root) that holds worktrees and
 *   the manifest. Default `.dsh-worktrees` — same hidden-dir pattern as
 *   Codex's `.codex/worktrees`.
 */
const Config = z.object({
	dirName: z.string().default(".dsh-worktrees")
});

/** Resolve the working directory a tool/command call operates from. */
function sessionCwd(agent) {
	return agent?.session?.header?.cwd ?? process.cwd();
}

/** Short formatter for a commit SHA (like `git rev-parse --short`). */
function shortSha(sha) {
	return sha.length > 7 ? sha.slice(0, 7) : sha;
}

/** Render a list result as plain text (shared by tool output and command). */
function renderList(result) {
	const { repoRoot, worktrees, dir } = result;
	if (worktrees.length === 0) {
		return `No permanent worktrees in ${repoRoot}.\nCreate one with worktree_create or /worktree create <name> [<base-commit>].`;
	}
	const lines = [`Permanent worktrees of ${repoRoot} (${dir}):`];
	for (const entry of worktrees) {
		const head = entry.branch ?? (entry.head ? `detached @ ${shortSha(entry.head)}` : "missing checkout");
		const state = entry.exists ? head : "REMOVED (unregistered from git)";
		lines.push(`  ${entry.name}  →  ${entry.path}  [${state}]  base ${shortSha(entry.baseCommit)}`);
	}
	return lines.join("\n");
}

/**
 * Create a permanent worktree and register it as a DSH workspace so it shows
 * up in the workspace picker / sidebar. Best-effort: registry failures never
 * fail the git operation.
 */
async function createAndRegister(ctx, manager, params) {
	const result = await manager.create(params);
	const registry = ctx.get("workspaceRegistry");
	if (registry !== undefined) {
		try {
			await registry.create(result.worktree.path, `[worktree] ${result.worktree.name}`);
		} catch (error) {
			// The worktree exists and is durable; only the convenience
			// registration failed. Leave a note in the tool text.
			result.registrationWarning = `workspace registration skipped: ${error.message}`;
		}
	}
	return result;
}

/** Best-effort removal of a worktree's workspace registration (dir is gone). */
async function unregisterWorkspace(ctx, manager, pathToRemove) {
	const registry = ctx.get("workspaceRegistry");
	if (registry === undefined) return;
	try {
		const workspace = await registry.resolveByPath(pathToRemove);
		if (workspace !== undefined) await registry.delete(workspace.id);
	} catch {
		// Stale registration is harmless; the worktree itself is already gone.
	}
}

/** Register the three model-facing worktree tools. */
function registerTools(ctx, manager) {
	ctx.tools.register(defineTool({
		name: "worktree_create",
		description: "Create a PERMANENT git worktree — a detached checkout of a commit in its own directory (like `codex worktree create --permanent`). The worktree survives after this session ends and can be reopened from new sessions; it is registered in the workspace list. Use it to experiment, fork work, or parallelize without touching the main working tree.",
		parameters: {
			name: {
				type: "string",
				required: true,
				description: "Unique name for the worktree (letters, digits, '.', '_', '-'; no leading '-' or '.')."
			},
			baseCommit: {
				type: "string",
				description: "Commit-ish to check out (default: the repository's current HEAD)."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					name: { type: "string", required: true },
					path: { type: "string", required: true },
					repoRoot: { type: "string", required: true },
					baseCommit: { type: "string", required: true },
					permanent: { type: "boolean", required: true },
					createdAt: { type: "string", required: true },
					registrationWarning: { type: "string" }
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: [
					`Created permanent worktree ${JSON.stringify(value.name)} at ${value.path}`,
					`  repo: ${value.repoRoot}`,
					`  base commit: ${value.baseCommit} (permanent)`,
					`  tip: work there with the file tools, or start a new session with this workspace.`,
					...(value.registrationWarning !== undefined ? [`  note: ${value.registrationWarning}`] : [])
				].join("\n")
			}]
		},
		execute(args, exec) {
			const cwd = sessionCwd(exec.agent);
			return createAndRegister(ctx, manager, {
				name: args.name,
				baseCommit: args.baseCommit,
				cwd,
				createdBy: exec.agent ? String(exec.agent.session.id) : null,
				signal: exec.signal
			}).then((result) => ({
				name: result.worktree.name,
				path: result.worktree.path,
				repoRoot: result.repoRoot,
				baseCommit: result.worktree.baseCommit,
				permanent: result.worktree.permanent,
				createdAt: result.worktree.createdAt,
				...(result.registrationWarning !== undefined ? { registrationWarning: result.registrationWarning } : {})
			}));
		},
		presentCall: (args) => ({
			card: "generic",
			title: "Create permanent worktree",
			kind: "other",
			rawInput: args
		})
	}));

	ctx.tools.register(defineTool({
		name: "worktree_list",
		description: "List the permanent git worktrees of the repository containing the current session, with their paths, base commits, and live git state (HEAD/branch).",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					repoRoot: { type: "string", required: true },
					dir: { type: "string", required: true },
					worktrees: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								name: { type: "string", required: true },
								path: { type: "string", required: true },
								baseCommit: { type: "string", required: true },
								createdAt: { type: "string", required: true },
								permanent: { type: "boolean", required: true },
								exists: { type: "boolean", required: true },
								head: { type: "string" },
								branch: { type: "string" }
							}
						}
					}
				}
			},
			render: (_args, value) => [{ type: "text", text: renderList(value) }]
		},
		execute(_args, exec) {
			return manager.list(sessionCwd(exec.agent), exec.signal).then((result) => ({
				repoRoot: result.repoRoot,
				dir: result.dir,
				worktrees: result.worktrees.map((entry) => ({
					name: entry.name,
					path: entry.path,
					baseCommit: entry.baseCommit,
					createdAt: entry.createdAt,
					permanent: entry.permanent,
					exists: entry.exists,
					...(entry.head !== null ? { head: entry.head } : {}),
					...(entry.branch !== null ? { branch: entry.branch } : {})
				}))
			}));
		},
		presentCall: () => ({
			card: "generic",
			title: "List permanent worktrees",
			kind: "other",
			rawInput: {}
		})
	}));

	ctx.tools.register(defineTool({
		name: "worktree_remove",
		description: "Remove a permanent git worktree created by this plugin (its manifest entry and, with force, even uncommitted changes). Refuses to remove the worktree the current session is working inside. Use worktree_list first to see names.",
		parameters: {
			name: {
				type: "string",
				required: true,
				description: "Registered worktree name to remove."
			},
			force: {
				type: "boolean",
				description: "Pass --force to git so removal succeeds even with uncommitted changes (default false)."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					name: { type: "string", required: true },
					path: { type: "string", required: true },
					repoRoot: { type: "string", required: true },
					removed: { type: "boolean", required: true },
					force: { type: "boolean", required: true }
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: `Removed permanent worktree ${JSON.stringify(value.name)} at ${value.path}${value.force ? " (forced)" : ""}.`
			}]
		},
		execute(args, exec) {
			const cwd = sessionCwd(exec.agent);
			return manager.remove({
				name: args.name,
				cwd,
				currentDir: cwd,
				force: args.force === true,
				signal: exec.signal
			}).then(async (result) => {
				await unregisterWorkspace(ctx, manager, result.path);
				return result;
			});
		},
		presentCall: (args) => ({
			card: "generic",
			title: "Remove permanent worktree",
			kind: "other",
			rawInput: args
		})
	}));
}

/** Parse `/worktree ...` into a typed request; errors carry usage help. */
function parseCommand(rawInput) {
	const tokens = rawInput.trim().split(/\s+/u).filter(Boolean);
	const usage = "Usage: /worktree create <name> [<base-commit>] | /worktree list | /worktree open <name> | /worktree remove <name>";
	if (tokens.length === 0) return { kind: "list" };
	const [verb, ...rest] = tokens;
	switch (verb) {
		case "list":
		case "ls":
			if (rest.length !== 0) return { kind: "usage" };
			return { kind: "list" };
		case "create":
		case "creat": {
			if (rest.length < 1 || rest.length > 2) return { kind: "usage" };
			return { kind: "create", name: rest[0], baseCommit: rest[1] };
		}
		case "open":
		case "remove":
		case "close":
		case "delete": {
			if (rest.length !== 1) return { kind: "usage" };
			return { kind: verb === "open" ? "open" : "remove", name: rest[0] };
		}
		default:
			return { kind: "unknown", verb };
	}
}

/**
 * Execute one parsed `/worktree` request against the manager.
 * @returns {Promise<{kind: "success"|"error", text: string}>}
 */
async function executeWorktreeCommand(ctx, manager, invocation) {
	const parsed = parseCommand(invocation.rawInput);
	const cwd = sessionCwd(invocation.agent);
	const usage = "Usage: /worktree create <name> [<base-commit>] | /worktree list | /worktree open <name> | /worktree remove <name>";
	try {
		switch (parsed.kind) {
			case "usage":
				return { kind: "error", text: usage };
			case "unknown":
				return { kind: "error", text: `Unknown /worktree verb ${JSON.stringify(parsed.verb)}.\n${usage}` };
			case "list": {
				const result = await manager.list(cwd, invocation.signal);
				return { kind: "success", text: renderList(result) };
			}
			case "create": {
				const result = await createAndRegister(ctx, manager, {
					name: parsed.name,
					baseCommit: parsed.baseCommit,
					cwd,
					createdBy: null,
					signal: invocation.signal
				});
				const note = result.registrationWarning !== undefined ? `\nnote: ${result.registrationWarning}` : "";
				return {
					kind: "success",
					text: [
						`Created permanent worktree ${JSON.stringify(result.worktree.name)} at ${result.worktree.path}`,
						`  repo: ${result.repoRoot}`,
						`  base commit: ${result.worktree.baseCommit}`,
						`Open a new session with the "[worktree] ${result.worktree.name}" workspace to work inside it.`,
						note
					].filter(Boolean).join("\n")
				};
			}
			case "open": {
				const list = await manager.list(cwd, invocation.signal);
				const entry = list.worktrees.find((candidate) => candidate.name === parsed.name);
				if (entry === undefined) {
					return { kind: "error", text: `no registered worktree named ${JSON.stringify(parsed.name)} in ${list.repoRoot}` };
				}
				if (!entry.exists) {
					return { kind: "error", text: `worktree ${JSON.stringify(parsed.name)} is registered but its checkout is gone (${entry.path})` };
				}
				let registered = false;
				const registry = ctx.get("workspaceRegistry");
				if (registry !== undefined) {
					try {
						await registry.create(entry.path, `[worktree] ${entry.name}`);
						registered = true;
					} catch {
						// keep going; the path itself is what matters
					}
				}
				const head = entry.branch ?? (entry.head ? `detached @ ${shortSha(entry.head)}` : "unknown");
				return {
					kind: "success",
					text: [
						`Permanent worktree ${JSON.stringify(entry.name)} of ${list.repoRoot}`,
						`  path: ${entry.path}`,
						`  base commit: ${entry.baseCommit}`,
						`  current: ${head}`,
						registered
							? "Registered as a workspace — start a new session and pick it from the workspace list to work inside it."
							: "Start a new session with this directory as its workspace to work inside it."
					].join("\n")
				};
			}
			case "remove": {
				const result = await manager.remove({
					name: parsed.name,
					cwd,
					currentDir: cwd,
					signal: invocation.signal
				});
				await unregisterWorkspace(ctx, manager, result.path);
				return { kind: "success", text: `Removed permanent worktree ${JSON.stringify(result.name)} at ${result.path}.` };
			}
			default:
				return { kind: "error", text: usage };
		}
	} catch (error) {
		if (error instanceof WorktreeError) return { kind: "error", text: error.message };
		throw error;
	}
}

/** Register the human-facing `/worktree` command (Codex CLI surface). */
function registerCommand(ctx, manager) {
	ctx.commands.register({
		name: "worktree",
		description: "create, list, open, or remove permanent git worktrees",
		input: { hint: "create <name> [<base-commit>] | list | open <name> | remove <name>" },
		handler: (invocation) => executeWorktreeCommand(ctx, manager, invocation)
	});
}

/** Render the once-per-session worktree context note. */
function renderWorktreeNote(repoRoot, worktree) {
	return [
		`You are working inside the permanent git worktree ${JSON.stringify(worktree.name)} of ${repoRoot}.`,
		`  worktree path: ${worktree.path}`,
		`  base commit: ${worktree.baseCommit}`,
		"Manage worktrees with worktree_create / worktree_list / worktree_remove, or the /worktree command."
	].join("\n");
}

/**
 * Announce, once per session, when a session runs inside a registered
 * permanent worktree (mirrors Codex showing the worktree in the session).
 */
function registerContextNote(ctx, manager) {
	/** @type {Map<string, {repoRoot: string, worktree: import("./manager.js").WorktreeEntry}|null>} */
	const lookedUp = new Map();
	const announced = new Set();
	ctx.on("agent/pre-step", async ({ agent, signal }, next) => {
		const decision = await next();
		if (decision.kind === "reject" || signal.aborted) return decision;
		const cwd = agent.session.header.cwd;
		if (typeof cwd !== "string") return decision;
		const sessionId = String(agent.session.id);
		let found = lookedUp.get(sessionId);
		if (found === undefined) {
			found = (await manager.findForCwd(cwd, signal)) ?? null;
			lookedUp.set(sessionId, found);
		}
		if (found === null || announced.has(sessionId)) return decision;
		announced.add(sessionId);
		const text = renderWorktreeNote(found.repoRoot, found.worktree);
		return {
			kind: "enter",
			messages: [...decision.messages, {
				id: crypto.randomUUID(),
				role: "user",
				content: [{ type: "text", text }],
				source: {
					kind: "plugin",
					plugin: name,
					form: "snapshot",
					sections: [{ name, text }]
				}
			}]
		};
	}, { prepend: true });
}

/**
 * Mount the plugin: worktree service, tools, command, and context note.
 * @param {import("@deepseek-ai/cordis").Context} ctx
 * @param {{dirName: string}} config
 */
function apply(ctx, config) {
	const manager = new WorktreeManager(ctx, { dirName: config.dirName });
	ctx.provide("worktree", manager);
	registerTools(ctx, manager);
	registerCommand(ctx, manager);
	registerContextNote(ctx, manager);
}

export { Config, WorktreeManager, WorktreeError, apply, inject, name };
