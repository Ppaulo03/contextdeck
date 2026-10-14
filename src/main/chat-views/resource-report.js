'use strict';

// Resource report of the ChatGPT views (M01-I3C-1). Pure: it turns the lifecycle inventory and the process metrics that main already
// has (Electron's app.getAppMetrics(), the OS process id of each view) into one picture. Nothing is read from a page, nothing is
// polled (a report is built only when asked) and no memory is ever attributed to a single view:
//
//   * Chromium may host several views in ONE renderer process (same site), and the GPU and utility processes are shared by
//     everything. A process that hosts views lists them all (`views`) and says it is `shared` when there is more than one.
//   * `viewHostsMB` is the sum over the DISTINCT processes that host at least one view: an upper bound for what the views cost,
//     not their cost. Destroying a view frees what its renderer can give back; Chromium may keep memory allocated afterwards.
//   * Working set (Windows) counts shared pages in every process that maps them; a sum over processes over-counts shared memory.
//     Use deltas between reports taken the same way, never the absolute total as "the app's memory".
//   * `cpuPercent` is the CPU used since the previous call to getAppMetrics() (any caller): take a first sample, wait, take the real one.
//   * No message, title or URL is part of a report.

const METHOD_NOTES = Object.freeze([
  'Memory is the working set reported by Electron (app.getAppMetrics) per process, in MB; shared pages are counted in every process that maps them.',
  'A process that hosts several views is marked shared; its memory is never divided among them. viewHostsMB is an upper bound, not a per-view cost.',
  'GPU, Browser (main) and Utility processes serve the whole application and are reported apart from the view hosts.',
  'cpuPercent is the use since the previous getAppMetrics() call: take one sample, wait, then take the one that is reported.',
  'Chromium may keep memory allocated after a view is destroyed; compare samples taken after a settling period, not only right after.'
]);

const mb = (kb) => Math.round(((kb || 0) / 1024) * 10) / 10;
const round2 = (n) => Math.round((n || 0) * 100) / 100;

// inventory: lifecycle.inventory(); summary: lifecycle.summary(); metrics: app.getAppMetrics(); pids: { viewId: osPid }.
function buildResourceReport({ summary, inventory = [], metrics = [], pids = {}, hubStats = null, at = Date.now() } = {}) {
  const hosting = new Map();                      // pid -> [viewId]
  for (const [viewId, pid] of Object.entries(pids)) if (pid) hosting.set(pid, [...(hosting.get(pid) || []), viewId]);
  const processes = metrics.map((m) => {
    const views = hosting.get(m.pid) || [];
    return {
      pid: m.pid, type: m.type, name: m.name || m.serviceName || null,
      workingSetMB: mb(m.memory && m.memory.workingSetSize), peakWorkingSetMB: mb(m.memory && m.memory.peakWorkingSetSize), privateMB: mb(m.memory && m.memory.privateBytes),
      cpuPercent: round2(m.cpu && m.cpu.percentCPUUsage), idleWakeupsPerSec: round2(m.cpu && m.cpu.idleWakeupsPerSecond),
      views, shared: views.length > 1
    };
  });
  const sum = (list, key) => round2(list.reduce((a, p) => a + p[key], 0));
  const hosts = processes.filter((p) => p.views.length > 0);
  const byType = {};
  for (const p of processes) byType[p.type] = { processes: (byType[p.type] ? byType[p.type].processes : 0) + 1, workingSetMB: round2((byType[p.type] ? byType[p.type].workingSetMB : 0) + p.workingSetMB) };
  const unmapped = Object.keys(pids).filter((id) => !pids[id] || !processes.some((p) => p.pid === pids[id]));
  return {
    at,
    views: summary || null,
    inventory: inventory.map((r) => ({ viewId: r.viewId, state: r.state, kind: r.kind, selected: r.selected, observed: r.observed, eligible: r.eligible, blockers: r.blockers })),
    observers: hubStats ? hubStats.observers : null,
    processes,
    totals: {
      processes: processes.length,
      allWorkingSetMB: sum(processes, 'workingSetMB'),
      allCpuPercent: sum(processes, 'cpuPercent'),
      viewHosts: hosts.length,
      viewHostsMB: sum(hosts, 'workingSetMB'),
      viewHostsCpuPercent: sum(hosts, 'cpuPercent'),
      sharedHosts: hosts.filter((p) => p.shared).length,
      byType
    },
    unmappedViews: unmapped,
    notes: METHOD_NOTES
  };
}

module.exports = { buildResourceReport, METHOD_NOTES };
