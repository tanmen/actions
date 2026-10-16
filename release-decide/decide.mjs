// main へのマージ（push）・定期便（schedule）・手動（workflow_dispatch）のどれで起こされたかを見て、
// 「今この版を出すか」を決める。版とノートは semantic-release のプラグイン 2 つ（commit-analyzer・release-notes-generator）に任せる。
//
// - semantic-release 本体は呼ばない。本体は dry-run でも push 権限を確かめる（verifyAuth）ので、判定のジョブに書き込み権限が要ってしまう
// - push で即時に出すのは「版を上げる変更に依存の更新以外が含まれ、前回の公開から cooldown 時間たっている」ときだけ。
//   それ以外は定期便が拾う。schedule と workflow_dispatch は版を上げる変更があれば出す
// - 出さないときも理由を出力と step summary に書く（緑のまま何もしない run を、理由の読める run にする）
// - paths（git の pathspec）を渡すと、前回のタグ以降のコミットのうちそのパスに触れたものだけで決める
//   （モノレポの 1 部品だけを版付けする・ドキュメントだけの変更で版を上げない）。空なら全部
//
// 手元で回すとき（GITHUB_OUTPUT が無いと結果を JSON で標準出力に出す。paths は INPUT_PATHS に改行区切りで）:
//   GITHUB_EVENT_NAME=schedule GITHUB_REF=refs/heads/main GITHUB_REPOSITORY=<owner>/<repo> GITHUB_WORKSPACE=<その clone> \
//     GITHUB_TOKEN=$(gh auth token) node decide.mjs
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { analyzeCommits } from "@semantic-release/commit-analyzer";
import { generateNotes } from "@semantic-release/release-notes-generator";

// pr-title.yml が検査する書式（Conventional Commits）に合わせる。semantic-release の既定の angular は `feat!:` を読めず、黙って版が上がらない
const PLUGIN_CONFIG = { preset: "conventionalcommits" };
// dependabot の接頭辞は `fix(deps)`（または prefix: fix ＋ include: scope）。開発用の依存は `chore(deps-dev)` で、もともと版を上げない
const DEPS_SCOPES = new Set(["deps", "deps-dev"]);
const EVENTS = new Set(["push", "schedule", "workflow_dispatch"]);
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const silent = { log() {}, warn() {}, error() {}, success() {} };

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }).trim();
}

export function parseTagFormat(format) {
  const marker = "${version}";
  const i = format.indexOf(marker);
  if (i < 0 || format.indexOf(marker, i + 1) >= 0) throw new Error(`tag-format には \${version} をちょうど 1 つ書く: ${format}`);
  return { prefix: format.slice(0, i), suffix: format.slice(i + marker.length) };
}

export function formatTag(format, version) {
  const { prefix, suffix } = parseTagFormat(format);
  return `${prefix}${version}${suffix}`;
}

function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

// HEAD から辿れるタグのうち、tag-format に合う最大の版。先行版（0.1.0-dev.3 など）は見ない
export function findLastRelease(cwd, format) {
  const { prefix, suffix } = parseTagFormat(format);
  let best = null;
  for (const tag of git(["tag", "--merged", "HEAD"], cwd).split("\n")) {
    if (!tag || !tag.startsWith(prefix) || !tag.endsWith(suffix)) continue;
    const version = tag.slice(prefix.length, tag.length - suffix.length);
    const m = SEMVER.exec(version);
    if (!m) continue;
    const parts = m.slice(1).map(Number);
    if (!best || compareVersions(parts, best.parts) > 0) best = { tag, version, parts };
  }
  if (!best) return null;
  return { version: best.version, gitTag: best.tag, gitHead: git(["rev-list", "-n", "1", best.tag], cwd) };
}

// paths の入力（1 行に 1 つの pathspec）を配列にする。各行の前後の空白（CRLF の \r も含む）と空行は捨てる。何も残らなければ全部を見る
export function parsePaths(input) {
  return (input ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
}

// 除外の印（長い形の :(exclude)・短い形の :! と :^）が付いた pathspec なら、印だけを外した pathspec を返す（glob・icase などほかの magic は残す）。
// 付いていなければ null
export function withoutExclude(pathspec) {
  const long = /^:\(([^)]*)\)([\s\S]*)$/.exec(pathspec);
  if (long) {
    const magic = long[1].split(",");
    if (!magic.includes("exclude")) return null;
    const others = magic.filter((m) => m !== "exclude");
    return others.length ? `:(${others.join(",")})${long[2]}` : long[2];
  }
  const short = /^:([/!^]*):?([\s\S]*)$/.exec(pathspec);
  if (!short || !/[!^]/.test(short[1])) return null;
  const others = short[1].replace(/[!^]/g, "");
  return others ? `:${others}:${short[2]}` : short[2];
}

