import type { NetworkDiagnostics, PublicAccessAdapter } from '@portpilot/shared';
import { nowIso } from '@portpilot/shared';

/**
 * Public-access strategies.
 *
 * Strategy A — Direct public hosting (viable when the ISP/router allow inbound).
 * Strategy B — No direct inbound (CGNAT/blocked): local features keep working;
 *              an optional external relay/tunnel can be plugged in via the
 *              PublicAccessAdapter interface. No third-party tunnel service is
 *              required or bundled.
 *
 * Honest-scope rule: nothing here claims public reachability without external
 * verification. Adapters produce guidance only; they never change router or
 * firewall settings.
 */

export class DirectHostingAdapter implements PublicAccessAdapter {
  id = 'direct';
  name = 'Direct public hosting (Strategy A)';
  description =
    'Publish a local app directly using your public IP, router port forwarding and (optionally) a free dynamic DNS hostname. No VPS or paid service required.';

  assess(diag: NetworkDiagnostics): { viable: boolean; reason: string } {
    if (diag.cgnatConfidence === 'likely') {
      return { viable: false, reason: 'The router WAN address appears private (CGNAT/double-NAT). Inbound connections from the internet cannot reach this PC without a relay.' };
    }
    if (diag.inboundPossible === 'possible') {
      return { viable: true, reason: 'A public WAN address was detected. Port forwarding + firewall rules may enable inbound HTTP(S). External verification is still required.' };
    }
    return { viable: false, reason: 'Network conditions could not be verified (router WAN IP unknown). Direct hosting cannot be confirmed until port forwarding is tested from outside.' };
  }

  getGuidance(diag: NetworkDiagnostics): string[] {
    const steps = [
      '1. Log into your router admin page and forward TCP 80/443 (or your chosen public port) to this PC\'s LAN IP (' + (diag.localAddresses[0]?.address ?? 'unknown') + ').',
      '2. Add a Windows Firewall inbound rule for the PortPilot proxy port. Use PowerShell (Administrator): New-NetFirewallRule -DisplayName "PortPilot Proxy" -Direction Inbound -Protocol TCP -LocalPort 8080 -Action Allow',
      '3. If your public IP changes (dynamic IP), use a legitimate free dynamic DNS hostname and enable its update client, or update the DNS record manually when it changes.',
      '4. Point the public DNS A-record (or the DDNS hostname) at your public IP: ' + (diag.publicIp ?? '(unknown - check your router admin page)') + '.',
      '5. Test from an external network (e.g. a phone on cellular data). Only after an external HTTP 200 is received is the app publicly reachable.',
      '6. For HTTPS, obtain a publicly trusted certificate (e.g. Let\'s Encrypt DNS-01) and terminate TLS on the PortPilot proxy. Certificates require a real public hostname — self-signed certificates do NOT provide public trust.',
    ];
    if (diag.cgnatConfidence === 'likely') {
      steps.unshift('WARNING: CGNAT is likely. Port forwarding cannot work in this situation — use Strategy B (relay) instead.');
    }
    return steps;
  }
}

export interface RelayConfig {
  endpoint: string;
  token?: string;
}

/**
 * Strategy B — user-operated relay / external tunnel connector.
 *
 * A clean adapter interface so a relay implementation can be added later.
 * A fully custom public relay needs SOME publicly reachable endpoint (a VPS,
 * a friend's server, a free-tier host...). If no reachable endpoint exists and
 * no third-party tunnel is permitted, globally accessible hosting cannot be
 * guaranteed — this module will never pretend otherwise.
 */
export class RelayTunnelAdapter implements PublicAccessAdapter {
  id = 'relay';
  name = 'External relay / tunnel connector (Strategy B)';
  description =
    'Connect PortPilot to a user-operated public relay or an external tunnel agent you already run. Local deployments keep working regardless. Requires a publicly reachable endpoint somewhere.';
  private config: RelayConfig | null = null;

  assess(diag: NetworkDiagnostics): { viable: boolean; reason: string } {
    if (this.config?.endpoint) {
      return { viable: true, reason: `Relay endpoint configured: ${this.config.endpoint}. Public reachability must be verified externally after the relay is running.` };
    }
    return {
      viable: false,
      reason:
        'No relay endpoint configured. A relay requires a publicly reachable endpoint operated by you (VPS, home server elsewhere, etc.). PortPilot does not bundle or mandate any third-party tunnel service.',
    };
  }

  getGuidance(_diag: NetworkDiagnostics): string[] {
    return [
      '1. Operate a small relay on any host with a public IP (a minimal HTTPS reverse tunnel endpoint is enough; no specific provider is required).',
      '2. Register it here via the Public Access page (endpoint URL + an access token you generate).',
      '3. The relay forwards public HTTP(S) traffic to this PC through an outbound connection, so no inbound port forwarding is needed.',
      '4. Verify public reachability from an external network before showing any public URL in the dashboard.',
      'Note: Outbound-only tunnels to third-party services (Cloudflare Tunnel, ngrok, etc.) are NOT required and NOT bundled. You may plug your own into this adapter.',
    ];
  }

  async configure(config: Record<string, string>): Promise<{ ok: boolean; message: string }> {
    const endpoint = (config.endpoint ?? '').trim();
    if (!/^https?:\/\/[A-Za-z0-9.-]+(:\d+)?(\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]*)?$/.test(endpoint)) {
      return { ok: false, message: 'Relay endpoint must be a valid http(s) URL.' };
    }
    this.config = { endpoint, token: config.token };
    return { ok: true, message: `Relay endpoint saved. Connector status: NOT CONNECTED (implement the outbound connector against the PublicAccessAdapter interface, then verify externally). Saved at ${nowIso()}.` };
  }

  async stop(): Promise<void> {
    this.config = null;
  }

  get current(): RelayConfig | null {
    return this.config;
  }
}

export class PublicAccessManager {
  readonly adapters: PublicAccessAdapter[] = [new DirectHostingAdapter(), new RelayTunnelAdapter()];

  get(id: string): PublicAccessAdapter | undefined {
    return this.adapters.find((a) => a.id === id);
  }

  status(diag: NetworkDiagnostics): { id: string; name: string; description: string; viable: boolean; reason: string; guidance: string[] }[] {
    return this.adapters.map((a) => {
      const assess = a.assess(diag);
      return { id: a.id, name: a.name, description: a.description, ...assess, guidance: a.getGuidance(diag) };
    });
  }

  overallStatus(diag: NetworkDiagnostics): 'local_only' | 'direct_possible' | 'relay_required' | 'unknown' {
    const direct = this.get('direct')!.assess(diag);
    if (direct.viable) return 'direct_possible';
    if (diag.cgnatConfidence === 'inconclusive' && diag.inboundPossible === 'unknown') return 'unknown';
    return 'relay_required';
  }
}
