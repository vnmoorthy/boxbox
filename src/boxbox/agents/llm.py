"""Claude backends for the strategist and the race engineer.

- ``anthropic``: the official Anthropic SDK. Used when credentials resolve
  (``ANTHROPIC_API_KEY``, ``ANTHROPIC_AUTH_TOKEN``, or an ``ant auth login`` profile).
- ``claude-cli``: the local Claude Code CLI in print mode, with tools, MCP servers,
  plugins and session persistence turned off. Handy when you have Claude Code but no
  API key.

Every failure raises :class:`LLMError`; callers fall back to the rules engine, so a
race never stalls on the network.
"""

from __future__ import annotations

import logging
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

logger = logging.getLogger("boxbox.llm")

DEFAULT_MODEL = "claude-opus-5-5"


class LLMError(Exception):
    pass


class AnthropicLLM:
    provider = "anthropic"

    def __init__(self, model: str = DEFAULT_MODEL, *, effort: str = "low", timeout: float = 60.0) -> None:
        import anthropic

        self._anthropic = anthropic
        self.model = model
        self.effort = effort
        self.client = anthropic.Anthropic(timeout=timeout, max_retries=1)

    def complete(self, system: str, messages: list[dict], *, max_tokens: int = 4096) -> str:
        a = self._anthropic
        kwargs = {
            "model": self.model,
            "max_tokens": max_tokens,
            "system": system,
            "messages": messages,
            "output_config": {"effort": self.effort},
            # Opt in to server-side refusal fallbacks: a declined request is retried
            # on a fallback model inside the same call.
            "betas": ["server-side-fallback-2026-07-01"],
        }
        try:
            try:
                response = self.client.beta.messages.create(**kwargs, fallbacks="default")
            except TypeError:  # SDK release without the typed parameter
                response = self.client.beta.messages.create(**kwargs, extra_body={"fallbacks": "default"})
        except a.AuthenticationError as exc:
            raise LLMError("Anthropic authentication failed: check ANTHROPIC_API_KEY") from exc
        except a.RateLimitError as exc:
            raise LLMError("Anthropic rate limit reached") from exc
        except a.APIStatusError as exc:
            raise LLMError(f"Anthropic API error {exc.status_code}: {exc.message}") from exc
        except a.APIConnectionError as exc:
            raise LLMError("Could not reach the Anthropic API") from exc
        if response.stop_reason == "refusal":
            raise LLMError("Claude declined this request")
        text = "".join(block.text for block in response.content if block.type == "text").strip()
        if not text:
            raise LLMError("Claude returned no text")
        return text


class ClaudeCliLLM:
    provider = "claude-cli"

    def __init__(self, model: str = DEFAULT_MODEL, *, timeout: float = 90.0, binary: str | None = None) -> None:
        self.model = model
        self.timeout = timeout
        self.binary = binary or shutil.which("claude")
        if not self.binary:
            raise LLMError("the claude CLI is not installed")
        # An empty working directory keeps project instructions out of the prompt.
        self.workdir = Path(tempfile.mkdtemp(prefix="boxbox-claude-"))

    def complete(self, system: str, messages: list[dict], *, max_tokens: int = 4096) -> str:
        if len(messages) == 1:
            prompt = messages[0]["content"]
        else:
            turns = [f"{'Engineer' if m['role'] == 'user' else 'You'}: {m['content']}" for m in messages[:-1]]
            prompt = "Conversation so far:\n\n" + "\n\n".join(turns) + f"\n\nNew question: {messages[-1]['content']}"
        cmd = [
            self.binary,
            "-p",
            "--model",
            self.model,
            "--system-prompt",
            system,
            "--tools",
            "",
            "--strict-mcp-config",
            "--no-session-persistence",
            "--setting-sources",
            "project",
            "--output-format",
            "text",
        ]
        try:
            proc = subprocess.run(
                cmd, input=prompt, cwd=self.workdir, capture_output=True, text=True, timeout=self.timeout, check=False
            )
        except subprocess.TimeoutExpired as exc:
            raise LLMError(f"claude CLI timed out after {self.timeout:.0f}s") from exc
        except OSError as exc:
            raise LLMError(f"could not run the claude CLI: {exc}") from exc
        text = proc.stdout.strip()
        if proc.returncode != 0 or not text:
            detail = (proc.stderr or proc.stdout).strip().splitlines()[-1:] or ["no output"]
            raise LLMError(f"claude CLI failed: {detail[0][:200]}")
        return text


def has_anthropic_credentials() -> bool:
    env = os.environ
    if env.get("ANTHROPIC_API_KEY") or env.get("ANTHROPIC_AUTH_TOKEN") or env.get("ANTHROPIC_PROFILE"):
        return True
    if env.get("ANTHROPIC_FEDERATION_RULE_ID"):
        return True
    return (Path.home() / ".config" / "anthropic").is_dir()


def resolve_llm(choice: str = "auto", model: str = DEFAULT_MODEL) -> AnthropicLLM | ClaudeCliLLM | None:
    """``auto`` prefers the API, then the Claude Code CLI, then none (rules only)."""
    if choice == "none":
        return None
    if choice in ("auto", "anthropic") and (choice == "anthropic" or has_anthropic_credentials()):
        try:
            return AnthropicLLM(model)
        except Exception as exc:  # missing SDK or bad config
            if choice == "anthropic":
                raise LLMError(f"Anthropic SDK unavailable: {exc}") from exc
            logger.warning("Anthropic SDK unavailable (%s); trying the claude CLI", exc)
    if choice in ("auto", "claude-cli"):
        try:
            return ClaudeCliLLM(model)
        except LLMError:
            if choice == "claude-cli":
                raise
    return None
