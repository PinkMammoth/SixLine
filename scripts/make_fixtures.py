"""Generate small, original GP3/GP4/GP5 test fixtures with PyGuitarPro.

Usage: uv venv && uv pip install pyguitarpro && python scripts/make_fixtures.py fixtures/
Content is a trivial original riff (no copyrighted material).
"""
import sys, os, copy
import guitarpro as gp

out = sys.argv[1] if len(sys.argv) > 1 else 'fixtures'

def make_song():
    song = gp.Song()
    song.title = 'Fixture Riff'
    song.artist = 'Test'
    song.tempo = 110
    # 4 measures
    while len(song.measureHeaders) < 4:
        song.addMeasureHeader(gp.MeasureHeader(number=len(song.measureHeaders) + 1))
    guitar = song.tracks[0]
    guitar.name = 'Guitar'
    guitar.channel.instrument = 29  # overdriven guitar
    bass = gp.Track(song, number=2, name='Bass', strings=[gp.GuitarString(n, v) for n, v in enumerate([43, 38, 33, 28], 1)])
    bass.channel = gp.MidiChannel(channel=2, effectChannel=3, instrument=33)
    drums = gp.Track(song, number=3, name='Drums', isPercussionTrack=True,
                     strings=[gp.GuitarString(n, 0) for n in range(1, 7)])
    drums.channel = gp.MidiChannel(channel=9, effectChannel=9, instrument=0)
    song.tracks += [bass, drums]
    for t in song.tracks:
        while len(t.measures) < 4:
            t.measures.append(gp.Measure(t, song.measureHeaders[len(t.measures)]))

    def put(measure, items):
        voice = measure.voices[0]
        voice.beats = []
        for dur, notes in items:
            b = gp.Beat(voice, duration=gp.Duration(value=dur))
            if not notes:
                b.status = gp.BeatStatus.rest
            else:
                b.status = gp.BeatStatus.normal
            for string, fret in notes:
                b.notes.append(gp.Note(b, value=fret, string=string, type=gp.NoteType.normal, velocity=95))
            voice.beats.append(b)

    # guitar (string 1 = high e in GP numbering)
    put(guitar.measures[0], [(8, [(6, 0)]), (8, [(6, 0)]), (8, [(6, 3)]), (8, [(6, 5)]), (4, [(6, 0), (5, 2)]), (4, [])])
    put(guitar.measures[1], [(16, [(5, 2)])] * 4 + [(8, [(4, 2)]), (8, [(3, 2)]), (2, [(2, 3), (1, 3)])])
    put(guitar.measures[2], [(4, [(6, 12)]), (4, [(6, 10)]), (4, [(6, 15)]), (4, [(5, 14)])])
    put(guitar.measures[3], [(1, [(6, 0), (5, 2), (4, 2)])])
    for i in range(4):
        put(bass.measures[i], [(4, [(4, 0)])] * 4)
    for i in range(4):
        put(drums.measures[i], [(8, [(1, 42), (6, 36)]), (8, [(1, 42)]), (8, [(1, 42), (3, 38)]), (8, [(1, 42)])] * 2)
    return song

os.makedirs(out, exist_ok=True)
for ver, ext in [((3, 0, 0), 'gp3'), ((4, 0, 0), 'gp4'), ((5, 1, 0), 'gp5')]:
    s = make_song()
    path = os.path.join(out, f'fixture.{ext}')
    gp.write(s, path, version=ver)
    print('wrote', path)
