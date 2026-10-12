from pathlib import Path

import pytest

from backend.track import TrackError, make_plan, normalize, parse_kml


def kml(body):
    return ('<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">' + body + '</kml>').encode()


def gx(coords, whens):
    return '<gx:Track>' + ''.join(f'<when>{when}</when>' for when in whens) + ''.join(f'<gx:coord>{c}</gx:coord>' for c in coords) + '</gx:Track>'


def simple_track():
    return normalize('test', [[0, 0, 0, 1000, True], [0.01, 0, 100, 1010, False], [0.01, 0, 100, 1020, False], [0.02, 0, 0, 1030, False]], 'test')


def test_time_interpolation_preserves_rest_and_endpoints():
    track = simple_track()
    plan = make_plan(track, speed=5, fps=1)
    assert plan['frameCount'] == 7
    assert plan['frames'][0][:3] == [0, 0, 0]
    assert plan['frames'][1][:3] == pytest.approx([0.005, 0, 50])
    assert plan['frames'][2][:3] == plan['frames'][3][:3] == plan['frames'][4][:3]
    assert plan['frames'][-1][:3] == [0.02, 0, 0]
    assert plan['frames'][-1][5] == 30


def test_uneven_final_interval_contains_exact_endpoint():
    plan = make_plan(simple_track(), speed=7, fps=1)
    assert [f[5] for f in plan['frames']] == [0, 7, 14, 21, 28, 30]


def test_clip_interpolates_at_boundaries():
    plan = make_plan(simple_track(), speed=2, fps=2, start=5, end=25)
    assert plan['frames'][0][0] == pytest.approx(0.005)
    assert plan['frames'][-1][0] == pytest.approx(0.015)
    assert plan['frames'][0][6] == pytest.approx(0.25)
    assert plan['frames'][-1][6] == pytest.approx(0.75)


def test_progress_tracks_distance_and_stops_during_rest():
    frames = make_plan(simple_track(), speed=5, fps=1)['frames']
    assert [frame[6] for frame in frames] == pytest.approx([0, 0.25, 0.5, 0.5, 0.5, 0.75, 1])
    uneven = normalize('variable pace', [[0, 0, 0, 0, True], [0.03, 0, 0, 10, False],
                                        [0.04, 0, 0, 30, False]], 'test')
    frames = make_plan(uneven, speed=10, fps=1)['frames']
    assert [frame[6] for frame in frames] == pytest.approx([0, 0.75, 0.875, 1])


def test_stationary_route_has_finite_zero_distance_progress():
    track = normalize('rest', [[1, 1, 0, 0, True], [1, 1, 0, 20, False]], 'test')
    assert all(frame[6] == 0 for frame in make_plan(track, speed=5, fps=1)['frames'])


def test_segment_gap_holds_and_never_counts_imaginary_distance():
    track = normalize('multi', [[0, 0, 0, 100, True], [0.01, 0, 0, 110, False], [1, 0, 0, 120, True], [1.01, 0, 0, 130, False]], 'test')
    frames = make_plan(track, speed=5, fps=1)['frames']
    assert frames[2][:2] == frames[3][:2] == [0.01, 0]
    assert frames[4][:2] == [1, 0]
    assert track['distanceMeters'] == pytest.approx(2223.9, abs=1)
    assert track['segmentCount'] == 2
    assert [frame[6] for frame in frames] == pytest.approx([0, 0.25, 0.5, 0.5, 0.5, 0.75, 1])


def test_date_line_uses_shortest_arc():
    track = normalize('date line', [[179.9, 10, 0, 0, True], [-179.9, 10, 0, 10, False]], 'test')
    frames = make_plan(track, speed=5, fps=1)['frames']
    assert frames[1][0] == pytest.approx(180)
    assert track['distanceMeters'] < 23000


def test_gx_parse_and_timezone():
    data = kml('<Placemark><name>测试</name>' + gx(['120 30 1', '121 30 2'], ['2026-01-01T08:00:00+08:00', '2026-01-01T00:00:10Z']) + '</Placemark>')
    track = parse_kml(data)[0]
    assert track['name'] == '测试'
    assert track['durationSeconds'] == 10
    assert track['pointCount'] == 2


def test_gx_multitrack_keeps_segments():
    data = kml('<Placemark><gx:MultiTrack>' + gx(['0 0 0', '1 0 0'], ['2026-01-01T00:00:00Z', '2026-01-01T00:00:10Z']) + gx(['2 0 0', '3 0 0'], ['2026-01-01T00:00:20Z', '2026-01-01T00:00:30Z']) + '</gx:MultiTrack></Placemark>')
    tracks = parse_kml(data)
    assert len(tracks) == 1
    assert tracks[0]['segmentCount'] == 2


def test_coros_timespan_points_prefer_track_points():
    data = kml('<Document><Placemark><TimeStamp><when>2026-01-01T00:00:00Z</when></TimeStamp><Point><coordinates>80,10</coordinates></Point></Placemark><Folder><name>Track Points</name>' + ''.join(f'<Placemark><TimeSpan><begin>2026-01-01T00:00:{i * 10:02d}Z</begin></TimeSpan><Point><coordinates>{120 + i},30,5</coordinates></Point></Placemark>' for i in range(2)) + '</Folder></Document>')
    track = parse_kml(data)[0]
    assert track['pointCount'] == 2
    assert track['points'][0][0] == 120


def test_point_time_extension_and_space_separated_coordinates():
    data = kml(
        '<Folder><Placemark><time>2026-01-01T00:00:00Z</time><Point><coordinates>120 30 5</coordinates></Point></Placemark>'
        '<Placemark><time>2026-01-01T00:00:10Z</time><Point><coordinates>121 30 5</coordinates></Point></Placemark></Folder>'
    )
    track = parse_kml(data)[0]
    assert track['source'] == 'TimeStamped Points'
    assert track['durationSeconds'] == 10
    assert track['points'][0][:3] == [120, 30, 5]


