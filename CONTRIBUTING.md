# Contributing

Issues and small pull requests are welcome. Before opening a pull request:

```sh
npm ci
npm run check
npm run build:studio
```

Keep the core workload-agnostic. Provider-specific configuration belongs under
`examples/`, while fetching, processing, and publication logic belongs in the
workload image. Changes that duplicate Bacalhau placement, execution, or worker
health behavior need a clear reason and migration path.

Never commit credentials, API tokens, signing keys, or populated env files.
Changes to the Studio manifest invalidate its signature; release maintainers
sign the final artifact after all manifest edits.
