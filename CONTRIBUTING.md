# Contributing to BoxBox

Thanks for helping build the pit wall.

## Setup

```bash
git clone https://github.com/vnmoorthy/boxbox.git
cd boxbox
uv sync --extra kafka --extra mcp
uv run boxbox --strategist rules     # no LLM needed
```

## Before you open a pull request

```bash
uv run ruff check src tests && uv run ruff format --check src tests
uv run pytest
node src/boxbox/web/js/selftest.mjs
```

- **Data contract.** Topics, records and the web API are specified in [docs/protocol.md](docs/protocol.md). Change it in the same pull request as any code that changes a record or endpoint.
- **Both brains.** The strategist's prompt (`src/boxbox/agents/prompt.py`) and the rules engine (`src/boxbox/agents/rules.py`) implement the same decision framework. Keep them in step.
- **Tests that race.** `tests/test_race.py` runs full races through the whole pipeline in lockstep. A new incident or strategy rule should come with a race test.
- **No build step.** The web app is plain ES modules; keep it that way.

## Ideas

New incidents (rain, a brake failure), more detectors, a second team car, multi-car strategy, a tyre-model calibration from real data, more MCP tools. Open an issue to discuss.
