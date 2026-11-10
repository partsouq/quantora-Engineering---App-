"""Checks that one malformed object never stops a whole DWG conversion.

Run: python3 tools/dwg/test_dwg2pdf.py   (needs pymupdf + ezdxf, as in the workflow)
"""
import json, os, subprocess, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__))


def drawing(model, layouts=None, paper=None):
    ents = [dict(e, ownerBlockRecordSoftId="1F") for e in model]
    ents += [dict(e, ownerBlockRecordSoftId="P1") for e in (paper or [])]
    return {
        "header": {"MEASUREMENT": 1},
        "tables": {"LAYER": {"entries": [{"name": "0", "plotFlag": 1}]},
                   "BLOCK_RECORD": {"entries": [{"name": "*Model_Space", "handle": "1F"},
                                                {"name": "*Paper_Space", "handle": "P1"}]}},
        "objects": {"LAYOUT": layouts or []},
        "entities": ents,
    }


GOOD = [{"type": "LINE", "layer": "0", "startPoint": {"x": 0, "y": 0}, "endPoint": {"x": 1000, "y": 500}},
        {"type": "TEXT", "layer": "0", "startPoint": {"x": 10, "y": 10}, "text": "DB-1", "textHeight": 25}]


def run(d):
    with tempfile.TemporaryDirectory() as t:
        js, pdf, rep = (os.path.join(t, n) for n in ("in.json", "out.pdf", "rep.json"))
        json.dump(d, open(js, "w"))
        r = subprocess.run([sys.executable, os.path.join(HERE, "dwg2pdf.py"), js, pdf, rep], capture_output=True, text=True)
        ok = r.returncode == 0 and os.path.exists(pdf)
        return ok, (json.load(open(rep)) if ok else None), r.stderr


class Robust(unittest.TestCase):
    def test_plain_model(self):
        ok, rep, err = run(drawing(GOOD))
        self.assertTrue(ok, err); self.assertEqual(len(rep["pages"]), 1)

    def test_entity_missing_points(self):
        bad = [{"type": "CIRCLE", "layer": "0"}, {"type": "LINE", "layer": "0", "startPoint": {"x": 5, "y": 5}}]
        ok, rep, err = run(drawing(GOOD + bad))
        self.assertTrue(ok, err)

    def test_broken_viewport_keeps_sheet(self):
        frame = [{"type": "LINE", "layer": "0", "startPoint": {"x": 0, "y": 0}, "endPoint": {"x": 841, "y": 0}},
                 {"type": "LINE", "layer": "0", "startPoint": {"x": 841, "y": 0}, "endPoint": {"x": 841, "y": 594}},
                 {"type": "LINE", "layer": "0", "startPoint": {"x": 0, "y": 594}, "endPoint": {"x": 841, "y": 594}},
                 {"type": "VIEWPORT", "layer": "0", "viewportId": 1, "width": 841, "height": 594, "viewportCenter": {"x": 420, "y": 297}},
                 # no centre point at all
                 {"type": "VIEWPORT", "layer": "0", "viewportId": 2, "width": 400, "height": 300},
                 # a view height that is not a number
                 {"type": "VIEWPORT", "layer": "0", "viewportId": 3, "width": 400, "height": 300,
                  "viewportCenter": {"x": 300, "y": 300}, "viewHeight": "bad"}]
        lay = [{"layoutName": "A1", "paperSpaceTableId": "P1", "tabOrder": None}]
        ok, rep, err = run(drawing(GOOD, lay, frame))
        self.assertTrue(ok, err)
        self.assertEqual([p["name"] for p in rep["pages"]], ["A1"])

    def test_infinite_coordinates_ignored(self):
        far = [{"type": "LINE", "layer": "0", "startPoint": {"x": float("inf"), "y": 0}, "endPoint": {"x": 0, "y": 0}}]
        ok, rep, err = run(drawing(GOOD + far))
        self.assertTrue(ok, err)


if __name__ == "__main__":
    unittest.main()
