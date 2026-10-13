# Security policy

## Supported versions

Use the latest maintained release and review upstream component advisories before deployment. Security fixes are delivered in new releases; published tags and assets are not rewritten. Early releases are not a production-security certification.

The v0.1.0 package includes Metabase 0.60.7, which is affected by a critical upstream advisory. See [component upgrade guidance](docs/Metabase_Compatibility.md) before use.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability, exposed credential or sensitive community data. Use GitHub's private vulnerability reporting feature for this repository. If unavailable, email [data@projecthelloworld.org](mailto:data@projecthelloworld.org) privately and include:

- the affected version or commit;
- the component and deployment mode;
- reproduction steps or a proof of concept;
- the likely impact;
- any suggested mitigation.

Do not access data that is not yours, disrupt a community service or retain personal information while investigating. Maintainers assess complete reports, coordinate remediation and credit reporters when requested and safe. Do not include working credentials or personal records in a report unless a secure transfer is explicitly arranged.

## Deployment boundary

Operate within the controls documented for your release. Remote exposure requires verified TLS, strong credentials, reviewed service ports/firewalls, protected backups and restore testing. Basic operator authentication does not imply tenant isolation, advanced roles or OIDC/MFA. See [operator and machine access](docs/Security_and_Access.md) for the trust boundary and deployment responsibilities.
