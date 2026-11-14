"""Deterministic worker packaging; no model-authored code is executed."""
from pathlib import Path
import hashlib, json
from PIL import Image, ImageOps
here = Path(__file__).resolve().parent
candidate = json.loads((here/'candidate.json').read_text())
assets = {}
out = here/'app/public/guide'
out.mkdir(parents=True, exist_ok=True)
steps = candidate['commonSteps'] + [s for v in candidate['variants'] for s in v['steps']]
for step in steps:
    region = step['diagram']
    if region is None: continue
    with Image.open(here/'processed'/f"page-{region['page']:02}.png") as page:
        w,h = page.size
        x,y,cw,ch = [region[k] for k in ['x','y','width','height']]
        image = page.crop((round(x*w),round(y*h),round((x+cw)*w),round((y+ch)*h))).convert('L')
        # Background drops away on an additive display; source geometry is preserved.
        image = ImageOps.invert(image)
        name = hashlib.sha256(json.dumps(region,sort_keys=True).encode()).hexdigest()[:16]+'.png'
        image.save(out/name)
        assets[step['id']] = '/guide/'+name
(here/'app/src/generated.json').write_text(json.dumps(candidate,indent=2,ensure_ascii=False)+'\n')
(here/'app/src/assets.json').write_text(json.dumps(assets,indent=2)+'\n')
print(f'Packaged {len(steps)} content screens and {len(assets)} local diagram references.')
