"""Fail fast, with a useful message, when the dashboard port is taken."""

from __future__ import annotations

import socket
import sys


def ensure_port_free(host: str, port: int) -> None:
    bind_host = "127.0.0.1" if host in ("localhost", "") else host
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind((bind_host, port))
        except OSError:
            sys.exit(
                f"Port {port} is already in use (another BoxBox, maybe?). "
                f"Stop it, or pick another port: boxbox --port {port + 1}"
            )
