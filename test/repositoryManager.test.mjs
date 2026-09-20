import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";

const managerUrl = new URL("../dist/repositoryManager.js", import.meta.url);
const requireModule = createRequire(managerUrl);
const loadManager = new Function("require", "module", "exports", readFileSync(managerUrl, "utf8"));

function deferred() {
  let resolve;
  const promise = new Promise((complete) => { resolve = complete; });
  return { promise, resolve };
}

function repositoryFixture(rootPath) {
  return {
    info: { rootPath, gitDir: rootPath + "/.git", commonGitDir: rootPath + "/.git", isBare: false },
    calls: { status: 0, branches: 0, operation: 0 },
    head: "initial",
    modified: false,
    async status() {
      this.calls.status += 1;
      return {
        branch: { head: "main", oid: this.head, upstream: null, ahead: 0, behind: 0 },
        changes: this.modified ? [{ path: "file.txt", indexStatus: " ", workTreeStatus: "M", kind: "modified", staged: false, unstaged: true, conflicted: false }] : [],
        generatedAt: Date.now(),
      };
    },
    async branches() {
      this.calls.branches += 1;
      return [{ name: "main", fullName: "refs/heads/main", kind: "local", oid: this.head }];
    },
    async operationState() {
      this.calls.operation += 1;
      return { kind: "none", canContinue: false, canAbort: false };
    },
  };
}

function harness(count = 2) {
  const repositories = Array.from({ length: count }, (_, index) => repositoryFixture("/repo-" + index));
  const state = {
    repositories,
    discover: async () => repositories,
    commands: [],
    onCommand: async () => undefined,
    events: 0,
  };
  class EventEmitter {
    listeners = new Set();
    disposed = false;
    event = (listener) => {
      this.listeners.add(listener);
      return { dispose: () => this.listeners.delete(listener) };
    };
    fire() {
      assert.equal(this.disposed, false, "must not fire after disposal");
      state.events += 1;
      for (const listener of this.listeners) listener();
    }
    dispose() {
      this.disposed = true;
      this.listeners.clear();
    }
  }
  const vscode = {
    EventEmitter,
    commands: {
      executeCommand: async (...args) => {
        state.commands.push(args);
        return state.onCommand(...args);
      },
    },
    l10n: { t: (message) => message },
  };
  const loaded = { exports: {} };
  loadManager((name) => {
    if (name === "vscode") return vscode;
    if (name === "./git/repository") return { discoverRepositories: (...args) => state.discover(...args) };
    return requireModule(name);
  }, loaded, loaded.exports);
  state.manager = new loaded.exports.RepositoryManager({}, () => repositories.map((repository) => repository.info.rootPath));
  return state;
}

function holdStatus(repository, onStart = () => undefined, onFinish = () => undefined) {
  const entered = deferred();
  const finished = deferred();
  const gate = deferred();
  const readStatus = repository.status.bind(repository);
  repository.status = async () => {
    onStart();
    entered.resolve();
    try {
      await gate.promise;
      return await readStatus();
    } finally {
      onFinish();
      finished.resolve();
    }
  };
  return { entered: entered.promise, finished: finished.promise, release: gate.resolve };
}

function requestsFor(repositories, refsStale = true) {
  return repositories.map((repository) => ({ rootPath: repository.info.rootPath, refsStale }));
}

for (const mode of ["discovery", "all", "batch"]) {
  test(mode + " refreshes at most four repositories concurrently and retains order", async (context) => {
    const state = harness(9);
    const { manager, repositories } = state;
    context.after(() => manager.dispose());
    if (mode !== "discovery") await manager.discoverAndRefresh();
    let active = 0;
    let peak = 0;
    let started = 0;
    const holds = repositories.map((repository) => holdStatus(repository, () => {
      started += 1;
      active += 1;
      peak = Math.max(peak, active);
    }, () => { active -= 1; }));
    context.after(() => holds.forEach((hold) => hold.release()));
    const operation = mode === "discovery" ? manager.discoverAndRefresh()
      : mode === "all" ? manager.refresh() : manager.refreshMany(requestsFor(repositories));
    await Promise.all(holds.slice(0, 4).map((hold) => hold.entered));
    await nextTurn();
    assert.equal(started, 4);
    assert.equal(peak, 4);
    holds[2].release();
    await holds[4].entered;
    assert.equal(started, 5, "a free slot must accept the next repository");
    holds.forEach((hold) => hold.release());
    await operation;
    assert.equal(started, repositories.length);
    assert.equal(peak, 4);
    assert.equal(active, 0);
    assert.deepEqual(manager.all.map((snapshot) => snapshot.repository), repositories);
  });
}

