"""Ordered in-process RPC channels. A disconnected caller never causes a replay."""

import re
from threading import Lock

from ontoweave_cq5000.errors import need
from ontoweave_cq_similarity.core import digest

CHANNEL = re.compile(r"^[0-9a-f-]{36}$")


class RPCChannels:
    def __init__(self):
        self.lock = Lock()
        self.channels = {}

    def dispatch(self, request, call):
        # Legacy bridge callers retain their original single-request behavior.
        if "rpc_channel" not in request and "rpc_sequence" not in request:
            return call()
        channel, sequence, scope = (request.get(key) for key in ("rpc_channel", "rpc_sequence", "scope"))
        need(isinstance(channel, str) and CHANNEL.fullmatch(channel)
             and type(sequence) is int and sequence > 0 and isinstance(scope, str), "RPC_CHANNEL_INVALID")
        with self.lock:
            if channel not in self.channels:
                need(len(self.channels) < 32, "RPC_CHANNEL_LIMIT")
                self.channels[channel] = {"lock": Lock(), "sequence": 0, "scope": scope}
            state = self.channels[channel]
        fingerprint = digest(request)
        with state["lock"]:
            need(state["scope"] == scope, "RPC_CHANNEL_SCOPE_CHANGED")
            if sequence == state["sequence"]:
                need(fingerprint == state["fingerprint"], "RPC_REDELIVERY_CONFLICT")
                return state["result"]
            need(sequence == state["sequence"] + 1, "RPC_CHANNEL_SEQUENCE_INVALID")
            result = call()
            state.update(sequence=sequence, fingerprint=fingerprint, result=result)
            return result
