import https from "https";
import pkg from "../../../../package.json" with { type: "json" };

const NPM_PACKAGE_NAME = "9router";
const DOCKERHUB_REPO = "simata/9router";
const DOCKERHUB_TAG = "stable";

function fetchJson(url) {
  return new Promise((resolve) => {
    const req = https.get(url, { timeout: 4000 }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}

// Fetch latest version from npm registry
async function fetchLatestVersion() {
  const data = await fetchJson(`https://registry.npmjs.org/${NPM_PACKAGE_NAME}/latest`);
  return data?.version || null;
}

async function fetchDockerTagInfo(tag = DOCKERHUB_TAG) {
  const data = await fetchJson(`https://hub.docker.com/v2/repositories/${DOCKERHUB_REPO}/tags/${tag}`);
  const digest = data?.images?.find((image) => image.digest)?.digest || null;
  return data ? {
    repo: DOCKERHUB_REPO,
    tag,
    digest,
    digestShort: digest ? digest.replace(/^sha256:/, "").slice(0, 12) : null,
    lastUpdated: data.last_updated || null,
    pullCommand: `docker pull ${DOCKERHUB_REPO}:${DOCKERHUB_TAG}`,
  } : null;
}

function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}

export async function GET() {
  const [latestVersion, dockerInfo, rawImageSha] = await Promise.all([
    fetchLatestVersion(),
    fetchDockerTagInfo(DOCKERHUB_TAG),
    Promise.resolve(process.env.NEXT_PUBLIC_APP_IMAGE_SHA || process.env.SOURCE_COMMIT || null),
  ]);
  
  const currentVersion = pkg.version;
  const imageSha = rawImageSha ? String(rawImageSha).slice(0, 7) : null;
  const isDockerImage = !!rawImageSha;
  let hasNpmUpdate = latestVersion ? compareVersions(latestVersion, currentVersion) > 0 : false;
  
  let dockerUpdate = null;
  if (isDockerImage && dockerInfo && dockerInfo.digestShort) {
    // Check if current image SHA (which acts as tag) matches Docker Hub's stable digest
    const shaFull = String(rawImageSha);
    // Try to match: either if sha is already digest format, or if it's a short commit SHA being used as tag
    // Compare dockerInfo.digestShort against shaFull (checking if sha contains digest or vice versa)
    const shaMatches = shaFull.replace(/^sha256:/, "").slice(0, 12) === dockerInfo.digestShort ||
                       dockerInfo.digestShort.startsWith(shaFull.replace(/^sha256:/, ""));
    // If SHA is also a Docker tag, try fetching that specific tag
    if (!shaMatches && shaFull.length === 40) {
      // Likely a commit SHA used as Docker tag, try to fetch that tag
      const shaTagInfo = await fetchDockerTagInfo(shaFull);
      if (shaTagInfo && shaTagInfo.digest) {
        const shaDigestFull = shaTagInfo.digest.replace(/^sha256:/, "");
        const stableDigestFull = dockerInfo.digest.replace(/^sha256:/, "");
        hasNpmUpdate = false; // For docker, compare image digests
        dockerUpdate = !shaDigestFull.startsWith(stableDigestFull.slice(0, 12)) || !stableDigestFull.startsWith(shaDigestFull.slice(0, 12));
      }
    } else {
      dockerUpdate = !shaMatches;
    }
  }
  
  const hasUpdate = hasNpmUpdate || dockerUpdate;

  return Response.json({ 
    currentVersion, 
    latestVersion, 
    hasUpdate,
    isDockerImage,
    imageSha,
    dockerInfo,
    shaTag: rawImageSha
  });
}
