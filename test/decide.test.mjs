// release-decide の判定を、作り物のリポジトリで確かめる。外（main の先頭・前回の公開日時）は差し替える。
//   node --test test/
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { bump, decide, findLastRelease, formatTag, isDepsCommit, parseTagFormat } from "../release-decide/decide.mjs";

const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function repo(steps) {
  const cwd = mkdtempSync(join(tmpdir(), "rd-"));
  dirs.push(cwd);
  // 手元の署名設定に左右されないように切る
  const git = (...args) => execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.name", "test");
  git("config", "user.email", "test@example.com");
  for (const step of steps) {
    if (step.tag) git("tag", step.tag);
    else git("commit", "-q", "--allow-empty", "-m", step);
  }
  return { cwd, head: git("rev-parse", "HEAD"), git };
}

const NOW = new Date("2026-10-11T12:00:00Z");
function run(r, overrides = {}) {
  return decide({
    cwd: r.cwd,
    event: "push",
    ref: "refs/heads/main",
    now: NOW,
    repositoryUrl: "https://github.com/tanmen/example",
    getRemoteHead: async () => r.head,
    getReleaseTime: async () => ({ at: new Date(NOW.getTime() - 24 * 3600e3), source: "テスト" }),
    ...overrides,
  });
}
const hoursAgo = (h) => async () => ({ at: new Date(NOW.getTime() - h * 3600e3), source: "テスト" });

describe("判定", () => {
  it("前回から cooldown 時間たっていれば、push で即時に出す", async () => {
    const r = repo(["feat: 最初", { tag: "v0.1.0" }, "fix: 直す (#2)"]);
    const result = await run(r, { getReleaseTime: hoursAgo(7) });
    assert.equal(result.release, true);
    assert.equal(result.version, "0.1.1");
    assert.equal(result.tag, "v0.1.1");
    assert.match(result.notes, /直す/);
  });

  it("cooldown の内側の push は定期便に回す", async () => {
    const r = repo(["feat: 最初", { tag: "v0.1.0" }, "feat: 足す (#2)"]);
    const result = await run(r, { getReleaseTime: hoursAgo(2) });
    assert.equal(result.release, false);
    assert.equal(result.reason, "cooldown");
    assert.equal(result.nextVersion, "0.2.0");
  });

  it("cooldown の内側でも、定期便と手動は出す", async () => {
    const r = repo(["feat: 最初", { tag: "v0.1.0" }, "feat: 足す (#2)"]);
    for (const event of ["schedule", "workflow_dispatch"]) {
      const result = await run(r, { event, getReleaseTime: hoursAgo(1) });
      assert.equal(result.release, true, event);
      assert.equal(result.version, "0.2.0", event);
    }
  });

  it("cooldown-hours が 0 なら push で毎回出す", async () => {
    const r = repo(["feat: 最初", { tag: "v0.1.0" }, "fix: 直す"]);
    const result = await run(r, { cooldownHours: 0, getReleaseTime: hoursAgo(0.1) });
    assert.equal(result.release, true);
  });

  it("版を上げる変更が依存の更新だけなら、push では出さず定期便で出す", async () => {
    const r = repo([
      "feat: 最初",
      { tag: "v0.1.0" },
      "fix(deps): bump handlebars from 4.7.9 to 4.7.10 (#43)",
      "chore(deps-dev): bump vitest from 3.0.0 to 3.1.0 (#44)",
      "chore(deps): bump actions/checkout from 6 to 7 (#45)",
    ]);
    const push = await run(r);
    assert.equal(push.release, false);
    assert.equal(push.reason, "deps-only");
    const schedule = await run(r, { event: "schedule" });
    assert.equal(schedule.release, true);
    assert.equal(schedule.version, "0.1.1");
  });

  it("依存の更新に人の変更が混ざっていれば、push で出す", async () => {
    const r = repo(["feat: 最初", { tag: "v0.1.0" }, "fix: 直す", "fix(deps): bump x from 1 to 2"]);
    const result = await run(r);
    assert.equal(result.release, true);
  });

  it("docs / chore / ci だけなら出さない", async () => {
    const r = repo(["feat: 最初", { tag: "v0.1.0" }, "docs: 書く", "chore: 片付ける", "ci: 直す"]);
    for (const event of ["push", "schedule"]) {
      const result = await run(r, { event });
      assert.equal(result.release, false, event);
      assert.equal(result.reason, "no-changes", event);
    }
  });

  it("`!` 付きの件名は major に上げる（angular の書式では読めない）", async () => {
    const r = repo(["feat: 最初", { tag: "v0.3.0" }, "feat!: 形を変える"]);
    const result = await run(r);
    assert.equal(result.version, "1.0.0");
  });

  it("本文の BREAKING CHANGE でも major に上げる", async () => {
    const r = repo(["feat: 最初", { tag: "v1.2.3" }, "fix: 直す\n\nBREAKING CHANGE: 設定の形が変わる"]);
    const result = await run(r);
    assert.equal(result.version, "2.0.0");
  });

  it("タグが無ければ初回の版で、cooldown を見ない", async () => {
    const r = repo(["feat: 最初"]);
    const result = await run(r, { getReleaseTime: async () => assert.fail("初回は前回の公開を引かない") });
    assert.equal(result.release, true);
    assert.equal(result.version, "1.0.0");
    const custom = await run(r, { initialVersion: "0.1.0" });
    assert.equal(custom.version, "0.1.0");
  });

  it("main が先へ進んでいたら出さない（後の run が拾う）", async () => {
    const r = repo(["feat: 最初", { tag: "v0.1.0" }, "fix: 直す"]);
    const result = await run(r, { getRemoteHead: async () => "0".repeat(40) });
    assert.equal(result.release, false);
    assert.equal(result.reason, "behind");
  });

  it("main 以外・対象外のきっかけでは出さない", async () => {
    const r = repo(["feat: 最初"]);
    assert.equal((await run(r, { ref: "refs/heads/feature" })).reason, "branch");
    assert.equal((await run(r, { event: "workflow_dispatch", ref: "refs/heads/feature" })).reason, "branch");
    // pull_request の ref は refs/pull/<番号>/merge。CI（test.yml）はこれが event になることを当てにしている
    assert.equal((await run(r, { event: "pull_request", ref: "refs/pull/1/merge" })).reason, "event");
  });

  it("浅い clone は黙って進めず落とす", async () => {
    const r = repo(["feat: 最初", { tag: "v0.1.0" }, "fix: 直す", "fix: もう 1 つ"]);
    const shallow = mkdtempSync(join(tmpdir(), "rd-"));
    dirs.push(shallow);
    execFileSync("git", ["clone", "-q", "--depth", "1", `file://${r.cwd.replace(/\\/g, "/")}`, shallow]);
    await assert.rejects(run({ cwd: shallow, head: r.head }), /fetch-depth: 0/);
  });

  it("日本語の件名と本文をそのまま読む", async () => {
    const r = repo(["feat: 最初", { tag: "v0.1.0" }, "fix: 長い動画で位置の帯がずれる (#54)\n\n本文。fix: で始まる行があっても版は 1 つ"]);
    const result = await run(r);
    assert.equal(result.version, "0.1.1");
    assert.equal(result.releasable.length, 1);
    assert.match(result.notes, /長い動画で位置の帯がずれる/);
  });
});

