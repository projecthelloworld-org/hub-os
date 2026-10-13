import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { buildPages, selectStableReleases, validateReleaseInstaller } from "../../../scripts/build-pages.js";

const archiveBytes = new TextEncoder().encode("HubOS release archive fixture");
const hash = createHash("sha256").update(archiveBytes).digest("hex");
const archiveUrl = "https://github.com/projecthelloworld-org/hub-os/releases/download/v0.1.0/hubos-v0.1.0.tar.gz";
function fixture() {
  return {
    release: {
      tag_name: "v0.1.0", draft: false, prerelease: false,
      html_url: "https://github.com/projecthelloworld-org/hub-os/releases/tag/v0.1.0",
      assets: [
        { name: "hubos-v0.1.0.tar.gz", browser_download_url: archiveUrl, digest: `sha256:${hash}` },
        { name: "SHA256SUMS", browser_download_url: "https://github.com/projecthelloworld-org/hub-os/releases/download/v0.1.0/SHA256SUMS" },
      ],
    },
    installer: `#!/usr/bin/env bash\nVERSION="0.1.0"\nDEFAULT_RELEASE_URL="${archiveUrl}"\nDEFAULT_RELEASE_SHA256="${hash}"\n`,
    checksums: `${hash}  hubos-v0.1.0.tar.gz\n`,
    archiveHash: hash,
  };
}

describe("Pages release verification", () => {
  test("uses GitHub's latest stable release and excludes drafts, prereleases, and non-version tags", () => {
    const releases = [
      { tag_name: "v0.1.0", draft: false, prerelease: false },
      { tag_name: "v0.2.0", draft: true, prerelease: false },
      { tag_name: "v0.3.0", draft: false, prerelease: true },
      { tag_name: "nightly", draft: false, prerelease: false },
    ];
    expect(selectStableReleases(releases, "v0.1.0").map((release) => release.tag_name)).toEqual(["v0.1.0"]);
    expect(() => selectStableReleases(releases, "v0.3.0")).toThrow("published stable version");
  });

  test("preserves verified installer bytes", () => {
    const data = fixture();
    expect(validateReleaseInstaller(data).installer).toBe(data.installer);
  });

  test("rejects missing assets and missing or duplicate checksum records", () => {
    const missing = fixture(); missing.release.assets = [];
    expect(() => validateReleaseInstaller(missing)).toThrow("asset");
    const noChecksum = fixture(); noChecksum.checksums = "";
    expect(() => validateReleaseInstaller(noChecksum)).toThrow("archive checksum");
    const duplicate = fixture(); duplicate.checksums += duplicate.checksums;
    expect(() => validateReleaseInstaller(duplicate)).toThrow("archive checksum");
  });

  test("rejects installer version, archive URL, checksum, and asset digest mismatches", () => {
    const version = fixture(); version.installer = version.installer.replace('VERSION="0.1.0"', 'VERSION="0.2.0"');
    expect(() => validateReleaseInstaller(version)).toThrow("version");
    const url = fixture(); url.installer = url.installer.replace(archiveUrl, "https://example.org/archive.tar.gz");
    expect(() => validateReleaseInstaller(url)).toThrow("archive URL");
    const embedded = fixture(); embedded.installer = embedded.installer.replace(hash, "b".repeat(64));
    expect(() => validateReleaseInstaller(embedded)).toThrow("checksum");
    const archive = fixture(); archive.archiveHash = "b".repeat(64);
    expect(() => validateReleaseInstaller(archive)).toThrow("checksum");
    const digest = fixture(); digest.release.assets[0].digest = `sha256:${"b".repeat(64)}`;
    expect(() => validateReleaseInstaller(digest)).toThrow("asset digest");
  });

  test("rejects invalid Bash before publication", () => {
    const data = fixture(); data.installer += "if then\n";
    expect(() => validateReleaseInstaller(data)).toThrow("Bash syntax");
  });
});

