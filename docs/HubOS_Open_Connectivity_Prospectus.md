# HubOS

## Open infrastructure for keeping schools connected

**A product prospectus for implementers, governments, funders, technology partners, and open-source contributors**

**Developed by Project Hello World**  
**Status:** Working product prospectus

---

## Connecting a school is only the beginning

A school can have a solar system, an internet connection, Wi-Fi, and digital devices and still be effectively offline.

A battery begins to fail. An access point stops responding. The ISP connection becomes unstable. Tablets stop checking in. A small fault remains invisible until somebody travels to the school or a teacher finds the right person to call.

By then, days or weeks of useful access may have been lost.

HubOS is being developed to close that operational gap. It is an open-source, self-hostable platform that helps schools and their support partners see whether connectivity infrastructure is working, identify what needs attention, and record what happens next.

Its purpose is straightforward:

> Know whether the school is connected. Know when it needs help. Make it easier for somebody to act.

---

## What HubOS is

HubOS is the operations and evidence layer for school connectivity.

It brings together information from systems that are usually viewed separately:

- solar and battery monitoring;
- routers, internet gateways, and Wi-Fi controllers;
- ISP usage and service reports;
- managed tablets and other school devices;
- field inspections and surveys;
- incidents, maintenance visits, and follow-up actions.

HubOS maps those sources to a shared record for each school. It then turns the data into current status, alerts, incidents, trends, and agreed performance indicators.

The basic flow is:

```text
collect -> combine -> understand -> act -> learn
```

The dashboard is not the outcome. A working school connection is the outcome.

---

## The problem HubOS addresses

School-connectivity programmes often invest heavily in installation but have limited visibility after commissioning.

The information needed to support a school may exist, but it is fragmented:

- the ISP knows how much traffic passed through a subscriber account;
- the network controller knows whether an access point is online;
- the solar platform knows whether the battery is charging;
- the MDM knows when a tablet last checked in;
- the school knows whether teachers can actually use the service;
- the maintenance team knows which fault was repaired;
- the programme team has surveys and follow-up records.

Without a common operational layer, teams are forced to check several portals, reconcile inconsistent identifiers, wait for periodic reports, or rely on informal messages from the field.

This creates four recurring risks:

1. Problems remain invisible for too long.
2. Technical teams travel without enough diagnostic information.
3. Programme reports describe activity without showing service reliability.
4. Partners become dependent on one vendor's dashboard or data format.

HubOS is designed to make these systems work together without requiring organisations to replace the tools they already use.

---

## What a school-support team can see

At a school level, HubOS is intended to answer practical questions:

- Is the internet connection available now?
- Is the latest information recent enough to trust?
- Is the solar and battery system operating within its configured range?
- Are routers and access points reporting?
- Are managed devices active?
- Is usage increasing, falling, or unexpectedly absent?
- Is there an open incident?
- Who is responsible for the next action?
- Has service recovery been verified?

At programme level, the same information can show:

- which schools need attention;
- which ISP or infrastructure problems recur;
- how quickly incidents are acknowledged and resolved;
- whether monitoring coverage is complete;
- which maintenance actions consume the most time or parts;
- how reliability differs across locations, providers, or configurations.

---

## Designed for real operating conditions

HubOS is intended for schools where power, connectivity, staffing, and technical support cannot be taken for granted.

### Intermittent connectivity

Sites or local agents can buffer measurements and send them when the connection returns. HubOS records both when a condition occurred and when the data arrived, so delayed synchronisation does not distort the history.

### Different equipment and providers

One deployment may use UniFi, another MikroTik, and another a mixture. Solar telemetry may come from Innovex REMOT, Victron, Felicity, or a generic sensor platform. ISP data may arrive through an API, a spreadsheet, or a monthly report.

HubOS uses replaceable connectors and a shared data model so the rest of the system does not need to be redesigned for every vendor.

### Local responsibility

Monitoring supports local operators; it does not replace them. A battery alert still needs a safe local check. An ISP outage still needs escalation. A damaged access point still needs repair.

HubOS connects the technical signal to an owner, a runbook, and a record of the response.

### Responsible data use

HubOS is not intended to build identifiable browsing histories. The default network view uses aggregate traffic, availability, performance, and client counts. Personal survey data remains separately governed in ODK or another approved research system.

---

## Open by design

HubOS is designed as open digital infrastructure rather than a closed monitoring product.

The HubOS-owned code, schemas, deployment configuration, dashboards, API specifications, connector interfaces, and runbooks are intended to be openly licensed. Partners can inspect the system, host it, adapt it, and contribute improvements.

The product can still connect to proprietary infrastructure. Routers, solar systems, controllers, and ISP platforms do not need to be open source for HubOS to read their approved operational interfaces.

The accurate promise is:

> An open-source and self-hostable operations layer with vendor-neutral connectors.

This gives implementers several choices:

