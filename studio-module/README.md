# Home Compute for Sprint Engine Studio

This optional capability module adds a fleet dashboard to Sprint Engine Studio.
It is a client of the generic Home Compute HTTP API; Studio is not required for
scheduling, and closing Studio does not stop the daemon or its jobs.

## Build for local development

```sh
npm install
npm run build:studio
```

The host provides React and the `@multicode/module-sdk/ui` and
`@multicode/module-sdk/surface` runtimes. The bundle deliberately marks those
imports external. The source uses the SDK's settings contribution, global
surface shell, buttons, fields, and status primitives.

To package for the marketplace, install the current Sprint Engine Studio module
SDK, sign `studio-module/manifest.json` with a private key kept outside this
repository, then use its `multicode-module pack` command. Do not publish an
unsigned bundle as a release.
