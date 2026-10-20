# Verification harness

## Native DSH 0.2.1 compatibility

After `npm install` and `npm run check`, run against an installed
`@deepseek-ai/dsh@0.2.1-rc.2` launcher, with `pnpm` available on `PATH`:

```sh
npm run test:dsh -- /absolute/path/to/@deepseek-ai/dsh/lib/bin.js
```

`native-compat.mjs` packs the built plugin and installs it through DSH's plugin
manager into a temporary `DSH_HOME`. It checks that the profile has no version
exemptions, projects the Kiro config schema through the native loader, starts
the Web profile on a temporary loopback port, and verifies authenticated HTTP
200 responses from the page and `/kiro/api/status`. Runtime `HOME` is isolated
and `KIRO_*` environment variables are removed so the probe does not use the
operator's credentials or make inference requests. The server is stopped after
the check, and successful temporary installations are removed.

DSH `0.2.1-rc.2` reports four schema-projection errors for its own
`@deepseek-ai/dsh-agent-preset` carriers. The probe explicitly permits only
that upstream diagnostic, requires a complete Kiro schema, and fails on any
other schema error or disabled-plugin warning. Full-profile schema projection
is not claimed to pass.

## Context overflow recovery

`overflow-probe/` is a DSH plugin used to prove one contract that unit tests
cannot reach and live traffic cannot force cheaply: that a
`CONTEXT_WINDOW_EXCEEDED` failure from this adapter makes DSH compact the
conversation and retry the turn.

It registers a `kiro-probe` provider whose scripted responses are:

1. one tool call, so the turn produces durable history,
2. then a throw whose code comes from this package's own `httpErrorCode()`
   applied to a real recorded Kiro HTTP 400 body,
3. a short summary for the compaction summarizer,
4. the final answer on the retried request.

Everything else — agent loop, token meter, `dsh-compaction-basic`, retry — is the
genuine installed code, and no provider credits are spent.

## Run it

```sh
# 1. build the artifact under test
npm run check && npm run pack:dist

# 2. create a throwaway profile that loads it next to this probe
mkdir -p "$DSH_HOME/profiles/kiro-recovery"
# package.json bundles: @deepseek-ai/dsh-base, @deepseek-ai/dsh-headless,
# dsh-kiro (file: the packed tarball), dsh-kiro-overflow-probe (file: this dir)
# cordis.patch.yml: set agent-default-model to provider kiro-probe, model probe-1
dsh plugin --profile kiro-recovery install

# 3. answer one task against an isolated DSH_HOME
DSH_HOME=/tmp/dsh-recovery KIRO_PROBE_TRACE=/tmp/probe.jsonl \
  dsh --profile kiro-recovery "Run the probe step and then report the outcome."
```

Expected: the task prints `recovered-ok`, `/tmp/probe.jsonl` records a
`CONTEXT_WINDOW_EXCEEDED` throw followed by a `purpose: "compaction"` call, and
the session transcript contains `compaction/start`, `compaction/summary`,
`compaction/end`, and `turn/end` with `completed`.