def test_coros_export_uses_lap_durations_for_line_string_route():
    # Synthetic COROS chunks and lap anchors keep format coverage without
    # bundling a personal activity export. Include a one-point chunk.
    data = kml('''<Document>
      <Placemark><name>Track</name><MultiGeometry>
        <LineString><coordinates>120,30,5</coordinates></LineString>
        <LineString><coordinates>120.001,30,5 120.002,30,5</coordinates></LineString>
        <LineString><coordinates>120.003,30,5 120.004,30,5</coordinates></LineString>
      </MultiGeometry></Placemark>
      <Folder><name>Laps</name>
        <Placemark><name>Start</name><Point><coordinates>120 30 5</coordinates></Point></Placemark>
        <Placemark><name>Lap 1</name><description>Time: 30</description><Point><coordinates>120 30 5</coordinates></Point></Placemark>
        <Placemark><name>Lap 2</name><description>Time: 40</description><Point><coordinates>120.002 30 5</coordinates></Point></Placemark>
        <Placemark><name>End</name><description>Time: 70</description><Point><coordinates>120.004 30 5</coordinates></Point></Placemark>
      </Folder></Document>''')
    track = parse_kml(data)[0]
    assert track['source'] == 'COROS Laps（分段时间）'
    assert track['timingDerived']
    assert not track['synthetic']
    assert track['pointCount'] == 5
    assert track['segmentCount'] == 1
    assert track['durationSeconds'] == pytest.approx(70)
    assert track['points'][2][3] - track['points'][0][3] == pytest.approx(30)
    assert track['startTime'] is None
    assert track['endTime'] is None
    assert any('COROS Laps' in warning for warning in track['warnings'])


def test_coros_lap_summary_rounding_keeps_all_laps():
    body = '''
    <Document>
      <Placemark><name>Track</name><MultiGeometry>
        <LineString><coordinates>0,0 0.01,0 0.02,0</coordinates></LineString>
      </MultiGeometry></Placemark>
      <Folder><name>Laps</name>
        <Placemark><name>Start</name><description>Time : 9</description><Point><coordinates>0 0</coordinates></Point></Placemark>
        <Placemark><name>Lap 1</name><description>Time: 5</description><Point><coordinates>0 0</coordinates></Point></Placemark>
        <Placemark><name>Lap 2</name><description>Time: 5</description><Point><coordinates>0.01 0</coordinates></Point></Placemark>
        <Placemark><name>End</name><description>Time : 9</description><Point><coordinates>0.02 0</coordinates></Point></Placemark>
      </Folder>
    </Document>'''
    track = parse_kml(kml(body))[0]
    assert track['durationSeconds'] == 10
    assert any('各 Lap 之和' in warning for warning in track['warnings'])


def test_no_timestamp_requires_explicit_duration():
    data = kml('<Placemark><LineString><coordinates>0,0 0.01,0 0.03,0</coordinates></LineString></Placemark>')
    with pytest.raises(TrackError) as exc:
        parse_kml(data)
    assert exc.value.code == 'missing_time'
    track = parse_kml(data, duration=30)[0]
    assert track['synthetic']
    assert track['points'][1][3] == pytest.approx(10)
    assert track['warnings']


def test_repeated_stationary_recordings_are_not_removed():
    track = normalize('rest', [[1, 1, 0, 0, True], [1, 1, 0, 100, False]], 'test')
    assert track['durationSeconds'] == 100
    assert track['pointCount'] == 2


def test_duplicate_conflicting_timestamp_rejected():
    with pytest.raises(TrackError, match='同一时间'):
        normalize('bad', [[0, 0, 0, 0, True], [1, 0, 0, 0, False]], 'test')


@pytest.mark.parametrize('body', [b'not XML', b'<!DOCTYPE kml [<!ENTITY x SYSTEM "file:///etc/passwd">]><kml>&x;</kml>', kml(gx(['0 0 0'], [])), kml(gx(['NaN 0 0', '0 0 0'], ['2026-01-01T00:00:00Z', '2026-01-01T00:00:10Z']))])
def test_invalid_and_entity_xml_rejected(body):
    with pytest.raises(TrackError):
        parse_kml(body)


@pytest.mark.parametrize('args', [{'start': 20, 'end': 10}, {'speed': 0}, {'fps': 0}, {'end': 31}, {'speed': float('nan')}, {'speed': 0.01, 'fps': 120}])
def test_invalid_or_excessive_plan_rejected(args):
    with pytest.raises(TrackError):
        make_plan(simple_track(), **args)


def test_bundled_demo_retains_timed_route_without_personal_metadata():
    from defusedxml import ElementTree as ET

    path = Path('examples/West Lake Loop.kml')
    contents = path.read_bytes()
    track = parse_kml(contents, path.name)[0]
    assert track['name'] == path.stem
    assert track['source'] == 'gx:Track'
    assert not track['synthetic']
    assert track['pointCount'] == 1911
    assert track['durationSeconds'] == 10460
    assert track['distanceMeters'] == pytest.approx(11965.272125033036)
    assert track['startTime'] == '2000-01-01T00:00:00+00:00'
    root = ET.fromstring(contents)
    assert {e.tag.rsplit('}', 1)[-1] for e in root.iter()} == {'kml', 'Document', 'name', 'Placemark', 'Track', 'when', 'coord'}
    assert all(not e.attrib for e in root.iter())
    assert sum(e.tag.rsplit('}', 1)[-1] == 'when' for e in root.iter()) == track['pointCount']
