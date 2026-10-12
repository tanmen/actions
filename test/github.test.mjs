// GitHub とのやり取り（createGitHub）を、本物の API で通す。基準は v1.0.0 の Release（immutable なので公開日時が動かない）。
// CI では必ず回す（GITHUB_TOKEN が無ければ落ちる）。手元では GITHUB_TOKEN=$(gh auth token) を付けたときだけ回す。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createGitHub } from "../release-decide/decide.mjs";

const token = process.env.GITHUB_TOKEN;
const skip = !token && !process.env.CI ? "GITHUB_TOKEN が無い（手元なら GITHUB_TOKEN=$(gh auth token) を付ける）" : false;
const repo = "tanmen/actions";

const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("GitHub の API", { skip }, () => {
  it("main の先頭を引く", async () => {
    const gh = createGitHub({ token, repo, cwd: process.cwd() });
    assert.match(await gh.getRemoteHead("main"), /^[0-9a-f]{40}$/);
  });

  it("無いブランチは黙らず落ちる", async () => {
    const gh = createGitHub({ token, repo, cwd: process.cwd() });
    await assert.rejects(gh.getRemoteHead("release-decide-no-such-branch"), /先頭を引けない: 404/);
  });

  it("前回の公開日時は GitHub Release の公開日時", async () => {
    const gh = createGitHub({ token, repo, cwd: process.cwd() });
    const last = await gh.getReleaseTime({ gitTag: "v1.0.0", gitHead: "070f0445057a907649d8302b4c69368aae45f0b1" });
    assert.equal(last.source, "GitHub Release");
    assert.equal(last.at.toISOString(), "2026-10-12T05:52:06.000Z");
  });

  it("Release が無いタグは、注釈付きタグの日時か、タグのコミットの日時", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "rd-"));
    dirs.push(cwd);
    const git = (args, env = {}) =>
      execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], {
        cwd,
        encoding: "utf8",
        env: { ...process.env, ...env },
      }).trim();
    git(["init", "-q", "-b", "main"]);
    git(["config", "user.name", "test"]);
    git(["config", "user.email", "test@example.com"]);
    git(["commit", "-q", "--allow-empty", "-m", "feat: a"], { GIT_COMMITTER_DATE: "2026-01-02T03:04:05Z" });
    // GitHub 側に同じ名前の Release が無いタグ（404 になる）
    git(["tag", "-a", "v9.9.9-annotated", "-m", "x"], { GIT_COMMITTER_DATE: "2026-02-03T04:05:06Z" });
    git(["tag", "v9.9.9-lightweight"]);
    const head = git(["rev-parse", "HEAD"]);
    const gh = createGitHub({ token, repo, cwd });

    const annotated = await gh.getReleaseTime({ gitTag: "v9.9.9-annotated", gitHead: head });
    assert.equal(annotated.source, "注釈付きタグ");
    assert.equal(annotated.at.toISOString(), "2026-02-03T04:05:06.000Z");

    const lightweight = await gh.getReleaseTime({ gitTag: "v9.9.9-lightweight", gitHead: head });
    assert.match(lightweight.source, /タグのコミットの日時/);
    assert.equal(lightweight.at.toISOString(), "2026-01-02T03:04:05.000Z");
  });
});