describe("Pages homepage", () => {
  let directory;
  let html;
  const data = fixture();

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "hubos-pages-test-"));
    const responses = new Map([
      ["https://api.github.com/repos/projecthelloworld-org/hub-os/releases/latest", JSON.stringify(data.release)],
      ["https://api.github.com/repos/projecthelloworld-org/hub-os/releases?per_page=100&page=1", JSON.stringify([data.release])],
      ["https://raw.githubusercontent.com/projecthelloworld-org/hub-os/v0.1.0/install.sh", data.installer],
      [data.release.assets[1].browser_download_url, data.checksums],
      [archiveUrl, archiveBytes],
    ]);
    await buildPages({
      outputDirectory: directory,
      token: "",
      fetchImpl: async (url) => {
        if (!responses.has(url)) throw new Error(`Unexpected request: ${url}`);
        return new Response(responses.get(url));
      },
    });
    html = await readFile(join(directory, "index.html"), "utf8");
  });

  afterAll(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  function copyControls(clipboard) {
    let click;
    let selected;
    const attributes = {};
    const button = {
      hidden: true, disabled: false, dataset: {}, title: "Copy installation command",
      setAttribute: (name, value) => { attributes[name] = value; },
      addEventListener: (event, listener) => { if (event === "click") click = listener; },
    };
    const command = { textContent: "curl -fsSL https://hubos.myhellohub.org/install.sh | bash" };
    const feedback = { textContent: "" };
    const elements = { "copy-command": button, "install-command": command, "copy-feedback": feedback };
    runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], {
      navigator: { clipboard },
      document: {
        getElementById: (id) => elements[id],
        createRange: () => ({ selectNodeContents: (element) => { selected = element; } }),
      },
      window: { getSelection: () => ({ removeAllRanges() {}, addRange() {} }) },
    });
    return { button, attributes, command, feedback, click: () => click(), selected: () => selected };
  }

  test("keeps the compact content, branding, release links and accessible copy control", () => {
    for (const content of [
      "--cream:#faf7f2", "--ink:#222", "--orange:#e76031", 'src="data:image/svg+xml,',
      "Keep school connectivity working.", "Latest stable: v0.1.0", "Versioned installers",
      'href="https://github.com/projecthelloworld-org/hub-os/blob/main/docs/Installation.md"',
      'href="./releases/v0.1.0/install.sh"', 'aria-labelledby="install-heading"',
      'aria-label="Copy installation command"', 'aria-describedby="copy-feedback" hidden>',
      '<div class="command-window">', '<svg class="copy-icon"', '<svg class="copy-success"',
      'role="status" aria-live="polite"',
    ]) expect(html).toContain(content);
    const withoutScript = html.replace(/<script>[\s\S]*?<\/script>/, "");
    expect(withoutScript).toContain('<code id="install-command">curl -fsSL https://hubos.myhellohub.org/install.sh | bash</code>');
    expect(withoutScript).toContain('href="https://github.com/projecthelloworld-org/hub-os"');
    expect(html).toMatch(/<div class="command-window">[\s\S]*?<pre[^>]*>[\s\S]*?<\/pre>\s*<button class="copy-command"/);
  });

  test("writes identical root and versioned installers without branding changes", async () => {
    expect(await readFile(join(directory, "install.sh"), "utf8")).toBe(data.installer);
    expect(await readFile(join(directory, "releases/v0.1.0/install.sh"), "utf8")).toBe(data.installer);
  });

  test("copies the exact one-line command and announces success", async () => {
    let copied;
    const controls = copyControls({ writeText: async (text) => { copied = text; } });
    expect(controls.button.hidden).toBe(false);
    const copying = controls.click();
    expect(controls.button.disabled).toBe(true);
    expect(controls.attributes["aria-busy"]).toBe("true");
    await copying;
    expect(copied).toBe(controls.command.textContent);
    expect(controls.feedback.textContent).toBe("Installation command copied.");
    expect(controls.button.dataset.state).toBe("copied");
    expect(controls.button.title).toBe("Command copied");
    expect(controls.button.disabled).toBe(false);
    expect(controls.attributes["aria-busy"]).toBe("false");
  });

  test("offers manual copying when clipboard permission is denied", async () => {
    const controls = copyControls({ writeText: async () => { throw new Error("Not allowed"); } });
    await controls.click();
    expect(controls.feedback.textContent).toBe("Copy unavailable. Select the command and copy it manually.");
    expect(controls.selected()).toBe(controls.command);
    expect(controls.button.dataset.state).toBe("idle");
    expect(controls.button.title).toBe("Copy installation command");
    expect(controls.button.disabled).toBe(false);
  });

  test("offers the same manual fallback when the clipboard API is unavailable", async () => {
    const controls = copyControls(undefined);
    await controls.click();
    expect(controls.feedback.textContent).toContain("copy it manually");
    expect(controls.selected()).toBe(controls.command);
    expect(controls.button.disabled).toBe(false);
  });
});
