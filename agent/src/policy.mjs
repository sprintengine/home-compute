// The machine's own rules for what it runs (§4.3), which the control plane
// cannot override: images must match `allowImages` (empty until the owner
// lists some: nothing runs by default); an image without a registry host (a
// local build, or Docker Hub's short names) only with `allowLocalImages`;
// never host networking. Privileges, bind mounts, devices and the Docker
// socket are never passed to `docker run` (its argv is fixed, see
// runtime/docker-cli.mjs), and a spec that asks for them is refused outright
// rather than quietly run without them.

const NETWORKS = new Set(["bridge", "none"]);
/** Spec fields that would ask for more than §4.3 allows; a spec carrying any is refused. */
const FORBIDDEN = {
  privileged: "privileged mode", volumes: "volumes", mounts: "mounts", binds: "bind mounts", devices: "devices",
  capAdd: "added capabilities", cap_add: "added capabilities", securityOpt: "security options", pid: "the host's PID namespace",
  ipc: "the host's IPC namespace", userns: "a user namespace mode", hostNetwork: "host networking", cgroupParent: "a cgroup parent",
  runtime: "another container runtime", sysctls: "sysctls",
};

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
  for (const [field, what] of Object.entries(FORBIDDEN)) {
    if (spec && Object.hasOwn(spec, field) && spec[field] !== null && spec[field] !== undefined && spec[field] !== false) {
      return `the spec asks for ${what}, which this machine never allows`;
    }
  }
  const image = String(spec?.image ?? "");
  if (!image || /\s/.test(image)) return "the image reference is invalid";
  if (isLocalImage(image) && !config.allowLocalImages) {
    return `${image} has no registry host; this machine runs such images only with allowLocalImages`;
  }
  const patterns = config.allowImages ?? [];
  if (!patterns.length) return "this machine's allowImages is empty, so it runs no image until its owner lists some";
  const allowed = patterns.some((pattern) => globToRegExp(pattern).test(image));
  if (!allowed) return `${image} does not match this machine's allowImages`;
  if (!NETWORKS.has(spec.network ?? "bridge")) return `network ${spec.network} is not allowed (only bridge or none)`;
  return null;
}
