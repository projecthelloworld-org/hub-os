# Community-site monitoring

HubOS helps operators understand whether shared community infrastructure is working and organise support when it is not. Schools are one kind of community site, alongside community centres, libraries and other shared spaces.

## Language

**Community site**:
A place where people share connectivity, power or managed devices. Its canonical identity remains the same when its equipment or external identifiers change.
_Avoid_: School (unless describing a school), controller site

**Source connection**:
A configured connection to one external system or controller that supplies operational evidence. Several source connections may serve the same community site.
_Avoid_: Vendor, site

**Mapping**:
A verified association between an external identifier in one source connection and a canonical HubOS entity. Several external identifiers may refer to the same community site.

**Observation**:
A timestamped numeric measurement with a source, metric, unit and quality. It is evidence of the measured property, not proof of community benefit or human use.

**Monitor**:
A check of a specific reachable target. An infrastructure monitor measures a HubOS service; a community monitor measures only the explicitly configured community target.
_Avoid_: Internet uptime (for an infrastructure or device reachability check)

**Observation coverage**:
The portion of an eligible measurement window supported by timely, valid evidence. Missing evidence is unknown, not healthy.

**Signal**:
Timestamped evidence that a configured operational condition is active or has recovered. Silence is not a recovery signal.

**Incident**:
A tracked support issue with its opening evidence, current state and ownership. Repeated signals for the same active issue update that incident rather than creating another one.

**Synthetic demonstration**:
Fictional sites and generated evidence used to demonstrate HubOS safely. Synthetic evidence must remain distinguishable from live evidence.
_Avoid_: Pilot data, live telemetry
