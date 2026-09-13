import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Field, GhostButton, InlineNotice, Input, PrimaryButton, Section, StatusDot } from "@multicode/module-sdk/ui";
import { GlobalSurfaceShell, SurfaceCanvasState, useSurfaceBackNav } from "@multicode/module-sdk/surface";

const DEFAULT_ENDPOINT = "http://127.0.0.1:4786";

const styles = `
.hc-root{height:100%;overflow:auto;background:var(--sem-color-bg-app);color:var(--sem-color-text-default);font:var(--sem-font-size-body)/var(--sem-font-line-default) var(--sem-font-family-ui)}
.hc-canvas{box-sizing:border-box;max-width:1180px;margin:0 auto;padding:28px 32px 48px}.hc-overview{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:22px}
.hc-metric{padding:16px 18px;border:1px solid var(--sem-color-border-subtle);border-radius:var(--sem-radius-shell);background:var(--sem-color-bg-surface)}.hc-metric-label{color:var(--sem-color-text-muted);font-size:var(--sem-font-size-meta)}.hc-metric-value{margin-top:7px;color:var(--sem-color-text-primary);font-size:24px;font-weight:var(--sem-font-weight-emphasis);letter-spacing:-.03em}.hc-metric-note{margin-top:3px;color:var(--sem-color-text-subtle);font-size:var(--sem-font-size-micro)}
.hc-table-wrap{overflow:hidden;border:1px solid var(--sem-color-border-subtle);border-radius:var(--sem-radius-shell);background:var(--sem-color-bg-surface)}.hc-table{width:100%;border-collapse:collapse}.hc-table th{padding:10px 14px;border-bottom:1px solid var(--sem-color-border-subtle);color:var(--sem-color-text-muted);font-size:var(--sem-font-size-micro);font-weight:var(--sem-font-weight-medium);letter-spacing:.05em;text-align:left;text-transform:uppercase}.hc-table td{padding:13px 14px;border-bottom:1px solid var(--sem-color-border-subtle);vertical-align:middle}.hc-table tr:last-child td{border-bottom:0}.hc-job{display:flex;align-items:center;gap:10px}.hc-job-name{color:var(--sem-color-text-primary);font-weight:var(--sem-font-weight-emphasis)}.hc-subtle{margin-top:2px;color:var(--sem-color-text-subtle);font:var(--sem-font-size-micro) var(--sem-font-family-mono)}.hc-state{display:flex;align-items:center;gap:7px}.hc-actions{display:flex;justify-content:flex-end;gap:6px}.hc-right{text-align:right!important}.hc-nodes{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.hc-node{padding:13px 14px;border:1px solid var(--sem-color-border-subtle);border-radius:var(--sem-radius-control);background:var(--sem-color-bg-surface)}.hc-node-head{display:flex;align-items:center;gap:8px;color:var(--sem-color-text-primary);font-weight:var(--sem-font-weight-medium)}.hc-node-detail{margin-top:5px;color:var(--sem-color-text-muted);font-size:var(--sem-font-size-meta)}.hc-settings{display:grid;gap:18px;max-width:620px;padding:8px 0}.hc-setting-actions{display:flex;align-items:center;gap:10px}.hc-code{font-family:var(--sem-font-family-mono)}
@media(max-width:820px){.hc-overview{grid-template-columns:repeat(2,1fr)}.hc-nodes{grid-template-columns:1fr}.hc-table th:nth-child(3),.hc-table td:nth-child(3){display:none}.hc-canvas{padding:20px 16px}}
`;

function FleetIcon({ className }) {
  return <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="6" rx="2"/><rect x="3" y="14" width="18" height="6" rx="2"/><path d="M7 7h.01M7 17h.01M17 7h1M17 17h1"/></svg>;
}

function configFrom(host) {
  return {
    endpoint: host.getModuleAppState("endpoint") || DEFAULT_ENDPOINT,
    token: host.getModuleAppState("token") || "",
  };
}

function useModuleConfig(host) {
  return useSyncExternalStore(
    (notify) => host.watchModuleAppState(notify),
    () => JSON.stringify(configFrom(host)),
  );
}

function relativeTime(value) {
  if (!value) return "Never";
  const seconds = Math.round((new Date(value).getTime() - Date.now()) / 1000);
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (Math.abs(seconds) < 90) return format.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 90) return format.format(minutes, "minute");
  return format.format(Math.round(minutes / 60), "hour");
}

function jobState(job) {
  if (job.paused) return { label: "Paused", tone: "warn" };
  const state = job.liveState || job.lastObservedState || (job.enabled ? "Waiting" : "Disabled");
  const lower = state.toLowerCase();
  if (["completed", "waiting"].includes(lower)) return { label: state, tone: "good" };
  if (["failed", "cancelled", "canceled", "stopped"].includes(lower)) return { label: state, tone: "error" };
  if (["running", "submitted", "queued"].includes(lower)) return { label: state, tone: "accent", pulse: true };
  return { label: state, tone: "neutral" };
}

function nodeName(node, index) {
  return node?.Info?.NodeID || node?.Info?.Name || node?.NodeID || node?.Name || node?.id || `Worker ${index + 1}`;
}

function nodeStatus(node) {
  return node?.ConnectionState?.Status || node?.ConnectionState || node?.Status || node?.status || "Connected";
}

