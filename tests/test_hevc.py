from pathlib import Path

import imageio_ffmpeg
import pytest

from backend.hevc import hevc_alpha_capability, probe_hevc_alpha


def test_missing_explicit_encoder_is_not_replaced(monkeypatch, tmp_path):
    monkeypatch.setenv('TRACE_HEVC_FFMPEG_PATH', str(tmp_path / 'missing-ffmpeg'))
    capability = hevc_alpha_capability()
    assert not capability['available']
    assert '不存在' in capability['reason']


def test_bundled_old_ffmpeg_cannot_claim_alpha_support():
    executable = imageio_ffmpeg.get_ffmpeg_exe()
    if 'v7.' not in executable:
        pytest.skip('This regression targets bundled FFmpeg 7, which does not encode HEVC Alpha')
    capability = probe_hevc_alpha(executable)
    assert not capability['available']
    assert 'Alpha' in capability['reason']


def test_real_alpha_round_trip_when_local_encoder_installed():
    executable = Path(__file__).resolve().parents[1] / '.tools/hevc-alpha/bin/ffmpeg'
    if not executable.exists():
        pytest.skip('Run npm run setup:hevc-alpha to test the actual HEVC encoder')
    capability = probe_hevc_alpha(str(executable))
    assert capability['available'], capability['reason']
    assert all(abs(actual - expected) <= 6 for actual, expected in
               zip(capability['verifiedAlpha'], [0, 128, 255, 64]))
