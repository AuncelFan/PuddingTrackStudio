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


def test_gpx_upload_merge_read_and_plan(client):
    contents = b'''<gpx xmlns="http://www.topografix.com/GPX/1/1"><trk><name>GPX hike</name><trkseg>
      <trkpt lon="120" lat="30"><time>2026-01-01T00:00:00Z</time></trkpt>
      <trkpt lon="120.00001" lat="30"><time>2026-01-01T00:00:00Z</time></trkpt>
      <trkpt lon="120.001" lat="30"><time>2026-01-01T00:00:10Z</time></trkpt>
    </trkseg></trk></gpx>'''
    response = client.post('/api/tracks', files={'file': ('HIKE.GPX', contents, 'application/gpx+xml')})
    assert response.status_code == 200
    track = response.json()['tracks'][0]
    assert track['filename'] == 'HIKE.GPX'
    assert track['source'] == 'GPX trk'
    assert track['pointCount'] == 2
    assert track['warnings']
    assert client.get(f"/api/tracks/{track['id']}").json() == track
    plan = client.post(f"/api/tracks/{track['id']}/plan", json={'speed': 1, 'fps': 1})
    assert plan.status_code == 200
    assert plan.json()['frameCount'] == 11
    assert plan.json()['frames'][0][:2] == [120.00001, 30]
    assert plan.json()['frames'][-1][:2] == [120.001, 30]


def test_gpx_upload_without_times_can_retry_with_duration(client):
    contents = b'<gpx><rte><rtept lon="120" lat="30"/><rtept lon="120.001" lat="30"/></rte></gpx>'
    files = {'file': ('route.gpx', contents)}
    response = client.post('/api/tracks', files=files)
    assert response.status_code == 422
    assert response.json()['code'] == 'missing_time'
    response = client.post('/api/tracks', files=files, data={'duration_seconds': '30'})
    assert response.status_code == 200
    track = response.json()['tracks'][0]
    assert track['synthetic']
    assert track['durationSeconds'] == 30


def test_kml_upload_merges_nearby_same_time_points(client):
    contents = b'''<kml xmlns:gx="http://www.google.com/kml/ext/2.2"><Placemark><gx:Track>
      <when>2026-01-01T00:00:00Z</when><when>2026-01-01T00:00:00Z</when><when>2026-01-01T00:00:10Z</when>
      <gx:coord>120 30 0</gx:coord><gx:coord>120.00001 30 0</gx:coord><gx:coord>120.001 30 0</gx:coord>
    </gx:Track></Placemark></kml>'''
    response = client.post('/api/tracks', files={'file': ('nearby.kml', contents)})
    assert response.status_code == 200
    track = response.json()['tracks'][0]
    assert track['pointCount'] == 2
    assert track['points'][0][:2] == [120.00001, 30]
    assert track['warnings']


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