function Dashboard({ host }) {
  const configKey = useModuleConfig(host);
  const config = useMemo(() => JSON.parse(configKey), [configKey]);
  const [snapshot, setSnapshot] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const refresh = useCallback(async () => {
    try {
      setSnapshot(await host.invoke("home-compute:snapshot", config));
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [host, configKey]);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 5_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const operate = async (job, action) => {
    setBusy(`${job.id}:${action}`);
    try {
      await host.invoke(`home-compute:${action}`, { ...config, jobId: job.id });
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy("");
    }
  };

  if (!snapshot && !error) return <SurfaceCanvasState kind="loading" label="Connecting to Home Compute"/>;
  if (!snapshot) return <SurfaceCanvasState kind="error" title="Home Compute is unavailable" hint="Check the endpoint and make sure the daemon is running." detail={error} onRetry={refresh}/>;
  const active = snapshot.jobs.filter((job) => job.activeJobId).length;
  const paused = snapshot.jobs.filter((job) => job.paused).length;
  const failed = snapshot.jobs.filter((job) => job.lastFinishedState === "Failed" || job.lastSubmissionError).length;

  return <div className="hc-root"><style>{styles}</style><div className="hc-canvas">
    {error ? <InlineNotice tone="warn" title="Latest refresh failed" detail={error}/> : null}
    <div className="hc-overview">
      <Metric label="Workers online" value={snapshot.nodeCount} note="Bacalhau compute nodes"/>
      <Metric label="Jobs configured" value={snapshot.jobs.length} note={`${paused} paused`}/>
      <Metric label="Active runs" value={active} note="Across the fleet"/>
      <Metric label="Needs attention" value={failed} note={failed ? "Review failed runs" : "All systems nominal"}/>
    </div>
    <Section title="Scheduled jobs" count={snapshot.jobs.length} inset="flush">
      <div className="hc-table-wrap"><table className="hc-table"><thead><tr><th>Job</th><th>State</th><th>Schedule</th><th>Last run</th><th className="hc-right">Actions</th></tr></thead><tbody>
        {snapshot.jobs.map((job) => {
          const state = jobState(job);
          const pauseAction = job.paused ? "resume" : "pause";
          return <tr key={job.id}><td><div className="hc-job"><StatusDot tone={state.tone} pulse={state.pulse}/><div><div className="hc-job-name">{job.id}</div><div className="hc-subtle">{job.image}</div></div></div></td><td><div className="hc-state">{state.label}</div></td><td className="hc-code">Every {job.schedule.every}</td><td>{relativeTime(job.lastSubmittedAt)}</td><td><div className="hc-actions"><GhostButton size="xs" busy={busy === `${job.id}:run`} disabled={Boolean(job.activeJobId)} onClick={() => operate(job, "run")}>Run now</GhostButton><GhostButton size="xs" busy={busy === `${job.id}:${pauseAction}`} onClick={() => operate(job, pauseAction)}>{job.paused ? "Resume" : "Pause"}</GhostButton></div></td></tr>;
        })}
      </tbody></table></div>
    </Section>
    <Section title="Compute nodes" count={snapshot.nodeCount}>
      <div className="hc-nodes">{snapshot.nodes.length ? snapshot.nodes.map((node, index) => <div className="hc-node" key={nodeName(node, index)}><div className="hc-node-head"><StatusDot tone="good"/><span>{nodeName(node, index)}</span></div><div className="hc-node-detail">{nodeStatus(node)} · available for placement</div></div>) : <div className="hc-node-detail">No workers reported by the orchestrator.</div>}</div>
    </Section>
  </div></div>;
}

function Metric({ label, value, note }) {
  return <div className="hc-metric"><div className="hc-metric-label">{label}</div><div className="hc-metric-value">{value}</div><div className="hc-metric-note">{note}</div></div>;
}

function createSurface(host) {
  return function HomeComputeSurface() {
    const back = useSurfaceBackNav();
    return <GlobalSurfaceShell ariaLabel="Home Compute" bar={{ title: "Home Compute" }} onBack={back.onBack} canGoBack={back.canGoBack}><Dashboard host={host}/></GlobalSurfaceShell>;
  };
}

function createSettings(host) {
  return function HomeComputeSettings({ values, setValue }) {
    const [status, setStatus] = useState("");
    const endpoint = typeof values.endpoint === "string" ? values.endpoint : DEFAULT_ENDPOINT;
    const token = typeof values.token === "string" ? values.token : "";
    const test = async () => {
      setStatus("Testing…");
      try {
        await host.invoke("home-compute:test-connection", { endpoint, token });
        setStatus("Connected");
      } catch (cause) {
        setStatus(cause instanceof Error ? cause.message : String(cause));
      }
    };
    return <div className="hc-settings"><style>{styles}</style><Field label="Controller endpoint" htmlFor="home-compute-endpoint" help="The Home Compute API on this machine or your private network."><Input id="home-compute-endpoint" fullWidth value={endpoint} onChange={(event) => setValue("endpoint", event.target.value)}/></Field><Field label="Bearer token" htmlFor="home-compute-token" help="Stored in Studio's module settings and sent only to this endpoint."><Input id="home-compute-token" fullWidth type="password" value={token} onChange={(event) => setValue("token", event.target.value)}/></Field><div className="hc-setting-actions"><PrimaryButton size="sm" onClick={test}>Test connection</PrimaryButton><span>{status}</span></div></div>;
  };
}

export function registerRenderer(host) {
  host.registerSettingsSection({ id: "connection", label: "Home Compute", description: "Connect Studio to your self-hosted controller.", icon: FleetIcon, Component: createSettings(host), order: 72 });
  host.registerGlobalSurface({ id: "home-compute", label: "Home Compute", Icon: FleetIcon, Component: createSurface(host), railPlacement: "inline" });
}
