"""Tests for the Standing computation (pure math, no DB)."""
import sys
import unittest
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from mesh_api.standing import compute_standing  # noqa: E402

TODAY = date(2026, 10, 3)


def ago(days: int) -> str:
    return (TODAY - timedelta(days=days)).isoformat()


class C:
    def __init__(self, date: str, mode: str, weight: int):
        self.date, self.mode, self.weight = date, mode, weight


class Standing(unittest.TestCase):
    def test_empty_is_zero_and_quiet(self):
        s = compute_standing([], today=TODAY)
        self.assertEqual(s["involvement"], 0)
        self.assertEqual(s["delta"], 0)
        self.assertEqual(s["energy"], "quiet")
        self.assertEqual(s["contributionCount"], 0)

    def test_recent_builds_raise_involvement_and_mix(self):
        s = compute_standing([C(ago(2), "built", 8), C(ago(10), "built", 6)], today=TODAY)
        self.assertGreater(s["involvement"], 30)
        self.assertEqual(s["modeMix"]["built"], 100)
        self.assertEqual(s["energy"], "humming")   # recent + rising

    def test_decay_old_counts_less_than_recent(self):
        recent = compute_standing([C(ago(1), "built", 5)], today=TODAY)["involvement"]
        old = compute_standing([C(ago(200), "built", 5)], today=TODAY)["involvement"]
        self.assertGreater(recent, old)

    def test_mode_mix_splits(self):
        s = compute_standing([C(ago(1), "built", 5), C(ago(1), "led", 5)], today=TODAY)
        self.assertEqual(s["modeMix"]["built"], 50)
        self.assertEqual(s["modeMix"]["led"], 50)

    def test_only_old_reads_cooling(self):
        s = compute_standing([C(ago(120), "built", 5)], today=TODAY)
        self.assertEqual(s["energy"], "cooling")
        self.assertGreater(s["involvement"], 0)


if __name__ == "__main__":
    unittest.main()
