"""Optional local static embeddings (model2vec) for conceptual dedup.

Static embeddings are tiny and CPU-only (no API key, no torch). We use them to
tell when a new community name means the same thing as an existing one —
word-order/extension variants score very high, lexically-related names land
mid-range, unrelated names ~0. Pure synonyms with no shared words are weak here;
that gap is covered by the agent's own judgment.

Everything degrades to "no signal" if the package or model can't load, so the
app runs fine without it (exact-name dedup still applies). The model is baked
into the Docker image at build time; first load in a fresh venv downloads it.
"""
import os
import threading

MODEL_NAME = os.environ.get("MESH_EMBED_MODEL", "minishlab/potion-base-8M")

_model = None
_failed = False
_lock = threading.Lock()


def _load():
    global _model, _failed
    if _model is not None or _failed:
        return _model
    with _lock:
        if _model is None and not _failed:
            try:
                from model2vec import StaticModel
                _model = StaticModel.from_pretrained(MODEL_NAME)
            except Exception:
                _failed = True
    return _model


def available() -> bool:
    return _load() is not None


def embed(text: str):
    """Return a list[float] embedding for `text`, or None if unavailable."""
    model = _load()
    if model is None or not (text or "").strip():
        return None
    try:
        vec = model.encode([text])[0]
        return [float(x) for x in vec]
    except Exception:
        return None


def cosine(a, b) -> float:
    """Cosine similarity of two equal-length float lists (pure Python, no numpy)."""
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = sum(x * x for x in a) ** 0.5
    nb = sum(y * y for y in b) ** 0.5
    if na == 0.0 or nb == 0.0:
        return 0.0
    return dot / (na * nb)
