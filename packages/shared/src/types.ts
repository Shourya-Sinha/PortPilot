/**
 * Core domain types for PortPilot HomeDeploy Dashboard.
 * These types are shared by the API, worker, engines and dashboard.
 */

export type DeploymentStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'rolled_back';

export type DeploymentPhase =
  | 'queued'
  | 'checkout'
  | 'detect'
  | 'install'
  | 'build'
  | 'artifact'
  | 'port_allocation'
  | 'startup'
  | 'health_check'
  | 'done'
  | 'failed'
  | 'cancelled';

export type RuntimeStatus =
  | 'stopped'
  | 'starting'
  | 'running'
  | 'unhealthy'
  | 'crashed'
  | 'unknown';

export type HostnameMode = 'local' | 'lan' | 'public';

export type HostnameResolutionStatus =
  | 'configured'
  | 'resolvable_local'
  | 'resolvable_public'
  | 'unresolvable'
  | 'unknown';

export type HostnameReachabilityStatus =
  | 'reachable_local'
  | 'unreachable_local'
  | 'reachable_external'
  | 'unreachable_external'
  | 'not_checked';

export type DeploymentMode = 'static' | 'node' | 'java-maven' | 'java-gradle';

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'none';

export type Framework =
  | 'static'
  | 'vite'
  | 'react'
  | 'next'
  | 'node'
  | 'express'
  | 'fastify'
  | 'java-maven'
  | 'java-gradle'
  | 'unknown';

export interface Project {
  id: string;
  name: string;
  /** Required website name used to generate the local hostname. */
  websiteName: string;
  repoUrl: string;
  branch: string;
  projectRoot: string;
  framework: Framework;
  deploymentMode: DeploymentMode;
  packageManager: PackageManager;
  installCommand: string | null;
  buildCommand: string | null;
  startCommand: string | null;
  outputDir: string | null;
  preferredPort: number | null;
  healthCheckPath: string | null;
  hostnameMode: HostnameMode;
  /** Optional public hostname. Never shown as available unless externally verified. */
  publicHostname: string | null;
  /** True when the project was confirmed by the user on first deployment. */
  configConfirmed: boolean;
  webhookSecret: string | null;
  /** Reference id of the stored GitHub token (never the token itself). */
  githubTokenRef: string | null;
  lastCommitSha: string | null;
  activeDeploymentId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Deployment {
  id: string;
  projectId: string;
  status: DeploymentStatus;
  phase: DeploymentPhase;
  commitSha: string | null;
  commitMessage: string | null;
  port: number | null;
  pid: number | null;
  artifactPath: string | null;
  workspacePath: string | null;
  error: string | null;
  exitCode: number | null;
  isRollbackOf: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
}

export interface HostnameRecord {
  id: string;
  projectId: string | null;
  hostname: string;
  mode: HostnameMode;
  targetPort: number | null;
  publicHostname: string | null;
  httpsEnabled: boolean;
  resolutionStatus: HostnameResolutionStatus;
  reachabilityStatus: HostnameReachabilityStatus;
  lastChecked: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EnvVar {
  id: string;
  projectId: string;
  key: string;
  /** Only ever exposed masked (e.g. "ab****xy"). */
  maskedValue: string;
  createdAt: string;
  updatedAt: string;
}

export interface RuntimeInfo {
  projectId: string;
  deploymentId: string | null;
  status: RuntimeStatus;
  pid: number | null;
  port: number | null;
  cwd: string | null;
  startedAt: string | null;
  lastError: string | null;
}

export interface ActivityEvent {
  id: string;
  type: string;
  message: string;
  projectId: string | null;
  deploymentId: string | null;
  createdAt: string;
}

export interface LogLine {
  ts: string;
  stream: 'stdout' | 'stderr' | 'system';
  text: string;
}

export interface DetectedConfig {
  framework: Framework;
  deploymentMode: DeploymentMode;
  packageManager: PackageManager;
  installCommand: string | null;
  buildCommand: string | null;
  startCommand: string | null;
  outputDir: string | null;
  healthCheckPath: string | null;
  confidence: 'high' | 'medium' | 'low';
  notes: string[];
}

export interface OverviewStats {
  projects: number;
  runningApps: number;
  failedDeployments: number;
  successfulDeployments: number;
  currentBuilds: number;
  queuedBuilds: number;
  cpuPercent: number | null;
  totalMemMb: number;
  freeMemMb: number;
  apiStatus: 'online';
  dnsStatus: 'running' | 'stopped' | 'error' | 'disabled';
  proxyStatus: 'running' | 'stopped' | 'error';
  publicAccessStatus: 'local_only' | 'direct_possible' | 'relay_required' | 'unknown';
  uptimeSeconds: number;
  nodeVersion: string;
  platform: string;
}

export interface NetworkDiagnostics {
  localAddresses: { name: string; address: string; family: string }[];
  defaultGateway: string | null;
  internetConnectivity: 'online' | 'offline' | 'unknown';
  publicIp: string | null;
  routerWanIp: string | null;
  behindNat: boolean | null;
  cgnatSuspected: boolean | null;
  cgnatConfidence: 'likely' | 'unlikely' | 'inconclusive';
  inboundPossible: 'possible' | 'unlikely' | 'unknown';
  listeningPorts: { port: number; label: string }[];
  portForwardingConfigured: boolean | null;
  publicHostnameConfigured: boolean;
  notes: string[];
  checkedAt: string;
}

/** Adapter contract for public-access strategies (direct hosting, relay, tunnel). */
export interface PublicAccessAdapter {
  id: string;
  name: string;
  description: string;
  /** Whether this adapter can work under the current network conditions. */
  assess(diag: NetworkDiagnostics): {
    viable: boolean;
    reason: string;
  };
  /** Human guidance; adapters never change router/firewall settings silently. */
  getGuidance(diag: NetworkDiagnostics): string[];
  /** Optional live configuration (e.g. user-supplied relay endpoint). */
  configure?(config: Record<string, string>): Promise<{ ok: boolean; message: string }>;
  stop?(): Promise<void>;
}
