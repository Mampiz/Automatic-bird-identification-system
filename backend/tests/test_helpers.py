"""Unit tests for the pure helpers in main.py.

These are the functions that decide what the API returns and what ends up drawn
on a frame, and they are the ones that can be tested without a model, a GPU or a
database.
"""
from __future__ import annotations

import hashlib

import pytest


class TestParseFrontendOrigins:
    """CORS origins come from an environment variable in three possible shapes."""

    def test_comma_separated(self, main_module):
        assert main_module._parse_frontend_origins(
            "https://a.example, https://b.example"
        ) == ["https://a.example", "https://b.example"]

    def test_json_array(self, main_module):
        assert main_module._parse_frontend_origins(
            '["https://a.example", "https://b.example"]'
        ) == ["https://a.example", "https://b.example"]

    def test_wildcard_is_kept_as_is(self, main_module):
        assert main_module._parse_frontend_origins("*") == ["*"]

    @pytest.mark.parametrize("raw", ["", "   ", None])
    def test_empty_falls_back_to_the_dev_origin(self, main_module, raw):
        assert main_module._parse_frontend_origins(raw) == ["http://localhost:5173"]

    def test_malformed_json_falls_back_to_comma_splitting(self, main_module):
        # A value that starts with "[" but is not valid JSON must not blow up the
        # process at import time, which is when this runs.
        assert main_module._parse_frontend_origins("[not json") == ["[not json"]

    def test_blank_entries_are_dropped(self, main_module):
        assert main_module._parse_frontend_origins("https://a.example, ,") == ["https://a.example"]


class TestBuildVideoJobId:
    """The job id is the deduplication key: same input, same job."""

    def test_is_deterministic(self, main_module):
        first = main_module._build_video_job_id("abc123", 0.25, 5)
        second = main_module._build_video_job_id("abc123", 0.25, 5)
        assert first == second

    def test_confidence_is_normalised_to_four_decimals(self, main_module):
        # 0.25 and 0.250000001 are the same request as far as the user is
        # concerned, and must not queue the same video twice.
        assert main_module._build_video_job_id("abc", 0.25, 5) == main_module._build_video_job_id(
            "abc", 0.2500000001, 5
        )

    def test_different_parameters_give_different_jobs(self, main_module):
        base = main_module._build_video_job_id("abc", 0.25, 5)
        assert base != main_module._build_video_job_id("abc", 0.40, 5)
        assert base != main_module._build_video_job_id("abc", 0.25, 10)
        assert base != main_module._build_video_job_id("def", 0.25, 5)

    def test_is_a_sha256_hex_digest(self, main_module):
        job_id = main_module._build_video_job_id("abc", 0.25, 5)
        assert len(job_id) == 64
        assert set(job_id) <= set("0123456789abcdef")


class TestSegmentsFromTimes:
    """Detection timestamps are collapsed into the segments shown on the player."""

    def test_empty_input(self, main_module):
        assert main_module._segments_from_times([], 1.0) == []

    def test_single_detection_is_a_zero_length_segment(self, main_module):
        assert main_module._segments_from_times([4.0], 1.0) == [
            {"start_time": 4.0, "end_time": 4.0}
        ]

    def test_close_detections_merge(self, main_module):
        assert main_module._segments_from_times([1.0, 1.5, 2.0], 1.0) == [
            {"start_time": 1.0, "end_time": 2.0}
        ]

    def test_a_gap_larger_than_the_threshold_splits(self, main_module):
        assert main_module._segments_from_times([1.0, 1.5, 9.0], 1.0) == [
            {"start_time": 1.0, "end_time": 1.5},
            {"start_time": 9.0, "end_time": 9.0},
        ]

    def test_a_gap_exactly_at_the_threshold_still_merges(self, main_module):
        # The comparison is "<=", so a gap of exactly gap_s belongs to the same
        # segment. Worth pinning: an off-by-one here fragments every result.
        assert main_module._segments_from_times([1.0, 2.0], 1.0) == [
            {"start_time": 1.0, "end_time": 2.0}
        ]

    def test_input_is_sorted_first(self, main_module):
        assert main_module._segments_from_times([2.0, 1.0, 1.5], 1.0) == [
            {"start_time": 1.0, "end_time": 2.0}
        ]


class TestToBboxNormXyxy:
    """Boxes are returned both normalised and clamped to the frame."""

    def test_normalises_against_the_frame_size(self, main_module):
        norm, clamped = main_module._to_bbox_norm_xyxy(0, 0, 320, 240, 640, 480)
        assert norm == [0.0, 0.0, 0.5, 0.5]
        assert clamped == [0.0, 0.0, 320.0, 240.0]

    def test_clamps_coordinates_outside_the_frame(self, main_module):
        # A model can predict slightly outside the image; the overlay must not.
        norm, clamped = main_module._to_bbox_norm_xyxy(-10, -10, 700, 500, 640, 480)
        assert clamped == [0.0, 0.0, 640.0, 480.0]
        assert norm == [0.0, 0.0, 1.0, 1.0]

    @pytest.mark.parametrize("width,height", [(0, 480), (640, 0), (0, 0)])
    def test_a_degenerate_frame_does_not_divide_by_zero(self, main_module, width, height):
        norm, _ = main_module._to_bbox_norm_xyxy(1, 1, 2, 2, width, height)
        assert norm == [0.0, 0.0, 0.0, 0.0]


class TestSpeciesColour:
    """Each species gets a stable colour so a video does not flicker."""

    def test_is_stable_for_the_same_species(self, main_module):
        assert main_module._species_color("Parus major") == main_module._species_color("Parus major")

    def test_differs_between_species(self, main_module):
        assert main_module._species_color("Parus major") != main_module._species_color("Turdus merula")

    def test_stays_in_the_readable_range(self, main_module):
        # 80..255 by construction: darker colours are unreadable on a dark frame.
        for species in ("Parus major", "Turdus merula", "Erithacus rubecula", ""):
            for channel in main_module._species_color(species):
                assert 80 <= channel <= 255

    def test_matches_the_documented_derivation(self, main_module):
        digest = hashlib.md5(b"Parus major").digest()
        expected = (80 + digest[0] % 176, 80 + digest[1] % 176, 80 + digest[2] % 176)
        assert main_module._species_color("Parus major") == expected


class TestSafeSuffix:
    """Uploaded filenames decide the extension of files written to disk."""

    @pytest.mark.parametrize(
        "filename,expected",
        [
            ("clip.MP4", ".mp4"),
            ("clip.mov", ".mov"),
            ("archive.tar.gz", ".gz"),
            ("noextension", ".mp4"),
            ("", ".mp4"),
            (None, ".mp4"),
        ],
    )
    def test_extension_is_lowercased_with_a_default(self, main_module, filename, expected):
        assert main_module._safe_suffix(filename) == expected


class TestParseResultJson:
    """Stored results are parsed defensively: the column is free-form text."""

    def test_parses_valid_json(self, main_module):
        assert main_module._parse_result_json('{"a": 1}') == {"a": 1}

    @pytest.mark.parametrize("raw", [None, "", "not json", "{unclosed"])
    def test_returns_none_rather_than_raising(self, main_module, raw):
        assert main_module._parse_result_json(raw) is None
