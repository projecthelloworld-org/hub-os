import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";

export const repository = "projecthelloworld-org/hub-os";
export const siteUrl = "https://hubos.myhellohub.org";
const stableTag = /^v\d+\.\d+\.\d+$/;

export function selectStableReleases(releases, latestTag) {
  const stable = releases.filter((release) =>
    !release.draft && !release.prerelease && stableTag.test(release.tag_name));
  if (!stable.some((release) => release.tag_name === latestTag)) {
    throw new Error("The latest release must be a published stable version");
  }
  return stable;
}

function declaration(installer, name) {
  const matches = [...installer.matchAll(new RegExp(`^${name}="([^"]*)"\\s*$`, "gm"))];
  if (matches.length !== 1) throw new Error(`Installer needs exactly one ${name} declaration`);
  return matches[0][1];
}

export function validateReleaseInstaller({ release, installer, checksums, archiveHash }) {
  const tag = release.tag_name;
  if (release.draft || release.prerelease || !stableTag.test(tag)) {
    throw new Error("Only published stable releases can be installed");
  }
  const archiveName = `hubos-${tag}.tar.gz`;
  const archive = release.assets.find((asset) => asset.name === archiveName);
  if (!archive) throw new Error(`${tag} has no ${archiveName} asset`);
  const expectedUrl = `https://github.com/${repository}/releases/download/${tag}/${archiveName}`;
  if (archive.browser_download_url !== expectedUrl) throw new Error(`${tag} archive URL is inconsistent`);
  if (declaration(installer, "VERSION") !== tag.slice(1)) throw new Error(`${tag} installer version is inconsistent`);
  if (declaration(installer, "DEFAULT_RELEASE_URL") !== expectedUrl) throw new Error(`${tag} installer archive URL is inconsistent`);

  const entries = checksums.split(/\r?\n/).map((line) =>
    line.match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/)).filter(Boolean);
  const archiveEntries = entries.filter((entry) => entry[2] === archiveName);
  if (archiveEntries.length !== 1) throw new Error(`${tag} needs exactly one archive checksum`);
  const expectedHash = archiveEntries[0][1].toLowerCase();
  const embeddedHash = declaration(installer, "DEFAULT_RELEASE_SHA256").toLowerCase();
  if (embeddedHash !== expectedHash || archiveHash !== expectedHash) {
    throw new Error(`${tag} archive checksum is inconsistent`);
  }
  if (archive.digest && archive.digest !== `sha256:${expectedHash}`) {
    throw new Error(`${tag} GitHub asset digest is inconsistent`);
  }
  const syntax = spawnSync("bash", ["-n"], { input: installer, encoding: "utf8" });
  if (syntax.status !== 0) throw new Error(`${tag} installer failed Bash syntax validation`);
  return { tag, installer, archiveUrl: expectedUrl, archiveHash: expectedHash, releaseUrl: release.html_url };
}