describe("タグ", () => {
  it("tag-format に合い、HEAD から辿れる最大の版を前回とする（先行版は見ない）", () => {
    const r = repo([
      "feat: a",
      { tag: "v0.9.0" },
      { tag: "site-v0.5.0" },
      "feat: b",
      { tag: "v0.10.0" },
      { tag: "v0.11.0-dev.1" },
      { tag: "nightly" },
    ]);
    assert.equal(findLastRelease(r.cwd, "v${version}").version, "0.10.0");
    assert.equal(findLastRelease(r.cwd, "site-v${version}").gitTag, "site-v0.5.0");
    assert.equal(findLastRelease(r.cwd, "app-v${version}"), null);
  });

  it("tag-format の ${version} はちょうど 1 つ", () => {
    assert.deepEqual(parseTagFormat("v${version}"), { prefix: "v", suffix: "" });
    assert.equal(formatTag("site-v${version}", "1.2.3"), "site-v1.2.3");
    assert.throws(() => parseTagFormat("v1"), /ちょうど 1 つ/);
    assert.throws(() => parseTagFormat("${version}-${version}"), /ちょうど 1 つ/);
  });
});

describe("小さな部品", () => {
  it("bump", () => {
    assert.equal(bump("0.9.9", "patch"), "0.9.10");
    assert.equal(bump("0.9.9", "minor"), "0.10.0");
    assert.equal(bump("0.9.9", "major"), "1.0.0");
  });

  it("依存の更新の見分け", () => {
    assert.equal(isDepsCommit({ subject: "fix(deps): bump x" }), true);
    assert.equal(isDepsCommit({ subject: "chore(deps-dev): bump y" }), true);
    assert.equal(isDepsCommit({ subject: "fix: deps を直す" }), false);
    assert.equal(isDepsCommit({ subject: "fix(ui): 直す" }), false);
  });
});
