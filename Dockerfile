FROM python:3.12-slim

COPY --from=ghcr.io/astral-sh/uv:0.8.17 /uv /usr/local/bin/uv
WORKDIR /app
ENV UV_LINK_MODE=copy UV_COMPILE_BYTECODE=1 PYTHONUNBUFFERED=1

COPY pyproject.toml uv.lock README.md LICENSE ./
RUN uv sync --frozen --no-dev --extra kafka --extra mcp --no-install-project
COPY src ./src
RUN uv sync --frozen --no-dev --extra kafka --extra mcp

EXPOSE 8088
ENTRYPOINT ["uv", "run", "--no-sync", "boxbox"]
CMD ["run", "--host", "0.0.0.0", "--no-browser"]
