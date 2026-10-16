// release-decide の判定を、作り物のリポジトリで確かめる。外（main の先頭・前回の公開日時）は差し替える。
//   node --test "test/*.test.mjs"
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import {
  bump,
  checkPaths,
  decide,
  findLastRelease,
  formatTag,
  isDepsCommit,
  parsePaths,
  parseTagFormat,
  withoutExclude,
} from "../release-decide/decide.mjs";

const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

// steps: 件名（空のコミット）/ { tag } / { revertPrevious } / { m: 件名, files: [触るファイル] }
//   / { branch: 作って移る } / { checkout: 移る } / { merge: ブランチ, m: マージの件名 }（--no-ff）
function repo(steps) {
  const cwd = mkdtempSync(join(tmpdir(), "rd-"));
  dirs.push(cwd);
  // 手元の署名設定・改行の変換に左右されないように切る
  const git = (...args) =>
    execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", "-c", "core.autocrlf=false", ...args], { cwd, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.name", "test");
  git("config", "user.email", "test@example.com");
  for (const step of steps) {
    if (step.tag) git("tag", step.tag);
    else if (step.files) {
      for (const file of step.files) {
        mkdirSync(dirname(join(cwd, file)), { recursive: true });
        appendFileSync(join(cwd, file), `${step.m}\n`);
      }
      git("add", "-A");
      git("commit", "-q", "-m", step.m);
    } else if (step.branch) git("checkout", "-q", "-b", step.branch);
    else if (step.checkout) git("checkout", "-q", step.checkout);
    else if (step.merge) git("merge", "-q", "--no-ff", "-m", step.m, step.merge);
    else if (step.revertPrevious) {
      // git revert は空のコミットを取り消せないので、git revert が書くのと同じ形のメッセージを自分で書く
      const [sha, subject] = [git("rev-parse", "HEAD"), git("log", "-1", "--format=%s")];
      git("commit", "-q", "--allow-empty", "-m", `Revert "${subject}"`, "-m", `This reverts commit ${sha}.`);
    } else git("commit", "-q", "--allow-empty", "-m", step);
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

  it("取り消された変更（feat → revert）は人の変更に数えない", async () => {
    const r = repo(["feat: 最初", { tag: "v0.1.0" }, "feat: 足す", { revertPrevious: true }, "fix(deps): bump x from 1 to 2"]);
    const push = await run(r);
    assert.equal(push.release, false);
    assert.equal(push.reason, "deps-only");
    assert.doesNotMatch(push.notes, /足す/);
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

describe("paths", () => {
  // アプリ・拡張機能・紹介ページ（web）・ドキュメントが 1 つのリポジトリにある形
  const monorepo = (...rest) =>
    repo([{ m: "feat: 最初", files: ["app/main.txt", "extension/main.txt", "web/index.txt", "docs/guide.md"] }, { tag: "v0.1.0" }, ...rest]);
  const subjects = (commits) => commits.map((c) => c.subject);
  // アプリだけを版付けする（紹介ページとドキュメントの変更では上げない）
  const APP = [".", ":(exclude)web", ":(exclude)docs"];

  it("渡さなければ今と同じ（全部のコミットを見る）", async () => {
    const r = monorepo(
      { m: "fix: 拡張を直す (#10)", files: ["extension/a.txt"] },
      { m: "feat: 紹介ページに節を足す (#11)", files: ["web/index.txt"] },
      { m: "docs: ガイドを直す (#12)", files: ["docs/guide.md"] },
    );
    const result = await run(r);
    assert.equal(result.version, "0.2.0");
    assert.equal(result.commits.length, 3);
    assert.deepEqual(subjects(result.releasable), ["feat: 紹介ページに節を足す (#11)", "fix: 拡張を直す (#10)"]);
    assert.equal("pathCommits" in result, false);
    assert.deepEqual(await run(r, { paths: [] }), result);
  });

  it("含めたパスに触れたコミットだけで、版とノートを決める（モノレポの 1 部品）", async () => {
    const r = monorepo(
      { m: "fix: 拡張を直す (#10)", files: ["extension/a.txt"] },
      { m: "feat: アプリに足す (#11)", files: ["app/a.txt"] },
      { m: "fix: 両方の誤字を直す (#12)", files: ["app/main.txt", "extension/main.txt"] },
    );
    const result = await run(r, { paths: ["extension"] });
    assert.equal(result.release, true);
    assert.equal(result.version, "0.1.1");
    assert.deepEqual(subjects(result.releasable), ["fix: 両方の誤字を直す (#12)", "fix: 拡張を直す (#10)"]);
    assert.doesNotMatch(result.notes, /アプリに足す/);
    assert.deepEqual(result.pathCommits, { matched: 2, total: 3 });
  });

  it(":(exclude) で外したパスの変更は数えない", async () => {
    const r = monorepo(
      { m: "fix: アプリを直す (#10)", files: ["app/a.txt"] },
      { m: "feat: 紹介ページに節を足す (#11)", files: ["web/index.txt"] },
    );
    const result = await run(r, { paths: APP });
    assert.equal(result.version, "0.1.1");
    assert.deepEqual(subjects(result.releasable), ["fix: アプリを直す (#10)"]);
    assert.doesNotMatch(result.notes, /紹介ページ/);
    assert.deepEqual(result.pathCommits, { matched: 1, total: 2 });
    // :(exclude) だけを書いても同じ（git は「それ以外の全部」から外すと読む）。短い書き方の :! も同じ
    for (const paths of [[":(exclude)web", ":(exclude)docs"], [":!web", ":!docs"]]) {
      assert.deepEqual(subjects((await run(r, { paths })).releasable), ["fix: アプリを直す (#10)"], paths.join(" "));
    }
  });

  it("外したパスだけの変更では、版を上げる種別でも出さない", async () => {
    const r = monorepo(
      { m: "feat: 紹介ページに節を足す (#10)", files: ["web/index.txt"] },
      { m: "fix: ガイドの誤字 (#11)", files: ["docs/guide.md"] },
    );
    for (const event of ["push", "schedule", "workflow_dispatch"]) {
      const result = await run(r, { event, paths: APP });
      assert.equal(result.release, false, event);
      assert.equal(result.reason, "no-changes", event);
      assert.match(result.message, /コミット 2 件のうち paths に当たるのは 0 件/, event);
      assert.deepEqual(result.pathCommits, { matched: 0, total: 2 }, event);
    }
  });

  it("外したパスの依存の更新と、含むパスの feat が混ざっても、ノートには含むパスのものだけ", async () => {
    const r = monorepo(
      { m: "fix(deps): bump astro from 5.0.0 to 5.1.0 (#20)", files: ["web/package.json"] },
      { m: "feat: アプリに足す (#21)", files: ["app/a.txt"] },
    );
    const result = await run(r, { paths: APP });
    assert.equal(result.release, true);
    assert.equal(result.version, "0.2.0");
    assert.deepEqual(subjects(result.releasable), ["feat: アプリに足す (#21)"]);
    assert.doesNotMatch(result.notes, /astro/);
  });

  it("含むパスの依存の更新と、外したパスの feat なら、push では依存の更新だけとして定期便に回す", async () => {
    const r = monorepo(
      { m: "feat: 紹介ページに節を足す (#20)", files: ["web/index.txt"] },
      { m: "fix(deps): bump zod from 3.0.0 to 3.1.0 (#21)", files: ["app/package.json"] },
    );
    const push = await run(r, { paths: APP });
    assert.equal(push.release, false);
    assert.equal(push.reason, "deps-only");
    assert.equal(push.nextVersion, "0.1.1");
    const schedule = await run(r, { event: "schedule", paths: APP });
    assert.equal(schedule.version, "0.1.1");
  });

  it("部品ごとにタグを分ける（tag-format と paths の組）", async () => {
    const r = repo([
      { m: "feat: 最初", files: ["app/main.txt", "extension/main.txt"] },
      { tag: "v0.3.0" },
      { tag: "extension-v1.2.0" },
      { m: "feat: アプリに足す (#30)", files: ["app/a.txt"] },
      { tag: "v0.4.0" },
      { m: "fix: 拡張を直す (#31)", files: ["extension/a.txt"] },
    ]);
    const extension = await run(r, { tagFormat: "extension-v${version}", paths: ["extension"] });
    assert.equal(extension.lastRelease.gitTag, "extension-v1.2.0");
    assert.equal(extension.tag, "extension-v1.2.1");
    assert.deepEqual(subjects(extension.releasable), ["fix: 拡張を直す (#31)"]);
    assert.deepEqual(extension.pathCommits, { matched: 1, total: 2 });
    const app = await run(r, { paths: [".", ":(exclude)extension"] });
    assert.equal(app.lastRelease.gitTag, "v0.4.0");
    assert.equal(app.reason, "no-changes");
  });

  it("通常のマージで入ったマージコミットも、paths に変更を持ち込んだなら数える", async () => {
    const r = monorepo(
      { branch: "topic" },
      { m: "fix: 拡張を直す", files: ["extension/a.txt"] },
      { checkout: "main" },
      { m: "chore: 紹介ページを整える", files: ["web/index.txt"] },
      // マージの件名だけが破壊的変更を言う。git log の既定の単純化では、第 2 親と同じ中身なので落ちる
      { merge: "topic", m: "feat!: 拡張の設定の形を変える (#40)" },
      { branch: "web-topic" },
      { m: "fix: 紹介ページの誤字", files: ["web/index.txt"] },
      { checkout: "main" },
      // 紹介ページだけを持ち込んだマージは、extension には数えない
      { merge: "web-topic", m: "feat: 紹介ページに節を足す (#41)" },
    );
    // 同じ秒のコミットは並びが定まらないので、集合で比べる
    const sorted = (commits) => subjects(commits).sort();
    const extension = await run(r, { paths: ["extension"] });
    assert.equal(extension.version, "1.0.0");
    assert.deepEqual(sorted(extension.releasable), ["feat!: 拡張の設定の形を変える (#40)", "fix: 拡張を直す"]);
    // paths: . は、渡さないときと同じコミットを数える
    const all = await run(r);
    assert.deepEqual(sorted((await run(r, { paths: ["."] })).commits), sorted(all.commits));
    assert.equal(all.commits.length, 5);
  });

  it("入力は 1 行に 1 つ。前後の空白・空行・CRLF は捨て、何も残らなければ全部", () => {
    assert.deepEqual(parsePaths("extension"), ["extension"]);
    assert.deepEqual(parsePaths(".\n:(exclude)web\n:(exclude)docs\n"), [".", ":(exclude)web", ":(exclude)docs"]);
    assert.deepEqual(parsePaths("  extension  \r\n\r\n\t:(exclude)extension/test\r\n"), ["extension", ":(exclude)extension/test"]);
    // 行の中の空白は pathspec の一部として残す（空白で区切って複数書く形は受けない）
    assert.deepEqual(parsePaths("my dir"), ["my dir"]);
    for (const empty of [undefined, "", "\n", "  \r\n \t\n"]) assert.deepEqual(parsePaths(empty), [], JSON.stringify(empty));
  });

  it("当たるファイルの無い paths は、黙って「変更なし」にせず落とす（きっかけより先に）", async () => {
    const r = monorepo();
    checkPaths(r.cwd, ["extension", "extension/", ":(exclude)web", "*.md", ...APP]);
    assert.throws(() => checkPaths(r.cwd, ["extention"]), /「extention」に当たるファイルが無い/);
    assert.throws(() => checkPaths(r.cwd, ["extension", "my dir"]), /「my dir」に当たるファイルが無い/);
    assert.throws(() => checkPaths(r.cwd, [".", ":(exclude)."]), /paths 全体で当たるファイルが無い/);
    assert.throws(() => checkPaths(r.cwd, ["extension", ":(exclude)extension"]), /paths 全体で当たるファイルが無い/);
    // 魔法の綴りの誤りは git が落とす（文言はロケールで変わるので、渡した pathspec が出ることだけ見る）
    assert.throws(() => checkPaths(r.cwd, [":(exlcude)web"]), /exlcude/);
    await assert.rejects(run(r, { event: "pull_request", ref: "refs/pull/1/merge", paths: ["extention"] }), /extention/);
    assert.equal((await run(r, { event: "pull_request", ref: "refs/pull/1/merge", paths: ["extension"] })).reason, "event");
  });

  it("除外の行も、外すパスの綴りの誤りで落とす（単独で引くと「それ以外の全部」に当たって通ってしまう）", () => {
    const r = monorepo();
    // 実在するものを外す形は、長い形・短い形・ほかの magic と並べた形のどれも通る
    checkPaths(r.cwd, [".", ":(exclude)web", ":!docs", ":^extension/main.txt", ":(exclude,glob)web/**", ":(icase,exclude)WEB", ":/!web"]);
    for (const typo of [":(exclude)webb", ":!webb", ":^webb", ":(exclude,glob)webb/**", ":/!webb"]) {
      assert.throws(() => checkPaths(r.cwd, [".", typo]), (e) => e.message.includes(`「${typo}」に当たるファイルが無い`), typo);
    }
    // 印だけで外すパスが無い行
    for (const empty of [":(exclude)", ":!"]) {
      assert.throws(() => checkPaths(r.cwd, [".", empty]), (e) => e.message.includes(`「${empty}」に外すパスが書かれていない`), empty);
    }
  });

  it("除外の印を外すときは、ほかの magic を残す", () => {
    const cases = {
      ":(exclude)web": "web",
      ":(exclude,glob)web/**": ":(glob)web/**",
      ":(icase,exclude)WEB": ":(icase)WEB",
      ":!web": "web",
      ":^web": "web",
      ":!:web": "web",
      ":/!web": ":/:web",
      ":!/web": ":/:web",
      ":(exclude)": "",
    };
    for (const [input, expected] of Object.entries(cases)) assert.equal(withoutExclude(input), expected, input);
    for (const plain of ["web", ".", ":(glob)web/**", ":/web", ":/", "::web", "my dir"]) assert.equal(withoutExclude(plain), null, plain);
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
