#!/usr/bin/env python3
"""Runs Mem0 for Crew Office: one JSON request per line in, one JSON answer per line out.

Everything stays on this computer. Vectors go in an on-disk Qdrant folder and history in a SQLite
file, both under the folder named by CREW_MEM0_DIR. The embedding model is the one the person
explicitly chose, from a short list of providers that run locally. Crew Office stores memories
verbatim (infer=False), so Mem0's language model is never called; its address is a closed local
port, so that even a mistake here could not reach a paid service.

Who may read what is not decided here. Crew Office checks that before asking, passes one namespace
at a time, and checks every result again against its own records.
"""

import json
import os
import sys

os.environ["MEM0_TELEMETRY"] = "False"
os.environ["ANONYMIZED_TELEMETRY"] = "False"
for name in list(os.environ):
    if name.endswith("_API_KEY"):
        del os.environ[name]

LOCAL_PROVIDERS = {"fastembed", "ollama", "huggingface", "lmstudio"}


def answer(req_id, **fields):
    sys.stdout.write(json.dumps({"id": req_id, **fields}) + "\n")
    sys.stdout.flush()


def embedder_config(provider, model):
    config = {"model": model}
    if provider == "ollama":
        url = os.environ.get("CREW_OLLAMA_URL", "http://127.0.0.1:11434")
        config["ollama_base_url"] = url
    return config


def build():
    from mem0 import Memory
    from mem0.configs.embeddings.base import BaseEmbedderConfig
    from mem0.utils.factory import EmbedderFactory

    provider = os.environ["CREW_MEM0_PROVIDER"]
    model = os.environ["CREW_MEM0_MODEL"]
    home = os.environ["CREW_MEM0_DIR"]
    if provider not in LOCAL_PROVIDERS:
        raise SystemExit(f"{provider} is not a local embedding provider.")
    os.makedirs(home, exist_ok=True)

    config = embedder_config(provider, model)
    # The vector size depends on the model, so ask the model.
    probe = EmbedderFactory.create(provider, config, None)
    dims = len(probe.embed("size"))

    return Memory.from_config({
        "vector_store": {
            "provider": "qdrant",
            "config": {
                "path": os.path.join(home, "qdrant"),
                "collection_name": "crew_office",
                "embedding_model_dims": dims,
                "on_disk": True,
            },
        },
        "embedder": {"provider": provider, "config": {**config, "embedding_dims": dims}},
        "llm": {
            "provider": "openai",
            "config": {"api_key": "not-used", "openai_base_url": "http://127.0.0.1:9/v1", "model": "not-used"},
        },
        "history_db_path": os.path.join(home, "history.db"),
    })


def results_of(found):
    return found.get("results", []) if isinstance(found, dict) else (found or [])


def handle(memory, method, params):
    if method == "ping":
        import mem0

        return {"version": getattr(mem0, "__version__", "unknown")}
    if method == "add":
        made = memory.add(
            params["text"],
            user_id=params["namespace"],
            metadata={"crew_id": params["crewId"]},
            infer=False,
        )
        rows = results_of(made)
        return {"mem0Id": rows[0]["id"] if rows else None}
    if method == "update":
        memory.update(params["mem0Id"], params["text"])
        return {}
    if method == "delete":
        memory.delete(params["mem0Id"])
        return {}
    if method == "search":
        filters = {"user_id": params["namespace"]}
        limit = int(params.get("limit", 10))
        try:
            found = memory.search(params["query"], filters=filters, top_k=limit)
        except TypeError:
            found = memory.search(params["query"], user_id=params["namespace"], limit=limit)
        return {
            "hits": [
                {"crewId": (row.get("metadata") or {}).get("crew_id"), "score": row.get("score")}
                for row in results_of(found)
            ]
        }
    raise ValueError(f"Unknown method {method}")


def main():
    try:
        memory = build()
    except Exception as err:  # Reported to the screen as the reason Mem0 is not available.
        answer(None, fatal=f"{type(err).__name__}: {err}")
        return 1
    answer(None, ready=True)
    for line in sys.stdin:
        req = json.loads(line)
        try:
            answer(req["id"], result=handle(memory, req["method"], req.get("params", {})))
        except Exception as err:
            answer(req["id"], error=f"{type(err).__name__}: {err}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
