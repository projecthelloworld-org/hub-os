import { describe, expect, test } from "bun:test";
import { selectStableReleases, validateReleaseInstaller } from "../../../scripts/build-pages.js";

const hash = "a".repeat(64);
const archiveUrl = "https://github.com/projecthelloworld-org/hub-os/releases/download/v0.1.0/hubos-v0.1.0.tar.gz";
function fixture() {
  return {
    release: {
      tag_name: "v0.1.0", draft: false, prerelease: false,
      assets: [{ name: "hubos-v0.1.0.tar.gz", browser_download_url: archiveUrl, digest: `sha256:${hash}` }],
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
