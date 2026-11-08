import io
import tempfile
import unittest
from pathlib import Path

import numpy as np
from PIL import Image
import tifffile

from studio.engine import (DEFAULTS, SRGB_ICC, apply_lut, encode, grade, histogram,
    load_rgb, mask_weights, parse_cube, to_linear, to_srgb, validate_edits)


class EngineTests(unittest.TestCase):
    def setUp(self):
        self.rgb = np.random.default_rng(3).uniform(.04, .85, (40, 60, 3)).astype(np.float32)

    def test_neutral_camera_rendering_is_unchanged_and_input_is_immutable(self):
        original = self.rgb.copy()
        out = grade(self.rgb, {})
        np.testing.assert_allclose(out, original, atol=2e-7)
        np.testing.assert_array_equal(self.rgb, original)

    def test_exposure_is_measured_in_stops_on_linear_data(self):
        source = np.full((3, 3, 3), .1, dtype=np.float32)
        out = grade(source, {"exposure": 1}, linear=True)
        np.testing.assert_allclose(to_linear(out), .2, atol=1e-6)

    def test_srgb_round_trip(self):
        np.testing.assert_allclose(to_srgb(to_linear(self.rgb)), self.rgb, atol=2e-7)

    def test_crop_and_rotation_have_exact_geometry(self):
        out = grade(self.rgb, {"quarter_turns": 1, "crop": [.25, .25, .5, .5]})
        expected = np.rot90(self.rgb, -1)[15:45, 10:30]
        np.testing.assert_allclose(out, expected, atol=2e-7)

    def test_masks_follow_visible_cropped_coordinates(self):
        source = np.full((80, 100, 3), .2, dtype=np.float32)
        out = grade(source, {"crop": [.5, 0, .5, 1], "quarter_turns": 0,
            "masks": [{"type": "radial", "x": .2, "y": .5, "radius": .15, "exposure": 1}]})
        self.assertEqual(out.shape, (80, 50, 3))
        self.assertGreater(out[40, 10, 0], out[40, 45, 0] * 1.2)
        self.assertAlmostEqual(float(out[40, 45, 0]), .2, places=5)

    def test_mask_feather_and_inversion(self):
        mask = validate_edits({"masks": [{"type": "radial"}]})["masks"][0]
        a = mask_weights((101, 101, 3), mask)
        b = mask_weights((101, 101, 3), {**mask, "invert": True})
        np.testing.assert_allclose(a + b, 1)
        self.assertEqual(a[50, 50, 0], 1)
        self.assertEqual(a[0, 0, 0], 0)

    def test_identity_cube_uses_r_fastest_order(self):
        lines = ["LUT_3D_SIZE 2"]
        for b in (0, 1):
            for g in (0, 1):
                for r in (0, 1):
                    lines.append(f"{r} {g} {b}")
        lut = parse_cube("\n".join(lines))
        np.testing.assert_allclose(apply_lut(self.rgb, lut), self.rgb, atol=2e-7)

    def test_cube_rejects_bad_size_nonfinite_and_1d(self):
        for text in ("LUT_3D_SIZE 0", "LUT_1D_SIZE 3", "LUT_3D_SIZE 2\n" + "nan 0 0\n" * 8):
            with self.subTest(text=text), self.assertRaises(ValueError):
                parse_cube(text)

    def test_tiff16_retains_more_than_eight_bit_precision_and_srgb_profile(self):
        values = np.arange(1024, dtype=np.float32) / 1023
        rgb = np.repeat(values.reshape(1, 1024, 1), 3, axis=2)
        data, mime, suffix = encode(rgb, "tiff16")
        with tifffile.TiffFile(io.BytesIO(data)) as tf:
            output = tf.asarray()
            self.assertEqual(output.dtype, np.uint16)
            self.assertEqual(len(np.unique(output[..., 0])), 1024)
            self.assertEqual(tf.pages[0].tags["InterColorProfile"].value, SRGB_ICC)
        self.assertEqual((mime, suffix), ("image/tiff", ".tif"))

    def test_high_bit_tiff_import_preserves_precision(self):
        rgb = np.arange(300, dtype=np.uint16).reshape(10, 10, 3) + 30000
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "test.tif"
            tifffile.imwrite(path, rgb, photometric="rgb", iccprofile=SRGB_ICC)
            result, linear = load_rgb(path)
        np.testing.assert_allclose(result, rgb.astype(np.float32) / 65535, atol=1e-7)
        self.assertFalse(linear)

    def test_jpeg_exif_orientation_is_applied(self):
        im = Image.new("RGB", (60, 40), "red")
        exif = Image.Exif(); exif[274] = 6
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "test.jpg"; im.save(path, exif=exif)
            result, _ = load_rgb(path)
        self.assertEqual(result.shape, (60, 40, 3))

    def test_detail_pipeline_keeps_float32_dimensions_and_finite_values(self):
        out = grade(self.rgb, {"texture": 60, "sharpness": 70, "grain": 25, "vignette": 30})
        self.assertEqual(out.shape, self.rgb.shape)
        self.assertEqual(out.dtype, np.float32)
        self.assertTrue(np.isfinite(out).all())

    def test_bad_edit_values_rejected(self):
        for value in ({"exposure": float("nan")}, {"exposure": 9}, {"crop": [0, 0, 0, 1]},
                      {"quarter_turns": 1.5}, {"curve": [[0,0],[0,.5],[1,1]]},
                      {"masks": [{"type":"subject"}]}, {"lut_id":"../../secret"}):
            with self.subTest(value=value), self.assertRaises(ValueError):
                validate_edits(value)

    def test_histogram_and_export_do_not_attach_source_exif(self):
        data, _, _ = encode(self.rgb, "jpeg")
        with Image.open(io.BytesIO(data)) as im:
            self.assertFalse(im.getexif())
            self.assertTrue(im.info.get("icc_profile"))
        hist = histogram(self.rgb)
        self.assertEqual(len(hist["channels"]), 3)
        self.assertEqual(sum(hist["channels"][0]), 40 * 60)


if __name__ == "__main__":
    unittest.main()
