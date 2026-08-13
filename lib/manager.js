// @ts-check
/**
 * dsh-worktree core: permanent git worktree management over the DSH
 * subprocess seam (`ctx.subprocess`). Mirrors the semantics of
 * `codex worktree create --permanent`:
 *
 * - A worktree is a real `git worktree add --detach <path> <commit>` checkout
 *   that lives on disk forever (it is never auto-removed by session teardown).
 * - Worktrees live under `<repo-root>/.dsh-worktrees/<name>` (like Codex's
 *   `.codex/worktrees/<name>`), so they stay inside the repository and,
 *   when the session workspace IS the repo root, inside the session's
 *   workspace-write sandbox.
 * - A per-repository manifest (`<repo-root>/.dsh-worktrees/manifest.json`)
 *   records every permanent worktree; it is what makes them durable across
 *   DSH restarts and discoverable by `/worktree` and the agent tools.
 *
 * The module is framework-light on purpose: it only needs a `ctx` carrying
 * `ctx.subprocess` (see {@link WorktreeManager}), which keeps the git logic
 * testable without booting a DSH profile.
 *
 * @module dsh-worktree/manager
 */
import fs from "node:fs";
import path from "node:path";

/**
 * A stable, machine-readable failure of worktree management. The message is
 * already user-facing (it is surfaced verbatim by tools and the command).
 */
export class WorktreeError extends Error {
	/** @param {string} code - stable error code, e.g. `NOT_A_GIT_REPO`. */
	constructor(code, message, options) {
		super(message, options);
		this.name = "WorktreeError";
		this.code = code;
	}
}

/** Manifest schema version written and read by this manager. */
const MANIFEST_VERSION = 1;
/** Git worktree names are one path segment: no spaces, no leading `-`/`.`. */
const WORKTREE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
/** Long names make for unwieldy paths; Codex names are short tokens. */
const MAX_NAME_LENGTH = 100;
/** Collect caps for `git` stdout/stderr (git output is tiny). */
const GIT_COLLECT_BYTES = 1 << 20;
/** Grace for the SIGTERM → SIGKILL escalation when a git child is aborted. */
const GIT_GRACE_MS = 30_000;

/**
 * Run one git command through `ctx.subprocess` and return its collected
 * outcome. Never shell-interpreted; argv is passed verbatim.
 */
async function git(ctx, argv, cwd, signal) {
	const handle = ctx.subprocess.spawn({
		argv: ["git", ...argv],
		cwd,
		stdio: {
			stdin: "ignore",
			stdout: { maxBytes: GIT_COLLECT_BYTES },
			stderr: { maxBytes: GIT_COLLECT_BYTES }
		},
		graceMs: GIT_GRACE_MS,
		signal
	});
	const outcome = await handle.done;
	const stdout = handle.collected.stdout?.readFrom(0).text ?? "";
	const stderr = handle.collected.stderr?.readFrom(0).text ?? "";
	return {
		exitCode: outcome.exitCode,
		signal: outcome.signal,
		stdout: stdout.trim(),
		stderr: stderr.trim()
	};
}

/** Whether a path exists (file, directory, or dangling symlink target aside). */
async function exists(p) {
	try {
		await fs.promises.stat(p);
		return true;
	} catch (error) {
		if (error.code === "ENOENT") return false;
		throw error;
	}
}

/**
 * Compare two paths canonically enough for containment checks: resolve
 * symlinks when possible, otherwise fall back to the lexical absolute path.
 */
function canonical(p) {
	try {
		return fs.realpathSync(p);
	} catch {
		return path.resolve(p);
	}
}

/** Whether `candidate` is `base` itself or a descendant of `base`. */
function isWithin(base, candidate) {
	const root = canonical(base);
	const target = canonical(candidate);
	return target === root || target.startsWith(root + path.sep);
}

/**
 * Durable record of one permanent worktree, as stored in the manifest.
 *
 * @typedef {object} WorktreeEntry
 * @property {string} name - unique name inside the repository.
 * @property {string} path - absolute worktree path (inside `.dsh-worktrees/`).
 * @property {string} baseCommit - resolved commit SHA checked out at creation.
 * @property {string} createdAt - ISO timestamp.
 * @property {string|null} createdBy - session id or `null` for `/worktree`.
 * @property {true} permanent - always true; the plugin only makes permanent worktrees.
 */

