"""Optional 40MP memory/output smoke check, separate from fast CI tests.

python -m studio.tests.full_resolution_smoke
Uses several GB of memory. Does not test a real RAF or camera.
"""
import hashlib
import io
import time

import numpy as np
import tifffile

from studio.engine import encode, grade


def main():
    started = time.perf_counter()
    rgb = np.empty((5152, 7728, 3), dtype=np.float32)
    rgb[..., 0] = np.linspace(.07, .8, 7728, dtype=np.float32)[None, :]
    rgb[..., 1] = np.linspace(.05, .7, 5152, dtype=np.float32)[:, None]
    rgb[..., 2] = .31
    digest = hashlib.sha256(memoryview(rgb).cast("B")).hexdigest()
    out = grade(rgb, {"exposure": .2, "contrast": 8, "vignette": 12,
        "masks": [{"type":"radial","exposure":.25,"x":.4,"y":.5,"radius":.25}]})
    data, _, _ = encode(out, "tiff16")
    with tifffile.TiffFile(io.BytesIO(data)) as tf:
        assert tf.pages[0].shape == (5152, 7728, 3)
        assert tf.pages[0].dtype == np.uint16
    assert hashlib.sha256(memoryview(rgb).cast("B")).hexdigest() == digest
    print(f"PASS: 7728 x 5152, 16-bit RGB TIFF, {len(data):,} bytes, source unchanged, {time.perf_counter()-started:.1f}s")


if __name__ == "__main__":
    main()