for (const mode of ["all", "batch"]) {
  test(mode + " refresh publishes all snapshots atomically with one notification", async (context) => {
    const state = harness();
    const { manager, repositories } = state;
    context.after(() => manager.dispose());
    await manager.discoverAndRefresh();
    const before = manager.all;
    state.events = 0;
    state.commands.length = 0;
    repositories.forEach((repository) => { repository.head = "updated"; repository.modified = true; });
    const holds = repositories.map((repository) => holdStatus(repository));
    context.after(() => holds.forEach((hold) => hold.release()));
    const operation = mode === "all" ? manager.refresh() : manager.refreshMany(requestsFor(repositories));
    await Promise.all(holds.map((hold) => hold.entered));
    holds[0].release();
    await holds[0].finished;
    await nextTurn();
    for (const snapshot of before) assert.equal(manager.snapshot(snapshot.repository.info.rootPath), snapshot);
    assert.equal(state.events, 0);
    assert.equal(state.commands.length, 0);
    holds[1].release();
    await operation;
    assert.equal(state.events, 1);
    assert.ok(manager.all.every((snapshot) => snapshot.status.branch.oid === "updated"));
    assert.deepEqual(state.commands, [["setContext", "jbGit.hasChanges", true]]);
    await manager.refreshMany(requestsFor(repositories));
    assert.equal(state.events, 1, "unchanged snapshots must not trigger another repaint");
  });
}

test("batch requests deduplicate roots without downgrading stale refs", async (context) => {
  const state = harness(3);
  const { manager, repositories } = state;
  context.after(() => manager.dispose());
  await manager.discoverAndRefresh();
  const [first, second, untouched] = repositories;
  const previous = manager.all;
  await manager.refreshMany([
    { rootPath: first.info.rootPath, refsStale: false },
    { rootPath: first.info.rootPath, refsStale: false },
    { rootPath: second.info.rootPath, refsStale: true },
    { rootPath: second.info.rootPath, refsStale: false },
  ]);
  assert.deepEqual(first.calls, { status: 2, branches: 1, operation: 2 });
  assert.deepEqual(second.calls, { status: 2, branches: 2, operation: 2 });
  assert.deepEqual(untouched.calls, { status: 1, branches: 1, operation: 1 });
  assert.equal(manager.snapshot(first.info.rootPath).branches, previous[0].branches);
  assert.equal(manager.snapshot(untouched.info.rootPath), previous[2]);
  await manager.refreshMany([
    { rootPath: first.info.rootPath, refsStale: false },
    { rootPath: first.info.rootPath },
    { rootPath: first.info.rootPath, refsStale: false },
  ]);
  assert.equal(first.calls.branches, 2, "an omitted refs flag defaults to a full read");
});

test("empty and unknown batches do not read repositories or update the UI", async (context) => {
  const state = harness();
  const { manager, repositories } = state;
  context.after(() => manager.dispose());
  await manager.discoverAndRefresh();
  state.events = 0;
  state.commands.length = 0;
  await manager.refreshMany([]);
  await manager.refreshMany([{ rootPath: "/unknown" }]);
  assert.equal(state.events, 0);
  assert.equal(state.commands.length, 0);
  for (const repository of repositories) assert.equal(repository.calls.status, 1);
});

test("single-root refresh keeps its default and status-only behavior", async (context) => {
  const { manager, repositories } = harness();
  context.after(() => manager.dispose());
  await manager.discoverAndRefresh();
  const root = repositories[0].info.rootPath;
  await manager.refresh(root, { refsStale: false });
  assert.equal(repositories[0].calls.branches, 1);
  await manager.refresh(root);
  assert.deepEqual(repositories[0].calls, { status: 3, branches: 2, operation: 3 });
  assert.equal(repositories[1].calls.status, 1);
});

test("a batch waits for earlier refreshes and copies its request flags", async (context) => {
  const { manager, repositories } = harness();
  context.after(() => manager.dispose());
  await manager.discoverAndRefresh();
  const hold = holdStatus(repositories[0]);
  context.after(() => hold.release());
  const first = manager.refresh(repositories[0].info.rootPath);
  await hold.entered;
  const request = { rootPath: repositories[1].info.rootPath, refsStale: true };
  const second = manager.refreshMany([request]);
  request.rootPath = "/unknown";
  request.refsStale = false;
  await nextTurn();
  assert.equal(repositories[1].calls.status, 1);
  hold.release();
  await Promise.all([first, second]);
  assert.deepEqual(repositories[1].calls, { status: 2, branches: 2, operation: 2 });
});