/**
 * Live git facts for one registered worktree path, matched against
 * `git worktree list --porcelain`.
 *
 * @typedef {object} WorktreeStatus
 * @property {string} path - absolute worktree path.
 * @property {string|null} head - full HEAD commit SHA.
 * @property {string|null} branch - checked-out branch name, or null when detached.
 */

/**
 * Result of {@link WorktreeManager.create}.
 *
 * @typedef {object} CreateResult
 * @property {string} repoRoot - main repository root (manifest owner).
 * @property {WorktreeEntry} worktree - the new durable entry.
 */

/**
 * Result of {@link WorktreeManager.list}.
 *
 * @typedef {object} ListResult
 * @property {string} repoRoot - main repository root.
 * @property {string} dir - the `.dsh-worktrees/` directory holding the manifest.
 * @property {Array<WorktreeEntry & {exists: boolean, head: string|null, branch: string|null}>} worktrees - registered entries plus live git facts.
 */

/**
 * Manager for one DSH context's permanent worktrees. All git work runs
 * through `ctx.subprocess`, so sandbox and process-tree semantics are the
 * harness's own.
 */
export class WorktreeManager {
	/**
	 * @param {object} ctx - context exposing `ctx.subprocess` (a `SubprocessRuntime`).
	 * @param {object} [options]
	 * @param {string} [options.dirName] - worktree directory name inside the repo root (default `.dsh-worktrees`).
	 */
	constructor(ctx, options = {}) {
		this.ctx = ctx;
		/** @type {string} */
		this.dirName = options.dirName ?? ".dsh-worktrees";
		/** Per-repo manifest cache; `null` means verified-absent. @type {Map<string, object|null>} */
		this.manifestCache = new Map();
	}

