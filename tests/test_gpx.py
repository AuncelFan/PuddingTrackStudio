import pytest

from backend.track import TrackError, make_plan, parse_gpx, parse_track


def gpx(body, version='1.1'):
    namespace = f' xmlns="http://www.topografix.com/GPX/{version.replace(".", "/")}"' if version else ''
    return f'<gpx{namespace}>{body}</gpx>'.encode()


def point(lon, time=None, elevation=None, kind='trkpt'):
    body = (f'<ele>{elevation}</ele>' if elevation is not None else '')
    body += f'<time>{time}</time>' if time is not None else ''
    return f'<{kind} lat="30" lon="{lon}">{body}</{kind}>'


@pytest.mark.parametrize('version', ['1.0', '1.1', ''])
def test_gpx_track_timezones_altitude_and_rest(version):
    data = gpx('<trk><name>徒步</name><trkseg>'
               + point(120, '2026-01-01T08:00:00+08:00', 5)
               + point(120, '2026-01-01T00:00:10Z', 5)
               + point(120.001, '2026-01-01T00:00:20Z', 15)
               + '</trkseg></trk>', version)
    track = parse_gpx(data)[0]
    assert track['name'] == '徒步'
    assert track['source'] == 'GPX trk'
    assert not track['synthetic']
    assert track['pointCount'] == 3
    assert track['durationSeconds'] == 20
    frames = make_plan(track, speed=5, fps=1)['frames']
    assert frames[0][:3] == frames[1][:3] == frames[2][:3] == [120, 30, 5]
    assert frames[-1][:3] == [120.001, 30, 15]


def test_gpx_keeps_segments_and_ignores_independent_waypoints():
    data = gpx('<wpt lat="0" lon="0"><time>1970-01-01T00:00:00Z</time></wpt><trk>'
               '<trkseg>' + point(120, '2026-01-01T00:00:00Z') + point(120.001, '2026-01-01T00:00:10Z')
               + '</trkseg><trkseg/><trkseg>'
               + point(121, '2026-01-01T00:00:20Z') + point(121.001, '2026-01-01T00:00:30Z')
               + '</trkseg></trk>')
    track = parse_gpx(data, 'hike.gpx')[0]
    assert track['name'] == 'hike'
    assert track['segmentCount'] == 2
    assert track['pointCount'] == 4
    assert track['durationSeconds'] == 30
    assert track['distanceMeters'] < 200
    frames = make_plan(track, speed=5, fps=1)['frames']
    assert frames[3][:2] == [120.001, 30]
    assert frames[4][:2] == [121, 30]


def test_gpx_returns_independent_tracks_and_routes():
    data = gpx('<metadata><name>行程</name></metadata><trk><name>A</name><trkseg>'
               + point(120, '2026-01-01T00:00:00Z') + point(120.001, '2026-01-01T00:00:10Z')
               + '</trkseg></trk><trk><trkseg>'
               + point(121, '2026-01-01T00:00:00Z') + point(121.001, '2026-01-01T00:00:10Z')
               + '</trkseg></trk><rte><name>路线</name>'
               + point(122, '2026-01-01T00:00:00Z', kind='rtept')
               + point(122.001, '2026-01-01T00:00:10Z', kind='rtept') + '</rte>')
    tracks = parse_gpx(data)
    assert [track['name'] for track in tracks] == ['A', '行程', '路线']
    assert [track['source'] for track in tracks] == ['GPX trk', 'GPX trk', 'GPX rte']
    assert all(track['durationSeconds'] == 10 for track in tracks)


@pytest.mark.parametrize('kind', ['trk', 'rte'])
def test_gpx_untimed_track_requires_duration(kind):
    point_kind = 'trkpt' if kind == 'trk' else 'rtept'
    points = point(120, kind=point_kind) + point(120.001, kind=point_kind) + point(120.003, kind=point_kind)
    body = f'<trkseg>{points}</trkseg>' if kind == 'trk' else points
    data = gpx(f'<metadata><time>2026-01-01T00:00:00Z</time></metadata><{kind}>{body}</{kind}>')
    with pytest.raises(TrackError) as exc:
        parse_gpx(data)
    assert exc.value.code == 'missing_time'
    track = parse_gpx(data, duration=30)[0]
    assert track['synthetic']
    assert track['durationSeconds'] == 30
    assert track['points'][1][3] == pytest.approx(10)
    assert track['points'][0][2] == 0
    assert track['startTime'] is None
    assert track['warnings']


def test_gpx_partial_time_cannot_be_replaced_by_duration():
    data = gpx('<trk><trkseg>' + point(120, '2026-01-01T00:00:00Z') + point(120.001) + '</trkseg></trk>')
    with pytest.raises(TrackError, match='部分点缺少时间'):
        parse_gpx(data, duration=30)


def test_gpx_duplicate_times_use_same_ten_meter_merge():
    data = gpx('<trk><trkseg>' + point(120, '2026-01-01T00:00:00.500Z', 5)
               + point(120.00001, '2026-01-01T08:00:00.500+08:00', 8)
               + point(120.001, '2026-01-01T00:00:10.500Z', 10) + '</trkseg></trk>')
    track = parse_gpx(data)[0]
    assert track['pointCount'] == 2
    assert track['points'][0][:3] == [120.00001, 30, 8]
    assert track['durationSeconds'] == 10
    assert any('10 米' in warning for warning in track['warnings'])


@pytest.mark.parametrize('data', [
    b'not XML', b'<kml/>',
    b'<!DOCTYPE gpx [<!ENTITY x SYSTEM "file:///etc/passwd">]><gpx>&x;</gpx>',
    gpx('<wpt lat="30" lon="120"/><wpt lat="30" lon="121"/>'),
    gpx('<trk><trkseg/></trk>'),
    *[gpx('<trk><trkseg>' + invalid_point + point(120.001, '2026-01-01T00:00:10Z') + '</trkseg></trk>') for invalid_point in [
        '<trkpt lon="120"><time>2026-01-01T00:00:00Z</time></trkpt>',
        '<trkpt lat="30"><time>2026-01-01T00:00:00Z</time></trkpt>',
        '<trkpt lat="91" lon="120"><time>2026-01-01T00:00:00Z</time></trkpt>',
        point('NaN', '2026-01-01T00:00:00Z'),
        point(181, '2026-01-01T00:00:00Z'),
        point(120, '2026-01-01T00:00:00Z', 'bad'),
        point(120, '2026-01-01T00:00:00Z', 'inf'),
        point(120, '2026-01-01T00:00:00'),
    ]],
])
def test_gpx_invalid_points_xml_and_waypoint_only_files_rejected(data):
    with pytest.raises(TrackError) as exc:
        parse_gpx(data)
    assert exc.value.code == 'invalid_gpx'


def test_track_dispatch_checks_extension_and_xml_format():
    data = gpx('<trk><trkseg>' + point(120, '2026-01-01T00:00:00Z') + point(120.001, '2026-01-01T00:00:10Z') + '</trkseg></trk>')
    assert parse_track(data, 'HIKE.GPX')[0]['source'] == 'GPX trk'
    with pytest.raises(TrackError, match='根节点必须是 kml'):
        parse_track(data, 'hike.kml')
    with pytest.raises(TrackError) as exc:
        parse_track(data, 'hike.xml')
    assert exc.value.code == 'unsupported_format'
