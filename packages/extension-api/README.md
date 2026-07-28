# `@minpeter/pss-extension-api`

Shared, host-agnostic contracts for authoring PSS coding-agent extensions.

The package currently exposes the minimal capability surface required by
official assistant renderers:

- instruction fragments;
- assistant renderer registration;
- renderer lifecycle context;
- extension factory and `provide()` contracts.

Host lifecycle, package loading, commands, tools, services, sessions, and
notification state remain owned by `@minpeter/pss-coding-agent`.