function htmlEscape(value) {
  return String(value).replace(/[&<>"']/g, (character) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function homePage(latest, versions) {
  const command = `curl -fsSL ${siteUrl}/install.sh | bash`;
  const rows = versions.map((version) => `<tr><td>${htmlEscape(version.tag)}</td><td><a href="./releases/${version.tag}/install.sh">Installer</a></td><td><a href="${htmlEscape(version.releaseUrl)}">Release &amp; checksums</a></td></tr>`).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="Install HubOS, the open-source operations layer for school connectivity.">
  <title>Install HubOS</title>
  <style>
    :root{color-scheme:light;--ink:#193a32;--muted:#52665e;--line:#d6dfd7}
    *{box-sizing:border-box}body{margin:0;background:#f5f5ee;color:var(--ink);font:17px/1.6 system-ui,sans-serif}
    main{max-width:850px;margin:auto;padding:64px 24px}header{border-bottom:1px solid var(--line);padding-bottom:32px}
    .brand{font-weight:750;font-size:24px;letter-spacing:-.6px}.version{float:right;font-size:14px;border:1px solid var(--line);padding:4px 12px;border-radius:30px}
    h1{font-size:clamp(36px,6vw,54px);line-height:1.1;letter-spacing:-1.7px;margin:42px 0 18px}h2{font-size:23px;margin:36px 0 14px}
    p{max-width:660px}a{color:var(--ink);text-underline-offset:4px}a:hover{color:#496d48}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:var(--ink);color:#f6f8ef;padding:24px;border-radius:8px;font-size:15px}
    .muted{color:var(--muted);font-size:15px}.links{display:flex;flex-wrap:wrap;gap:12px 28px}table{width:100%;border-collapse:collapse;font-size:15px}th,td{text-align:left;padding:12px 8px;border-bottom:1px solid var(--line)}footer{margin-top:48px;color:var(--muted);font-size:14px}
    @media(max-width:500px){main{padding:32px 18px}pre{padding:18px}.version{float:none;display:inline-block;margin-left:16px}th,td{padding:10px 4px}}
  </style>
</head>
<body><main>
  <header><span class="brand">HubOS</span><span class="version">Latest stable: ${htmlEscape(latest.tag)}</span></header>
  <h1>Keep school connectivity working.</h1>
  <p>HubOS brings connectivity, power, devices, and support into a shared operational view. Run the open-source stack on your own infrastructure.</p>
  <h2>Install from your terminal</h2>
  <pre><code>${htmlEscape(command)}</code></pre>
  <p class="muted">The interactive installer helps you choose credentials, checks Docker, and connects Metabase to PostgreSQL. This URL follows the latest stable release.</p>
  <nav class="links" aria-label="HubOS resources">
    <a href="https://github.com/${repository}/blob/main/docs/Installation.md">Installation guide</a>
    <a href="${htmlEscape(latest.releaseUrl)}">Latest release</a>
    <a href="https://github.com/${repository}">Source &amp; contributions</a>
  </nav>
  <h2>Versioned installers</h2>
  <p class="muted">Choose a specific release when you need a consistent deployment version.</p>
  <table><thead><tr><th scope="col">Version</th><th scope="col">Download</th><th scope="col">Details</th></tr></thead><tbody>${rows}</tbody></table>
  <footer>Project Hello World · HubOS is released under the MIT License.</footer>
</main></body></html>\n`;
}

export async function buildPages({ outputDirectory = "dist/pages", fetchImpl = fetch, token = process.env.GITHUB_TOKEN } = {}) {
  async function request(url, json = false) {
    const headers = { "User-Agent": "HubOS-Pages", ...(json ? { Accept: "application/vnd.github+json" } : {}) };
    if (token && new URL(url).hostname === "api.github.com") headers.Authorization = `Bearer ${token}`;
    const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error(`Request failed (${response.status}): ${url}`);
    return response;
  }
  const api = `https://api.github.com/repos/${repository}`;
  const latestRelease = await (await request(`${api}/releases/latest`, true)).json();
  const releases = [];
  for (let page = 1; ; page += 1) {
    const batch = await (await request(`${api}/releases?per_page=100&page=${page}`, true)).json();
    releases.push(...batch);
    if (batch.length < 100) break;
  }
  const stable = selectStableReleases(releases, latestRelease.tag_name);
  const verified = [];
  for (const release of stable) {
    const sums = release.assets.find((asset) => asset.name === "SHA256SUMS");
    const archive = release.assets.find((asset) => asset.name === `hubos-${release.tag_name}.tar.gz`);
    if (!sums || !archive) throw new Error(`${release.tag_name} is missing required release assets`);
    const [installer, checksums, archiveBytes] = await Promise.all([
      request(`https://raw.githubusercontent.com/${repository}/${release.tag_name}/install.sh`).then((response) => response.text()),
      request(sums.browser_download_url).then((response) => response.text()),
      request(archive.browser_download_url).then((response) => response.arrayBuffer()),
    ]);
    const archiveHash = createHash("sha256").update(new Uint8Array(archiveBytes)).digest("hex");
    verified.push(validateReleaseInstaller({ release, installer, checksums, archiveHash }));
  }
  const latest = verified.find((release) => release.tag === latestRelease.tag_name);
  const output = resolve(outputDirectory);
  await mkdir(output, { recursive: true });
  for (const release of verified) {
    const versionDirectory = join(output, "releases", release.tag);
    await mkdir(versionDirectory, { recursive: true });
    await writeFile(join(versionDirectory, "install.sh"), release.installer);
  }
  await writeFile(join(output, "install.sh"), latest.installer);
  await writeFile(join(output, ".nojekyll"), "");
  await writeFile(join(output, "index.html"), homePage(latest, verified));
  console.log(`Prepared GitHub Pages for ${latest.tag}: ${verified.length} verified stable release(s)`);
  return { latestTag: latest.tag, versions: verified.map((release) => release.tag), output };
}

if (import.meta.main) {
  try { await buildPages({ outputDirectory: process.argv[2] ?? "dist/pages" }); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
