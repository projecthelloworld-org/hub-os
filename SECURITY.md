# Security policy

## Supported versions

HubOS is currently in its first public development series. Security fixes are applied to the latest tagged release and the `main` branch.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability, exposed credential, or sensitive school data. Use GitHub's private vulnerability reporting feature for this repository. If that feature is unavailable, contact Project Hello World through its established private organisational contact channel and include:

- the affected version or commit;
- the component and deployment mode;
- reproduction steps or a proof of concept;
- the likely impact;
- any suggested mitigation.

Do not access data that is not yours, disrupt a running school service, or retain personal information while investigating. The maintainers will acknowledge a complete report, assess severity, coordinate a fix, and credit the reporter when requested and safe.

## Deployment boundary

The reference Compose environment is for evaluation and controlled internal deployments. An internet-facing deployment additionally requires HTTPS, external identity or OIDC, least-privilege access, a production secret manager, firewall review, encrypted off-host backups, restore testing, and operational monitoring.
