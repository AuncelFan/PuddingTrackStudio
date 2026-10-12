import json
import pytest
from fastapi.testclient import TestClient

from backend import jobs, main
from backend.models import SceneConfig


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(main, 'TRACKS', tmp_path / 'tracks')
    monkeypatch.setattr(main, 'TILES', tmp_path / 'tiles')
    monkeypatch.setattr(jobs, 'DATA', tmp_path)
    with TestClient(main.app) as client:
        yield client


def test_upload_plan_and_read(client):
    response = client.post('/api/tracks', files={'file': ('sample.kml', main.DEMO.read_bytes())})
    assert response.status_code == 200
    track = response.json()['tracks'][0]
    assert client.get(f"/api/tracks/{track['id']}").json()['pointCount'] == track['pointCount']
    plan = client.post(f"/api/tracks/{track['id']}/plan", json={'speed': 60, 'fps': 24, 'start': 34, 'end': 94})
    assert plan.status_code == 200
    assert plan.json()['frameCount'] == 25
    assert plan.json()['frames'][0][5] == 34
    assert plan.json()['frames'][-1][5] == 94


def test_bad_file_and_unknown_track(client):
    assert client.post('/api/tracks', files={'file': ('bad.txt', b'test')}).status_code == 422
    assert client.get('/api/tracks/../../etc/passwd').status_code == 404
    assert client.get('/api/tracks/' + '0' * 36).status_code == 404


def test_demo_loads_cleaned_west_lake_route(client):
    response = client.post('/api/demo')
    assert response.status_code == 200
    track = response.json()['tracks'][0]
    assert track['filename'] == 'West Lake Loop.kml'
    assert track['pointCount'] == 1911
    assert track['durationSeconds'] == 10460
    assert track['startTime'] == '2000-01-01T00:00:00+00:00'


def test_tile_validation_prevents_external_requests(client):
    assert client.get('/api/tiles/arbitrary/0/0/0.png').status_code == 422
    assert client.get('/api/tiles/osm/19/0/0.png').status_code == 422
    assert client.get('/api/tiles/osm/0/1/0.png').status_code == 422


@pytest.mark.parametrize('kwargs', [{'width': 639}, {'width': 3840, 'height': 3840}, {'mode': 'geometry', 'backgroundOpacity': 0}, {'routeColor': 'red'}, {'backgroundOpacity': float('nan')}, {'format': 'hevc'}, {'format': 'hevc-alpha', 'height': 639}, {'lineWidth': 641}, {'markerSize': 321}, {'markerStyle': 'invalid'}, {'trailColor': 'red'}])
def test_invalid_output_config_rejected(kwargs):
    with pytest.raises(ValueError):
        SceneConfig(**kwargs)


def test_transparent_formats_allowed():
    assert SceneConfig(mode='geometry', format='webm', backgroundOpacity=0).backgroundOpacity == 0
    assert SceneConfig(mode='geometry', format='mov', backgroundOpacity=0.5).backgroundOpacity == 0.5
    assert SceneConfig(mode='geometry', format='hevc-alpha', backgroundOpacity=0.5).backgroundOpacity == 0.5


def test_large_appearance_sizes_and_marker_styles_allowed():
    for style in ['dot', 'ring', 'arrow', 'pin', 'crosshair']:
        config = SceneConfig(lineWidth=640, markerSize=320, markerStyle=style, trailColor='#dd3388')
        assert config.lineWidth == 640
        assert config.markerStyle == style


def test_hevc_unavailable_rejects_export_before_queueing(client, monkeypatch):
    capability = {'available': False, 'reason': '测试编码器未启用 Alpha'}
    monkeypatch.setattr(main, 'hevc_alpha_capability', lambda: capability)
    assert client.get('/api/health').json()['hevcAlpha'] == capability
    track = client.post('/api/demo').json()['tracks'][0]
    response = client.post('/api/exports', json={
        'trackId': track['id'], 'config': {'format': 'hevc-alpha'},
        'camera': {'center': [0, 0], 'span': 1000},
    })
    assert response.status_code == 503
    assert response.json()['detail'] == capability['reason']
    assert not client.app.state.jobs.jobs


def test_hevc_job_uses_verified_encoder_and_mov_container(client, monkeypatch):
    capability = {'available': True, 'reason': None, 'ffmpeg': '/verified-alpha/ffmpeg'}
    monkeypatch.setattr(main, 'hevc_alpha_capability', lambda: capability)
    monkeypatch.setattr(jobs, 'hevc_alpha_capability', lambda: capability)
    monkeypatch.setattr(client.app.state.jobs.executor, 'submit', lambda *args: None)
    track = client.post('/api/demo').json()['tracks'][0]
    response = client.post('/api/exports', json={
        'trackId': track['id'], 'config': {'format': 'hevc-alpha'},
        'plan': {'end': 60}, 'camera': {'center': [0, 0], 'span': 1000},
    })
    assert response.status_code == 202
    job = response.json()
    assert job['format'] == 'mov'
    assert job['encoding'] == 'hevc-alpha'
    manifest = json.loads((client.app.state.jobs.directory / job['id'] / 'input.json').read_text())
    assert manifest['ffmpeg'] == capability['ffmpeg']
    assert manifest['output'].endswith('/minimap.mov')
    assert manifest['config']['format'] == 'hevc-alpha'
