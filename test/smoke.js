// @ts-check
/**
 * Standalone smoke test for dsh-worktree's git logic. Boots no DSH profile:
 * a fake `ctx.subprocess` spawns real `git` through node:child_process, and
 * the WorktreeManager is exercised end to end in a scratch repository.
 *
 * Run: node test/smoke.js
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WorktreeError, WorktreeManager } from "../lib/manager.js";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Minimal SubprocessRuntime-shaped fake: spawns real git, collects output. */
function fakeCtx() {
	return {
		subprocess: {
			spawn(spec) {
				const child = spawn(spec.argv[0], spec.argv.slice(1), {
					cwd: spec.cwd,
					env: { ...process.env },
					stdio: ["ignore", "pipe", "pipe"]
				});
				let stdout = "";
				let stderr = "";
				child.stdout.on("data", (chunk) => { stdout += chunk; });
				child.stderr.on("data", (chunk) => { stderr += chunk; });
				const done = new Promise((resolve) => {
					child.on("close", (exitCode, signal) => resolve({ exitCode, signal }));
				});
				return {
					done,
					collected: {
						stdout: { readFrom: () => ({ text: stdout }) },
						stderr: { readFrom: () => ({ text: stderr }) }
					}
				};
			}
		}
	};
}

async function run(ctx, argv, cwd) {
	const handle = ctx.subprocess.spawn({
		argv,
		cwd,
		stdio: { stdin: "ignore", stdout: { maxBytes: 1 << 20 }, stderr: { maxBytes: 1 << 20 } },
		graceMs: 30000
	});
	const outcome = await handle.done;
	return {
		exitCode: outcome.exitCode,
		stdout: (handle.collected.stdout?.readFrom(0).text ?? "").trim(),
		stderr: (handle.collected.stderr?.readFrom(0).text ?? "").trim()
	};
}

let passed = 0;
let failed = 0;
function check(label, condition, detail = "") {
	if (condition) {
		passed++;
		console.log(`  ok   ${label}`);
	} else {
		failed++;
		console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
	}
}
function checkThrows(label, fn, code) {
	return fn().then(
		() => { failed++; console.log(`  FAIL ${label} (expected ${code} to throw)`); },
		(error) => {
			const ok = error instanceof WorktreeError && error.code === code;
			if (ok) { passed++; console.log(`  ok   ${label}`); }
			else { failed++; console.log(`  FAIL ${label} — expected ${code}, got ${error?.code ?? error}`); }
		}
	);
}

// Scratch lives in the OS temp dir, NOT next to the source tree: git repo
// discovery walks UP from cwd, so a scratch dir inside any enclosing git
// repository would make the "reject non-repo" case find a repo and fail.
const scratch = await fs.promises.mkdtemp(path.join(os.tmpdir(), "dsh-worktree-smoke-"));
await fs.promises.mkdir(path.join(scratch, "repo"), { recursive: true });
const repo = path.join(scratch, "repo");
const ctx = fakeCtx();

console.log("setting up scratch repo");
check("git init", (await run(ctx, ["git", "init", "-b", "main"], repo)).exitCode === 0);
await fs.promises.writeFile(path.join(repo, "README.md"), "smoke\n");
check("git add", (await run(ctx, ["git", "add", "README.md"], repo)).exitCode === 0);
const commit = await run(ctx, ["git", "-c", "user.name=Smoke", "-c", "user.email=smoke@example.com", "commit", "-m", "init"], repo);
check("initial commit", commit.exitCode === 0, commit.stderr);
const headSha = (await run(ctx, ["git", "rev-parse", "HEAD"], repo)).stdout;

const manager = new WorktreeManager(ctx, { dirName: ".dsh-worktrees" });

console.log("create");
const created = await manager.create({ name: "feat-a", cwd: repo, createdBy: "session-test" });
check("worktree path exists", fs.existsSync(created.worktree.path));
check("worktree is a directory", fs.statSync(created.worktree.path).isDirectory());
check("base commit is HEAD", created.worktree.baseCommit === headSha);
check("permanent flag", created.worktree.permanent === true);
check("createdBy recorded", created.worktree.createdBy === "session-test");
const detachedHead = (await run(ctx, ["git", "rev-parse", "HEAD"], created.worktree.path)).stdout;
check("detached at base commit", detachedHead === headSha);
check("manifest file written", fs.existsSync(path.join(repo, ".dsh-worktrees", "manifest.json")));
const mainStatus = (await run(ctx, ["git", "status", "--porcelain"], repo)).stdout;
check("main tree tracked files untouched", mainStatus === `?? .dsh-worktrees/`, JSON.stringify(mainStatus));

console.log("list");
const listed = await manager.list(repo);
check("one worktree listed", listed.worktrees.length === 1);
check("listed name", listed.worktrees[0].name === "feat-a");
check("listed exists", listed.worktrees[0].exists === true);
check("listed branch detached", listed.worktrees[0].branch === null && listed.worktrees[0].head === headSha);

console.log("findForCwd");
const found = await manager.findForCwd(created.worktree.path);
check("finds worktree from inside", found?.worktree.name === "feat-a");
check("finds repo root", found?.repoRoot === fs.realpathSync(repo), `got ${found?.repoRoot}`);
const notFound = await manager.findForCwd(repo);
check("main tree is not a worktree", notFound === undefined);

console.log("create with explicit base + second worktree");
const second = await manager.create({ name: "feat-b", baseCommit: headSha, cwd: repo });
check("second worktree created", fs.existsSync(second.worktree.path));
const relisted = await manager.list(repo);
check("two worktrees listed", relisted.worktrees.length === 2);

console.log("errors");
await checkThrows("reject duplicate name", () => manager.create({ name: "feat-a", cwd: repo }), "ALREADY_EXISTS");
await checkThrows("reject invalid name", () => manager.create({ name: "bad name", cwd: repo }), "INVALID_NAME");
await checkThrows("reject bad commit", () => manager.create({ name: "feat-c", baseCommit: "nope-does-not-exist", cwd: repo }), "BAD_COMMIT");
await checkThrows("reject remove of current worktree", () => manager.remove({ name: "feat-a", cwd: repo, currentDir: created.worktree.path }), "IN_USE");
await checkThrows("reject remove of unknown worktree", () => manager.remove({ name: "ghost", cwd: repo }), "NOT_FOUND");

console.log("remove");
const removed = await manager.remove({ name: "feat-a", cwd: repo });
check("removed reports path", removed.path === created.worktree.path);
check("checkout deleted", !fs.existsSync(created.worktree.path));
const final = await manager.list(repo);
check("one worktree remains", final.worktrees.length === 1 && final.worktrees[0].name === "feat-b");
const afterRemoval = await manager.findForCwd(created.worktree.path);
check("gone worktree no longer found", afterRemoval === undefined);

console.log("remove with uncommitted change (force)");
await fs.promises.writeFile(path.join(second.worktree.path, "dirty.txt"), "dirty\n");
const forced = await manager.remove({ name: "feat-b", cwd: repo, force: true });
check("forced remove succeeded", forced.removed === true);
const empty = await manager.list(repo);
check("manifest empty again", empty.worktrees.length === 0);

console.log("not a git repo");
const plain = path.join(scratch, "plain");
await fs.promises.mkdir(plain, { recursive: true });
await checkThrows("reject non-repo", () => manager.list(plain), "NOT_A_GIT_REPO");

await fs.promises.rm(scratch, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