- run HubOS on their own server;
- use only the components they need;
- connect existing ODK or MDM deployments;
- add a new router, solar, or ISP connector;
- publish selected indicators to a government or partner system;
- use a future hosted service when they do not want to operate the infrastructure themselves.

---

## A modular technical foundation

The proposed HubOS stack uses mature open-source components and a small amount of purpose-built integration code.

### Core data and integration

- PostgreSQL for the school registry, source mappings, telemetry, incidents, and KPI results.
- A HubOS REST API for status, incidents, integrations, and external reporting.
- Background connector workers for scheduled collection, retries, and backfill.

### Monitoring and action

- PostgreSQL-backed operational status, connector health, and incident history.
- Metabase as the reference dashboard, reporting, and alerting layer.
- HubOS incident records and runbooks for assigning and verifying action.

### Evidence and field information

- Versioned analytics views consumed by Metabase and available to other tools through PostgreSQL when future versions require them.
- ODK Central for offline-capable inspections, maintenance forms, and programme evidence.
- Headwind MDM for managed Android devices, connected through a defined adapter.

### Optional modules

- ThingsBoard Community Edition for generic IoT and solar telemetry.
- FreeRADIUS and OpenWISP components for future voucher and access-management work.
- A lightweight site agent for local probes, SNMP collection, and store-and-forward operation.

The modules are packaged as Docker Compose projects. A small programme can start on modest infrastructure; larger deployments can separate services as operational needs grow.

---

## Solar monitoring without a new lock-in

Reliable school connectivity depends on reliable power.

The first solar integration will use the Innovex REMOT Open API, which exposes device inventory, current readings, historical measurements, and notifications. HubOS can normalise panel voltage, panel current, battery voltage, supply measurements, temperatures, device state, and data freshness.

For other equipment, HubOS will support vendor adapters and open telemetry paths. The recommended optional generic IoT module is ThingsBoard Community Edition, whose open-source server and gateway support common protocols such as MQTT, HTTP, Modbus, and SNMP.

This approach allows a partner to retain an existing solar platform while preserving a route for locally integrated and future devices.

---

## Monitoring that leads to action

HubOS separates technical signals from human work.

A failed connectivity check is a signal. Several failed checks produce a confirmed status. A persistent, actionable status produces an alert. Related alerts create or update an incident. The incident is acknowledged, assigned, investigated, and closed only after recovery has been verified.

This matters because an alert without ownership is only another message.

Initial runbooks will cover common conditions such as:

- a school has lost internet connectivity;
- monitoring data has gone stale;
- an access point is offline;
- a battery has crossed its site-specific warning level;
- managed devices have stopped checking in;
- an ISP report or connector has failed to update.

Alerts can be delivered through email or open webhook integrations. Deploying organisations can add their preferred messaging gateway without making it a compulsory HubOS dependency.

---

## How success will be measured

The first implementation is focused on operational feasibility, not on claiming educational impact.

Three primary measures will show whether HubOS is useful.

### 1. Visibility coverage

For how much of the monitored period does HubOS have fresh, valid evidence about connectivity, power, and devices?

Missing information is shown as unknown. It is never silently treated as healthy.

### 2. Usable connectivity availability

During what proportion of eligible monitoring intervals can the school reach the internet at the minimum configured service level?

This is more useful than reporting that a router is switched on.

### 3. Incident restoration performance

How long does it take from a qualifying service problem to verified restoration, and what kinds of incidents take longest?

These measures are supported by diagnostics such as alert delay, acknowledgement time, repeat incidents, device activity, solar-data freshness, and maintenance actions.

Service targets should be established after baseline data is available. HubOS will not present arbitrary targets as evidence of good performance.

---

## A ten-school reference implementation

The initial reference pattern covers ten schools:

- five in Uganda;
- five in Angola.

The two-country design is intentional. It tests whether the product can handle different operators, controllers, ISPs, identifiers, infrastructure arrangements, and support processes without creating a custom platform for each programme.

The reference implementation will validate whether HubOS can:

- map every school and external system to stable shared identifiers;
- collect network and solar information through more than one integration path;
- distinguish a school outage from a monitoring failure;
- alert the right support role without flooding them;
- record acknowledgement, action, and verified restoration;
- combine technical monitoring with approved ODK operational evidence;
- produce country, programme, and school views from one documented model;
- be installed locally from public instructions and demonstration data.

The ten schools are the first proving ground, not the boundary of the product.

---

## What HubOS will not claim

Trust depends on being clear about the limits of the evidence.

HubOS will not claim that:

- connectivity automatically improves learning;
- a powered router means a usable service;
- missing telemetry means a school is healthy;
- one ISP's protocol classifications are comparable with another's;
- a ten-school operational implementation proves national-scale performance;
- every connected system is itself open source.

Instead, HubOS will show what was measured, where it came from, how recent it is, and which rule produced a status or KPI.

---

## Why a shared open-source product matters

Many school-connectivity programmes face the same operational problem and rebuild the same integrations in isolation.

One team writes a script for a router controller. Another manually combines solar exports and incident forms. A third depends on a vendor dashboard that cannot be adapted or joined to programme evidence.

