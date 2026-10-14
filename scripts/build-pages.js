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
  <meta name="description" content="Install HubOS, the open-source operations layer for community connectivity.">
  <title>Install HubOS</title>
  <style>
    :root{color-scheme:light;--cream:#faf7f2;--ink:#222;--orange:#e76031;--orange-dark:#a83d1b;--muted:#636464;--line:#22222229}
    *{box-sizing:border-box}[hidden]{display:none!important}
    body{margin:0;background:var(--cream);color:var(--ink);font:17px/1.6 Hellix,"DM Sans","Avenir Next","Helvetica Neue",Arial,sans-serif}
    ::selection{background:var(--orange);color:var(--ink)}
    main{max-width:900px;margin:auto;padding:52px 28px 36px}
    header{display:flex;align-items:center;justify-content:space-between;gap:20px;flex-wrap:wrap;border-bottom:1px solid var(--line);padding-bottom:28px}
    .brand{display:inline-flex;align-items:center;gap:12px;color:var(--ink);text-decoration:none}.brand img{display:block;flex:none}.brand strong{display:block;font-size:25px;line-height:1.1;letter-spacing:-.025em}.brand small{display:block;margin-top:5px;color:var(--muted);font-size:12px;line-height:1.3}
    .version{font-size:13px;border:1px solid var(--line);padding:6px 12px;border-radius:24px;white-space:nowrap;font-variant-numeric:tabular-nums}
    h1{font-size:clamp(36px,5vw,56px);line-height:1.08;letter-spacing:-.035em;text-wrap:balance;margin:44px 0 20px}h2{font-size:24px;line-height:1.25;letter-spacing:-.02em;margin:0}
    p{max-width:70ch;margin:0 0 20px}.lead{font-size:18px;line-height:1.65;max-width:66ch}
    a{color:var(--orange-dark);text-underline-offset:4px;text-decoration-thickness:1px}a:hover{color:var(--ink)}
    a:focus-visible,button:focus-visible,pre:focus-visible{outline:3px solid var(--orange-dark);outline-offset:5px}
    section{margin-top:40px}.section-title{margin-bottom:18px}
    .command-window{display:flex;align-items:center;gap:8px;padding:12px;background:var(--ink);border-radius:6px}
    .copy-command{display:inline-flex;align-items:center;justify-content:center;flex:none;width:44px;height:44px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--cream);cursor:pointer}
    .copy-command:hover{background:#383633}.copy-command:active{background:#49443e}.copy-command:disabled{color:#c7c3bc;cursor:wait}.copy-command:focus-visible{outline-color:var(--orange);outline-offset:2px}
    .copy-command svg{display:block;width:20px;height:20px}.copy-command .copy-success{display:none}.copy-command[data-state="copied"] .copy-icon{display:none}.copy-command[data-state="copied"] .copy-success{display:block}
    pre{flex:1;min-width:0;max-width:100%;margin:0;white-space:pre;overflow-x:auto;color:var(--cream);padding:10px 12px;font:14px/1.65 ui-monospace,SFMono-Regular,Consolas,monospace;scrollbar-color:var(--orange) var(--ink);scrollbar-width:thin}
    pre::selection,pre ::selection{background:var(--orange);color:var(--ink)}
    .copy-feedback{min-height:1.5em;margin:6px 0 8px;color:var(--muted);font-size:13px}.muted{color:var(--muted);font-size:15px}.install-note{margin-bottom:16px}
    .links{display:flex;flex-wrap:wrap;gap:4px 26px;font-size:15px}.links a{display:inline-flex;align-items:center;min-height:44px}
    .release-note{margin-top:14px;margin-bottom:16px}table{width:100%;border-collapse:collapse;font-size:14px;font-variant-numeric:tabular-nums}th,td{text-align:left;padding:13px 10px;border-bottom:1px solid var(--line)}th:first-child,td:first-child{padding-left:0}th:last-child,td:last-child{padding-right:0}td a{display:inline-block;padding:4px 0}
    footer{margin-top:44px;padding-top:22px;border-top:1px solid var(--line);color:var(--muted);font-size:13px}
    @media(max-width:500px){main{padding:28px 18px}header{gap:16px;padding-bottom:22px}h1{margin-top:34px}section{margin-top:32px}h2{font-size:22px}.command-window{padding:10px;gap:4px}pre{padding:10px 8px;font-size:13px}.lead{font-size:17px}th,td{padding:12px 6px}footer{margin-top:34px}}
  </style>
</head>
<body><main>
  <header>
    <a class="brand" href="./" aria-label="HubOS home">
      <img width="32" height="38" alt="" src="data:image/svg+xml,%3csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2036%2042'%3e%3cpath%20fill='%23e76031'%20d='M23.03%200%200%20.21l.81%2020.08%202.53-.16%206.68%208.79-.12-8.7%2013.13-.1V0Zm-10.07%2014.59-.06-3.18-2.28.05.06%203.18-3.69.06-.15-9.4%203.69-.07.05%203.09%202.28-.04-.05-3.09%203.69-.06.15%209.4-3.69.06Z'/%3e%3cpath%20fill='%23e76031'%20d='m31.3%2021.8-6.68-8.79.12%208.7-13.14.1v20.11l23.04-.2.69-19.84-4.03-.08Zm-3.63%2014.83h-3.3l-1.34-5.18-1.32%205.17h-3.3l-2.37-9.08v-.07h3.36l1.04%204.77%201.03-4.77h3.27l1.04%204.77%201.03-4.77h3.21l-2.35%209.16Z'/%3e%3c/svg%3e">
      <span><strong>HubOS</strong><small>Project Hello World</small></span>
    </a>
    <span class="version">Latest stable: ${htmlEscape(latest.tag)}</span>
  </header>
  <h1>Keep community connectivity working.</h1>
  <p class="lead">HubOS brings connectivity, power, devices, and support into a shared operational view. Run the open-source stack on your own infrastructure.</p>
  <section aria-labelledby="install-heading">
    <h2 id="install-heading" class="section-title">Install from your terminal</h2>
    <div class="command-window">
      <pre tabindex="0" role="region" aria-label="Installation command"><code id="install-command">${htmlEscape(command)}</code></pre>
      <button class="copy-command" id="copy-command" type="button" aria-label="Copy installation command" title="Copy installation command" aria-describedby="copy-feedback" hidden>
        <svg class="copy-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
          <title>Copy command</title><desc>Two overlapping document outlines.</desc>
          <rect x="8" y="8" width="12" height="12" rx="2"/>
          <path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>
        </svg>
        <svg class="copy-success" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
          <title>Command copied</title><desc>A checkmark confirms the command was copied.</desc>
          <path d="m6 12 4 4 8-8"/>
        </svg>
      </button>
    </div>
    <p class="copy-feedback" id="copy-feedback" role="status" aria-live="polite" aria-atomic="true"></p>
    <p class="muted install-note">The interactive installer helps you choose credentials, checks Docker, and connects Metabase to PostgreSQL. This URL follows the latest stable release.</p>
    <nav class="links" aria-label="HubOS resources">
      <a href="https://github.com/${repository}/blob/main/docs/Installation.md">Installation guide</a>
      <a href="${htmlEscape(latest.releaseUrl)}">Latest release</a>
      <a href="https://github.com/${repository}">Source &amp; contributions</a>
    </nav>
  </section>
  <section aria-labelledby="releases-heading">
    <h2 id="releases-heading">Versioned installers</h2>
    <p class="muted release-note">Choose a specific release when you need a consistent deployment version.</p>
    <table><thead><tr><th scope="col">Version</th><th scope="col">Download</th><th scope="col">Details</th></tr></thead><tbody>${rows}</tbody></table>
  </section>
  <footer>Project Hello World · HubOS is released under the MIT License.</footer>
</main>
<script>
  const copyButton = document.getElementById("copy-command");
  const command = document.getElementById("install-command");
  const feedback = document.getElementById("copy-feedback");
  copyButton.hidden = false;
  copyButton.addEventListener("click", async () => {
    copyButton.disabled = true;
    copyButton.setAttribute("aria-busy", "true");
    copyButton.dataset.state = "idle";
    copyButton.title = "Copying command";
    feedback.textContent = "";
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(command.textContent);
      copyButton.dataset.state = "copied";
      copyButton.title = "Command copied";
      feedback.textContent = "Installation command copied.";
    } catch {
      copyButton.dataset.state = "idle";
      copyButton.title = "Copy installation command";
      feedback.textContent = "Copy unavailable. Select the command and copy it manually.";
      const selection = window.getSelection();
      if (selection) {
        const range = document.createRange();
        range.selectNodeContents(command);
        selection.removeAllRanges();
        selection.addRange(range);
      }
    } finally {
      copyButton.disabled = false;
      copyButton.setAttribute("aria-busy", "false");
    }
  });
</script>
</body></html>\n`;
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
