#!/usr/bin/env python3
"""Rough cut of the demo video from generated assets (no network, no cost).

    python3 scripts/demo-video/rough_cut.py   ->  .data/demo-video/rough-cut.mp4

Missing assets (e.g. phone recordings not made yet) become labelled placeholder
cards, so the cut always renders. Glasses UI is composited with a screen blend.
"""
import json, os, subprocess, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
D = ROOT / '.data' / 'demo-video'
SEG = D / 'segments'
FONT = '/usr/share/fonts/google-noto/NotoSans-Bold.ttf'
W, H, FPS = 1280, 720, 24
VO = {l['id']: l for l in json.loads((Path(__file__).parent / 'voiceover.json').read_text())['lines']}

# Segment spec. clips: AI scenes (split evenly). ui: glasses overlay clips played in order.
# phone: phone recording shown in a frame. card: text card. vo: voice line ids in order.
S = [
    # 1. Assembly (main story)
    dict(clips=['h01-hook'], vo=['01']),
    dict(clips=['h02-phone'], vo=['02']),
    dict(phone='p01-author', speed=4.0, dur=6, caption='Real authoring app · GPT-6 Luna'),
    dict(phone='p01-guide', dur=3, caption='Generated from the real TROTTEN manual'),
    dict(clips=['h03-glasses-on'], vo=['03']),
    dict(clips=['h04-pov-steps'], ui=['01-home', '02-steps'], vo=['04'], dur=9),
    dict(clips=['h05-pov-screws'], ui=['03-ask'], ui_start=3.0, vo=['05', '06', '29', '07']),
    dict(clips=['h06-backwards'], vo=['08', '30']),
    dict(clips=['h07-pov-fix'], ui=['04-problem'], ui_speed=1.6, vo=['32', '09'], dur=11),
    dict(clips=['h08-doorbell'], vo=['10'], dur=2.5),
    dict(clips=['h09-next-day'], ui=['05-resume'], ui_start=1.0, vo=['11'], caption='Offline. Saved on the glasses.'),
    # 2. Cooking
    dict(clips=['c01-cook-struggle'], vo=['21']),
    dict(clips=['b01-cooking'], ui=['09-cooking'], ui_speed=1.5, vo=['22']),
    # 3. Laundry
    dict(clips=['l01-laundry-struggle'], vo=['23']),
    dict(phone='p02-laundry', speed=3.0, dur=3.5),
    dict(clips=['b03-laundry'], ui=['06-laundry'], ui_speed=1.5, vo=['24']),
    # 4. Game table (swap b04 for the real on-device clip)
    dict(clips=['t01-table-struggle'], vo=['25']),
    dict(clips=['b04-tabletop'], ui=['08-dnd'], ui_start=0.5, vo=['26', '16', '31'], caption='REPLACE WITH REAL ON-DEVICE CLIP'),
    # Blocks + phone + how it works
    dict(clips=['b02-crochet', 'b05-bike', 'b06-workout', 'b07-meds'], vo=['27'], caption='Blocks: step guide · counter · checklist · dashboard'),
    dict(phone='p03-notes', speed=1.0, vo=['28']),
    dict(card='Manual or prompt  ->  model  ->  checked Solution data\\nRuns offline on the glasses\\nNeural Band + Meta AI (WebMCP)', vo=['19']),
    dict(clips=['h10-done'], vo=['20']),
    dict(card='Bring your manual.\\nKeep your hands on what you are making.', dur=3.0),
]