A shared HubOS project can turn that repeated work into reusable public infrastructure:

- a common model for schools, hubs, assets, services, and incidents;
- tested connectors for widely used network and solar systems;
- open KPI definitions;
- reusable dashboards and runbooks;
- sample data and conformance tests;
- implementation guidance that partners can improve together.

The value is not only lower software cost. Shared interfaces make it easier to change vendors, compare operating models, audit calculations, and retain local control of data.

---

## Ways to participate

HubOS needs different kinds of partners.

### Deploy and test

Implementing organisations and governments can use the reference stack, test it against real infrastructure, and document what must improve for field use.

### Contribute integrations

Technology partners can contribute or support connectors for router controllers, solar platforms, MDM systems, ISPs, EMIS platforms, and national connectivity systems.

### Improve operations practice

School operators, technicians, and country teams can shape the alerts, runbooks, incident categories, and dashboards so they reflect real support decisions.

### Fund open digital infrastructure

Funders can support the shared components that are difficult for one deployment to finance alone: secure connector frameworks, public test fixtures, documentation, accessibility, security reviews, multilingual guidance, and long-term maintenance.

### Host or support deployments

Infrastructure and service partners can help organisations that want the benefits of HubOS but do not have an internal platform team.

### Strengthen evidence

MEL and research partners can improve metric definitions, data-quality checks, baseline methods, and responsible links between operational performance and education programmes.

---

## Sustainability

HubOS is designed to support more than one operating model.

### Self-hosted

A government, NGO, or programme partner can operate the stack on infrastructure it controls. It owns its credentials, users, retention settings, and data-sharing decisions.

### Partner-supported

A local or regional technical partner can operate HubOS for several programmes while keeping each organisation's access and data separated.

### Managed service

Project Hello World or another qualified provider can offer a hosted service for organisations that cannot maintain the platform themselves. The hosted option should use the same published APIs and exportable data model as the self-hosted version.

### Shared development

Connectors, schemas, dashboards, documentation, and security fixes can be maintained as a public product rather than as one-off project deliverables.

Open source does not remove the cost of maintenance. It makes the work inspectable, reusable, and possible to share.

---

## Key risks and how the design responds

### Vendor interfaces change

Connectors are versioned and tested against documented response fixtures. Unexpected fields are quarantined rather than silently accepted.

### Different systems use different school identifiers

HubOS gives each school a canonical identifier and maintains reviewed mappings to controller, ISP, solar, MDM, and ODK identifiers.

### Monitoring becomes surveillance

The default model excludes identifiable browsing histories and limits network evidence to what is needed for operations.

### Operators receive too many alerts

Alerts must persist before notification, related alerts are grouped, dependent alerts are suppressed, and non-actionable alerts are reviewed.

### The platform becomes too complex to operate

Components are optional and independently deployable. The HubOS-owned code remains small, and local demonstration data allows testing without live vendor systems.

### A dashboard does not improve support

Every high-severity alert links to an incident owner, a safe first action, an escalation path, and recovery evidence.

---

## The invitation

HubOS is an opportunity to build a shared operations layer for school connectivity: open enough to inspect and adapt, practical enough to run on modest infrastructure, and disciplined enough to show when its evidence is incomplete.

The first goal is not to build the largest possible platform. It is to establish a dependable core that can answer whether a school is connected, reveal when support is needed, and learn from every response.

Organisations can participate by deploying the reference stack, contributing a connector, sharing operational requirements, funding public components, improving runbooks, or helping host the system for others.

If school connectivity is to last, installation cannot be the final milestone. The service must remain visible, supportable, and accountable over time.

That is the role HubOS is designed to play.

---

## Further technical information

The accompanying technical design defines:

- the Docker Compose deployment profiles;
- canonical entities and identifier mapping;
- connector contracts;
- Innovex REMOT, UniFi, MikroTik, ISP, Headwind, and ODK integration patterns;
- generic open-source IoT options;
- alert and incident workflows;
- privacy and tenant boundaries;
- KPIs, acceptance criteria, and implementation stages.

Technical design: [HubOS Pilot-Ready Technical Design](./HubOS_Pilot_Ready_Technical_Design.md)

### Technology references

- [Innovex REMOT Open API](https://documenter.getpostman.com/view/816683/2s93m1YPUj)
- [UniFi official API introduction](https://help.ui.com/hc/en-us/articles/30076656117655-Getting-Started-with-the-Official-UniFi-API)
- [MikroTik RouterOS REST API](https://help.mikrotik.com/docs/spaces/ROS/pages/47579162/REST%2BAPI)
- [ODK](https://getodk.org/)
- [Headwind MDM](https://h-mdm.com/open-source/)
- [ThingsBoard Community Edition](https://thingsboard.io/docs/)
- [Metabase alerts](https://www.metabase.com/docs/latest/questions/alerts)
- [FreeRADIUS](https://www.freeradius.org/documentation/)