test("failed repositories do not hide healthy updates and recover without stale cached refs", async (context) => {
  const state = harness();
  const { manager, repositories } = state;
  context.after(() => manager.dispose());
  await manager.discoverAndRefresh();
  state.events = 0;
  const readStatus = repositories[0].status;
  repositories[0].status = async () => { throw new Error("status unavailable"); };
  repositories[1].head = "updated";
  await manager.refreshMany(requestsFor(repositories));
  assert.equal(manager.snapshot(repositories[0].info.rootPath).error, "status unavailable");
  assert.equal(manager.snapshot(repositories[1].info.rootPath).status.branch.oid, "updated");
  assert.equal(state.events, 1);
  repositories[0].status = readStatus;
  await manager.refreshMany([{ rootPath: repositories[0].info.rootPath, refsStale: false }]);
  assert.equal(manager.snapshot(repositories[0].info.rootPath).error, undefined);
  assert.equal(repositories[0].calls.branches, 3, "error snapshots cannot supply cached refs");
});

test("a failed status read retains its concurrency slot until the other reads finish", async (context) => {
  const { manager, repositories } = harness(5);
  context.after(() => manager.dispose());
  await manager.discoverAndRefresh();
  const gates = repositories.map(() => deferred());
  let started = 0;
  const firstWave = deferred();
  repositories.forEach((repository, index) => {
    repository.status = async () => { throw new Error("status unavailable"); };
    const readBranches = repository.branches.bind(repository);
    repository.branches = async () => {
      started += 1;
      if (started === 4) firstWave.resolve();
      await gates[index].promise;
      return readBranches();
    };
  });
  context.after(() => gates.forEach((gate) => gate.resolve()));
  const operation = manager.refreshMany(requestsFor(repositories));
  await firstWave.promise;
  await nextTurn();
  assert.equal(started, 4);
  gates.forEach((gate) => gate.resolve());
  await operation;
  assert.equal(started, 5);
  assert.ok(manager.all.every((snapshot) => snapshot.error === "status unavailable"));
});

test("disposing during a refresh prevents publication, queued work and new reads", async (context) => {
  const state = harness(7);
  const { manager, repositories } = state;
  context.after(() => manager.dispose());
  await manager.discoverAndRefresh();
  const before = manager.all;
  state.events = 0;
  state.commands.length = 0;
  let started = 0;
  repositories.forEach((repository) => { repository.head = "updated"; repository.modified = true; });
  const holds = repositories.map((repository) => holdStatus(repository, () => { started += 1; }));
  context.after(() => holds.forEach((hold) => hold.release()));
  const operation = manager.refreshMany(requestsFor(repositories));
  await Promise.all(holds.slice(0, 4).map((hold) => hold.entered));
  const queued = manager.refresh();
  manager.dispose();
  holds.forEach((hold) => hold.release());
  await Promise.all([operation, queued]);
  for (const snapshot of before) assert.equal(manager.snapshot(snapshot.repository.info.rootPath), snapshot);
  assert.equal(started, 4);
  assert.equal(state.events, 0);
  assert.equal(state.commands.length, 0);
});

test("disposing during discovery avoids starting snapshot reads", async (context) => {
  const state = harness();
  const { manager, repositories } = state;
  context.after(() => manager.dispose());
  const entered = deferred();
  const gate = deferred();
  context.after(() => gate.resolve());
  state.discover = async () => { entered.resolve(); await gate.promise; return repositories; };
  const operation = manager.discoverAndRefresh();
  await entered.promise;
  manager.dispose();
  gate.resolve();
  await operation;
  assert.equal(manager.all.length, 0);
  assert.equal(state.events, 0);
  assert.equal(state.commands.length, 0);
  assert.ok(repositories.every((repository) => repository.calls.status === 0));
});

for (const mode of ["discovery", "batch"]) {
  test("disposing while " + mode + " updates context suppresses the final event", async (context) => {
    const state = harness();
    const { manager, repositories } = state;
    context.after(() => manager.dispose());
    if (mode !== "discovery") {
      await manager.discoverAndRefresh();
      repositories[0].modified = true;
    }
    state.events = 0;
    const entered = deferred();
    const gate = deferred();
    context.after(() => gate.resolve());
    state.onCommand = async () => { entered.resolve(); await gate.promise; };
    const operation = mode === "discovery" ? manager.discoverAndRefresh() : manager.refreshMany(requestsFor(repositories));
    await entered.promise;
    manager.dispose();
    gate.resolve();
    await operation;
    assert.equal(state.events, 0);
  });
}
