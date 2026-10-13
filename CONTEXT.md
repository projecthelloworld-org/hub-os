# HubOS domain concepts

HubOS helps operators understand whether shared community infrastructure is working and organise support when it is not. Schools are one kind of community site, alongside community centres, libraries and other shared spaces.

## Shared terminology

**Community site**:
A place where people share connectivity, power or managed devices. Its canonical identity remains the same when its equipment or external identifiers change.
Schools are one site classification, not the name for every location. A controller's local site identifier is a source identifier, not the canonical community site.

**Source connection**:
A configured connection to one external system or controller that supplies operational evidence. Several source connections may serve the same community site.
The source connection is distinct from both its vendor and the community site it serves.

**Mapping**:
A verified association between an external identifier in one source connection and a canonical HubOS entity. Several external identifiers may refer to the same community site.

**Observation**:
A timestamped numeric measurement with a source, metric, unit and quality. It is evidence of the measured property, not proof of community benefit or human use.

**Monitor**:
A check of a specific reachable target. An infrastructure monitor measures a HubOS service; a community monitor measures only the explicitly configured community target.
Infrastructure/device reachability must not be labelled community internet uptime.

**Observation coverage**:
The portion of an eligible measurement window supported by timely, valid evidence. Missing evidence is unknown, not healthy.

**Signal**:
Timestamped evidence that a configured operational condition is active or has recovered. Silence is not a recovery signal.

**Incident**:
A tracked support issue with its opening evidence, current state and ownership. Repeated signals for the same active issue update that incident rather than creating another one.

**Synthetic demonstration**:
Fictional sites and generated evidence used to demonstrate HubOS safely. Synthetic evidence must remain distinguishable from live evidence.
The demonstration is not live telemetry or evidence of a field pilot.
