# Independence and distribution scope

The public project implements general-purpose local task lifecycle primitives. It is not a copy of an application-specific product or a distribution of a third-party app runtime.

Included: durable task/job state, named resource reservations, background child execution, attempt histories, explicit external-operation reconciliation, completion gates, a CLI, tests, and examples.

Excluded: customer or employee information, application accounts, network sessions, private business rules, workplace configuration, production datasets, and third-party proprietary binaries.

This repository is meant to be usable with an entirely self-contained Node.js installation and a local filesystem. Its included tests create temporary working directories without accessing real business systems.

See [Architecture](ARCHITECTURE.md) for implementation details and stated limits.
