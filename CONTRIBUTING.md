# Contributing to HubOS

HubOS is open infrastructure for monitoring and supporting community connectivity. Contributions that improve interoperability, field reliability, privacy, maintainability, documentation, accessibility or operational usefulness are welcome.

## Before opening a change

- Use an issue to discuss large architectural changes or a new required dependency.
- Do not include real community, participant, respondent, device, network or credential data.
- Keep vendor-specific behavior inside a connector and emit the canonical observation envelope.
- Keep HubOS-owned runtime code in vanilla JavaScript on Bun.
- Declare database changes as forward SQL migrations; do not add an ORM schema layer.

## Setup and checks

Follow [contributor setup](docs/Local_Development.md) for private credentials, operator authentication and isolated test applications.

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

Keep documentation useful to users and contributors: describe supported operation and compatibility, put future capabilities in the roadmap, and keep individual run logs/checkpoints in CI artifacts rather than public guides. Validate relative links when moving a document.

## Pull requests

Keep a pull request focused on one change. Explain the operational problem, the approach, how it was verified, and any migration or compatibility impact. By contributing, you agree that your contribution is licensed under the repository's MIT License.