// 当たるファイルの無い pathspec（綴りの誤り・ディレクトリの改名）は、エラーにならず「変更なし」や「外したつもりで外れていない」を出し続ける。
// HEAD の木で確かめて落とす。除外の行は単独で引くと「それ以外の全部」に当たって必ず通るので、印を外したパス（外す側）で引く。
// 1 行ずつのあと全体でも見る（extension と :(exclude)extension の組は全体で 0 件）
export function checkPaths(cwd, paths) {
  for (const pathspec of paths) {
    const target = withoutExclude(pathspec) ?? pathspec;
    if (!target) throw new Error(`paths の「${pathspec}」に外すパスが書かれていない`);
    if (!git(["ls-files", "--", target], cwd)) throw new Error(`paths の「${pathspec}」に当たるファイルが無い（綴りとディレクトリの改名を見る）`);
  }
  if (!git(["ls-files", "--", ...paths], cwd)) throw new Error(`paths 全体で当たるファイルが無い（${paths.join(" ")}）`);
}

const rangeSince = (sinceTag) => (sinceTag ? `${sinceTag}..HEAD` : "HEAD");

// paths を渡すと git log は履歴を単純化し、第 2 親と同じ中身のマージコミット（通常のマージ）を落とす。マージの件名（feat!: など）が
// 版から消えないよう、--show-pulls で「第 1 親から見て paths に変更を持ち込んだマージ」を残す
export function readCommits(cwd, sinceTag, paths = []) {
  const filter = paths.length ? ["--show-pulls", rangeSince(sinceTag), "--", ...paths] : [rangeSince(sinceTag)];
  const out = execFileSync("git", ["log", "--format=%H%x1f%cI%x1f%B%x1e", ...filter], {
    cwd,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  return out
    .split("\x1e")
    .map((record) => record.replace(/^\n+/, ""))
    .filter(Boolean)
    .map((record) => {
      const [hash, committerDate, body] = record.split("\x1f");
      const message = body.trim();
      return { hash, committerDate, message, subject: message.split("\n")[0] };
    });
}

export function bump(version, type) {
  const [major, minor, patch] = version.split(".").map(Number);
  if (type === "major") return `${major + 1}.0.0`;
  if (type === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

export function isDepsCommit(commit) {
  const m = /^\w+(?:\(([^)]*)\))?!?:/.exec(commit.subject);
  return Boolean(m && m[1] && DEPS_SCOPES.has(m[1].trim()));
}

function hoursBetween(from, to) {
  return (to.getTime() - from.getTime()) / 3_600_000;
}

/**
 * 判定の本体。外とのやり取り（main の先頭・前回の公開日時）は引数で受けるので、テストで差し替えられる。
 * pathCommits（paths を渡したときだけ）は、前回からのコミットの全体の数（total）と paths に当たった数（matched）。
 * @returns {Promise<{release: boolean, reason: string, message: string, version?: string, nextVersion?: string,
 *   lastRelease?: object|null, tag?: string, notes?: string, commits?: object[], releasable?: object[],
 *   pathCommits?: {matched: number, total: number}}>}
 */
export async function decide({
  cwd,
  event,
  ref,
  branch = "main",
  tagFormat = "v${version}",
  initialVersion = "1.0.0",
  cooldownHours = 6,
  paths = [],
  now = new Date(),
  repositoryUrl,
  getRemoteHead,
  getReleaseTime,
  logger = silent,
}) {
  // paths の誤りは設定の誤りなので、きっかけより先に見て落とす（test.yml は pull_request でこれを使い、action.yml から paths が届くかを確かめる）
  if (paths.length) checkPaths(cwd, paths);
  // きっかけを先に見る。pull_request の ref は refs/pull/<番号>/merge なので、ブランチを先に見ると理由が branch に化ける
  if (!EVENTS.has(event)) {
    return { release: false, reason: "event", message: `${event} では出さない（push・schedule・workflow_dispatch だけ）` };
  }
  if (ref !== `refs/heads/${branch}`) {
    return { release: false, reason: "branch", message: `${branch} 以外から起こされた（${ref}）。出さない` };
  }
  if (git(["rev-parse", "--is-shallow-repository"], cwd) === "true") {
    // 浅い clone ではタグと履歴が欠け、前回の版を見失って 1.0.0 や大きすぎる版を出す。黙って進めない
    throw new Error("履歴が浅い。checkout に fetch-depth: 0 を付ける（release-decide は中で付けているので、後から浅く取り直していないか見る）");
  }

  const head = git(["rev-parse", "HEAD"], cwd);
  const remoteHead = await getRemoteHead(branch);
  if (remoteHead !== head) {
    return {
      release: false,
      reason: "behind",
      message: `${branch} が先へ進んでいる（手元 ${head.slice(0, 7)}・リモート ${remoteHead.slice(0, 7)}）。後の run が拾う`,
    };
  }

  const lastRelease = findLastRelease(cwd, tagFormat);
  const commits = readCommits(cwd, lastRelease?.gitTag, paths);
  // paths で絞ったときだけ、絞る前の数も残す（外れたコミットの数を step summary で読めるように）
  const counted = paths.length
    ? { pathCommits: { matched: commits.length, total: Number(git(["rev-list", "--count", rangeSince(lastRelease?.gitTag)], cwd)) } }
    : {};
  const context = { cwd, commits, logger, options: { repositoryUrl }, lastRelease: lastRelease ?? {} };
  const type = await analyzeCommits(PLUGIN_CONFIG, context);
  if (!type) {
    const count = counted.pathCommits
      ? `コミット ${counted.pathCommits.total} 件のうち paths に当たるのは ${commits.length} 件`
      : `${commits.length} 件のコミット`;
    return {
      release: false,
      reason: "no-changes",
      message: `${lastRelease ? `前回（${lastRelease.gitTag}）` : "最初"}から版を上げる変更が無い（${count}）`,
      lastRelease,
      commits,
      releasable: [],
      ...counted,
    };
  }

  const releasable = [];
  for (const commit of commits) {
    if (await analyzeCommits(PLUGIN_CONFIG, { ...context, commits: [commit], logger: silent })) releasable.push(commit);
  }
  const nextVersion = lastRelease ? bump(lastRelease.version, type) : initialVersion;
  const tag = formatTag(tagFormat, nextVersion);
  const notes = await generateNotes(PLUGIN_CONFIG, {
    ...context,
    lastRelease: lastRelease ?? {},
    nextRelease: { version: nextVersion, gitTag: tag, gitHead: head },
  });
  const base = { nextVersion, lastRelease, tag, notes, commits, releasable, ...counted };

  if (event === "push") {
    // 依存の更新を除いた残りを、まとめて判定し直す。1 件ずつ見ると、取り消された変更（feat → revert）が残って見える。
    // まとめて渡せば、全体の判定と同じく変更と revert の組が外れる
    const others = commits.filter((commit) => !isDepsCommit(commit));
    if (!(await analyzeCommits(PLUGIN_CONFIG, { ...context, commits: others, logger: silent }))) {
      return { ...base, release: false, reason: "deps-only", message: `版を上げる変更が依存の更新だけ（${releasable.length} 件）。定期便で出す` };
    }
    if (lastRelease && cooldownHours > 0) {
      const last = await getReleaseTime(lastRelease);
      const elapsed = hoursBetween(last.at, now);
      if (elapsed < cooldownHours) {
        return {
          ...base,
          release: false,
          reason: "cooldown",
          message: `前回の公開（${lastRelease.gitTag}・${last.at.toISOString()}・${last.source}）から ${elapsed.toFixed(1)} 時間。${cooldownHours} 時間たつまでは定期便に回す`,
        };
      }
    }
  }

  return {
    ...base,
    release: true,
    version: nextVersion,
    reason: "release",
    message: `出す: ${lastRelease ? lastRelease.version : "（初回）"} → ${nextVersion}（${event}）`,
  };
}

/** GitHub とのやり取り（main の先頭・前回の公開日時）。テスト（test/github.test.mjs）が本物の API で同じものを通す */
export function createGitHub({ api = "https://api.github.com", token, repo, cwd }) {
  const get = (path) =>
    fetch(`${api}${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
    });
  return {
    async getRemoteHead(branch) {
      const res = await get(`/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`);
      if (!res.ok) throw new Error(`${branch} の先頭を引けない: ${res.status} ${await res.text()}`);
      return (await res.json()).object.sha;
    },
    async getReleaseTime(lastRelease) {
      const res = await get(`/repos/${repo}/releases/tags/${encodeURIComponent(lastRelease.gitTag)}`);
      if (res.ok) {
        const release = await res.json();
        return { at: new Date(release.published_at ?? release.created_at), source: "GitHub Release" };
      }
      if (res.status !== 404) throw new Error(`${lastRelease.gitTag} の Release を引けない: ${res.status} ${await res.text()}`);
      // Release が無い版（release-please から移したリポジトリの古いタグなど）。注釈付きタグなら打った日時、無ければタグのコミットの日時
      const tagged = git(["for-each-ref", `refs/tags/${lastRelease.gitTag}`, "--format=%(taggerdate:iso-strict)"], cwd);
      if (tagged) return { at: new Date(tagged), source: "注釈付きタグ" };
      return { at: new Date(git(["log", "-1", "--format=%cI", lastRelease.gitHead], cwd)), source: "タグのコミットの日時（Release が無い）" };
    },
  };
}

function writeOutputs(file, result) {
  const delimiter = `RELEASE_DECIDE_${randomUUID()}`;
  const lines = [
    `release=${result.release}`,
    `reason=${result.reason}`,
    `version=${result.release ? result.version : ""}`,
    `next-version=${result.nextVersion ?? ""}`,
    `last-version=${result.lastRelease?.version ?? ""}`,
    `tag=${result.release ? result.tag : ""}`,
    `notes<<${delimiter}`,
    result.notes ?? "",
    delimiter,
    "",
  ];
  appendFileSync(file, lines.join("\n"));
}

function writeSummary(file, result, event, paths = []) {
  const rows = [
    ["判定", result.release ? "**出す**" : "出さない"],
    ["理由", result.message],
    ["きっかけ", event],
    ["前回", result.lastRelease?.gitTag ?? "（無し）"],
    ["次の版", result.nextVersion ?? "—"],
  ];
  // paths を渡したときだけ足す（渡さないときの summary は前と同じ）
  if (paths.length) {
    const count = result.pathCommits ? `（コミット ${result.pathCommits.total} 件のうち ${result.pathCommits.matched} 件が当たる）` : "";
    rows.push(["paths", `${paths.map((p) => `\`${p}\``).join(" ")}${count}`]);
  }
  const escape = (s) => String(s).replace(/\|/g, "\\|").replace(/\n/g, " ");
  let md = `## release-decide\n\n| | |\n| --- | --- |\n${rows.map(([k, v]) => `| ${k} | ${escape(v)} |`).join("\n")}\n`;
  if (result.releasable?.length) {
    md += `\n<details><summary>版を上げる変更（${result.releasable.length} 件）</summary>\n\n`;
    md += result.releasable.map((c) => `- ${escape(c.subject)} (${c.hash.slice(0, 7)})${isDepsCommit(c) ? " — 依存" : ""}`).join("\n");
    md += "\n\n</details>\n";
  }
  appendFileSync(file, md);
}

async function main() {
  const env = process.env;
  const repo = env.GITHUB_REPOSITORY;
  const api = env.GITHUB_API_URL ?? "https://api.github.com";
  const server = env.GITHUB_SERVER_URL ?? "https://github.com";
  const token = env.GITHUB_TOKEN;
  if (!repo || !token) throw new Error("GITHUB_REPOSITORY と GITHUB_TOKEN が要る");
  const cwd = env.GITHUB_WORKSPACE ?? process.cwd();
  const cooldownHours = Number(env.INPUT_COOLDOWN_HOURS ?? "6");
  if (!Number.isFinite(cooldownHours) || cooldownHours < 0) throw new Error(`cooldown-hours が数でない: ${env.INPUT_COOLDOWN_HOURS}`);
  const event = env.GITHUB_EVENT_NAME;
  const paths = parsePaths(env.INPUT_PATHS);

  const result = await decide({
    cwd,
    event,
    ref: env.GITHUB_REF,
    branch: env.INPUT_BRANCH || "main",
    tagFormat: env.INPUT_TAG_FORMAT || "v${version}",
    initialVersion: env.INPUT_INITIAL_VERSION || "1.0.0",
    cooldownHours,
    paths,
    now: env.RELEASE_DECIDE_NOW ? new Date(env.RELEASE_DECIDE_NOW) : new Date(),
    repositoryUrl: `${server}/${repo}`,
    logger: { log: (...a) => console.error(...a), warn: (...a) => console.error(...a), error: (...a) => console.error(...a), success: (...a) => console.error(...a) },
    ...createGitHub({ api, token, repo, cwd }),
  });

  console.error(`[release-decide] ${result.message}`);
  if (env.GITHUB_STEP_SUMMARY) writeSummary(env.GITHUB_STEP_SUMMARY, result, event, paths);
  if (env.GITHUB_OUTPUT) writeOutputs(env.GITHUB_OUTPUT, result);
  else process.stdout.write(`${JSON.stringify({ ...result, commits: undefined, releasable: result.releasable?.map((c) => c.subject) }, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  });
}
