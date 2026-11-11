"""One bad object or one broken viewport must not fail a whole DWG (2026-11-11: 8 sheets of one
upload failed with "Drawing the DWG failed"). Run: pip install ezdxf==1.4.4 pymupdf==1.28.2 pytest;
python3 -m pytest tools/dwg/test_dwg2pdf.py"""
import json, os, subprocess, sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))


def line(a, b, c, d, owner="1F"):
    return {"type": "LINE", "layer": "0", "ownerBlockRecordSoftId": owner,
            "startPoint": {"x": a, "y": b}, "endPoint": {"x": c, "y": d}}


def drawing(ents, layouts=None):
    return {"header": {"MEASUREMENT": 1},
            "tables": {"LAYER": {"entries": [{"name": "0", "colorIndex": 7}]},
                       "BLOCK_RECORD": {"entries": [{"name": "*Model_Space", "handle": "1F"},
                                                    {"name": "*Paper_Space", "handle": "PS"}]}},
            "objects": {"LAYOUT": layouts or []}, "entities": ents}


def sheet(extra_viewport):
    paper = [line(0, 0, 30, 30, "PS"), line(1, 1, 2, 2, "PS"), line(3, 3, 4, 4, "PS"),
             {"type": "VIEWPORT", "ownerBlockRecordSoftId": "PS", "viewportId": 1, "width": 400, "height": 300,
              "viewportCenter": {"x": 200, "y": 150}},
             dict({"type": "VIEWPORT", "ownerBlockRecordSoftId": "PS", "viewportId": 3}, **extra_viewport),
             {"type": "VIEWPORT", "ownerBlockRecordSoftId": "PS", "viewportId": 2, "width": 200, "height": 100,
              "viewportCenter": {"x": 150, "y": 100}, "viewHeight": 60, "viewCenter": {"x": 50, "y": 25}}]
    return drawing([line(0, 0, 100, 50), line(10, 10, 20, 40)] + paper,
                   [{"layoutName": "Sheet 1", "paperSpaceTableId": "PS",
                     "minLimit": {"x": 0, "y": 0}, "maxLimit": {"x": 420, "y": 297}}])


def run(tmp_path, d):
    src, pdf, rep = tmp_path / "in.json", tmp_path / "out.pdf", tmp_path / "rep.json"
    src.write_text(json.dumps(d))
    r = subprocess.run([sys.executable, os.path.join(HERE, "dwg2pdf.py"), str(src), str(pdf), str(rep)],
                       capture_output=True, text=True)
    assert r.returncode == 0, r.stderr[-400:]
    assert pdf.exists()
    return json.loads(rep.read_text())


def test_object_without_points_is_skipped(tmp_path):
    bad = {"type": "LINE", "layer": "0", "ownerBlockRecordSoftId": "1F", "endPoint": {"x": 1, "y": 1}}
    rep = run(tmp_path, drawing([line(0, 0, 100, 50), line(10, 10, 20, 40), bad]))
    assert len(rep["pages"]) == 1 and rep["drawn"] == 2


@pytest.mark.parametrize("vp", [
    {"width": 1e-9, "height": 0, "viewportCenter": {"x": 10, "y": 10}, "viewHeight": 0},  # zero-size frame
    {"width": 100, "height": 100},                                                          # no centre
    {"width": 100, "height": 100, "viewportCenter": {"x": 50, "y": 50}, "viewHeight": "x"}, # unreadable zoom
])
def test_broken_viewport_does_not_lose_the_sheet(tmp_path, vp):
    rep = run(tmp_path, sheet(vp))
    assert [p["name"] for p in rep["pages"]] == ["Sheet 1"]
    assert rep["drawn"] >= 3  # paper lines (and the good viewport) are still drawn


def test_good_sheet_unchanged(tmp_path):
    rep = run(tmp_path, sheet({"width": 100, "height": 80, "viewportCenter": {"x": 300, "y": 200}}))
    assert rep["pages"][0]["viewports"] == 2
    assert "error:VIEWPORT" not in rep["skipped_types"]
