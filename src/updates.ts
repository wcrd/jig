// Check for Updates: compares this version with the latest GitHub release and
// says whether there's a newer one, with a button to its release page. It
// doesn't download or install anything.

import { getVersion } from "@tauri-apps/api/app";

import { isTauri, openUrl } from "./api";
import { notify } from "./ui";

const LATEST_RELEASE = "https://api.github.com/repos/wcrd/jig/releases/latest";

export async function checkForUpdates() {
  if (!isTauri) return;
  const current = await getVersion();
  let release: { tag_name: string; html_url: string };
  try {
    const response = await fetch(LATEST_RELEASE, { headers: { Accept: "application/vnd.github+json" } });
    if (response.status === 404) return notify("No Jig releases are published yet.");
    if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
    release = await response.json();
  } catch (e) {
    return notify(`Couldn't check for updates: ${e instanceof Error ? e.message : e}`);
  }
  const latest = release.tag_name.replace(/^v/, "");
  if (compareVersions(latest, current) > 0) {
    notify(`Jig ${latest} is available (you have ${current}).`, { label: "Download", run: () => openUrl(release.html_url) });
  } else {
    notify(`Jig ${current} is the latest version.`);
  }
}

/** Compares dotted version numbers part by part; a missing part counts as 0. */
function compareVersions(a: string, b: string): number {
  const as = a.split(".").map((n) => parseInt(n, 10) || 0);
  const bs = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    const diff = (as[i] ?? 0) - (bs[i] ?? 0);
    if (diff) return diff;
  }
  return 0;
}
