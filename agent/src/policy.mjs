// The machine's own rules for what it runs (§4.3), which the control plane
// cannot override: images must match `allowImages`; an image without a
// registry host (a local build, or Docker Hub's short names) only with
// `allowLocalImages`; never host networking. Privileges, bind mounts and the
// Docker socket are never asked for: a spec has no field that could.

const NETWORKS = new Set(["bridge", "none"]);

function globToRegExp(pattern) {
  return new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
}

/** Whether `image` names no registry host: `wingfoil-forecast:local`, `alpine`, `user/app`. */
export function isLocalImage(image) {
  const slash = image.indexOf("/");
  if (slash < 0) return true;
  const first = image.slice(0, slash);
  return !(first.includes(".") || first.includes(":") || first === "localhost");
}

/** Why this machine refuses a claim's spec, or null. */
export function specRefusal(spec, config) {
  const image = String(spec?.image ?? "");
  if (!image || /\s/.test(image)) return "the image reference is invalid";
  if (isLocalImage(image) && !config.allowLocalImages) {
    return `${image} has no registry host; this machine runs such images only with allowLocalImages`;
  }
  const allowed = (config.allowImages ?? []).some((pattern) => globToRegExp(pattern).test(image));
  if (!allowed) return `${image} does not match this machine's allowImages`;
  if (!NETWORKS.has(spec.network ?? "bridge")) return `network ${spec.network} is not allowed`;
  return null;
}
