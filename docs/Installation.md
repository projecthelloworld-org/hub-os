# Installing HubOS from a terminal

HubOS includes an interactive installer for system administrators. It prepares a complete core deployment, generates independent service secrets, connects Metabase to PostgreSQL, starts the containers, and verifies their health.

## Interactive installation

From an unpacked HubOS release:

```sh
./install.sh
```

The installer asks for:

- the network bind address and public ports;
- the URL Metabase should include in alerts;
- the Metabase administrator's name, email, and password;
- whether Docker should be installed when it is missing on a supported Ubuntu or Debian host.

Pressing Enter at the password prompt generates a strong password. PostgreSQL, API, Metabase application-database, and encryption secrets are always generated unless explicitly supplied through environment variables. All values are stored in `.env` with permissions limited to its owner.

The core profile installs HubOS, PostgreSQL, Caddy, Metabase, the demonstration schools, and Mailpit. To include the independently maintained ODK Central and Headwind MDM applications:

```sh
./install.sh --profile ecosystem
```

The ecosystem profile needs `git` and considerably more memory, storage, and startup time.

## Hosted one-command installation

The public installation command is:

```sh
curl -fsSL https://hubos.myhellohub.org/install.sh | bash
```

Interactive input is read directly from the terminal, so piping the script does not consume the answers. The hosted installer is published over HTTPS, and its embedded `DEFAULT_RELEASE_URL` and `DEFAULT_RELEASE_SHA256` identify the immutable GitHub release archive. The installer verifies that checksum before extracting the release. A mirror or internally reviewed archive can be supplied explicitly:

```sh
curl -fsSL https://hubos.myhellohub.org/install.sh | \
  HUBOS_RELEASE_URL=https://mirror.example.org/hubos-VERSION.tar.gz \
  HUBOS_RELEASE_SHA256=THE_RELEASE_SHA256 bash
```

Administrators should inspect a downloaded installer before running it with elevated privileges. HubOS does not install Docker silently. On Ubuntu and Debian, the operator must approve installation from Docker's official package repository. On macOS, the installer directs the operator to install and start Docker Desktop.

## Automated installation

For configuration management or unattended test hosts, provide settings in the environment:

```sh
METABASE_ADMIN_EMAIL=operator@example.org \
METABASE_ADMIN_PASSWORD='use-a-secret-manager' \
HUBOS_BIND_ADDRESS=0.0.0.0 \
./install.sh --non-interactive --yes
```

Omitted service secrets are generated securely. Use `--no-start` to create and validate the configuration without starting containers. Use `--install-dir PATH` when a downloaded release should live outside the default `$HOME/hubos` directory.

## Existing installations

Re-running the installer detects and preserves an existing `.env`; this prevents accidental rotation of passwords that are already attached to persistent PostgreSQL volumes. It validates the current Compose configuration and starts or repairs the declared services. Database credential rotation must use a documented rotation procedure rather than replacing `.env` alone.

The installer does not remove containers, volumes, databases, dashboards, or existing credentials. Before upgrading, back up:

- the installation directory, especially `.env`;
- the `postgres-data` volume;
- the `metabase-db-data` volume;
- ODK and Headwind data when the ecosystem profile is enabled.

## Production boundary

The generated deployment is suitable for local evaluation and controlled internal networks. Before binding it to a public interface, configure HTTPS domains in Caddy, external identity or OIDC, firewall rules, restricted administrator access, encrypted off-host backups, monitoring of backup restoration, and a production secret manager.

Docker publishes configured container ports before some host firewall rule sets. Review Docker's firewall behavior and expose only the intended HubOS entry points.
