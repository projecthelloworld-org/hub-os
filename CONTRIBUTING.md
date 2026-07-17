# Contributing to HubOS

HubOS is open infrastructure for monitoring and supporting school connectivity. Contributions that improve interoperability, field reliability, privacy, maintainability, documentation, or operational usefulness are welcome.

## Before opening a change

- Use an issue to discuss large architectural changes or a new required dependency.
- Do not include real school, learner, device, network, or credential data.
- Keep vendor-specific behavior inside a connector and emit the canonical observation envelope.
- Keep HubOS-owned runtime code in vanilla JavaScript on Bun.
- Declare database changes as forward SQL migrations; do not add an ORM schema layer.

## Local checks

Run these before submitting a pull request:

```sh
make install
make test
make check
make compose-config
```

Changes to the optional ODK or Headwind deployment should also pass:

```sh
make ecosystem-config
```

Add tests for changed behavior. Documentation and example configuration must use synthetic identifiers and placeholder credentials only.

## Pull requests

Keep a pull request focused on one change. Explain the operational problem, the approach, how it was verified, and any migration or compatibility impact. By contributing, you agree that your contribution is licensed under the repository's MIT License.
