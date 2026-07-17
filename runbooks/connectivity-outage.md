# Connectivity outage

Use this runbook when a site-perspective connectivity check is persistently failing.

## Safety and scope

- Do not expose router management ports to the public internet.
- Do not ask school staff to perform electrical work.
- Do not reboot equipment repeatedly without recording the result.

## Triage

1. Confirm whether the evidence is fresh or the monitoring path is stale.
2. Compare WAN, power, controller, and access-point status.
3. Check whether other schools using the same controller or ISP are affected.
4. If power is degraded, follow the approved power-system runbook before network changes.
5. If power is healthy and the WAN is down, contact the ISP using the mapped subscriber reference.
6. If the WAN is healthy but Wi-Fi is down, check the gateway, switch, and access-point chain.

## Resolution evidence

Before closing the incident, record:

- the recovery time;
- the person or organisation that restored service;
- the action taken;
- a fresh successful site-perspective probe;
- whether the problem is likely to recur.