	/**
	 * Resolve the main repository root that owns worktree operations for a
	 * working directory. Works from the main checkout AND from inside a
	 * linked worktree (`--git-common-dir` points at the main repo's `.git`).
	 * @param {string} cwd - any directory inside the repository.
	 * @param {AbortSignal} [signal]
	 * @returns {Promise<string>} absolute main repo root.
	 */
	async resolveRepoRoot(cwd, signal) {
		const result = await git(this.ctx, ["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd, signal);
		if (result.exitCode !== 0) {
			const detail = result.stderr || "not a git repository";
			throw new WorktreeError("NOT_A_GIT_REPO", `${detail} (${cwd})`);
		}
		// git reports real paths; canonicalize so a repo reached through a
		// symlinked parent (macOS /tmp, /var) has ONE spelling as manifest
		// owner and cache key — never two.
		return canonical(path.resolve(path.dirname(result.stdout)));
	}

	/** Absolute manifest path for a repo root. */
	manifestPath(root) {
		return path.join(root, this.dirName, "manifest.json");
	}

	/**
	 * Load (and cache) the manifest for a repo root. Returns `null` when the
	 * repository has no manifest yet; a malformed manifest fails loud instead
	 * of being overwritten silently.
	 * @param {string} root - main repo root.
	 * @param {AbortSignal} [signal]
	 * @returns {Promise<{version: number, worktrees: WorktreeEntry[]}|null>}
	 */
	async loadManifest(root, signal) {
		if (this.manifestCache.has(root)) return this.manifestCache.get(root);
		const file = this.manifestPath(root);
		let manifest = null;
		try {
			const raw = await fs.promises.readFile(file, "utf8");
			const parsed = JSON.parse(raw);
			if (parsed?.version !== MANIFEST_VERSION || !Array.isArray(parsed.worktrees)) {
				throw new Error("unsupported manifest shape");
			}
			manifest = parsed;
		} catch (error) {
			if (error.code !== "ENOENT") {
				throw new WorktreeError("MANIFEST_CORRUPT", `worktree manifest ${file} is unreadable: ${error.message}`, { cause: error });
			}
		}
		this.manifestCache.set(root, manifest);
		return manifest;
	}

	/** Persist a manifest atomically (tmp file + rename) and refresh the cache. */
	async saveManifest(root, manifest) {
		const dir = path.join(root, this.dirName);
		await fs.promises.mkdir(dir, { recursive: true });
		const file = path.join(dir, "manifest.json");
		const tmp = `${file}.tmp-${process.pid}`;
		await fs.promises.writeFile(tmp, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
		await fs.promises.rename(tmp, file);
		this.manifestCache.set(root, manifest);
	}

	/**
	 * Resolve a commit-ish to its full SHA inside the repository.
	 * @param {string} root - main repo root.
	 * @param {string|undefined} baseCommit - commit-ish; defaults to `HEAD`.
	 * @param {AbortSignal} [signal]
	 * @returns {Promise<{ref: string, sha: string}>}
	 */
	async resolveCommit(root, baseCommit, signal) {
		const ref = baseCommit?.trim() || "HEAD";
		const result = await git(this.ctx, ["rev-parse", "--verify", `${ref}^{commit}`], root, signal);
		if (result.exitCode !== 0) {
			throw new WorktreeError("BAD_COMMIT", `cannot resolve commit ${JSON.stringify(ref)}: ${result.stderr || "unknown revision"}`);
		}
		return { ref, sha: result.stdout };
	}

	/**
	 * Create a PERMANENT git worktree, exactly like `codex worktree create
	 * --permanent`: a detached checkout of `baseCommit` (default HEAD) under
	 * `<repo>/.dsh-worktrees/<name>`, recorded in the manifest so it survives
	 * restarts and sessions.
	 * @param {object} params
	 * @param {string} params.name - worktree name (one path segment).
	 * @param {string} [params.baseCommit] - commit-ish; default current HEAD.
	 * @param {string} params.cwd - session working directory (repo discovery base).
	 * @param {string|null} [params.createdBy] - session id attribution, or null.
	 * @param {AbortSignal} [signal]
	 * @returns {Promise<CreateResult>}
	 */
	async create({ name, baseCommit, cwd, createdBy = null, signal }) {
		const trimmed = name.trim();
		if (!WORKTREE_NAME.test(trimmed) || trimmed === "." || trimmed === "..") {
			throw new WorktreeError("INVALID_NAME", `invalid worktree name ${JSON.stringify(name)}: use letters, digits, '.', '_' or '-', without leading '-' or '.'`);
		}
		if (trimmed.length > MAX_NAME_LENGTH) {
			throw new WorktreeError("INVALID_NAME", `worktree name too long (max ${MAX_NAME_LENGTH} characters)`);
		}
		const root = await this.resolveRepoRoot(cwd, signal);
		const target = path.join(root, this.dirName, trimmed);
		if (await exists(target)) {
			throw new WorktreeError("ALREADY_EXISTS", `a directory already exists at ${target}`);
		}
		const manifest = await this.loadManifest(root, signal);
		if (manifest?.worktrees.some((entry) => entry.name === trimmed)) {
			throw new WorktreeError("ALREADY_EXISTS", `worktree ${JSON.stringify(trimmed)} already exists in ${root}`);
		}
		const commit = await this.resolveCommit(root, baseCommit, signal);
		const result = await git(this.ctx, ["worktree", "add", "--detach", target, commit.sha], root, signal);
		if (result.exitCode !== 0) {
			throw new WorktreeError("GIT_FAILED", `git worktree add failed: ${result.stderr || result.stdout}`);
		}
		const entry = {
			name: trimmed,
			path: target,
			baseCommit: commit.sha,
			createdAt: new Date().toISOString(),
			createdBy,
			permanent: true
		};
		const next = manifest ?? { version: MANIFEST_VERSION, worktrees: [] };
		next.worktrees.push(entry);
		await this.saveManifest(root, next);
		return { repoRoot: root, worktree: entry };
	}

	/**
	 * Live `git worktree list --porcelain` facts for every path in a repo.
	 * @param {string} root - main repo root.
	 * @param {AbortSignal} [signal]
	 * @returns {Promise<Map<string, WorktreeStatus>>} path → status.
	 */
	async liveWorktrees(root, signal) {
		const result = await git(this.ctx, ["worktree", "list", "--porcelain"], root, signal);
		const map = new Map();
		if (result.exitCode !== 0) return map;
		/** @type {WorktreeStatus|null} */
		let current = null;
		for (const line of result.stdout.split("\n")) {
			if (line.startsWith("worktree ")) {
				current = { path: line.slice("worktree ".length), head: null, branch: null };
				map.set(current.path, current);
			} else if (current !== null && line.startsWith("HEAD ")) {
				current.head = line.slice("HEAD ".length);
			} else if (current !== null && line.startsWith("branch ")) {
				current.branch = line.slice("branch ".length).replace(/^refs\/heads\//u, "");
			}
		}
		return map;
	}

	/**
	 * List every registered permanent worktree of the repository containing
	 * `cwd`, annotated with live git facts (existence, HEAD, branch).
	 * @param {string} cwd - session working directory.
	 * @param {AbortSignal} [signal]
	 * @returns {Promise<ListResult>}
	 */
	async list(cwd, signal) {
		const root = await this.resolveRepoRoot(cwd, signal);
		const manifest = await this.loadManifest(root, signal);
		const live = await this.liveWorktrees(root, signal);
		const worktrees = [];
		for (const entry of manifest?.worktrees ?? []) {
			const state = live.get(entry.path);
			worktrees.push({
				...entry,
				exists: state !== undefined,
				head: state?.head ?? null,
				branch: state?.branch ?? null
			});
		}
		return { repoRoot: root, dir: path.join(root, this.dirName), worktrees };
	}

	/**
	 * Remove a registered permanent worktree: `git worktree remove` plus
	 * manifest cleanup. Refuses to remove the worktree the current session is
	 * working inside.
	 * @param {object} params
	 * @param {string} params.name - registered worktree name.
	 * @param {string} params.cwd - session working directory (repo discovery base).
	 * @param {string} [params.currentDir] - the caller's own directory; removal is refused when it lies inside the worktree.
	 * @param {boolean} [params.force] - pass `--force` to git (removes even with uncommitted changes).
	 * @param {AbortSignal} [signal]
	 * @returns {Promise<{name: string, path: string, repoRoot: string, removed: true, force: boolean}>}
	 */
	async remove({ name, cwd, currentDir, force = false, signal }) {
		const trimmed = name.trim();
		const root = await this.resolveRepoRoot(cwd, signal);
		const manifest = await this.loadManifest(root, signal);
		const entry = manifest?.worktrees.find((candidate) => candidate.name === trimmed);
		if (entry === undefined) {
			throw new WorktreeError("NOT_FOUND", `no registered worktree named ${JSON.stringify(trimmed)} in ${root}`);
		}
		if (currentDir !== undefined && isWithin(entry.path, currentDir)) {
			throw new WorktreeError("IN_USE", `cannot remove worktree ${JSON.stringify(trimmed)}: the current session is working inside it (${currentDir})`);
		}
		const argv = force ? ["worktree", "remove", "--force", entry.path] : ["worktree", "remove", entry.path];
		const result = await git(this.ctx, argv, root, signal);
		if (result.exitCode !== 0) {
			throw new WorktreeError("GIT_FAILED", `git worktree remove failed: ${result.stderr || result.stdout}`);
		}
		manifest.worktrees = manifest.worktrees.filter((candidate) => candidate.name !== trimmed);
		await this.saveManifest(root, manifest);
		return { name: trimmed, path: entry.path, repoRoot: root, removed: true, force };
	}

	/**
	 * Whether `cwd` lies inside a registered permanent worktree, and which one.
	 * Walks up from `cwd` to find a `.dsh-worktrees/manifest.json` (the
	 * manifest lives at the main repo root, and every worktree is a descendant
	 * of its directory), then checks membership.
	 * @param {string} cwd - directory to test.
	 * @param {AbortSignal} [signal]
	 * @returns {Promise<{repoRoot: string, worktree: WorktreeEntry}|undefined>}
	 */
	async findForCwd(cwd, signal) {
		let dir = path.resolve(cwd);
		const visited = new Set();
		while (!visited.has(dir)) {
			visited.add(dir);
			// Canonicalize each step so the manifest is located (and cached)
			// under the same repo-root spelling create/list/remove use.
			const canon = canonical(dir);
			const manifestFile = path.join(canon, this.dirName, "manifest.json");
			if (await exists(manifestFile)) {
				const manifest = await this.loadManifest(canon, signal);
				for (const entry of manifest?.worktrees ?? []) {
					if (isWithin(entry.path, cwd)) return { repoRoot: canon, worktree: entry };
				}
				return undefined;
			}
			const parent = path.dirname(dir);
			if (parent === dir) return undefined;
			dir = parent;
		}
		return undefined;
	}
}