def dur(p):
    return float(subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', str(p)]))


def esc(t):
    return t.replace(':', r'\:').replace("'", r"\'").replace(',', r'\,')


def text(t, size, y, box=True):
    b = ':box=1:boxcolor=black@0.45:boxborderw=14' if box else ''
    return f"drawtext=fontfile={FONT}:text='{esc(t)}':fontsize={size}:fontcolor=white:x=(w-text_w)/2:y={y}{b}:line_spacing=12"


def render(i, s):
    out = SEG / f'{i:02d}.mp4'
    ins, vf, af = [], [], []
    # Audio timeline: lines back to back with their pauseBefore.
    t, placed = 0.3, []
    for vid in s.get('vo', []):
        line = VO[vid]
        wav = next((D / 'voice').glob(f'{vid}-*.wav'), None)
        t += line.get('pauseBefore', 0)
        if wav:
            placed.append((wav, t)); t += dur(wav)
    length = max(t + 0.6, s.get('dur', 0), 2.0)

    count = [0]

    def add(p, lavfi=False):
        ins.extend((['-f', 'lavfi'] if lavfi else []) + ['-i', str(p)]); count[0] += 1; return count[0] - 1

    if 'clips' in s:
        parts = []
        for c in s['clips']:
            p = D / 'clips' / f'{c}.mp4'
            n, share = add(p), length / len(s['clips'])
            k = min(max(share / dur(p), 1.0), 1.5)
            vf.append(f'[{n}:v]setpts={k}*(PTS-STARTPTS),scale={W}:{H},fps={FPS},tpad=stop_mode=clone:stop_duration={share},trim=duration={share},setpts=PTS-STARTPTS[c{n}]')
            parts.append(f'[c{n}]')
        vf.append(f"{''.join(parts)}concat=n={len(parts)}:v=1:a=0,format=gbrp[base]")
        cur = '[base]'
        uis = [D / 'ui' / f'{u}.mp4' for u in s.get('ui', []) if (D / 'ui' / f'{u}.mp4').exists()]
        if uis:
            un = [add(u) for u in uis]
            sp, st = s.get('ui_speed', 1.0), s.get('ui_start', 0.5)
            vf.append(f"{''.join(f'[{n}:v]' for n in un)}concat=n={len(un)}:v=1:a=0,setpts=(PTS-STARTPTS)/{sp},fps={FPS},scale=400:400,"
                      f'pad={W}:{H}:820:50:black,tpad=start_duration={st}:stop_mode=clone:stop_duration={length},trim=duration={length},format=gbrp[ui]')
            vf.append(f"{cur}[ui]blend=all_mode=screen,format=yuv420p,{text('Display simulated · real app', 18, 'h-40', False).replace('x=(w-text_w)/2', 'x=w-text_w-24')}[v1]")
            cur = '[v1]'
        else:
            vf.append(f'{cur}format=yuv420p[v1]'); cur = '[v1]'
    elif 'phone' in s:
        p = D / 'ui' / f"{s['phone']}.mp4"
        if p.exists():
            n = add(p)
            # Early recordings put a 393x852 page in the top-left of a 1179x2556 canvas.
            crop = 'crop=393:852:0:0,' if int(subprocess.check_output(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width', '-of', 'csv=p=0', str(p)])) > 600 else ''
            vf.append(f"[{n}:v]{crop}setpts=(PTS-STARTPTS)/{s.get('speed', 1)},fps={FPS},scale=-2:660,pad={W}:{H}:(ow-iw)/2:30:0x1b1d22,"
                      f'tpad=stop_mode=clone:stop_duration={length},trim=duration={length},format=yuv420p[v1]')
        else:
            n = add(f'color=c=0x1b1d22:s={W}x{H}:r={FPS}:d={length}', True)
            vf.append(f"[{n}:v]{text('[phone recording: ' + s['phone'] + ']', 34, '(h-text_h)/2', False)},format=yuv420p[v1]")
        cur = '[v1]'
    else:
        n = add(f'color=c=black:s={W}x{H}:r={FPS}:d={length}', True)
        vf.append(f"[{n}:v]{text(s['card'].replace(chr(92) + 'n', chr(10)), 40, '(h-text_h)/2', False)},format=yuv420p[v1]")
        cur = '[v1]'
    if s.get('caption'):
        vf.append(f"{cur}{text(s['caption'], 30, 'h-110')}[v2]"); cur = '[v2]'

    an = add(f'anullsrc=r=48000:cl=stereo:d={length}', True)
    mix = [f'[{an}:a]']
    for wav, at in placed:
        n = add(wav)
        af.append(f'[{n}:a]aresample=48000,aformat=channel_layouts=stereo,adelay={int(at * 1000)}:all=1[a{n}]')
        mix.append(f'[a{n}]')
    af.append(f"{''.join(mix)}amix=inputs={len(mix)}:normalize=0:duration=first[aout]")
    cmd = ['ffmpeg', '-y', '-loglevel', 'error', *ins, '-filter_complex', ';'.join(vf + af),
           '-map', cur, '-map', '[aout]', '-t', f'{length:.3f}', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
           '-c:a', 'aac', '-b:a', '160k', str(out)]
    subprocess.run(cmd, check=True)
    return out, length


def main():
    SEG.mkdir(parents=True, exist_ok=True)
    files, total = [], 0.0
    for i, s in enumerate(S):
        f, l = render(i, s)
        files.append(f); total += l
        print(f'{i:02d} {l:5.1f}s  t={total:6.1f}  {s.get("clips") or s.get("phone") or "card"}')
    lst = SEG / 'list.txt'
    lst.write_text(''.join(f"file '{f}'\n" for f in files))
    final = D / 'rough-cut.mp4'
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', str(lst), '-c', 'copy', str(final)], check=True)
    print(f'{final}  {total:.1f}s')


if __name__ == '__main__':
    main()
