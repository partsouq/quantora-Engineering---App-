"""Render a DWG (already parsed to JSON by libredwg-web) to a vector PDF with real, selectable text.

Usage: python3 dwg2pdf.py drawing.json out.pdf [report.json]

One PDF page per paper layout that has content (the sheets as they are plotted, title block included).
If the drawing has no usable layouts, model space is drawn on one A1 page, fitted to the drawing.
Lines, arcs, circles, polylines, splines, ellipses, hatches, solids, blocks (with attributes and arrays),
dimensions and tables are drawn as vectors; TEXT / MTEXT / ATTRIB are real PDF text, so the take-off can
read tags, legends and schedules exactly as it does from a PDF exported from AutoCAD.
"""
import json, math, sys, re
import pymupdf
from ezdxf.colors import aci2rgb
from ezdxf.math import BSpline, fit_points_to_cad_cv, Vec3
from ezdxf.tools.text import plain_mtext

MM = 72 / 25.4
MAX_DEPTH = 12


# ---------------------------------------------------------------- geometry helpers
class M:
    """2D affine transform: (x, y) -> (a*x + c*y + e, b*x + d*y + f)."""
    __slots__ = ("a", "b", "c", "d", "e", "f")

    def __init__(self, a=1, b=0, c=0, d=1, e=0, f=0):
        self.a, self.b, self.c, self.d, self.e, self.f = a, b, c, d, e, f

    def __matmul__(self, o):  # self after o
        return M(self.a * o.a + self.c * o.b, self.b * o.a + self.d * o.b,
                 self.a * o.c + self.c * o.d, self.b * o.c + self.d * o.d,
                 self.a * o.e + self.c * o.f + self.e, self.b * o.e + self.d * o.f + self.f)

    def p(self, x, y):
        return (self.a * x + self.c * y + self.e, self.b * x + self.d * y + self.f)

    def scale(self):
        return math.sqrt(abs(self.a * self.d - self.b * self.c)) or 1.0

    def angle(self):
        return math.atan2(self.b, self.a)


def T(x, y): return M(1, 0, 0, 1, x, y)
def S(sx, sy): return M(sx, 0, 0, sy, 0, 0)
def R(t): return M(math.cos(t), math.sin(t), -math.sin(t), math.cos(t), 0, 0)


def P(pt):
    return (float(pt.get("x", 0) or 0), float(pt.get("y", 0) or 0)) if isinstance(pt, dict) else (0.0, 0.0)


def arc_pts(cx, cy, r, a0, a1, ccw=True):
    if ccw:
        while a1 <= a0: a1 += 2 * math.pi
    else:
        while a1 >= a0: a1 -= 2 * math.pi
    n = max(8, min(256, int(abs(a1 - a0) / (math.pi / 36)) + 1))
    return [(cx + r * math.cos(a0 + (a1 - a0) * i / n), cy + r * math.sin(a0 + (a1 - a0) * i / n)) for i in range(n + 1)]


def bulge_pts(p0, p1, b):
    if abs(b) < 1e-9: return [p1]
    (x0, y0), (x1, y1) = p0, p1
    dx, dy = x1 - x0, y1 - y0
    chord = math.hypot(dx, dy)
    if chord < 1e-12: return [p1]
    theta = 4 * math.atan(b)
    r = chord / (2 * math.sin(theta / 2))
    mx, my = (x0 + x1) / 2, (y0 + y1) / 2
    h = r * math.cos(theta / 2)
    nx, ny = -dy / chord, dx / chord
    cx, cy = mx + nx * h, my + ny * h
    a0 = math.atan2(y0 - cy, x0 - cx); a1 = math.atan2(y1 - cy, x1 - cx)
    return arc_pts(cx, cy, abs(r), a0, a1, ccw=b > 0)[1:]


def poly_pts(verts, closed):
    if not verts: return []
    out = [P(verts[0])]
    n = len(verts)
    for i in range(n - 1 + (1 if closed else 0)):
        v0, v1 = verts[i], verts[(i + 1) % n]
        out += bulge_pts(P(v0), P(v1), float(v0.get("bulge", 0) or 0))
    return out


# ---------------------------------------------------------------- the drawing
class Dwg:
    def __init__(self, d):
        self.d = d
        self.layers = {}
        for l in d.get("tables", {}).get("LAYER", {}).get("entries", []):
            self.layers[l.get("name")] = l
        self.blocks = {}
        for b in d.get("tables", {}).get("BLOCK_RECORD", {}).get("entries", []):
            self.blocks[b.get("name")] = b
        self.by_owner = {}
        for e in d.get("entities", []):
            self.by_owner.setdefault(e.get("ownerBlockRecordSoftId"), []).append(e)
        # block definitions carry their own entity lists
        for b in self.blocks.values():
            if isinstance(b.get("entities"), list) and b["entities"] and not b["name"].lower().startswith(("*model_space", "*paper_space")):
                self.by_owner[b.get("handle")] = b["entities"]
        self.model_handle = (self.blocks.get("*Model_Space") or {}).get("handle", "1F")
        self.layouts = [l for l in (d.get("objects", {}).get("LAYOUT") or []) if l.get("layoutName") != "Model"]
        # Older DWG versions have no plot flag and read back as "not plotted" on every layer.
        self.trust_plot_flag = any((l.get("plotFlag", 1) or 0) != 0 for l in self.layers.values())
        self.stats = {"drawn": 0, "text": 0, "skipped_types": {}}
        # linked drawings (XREF): their content is in another file that was not uploaded
        xref_handles = {b.get("handle") for b in self.blocks.values() if (int(b.get("flags") or 0) & 12)}
        self.stats["xref_blocks"] = len(xref_handles)
        self.stats["xref_inserts"] = sum(1 for e in d.get("entities", []) if e.get("type") == "INSERT" and (self.blocks.get(e.get("name")) or {}).get("handle") in xref_handles)
        self.stats["model_entities"] = len(self.by_owner.get(self.model_handle, []))

    def layer_visible(self, name):
        l = self.layers.get(name)
        if not l: return True
        if l.get("off") or l.get("frozen"): return False
        if self.trust_plot_flag and l.get("plotFlag", 1) == 0: return False
        return True

    def color(self, e, inherited):
        ci = e.get("colorIndex", 256)
        if e.get("color") not in (None, 0) and isinstance(e.get("color"), int) and ci not in (0, 256) and ci > 255:
            rgb = e["color"]; c = ((rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255)
        elif ci == 0:  # BYBLOCK
            return inherited
        elif ci == 256 or ci is None:  # BYLAYER
            l = self.layers.get(e.get("layer")) or {}
            lci = abs(int(l.get("colorIndex", 7) or 7))
            if e.get("layer") == "0" and inherited is not None: return inherited
            c = aci2rgb(lci) if 1 <= lci <= 255 else (0, 0, 0)
        else:
            c = aci2rgb(int(ci)) if 1 <= int(ci) <= 255 else (0, 0, 0)
        r, g, b = c
        # white / near-white plots black on paper
        lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
        if lum > 235 and max(r, g, b) - min(r, g, b) < 30: return (0, 0, 0)
        k = 1.0 if lum <= 140 else 140.0 / lum          # cyan / yellow / light grey would vanish on white paper
        return (r * k / 255, g * k / 255, b * k / 255)


# ---------------------------------------------------------------- rendering
class Painter:
    def __init__(self, page, to_page, clip=None):
        self.page, self.to_page, self.clip = page, to_page, clip
        self.shape = page.new_shape()
        self.n = 0

    def flush(self):
        self.shape.commit(overlay=True)
        self.shape = self.page.new_shape()

    def line(self, pts, color, width=0.3, closed=False, fill=None):
        if len(pts) < 2: return
        q = [pymupdf.Point(*self.to_page(*p)) for p in pts]
        if closed: q.append(q[0])
        self.shape.draw_polyline(q)
        self.shape.finish(color=color, fill=fill, width=width, closePath=closed and fill is not None, fill_opacity=0.35 if fill else 1)
        self.n += 1
        if self.n % 4000 == 0: self.flush()

    def text(self, x, y, s, h, ang, color):
        if not s or not s.strip(): return
        px, py = self.to_page(x, y)
        hp = h
        if hp < 0.6 or hp > 600: return
        if self.clip is not None and not self.clip.contains(pymupdf.Point(px, py)): return
        # text goes straight onto the sheet (never inside an embedded viewport picture), so it stays readable text
        target = getattr(self, "text_page", None) or self.page
        try:
            m = pymupdf.Matrix(-math.degrees(ang))
            pt = pymupdf.Point(px, py)
            target.insert_text(pt, s, fontsize=hp, fontname="helv", color=color, morph=(pt, m))
        except Exception:
            pass


def mtext_lines(raw):
    try:
        t = plain_mtext(raw, split=False)
    except Exception:
        t = re.sub(r"\\[A-Za-z][^;]*;|[{}]", "", raw).replace("\\P", "\n")
    return t.split("\n")


def draw_entities(dw, ents, mat, painter, ink, depth, layer_of_insert=None):
    if depth > MAX_DEPTH: return
    sc = mat.scale()
    for e in ents:
        t = e.get("type")
        lay = e.get("layer")
        if lay == "0" and layer_of_insert: lay_eff = layer_of_insert
        else: lay_eff = lay
        if not e.get("isVisible", True) or not dw.layer_visible(lay_eff): continue
        col = dw.color(e, ink)
        try:
            if t == "LINE":
                painter.line([mat.p(*P(e["startPoint"])), mat.p(*P(e["endPoint"]))], col)
            elif t == "LWPOLYLINE":
                closed = bool((e.get("flag") or 0) & 1)
                pts = [mat.p(*p) for p in poly_pts(e.get("vertices") or [], closed)]
                painter.line(pts, col, width=max(0.3, (e.get("constantWidth") or 0) * sc * painter_scale(painter)))
            elif t in ("POLYLINE2D", "POLYLINE3D", "POLYLINE"):
                closed = bool((e.get("flag") or 0) & 1)
                vs = [v for v in (e.get("vertices") or []) if not ((v.get("flag") or 0) & 16)]
                painter.line([mat.p(*p) for p in poly_pts(vs, closed)], col)
            elif t == "CIRCLE":
                cx, cy = P(e["center"]); r = float(e["radius"])
                painter.line([mat.p(*p) for p in arc_pts(cx, cy, r, 0, 2 * math.pi)], col)
            elif t == "ARC":
                cx, cy = P(e["center"]); r = float(e["radius"])
                a0, a1 = float(e["startAngle"]), float(e["endAngle"])
                if (e.get("extrusionDirection") or {}).get("z", 1) < 0:
                    cx = -cx; a0, a1 = math.pi - a1, math.pi - a0
                painter.line([mat.p(*p) for p in arc_pts(cx, cy, r, a0, a1)], col)
            elif t == "ELLIPSE":
                cx, cy = P(e["center"]); mx, my = P(e["majorAxisEndPoint"]); ratio = float(e.get("axisRatio", 1))
                a0, a1 = float(e.get("startAngle", 0)), float(e.get("endAngle", 2 * math.pi))
                while a1 <= a0: a1 += 2 * math.pi
                n = max(24, int((a1 - a0) / (math.pi / 48)))
                pts = []
                for i in range(n + 1):
                    u = a0 + (a1 - a0) * i / n
                    pts.append(mat.p(cx + mx * math.cos(u) - my * ratio * math.sin(u), cy + my * math.cos(u) + mx * ratio * math.sin(u)))
                painter.line(pts, col)
            elif t == "SPLINE":
                cps = [Vec3(p["x"], p["y"], 0) for p in (e.get("controlPoints") or [])]
                fps = [Vec3(p["x"], p["y"], 0) for p in (e.get("fitPoints") or [])]
                pts = []
                if len(cps) >= 2:
                    deg = int(e.get("degree") or 3); deg = min(deg, len(cps) - 1)
                    knots = e.get("knots") or None
                    try:
                        sp = BSpline(cps, order=deg + 1, knots=knots if knots and len(knots) == len(cps) + deg + 1 else None)
                    except Exception:
                        sp = BSpline(cps, order=deg + 1)
                    pts = [(v.x, v.y) for v in sp.approximate(max(16, len(cps) * 8))]
                elif len(fps) >= 2:
                    try:
                        sp = fit_points_to_cad_cv(fps)
                        pts = [(v.x, v.y) for v in sp.approximate(max(16, len(fps) * 8))]
                    except Exception:
                        pts = [(v.x, v.y) for v in fps]
                painter.line([mat.p(*p) for p in pts], col)
            elif t in ("SOLID", "TRACE", "3DFACE"):
                cs = [P(e.get(k)) for k in ("corner1", "corner2", "corner4", "corner3") if e.get(k)]
                if t == "3DFACE": cs = [P(e.get(k)) for k in ("corner1", "corner2", "corner3", "corner4") if e.get(k)]
                painter.line([mat.p(*p) for p in cs], col, closed=True, fill=col if t != "3DFACE" else None)
            elif t == "HATCH":
                solid = bool(e.get("solidFill"))
                for bp in e.get("boundaryPaths") or []:
                    pts = []
                    if bp.get("vertices"):
                        pts = poly_pts(bp["vertices"], True)
                    for ed in bp.get("edges") or []:
                        et = ed.get("type")
                        if et == 1:
                            pts += [P(ed["start"]), P(ed["end"])]
                        elif et == 2:
                            cx, cy = P(ed["center"]); r = float(ed["radius"])
                            a0, a1 = float(ed.get("startAngle", 0)), float(ed.get("endAngle", 0))
                            ccw = bool(ed.get("isCCW", ed.get("counterClockWiseFlag", 1)))
                            if not ccw: a0, a1 = -a0, -a1
                            pts += arc_pts(cx, cy, r, a0, a1, ccw)
                        elif et == 3:
                            cx, cy = P(ed["center"]); mx, my = P(ed.get("end") or ed.get("majorAxisEndPoint") or {})
                            ratio = float(ed.get("lengthOfMinorAxis", ed.get("axisRatio", 1)) or 1)
                            a0, a1 = float(ed.get("startAngle", 0)), float(ed.get("endAngle", 2 * math.pi))
                            while a1 <= a0: a1 += 2 * math.pi
                            for i in range(33):
                                u = a0 + (a1 - a0) * i / 32
                                pts.append((cx + mx * math.cos(u) - my * ratio * math.sin(u), cy + my * math.cos(u) + mx * ratio * math.sin(u)))
                        elif et == 4:
                            cps = [Vec3(p["x"], p["y"], 0) for p in (ed.get("controlPoints") or [])]
                            if len(cps) >= 2:
                                deg = min(int(ed.get("degree") or 3), len(cps) - 1)
                                pts += [(v.x, v.y) for v in BSpline(cps, order=deg + 1).approximate(len(cps) * 6)]
                    if len(pts) >= 3:
                        q = [mat.p(*p) for p in pts]
                        if solid:
                            painter.line(q, col, closed=True, fill=col)
                        else:
                            # patterned hatch: outline plus a faint tint, so the area reads as hatched
                            painter.line(q, col, width=0.2, closed=True, fill=tuple(0.6 + 0.4 * c for c in col))
            elif t == "TEXT":
                x, y = P(e.get("startPoint"))
                if (e.get("halign") or e.get("valign")) and e.get("endPoint") and P(e["endPoint"]) != (0.0, 0.0):
                    x, y = P(e["endPoint"])
                    h = float(e.get("textHeight") or 2.5)
                    x -= len(e.get("text", "")) * h * 0.5 * (0.5 if e.get("halign") in (1, 4) else 1 if e.get("halign") == 2 else 0)
                _text(painter, mat, x, y, e.get("text", ""), float(e.get("textHeight") or 2.5), float(e.get("rotation") or 0), col, dw)
            elif t == "MTEXT":
                x, y = P(e.get("insertionPoint")); h = float(e.get("textHeight") or 2.5)
                ang = float(e.get("rotation") or 0)
                dx, dy = P(e.get("direction") or {})
                if (dx or dy) and not ang: ang = math.atan2(dy, dx)
                lines = mtext_lines(e.get("text", ""))
                ap = int(e.get("attachmentPoint") or 1)
                tot = len(lines) * h * 1.67 * float(e.get("lineSpacing") or 1)
                yoff = -h if ap in (1, 2, 3) else (tot / 2 - h if ap in (4, 5, 6) else tot - h)
                for i, ln in enumerate(lines):
                    ox = -math.sin(ang) * (yoff - i * h * 1.67); oy = math.cos(ang) * (yoff - i * h * 1.67)
                    _text(painter, mat, x + ox, y + oy, ln, h, ang, col, dw)
            elif t in ("ATTRIB", "ATTDEF"):
                if t == "ATTDEF": continue  # definitions show only through their ATTRIBs
                tx = e.get("text") or {}
                if (e.get("flags") or 0) & 1: continue  # invisible
                x, y = P(tx.get("startPoint"))
                if (tx.get("halign") or tx.get("valign")) and P(e.get("alignmentPoint") or {}) != (0.0, 0.0):
                    x, y = P(e["alignmentPoint"])
                _text(painter, mat, x, y, tx.get("text", ""), float(tx.get("textHeight") or 2.5), float(tx.get("rotation") or 0), col, dw)
            elif t == "INSERT":
                b = dw.blocks.get(e.get("name"))
                if not b: continue
                bx, by = P(b.get("basePoint"))
                ix, iy = P(e.get("insertionPoint"))
                sx, sy = float(e.get("xScale") or 1), float(e.get("yScale") or 1)
                if (e.get("extrusionDirection") or {}).get("z", 1) < 0: ix = -ix; sx = -sx
                rot = float(e.get("rotation") or 0)
                cols, rows = max(1, int(e.get("columnCount") or 1)), max(1, int(e.get("rowCount") or 1))
                cs, rs = float(e.get("columnSpacing") or 0), float(e.get("rowSpacing") or 0)
                kids = dw.by_owner.get(b.get("handle"), [])
                for r_ in range(rows):
                    for c_ in range(cols):
                        local = T(ix, iy) @ R(rot) @ T(c_ * cs / (sx or 1), r_ * rs / (sy or 1)) @ S(sx, sy) @ T(-bx, -by)
                        draw_entities(dw, kids, mat @ local, painter, col, depth + 1, lay_eff)
                for a in e.get("attribs") or []:
                    draw_entities(dw, [a], mat, painter, col, depth + 1, lay_eff)
            elif t in ("DIMENSION", "ACAD_TABLE"):
                b = dw.blocks.get(e.get("name")) if e.get("name") else None
                if not b and t == "ACAD_TABLE": b = dw.blocks.get(e.get("blockRecordName") or "")
                if b:
                    ix, iy = P(e.get("insertionPoint") or {}) if t == "ACAD_TABLE" else (0.0, 0.0)
                    draw_entities(dw, dw.by_owner.get(b.get("handle"), []), mat @ T(ix, iy), painter, col, depth + 1, lay_eff)
            elif t == "LEADER":
                painter.line([mat.p(*P(v)) for v in (e.get("vertices") or [])], col)
            elif t == "MULTILEADER":
                # leader lines: start point(s) -> landing point; then the label text or the tag block
                for sec in e.get("leaderSections") or []:
                    land = P(sec.get("lastLeaderLinePoint") or {})
                    for ll in sec.get("leaderLines") or []:
                        pts = [P(v) for v in (ll.get("vertices") or [])] + [land]
                        painter.line([mat.p(*q) for q in pts], col)
                    dv = P(sec.get("doglegVector") or {}); dl = float(sec.get("doglegLength") or 0)
                    if dl and (dv[0] or dv[1]):
                        painter.line([mat.p(*land), mat.p(land[0] + dv[0] * dl, land[1] + dv[1] * dl)], col)
                if e.get("hasMText") and e.get("textContent"):
                    x, y = P(e.get("textAnchor") or e.get("contentBasePosition") or {})
                    h = float(e.get("textHeight") or 2.5) * float(e.get("contentScale") or 1)
                    ang = float(e.get("textRotation") or 0)
                    dx, dy = P(e.get("textDirection") or {})
                    if (dx or dy) and not ang: ang = math.atan2(dy, dx)
                    for i, ln in enumerate(mtext_lines(e["textContent"])):
                        off = h + i * h * 1.67
                        _text(painter, mat, x + math.sin(ang) * off, y - math.cos(ang) * off, ln, h, ang, col, dw)
                if e.get("hasBlock"):
                    bid = e.get("blockContentId") or e.get("blockRecordId") or e.get("blockContentBlockId")
                    b = next((bb for bb in dw.blocks.values() if bb.get("handle") == bid), None) if bid else None
                    if b:
                        bx, by = P(b.get("basePoint"))
                        ix, iy = P(e.get("blockContentPosition") or e.get("contentBasePosition") or {})
                        sc_ = e.get("blockContentScale") or {}
                        local = T(ix, iy) @ R(float(e.get("blockContentRotation") or 0)) @ S(float(sc_.get("x") or 1), float(sc_.get("y") or 1)) @ T(-bx, -by)
                        draw_entities(dw, dw.by_owner.get(b.get("handle"), []), mat @ local, painter, col, depth + 1, lay_eff)
            elif t in ("VIEWPORT", "POINT", "XLINE", "RAY", "WIPEOUT", "3DSOLID", "REGION", "BODY", "IMAGE", "OLE2FRAME", "MLINE", "TOLERANCE", "HELIX", "MESH", "PROXY"):
                dw.stats["skipped_types"][t] = dw.stats["skipped_types"].get(t, 0) + 1
                continue
            else:
                dw.stats["skipped_types"][t] = dw.stats["skipped_types"].get(t, 0) + 1
                continue
            dw.stats["drawn"] += 1
        except Exception as ex:  # one bad entity never stops the sheet
            dw.stats["skipped_types"]["error:" + str(t)] = dw.stats["skipped_types"].get("error:" + str(t), 0) + 1


def painter_scale(painter):
    return getattr(painter, "unit_scale", 1.0)


def _text(painter, mat, x, y, s, h, rot, col, dw):
    px, py = mat.p(x, y)
    hp = h * mat.scale() * painter.unit_scale
    painter.text(px, py, s, hp, rot + mat.angle(), col)
    dw.stats["text"] += 1


# ---------------------------------------------------------------- extents
def collect_points(dw, ents, mat, out, depth=0, cap=400000):
    if depth > 6 or len(out) > cap: return
    for e in ents:
        try:
            _collect_one(dw, e, mat, out, depth, cap)
        except Exception:  # one bad object never stops the sheet (2026-11-11: whole DWGs failed on one)
            continue


def _collect_one(dw, e, mat, out, depth, cap):
    t = e.get("type")
    if not dw.layer_visible(e.get("layer")): return
    if t == "LINE":
        out.append(mat.p(*P(e["startPoint"]))); out.append(mat.p(*P(e["endPoint"])))
    elif t in ("LWPOLYLINE", "POLYLINE2D", "POLYLINE3D", "LEADER"):
        for v in (e.get("vertices") or [])[:200]: out.append(mat.p(*P(v)))
    elif t in ("CIRCLE", "ARC", "ELLIPSE"):
        out.append(mat.p(*P(e["center"])))
    elif t == "TEXT":
        out.append(mat.p(*P(e.get("startPoint"))))
    elif t == "MTEXT":
        out.append(mat.p(*P(e.get("insertionPoint"))))
    elif t == "INSERT":
        b = dw.blocks.get(e.get("name"))
        ip = P(e.get("insertionPoint"))
        if b and depth < 2:
            bx, by = P(b.get("basePoint"))
            local = T(*ip) @ R(float(e.get("rotation") or 0)) @ S(float(e.get("xScale") or 1), float(e.get("yScale") or 1)) @ T(-bx, -by)
            collect_points(dw, dw.by_owner.get(b.get("handle"), [])[:400], mat @ local, out, depth + 1, cap)
        else:
            out.append(mat.p(*ip))


def robust_box(pts):
    """The drawing's real extent. Stray objects far away (a block left at a huge coordinate, a
    construction point) would otherwise shrink the whole plan to a dot, so points beyond a wide fence
    around the middle half of the drawing are ignored, as long as they are only a small share."""
    if not pts: return None
    xs = sorted(p[0] for p in pts); ys = sorted(p[1] for p in pts)
    n = len(xs)

    def fence(v):
        q1, q3 = v[n // 4], v[(3 * n) // 4]
        iqr = q3 - q1
        if iqr <= 0: return v[0], v[-1]
        lo, hi = q1 - 6 * iqr, q3 + 6 * iqr
        keep = [a for a in v if lo <= a <= hi]
        if len(keep) < n * 0.9: return v[0], v[-1]      # many far points: they are real content
        return keep[0], keep[-1]

    x0, x1 = fence(xs); y0, y1 = fence(ys)
    if x1 - x0 <= 0 or y1 - y0 <= 0: return None
    return x0, y0, x1, y1


# ---------------------------------------------------------------- pages
def model_page(doc, dw, report):
    ents = dw.by_owner.get(dw.model_handle, [])
    pts = []; collect_points(dw, ents, M(), pts)
    box = robust_box(pts)
    if not box: return False
    x0, y0, x1, y1 = box
    w, h = x1 - x0, y1 - y0
    long_mm = 841.0  # A1
    if w >= h: pw, ph = long_mm, max(200.0, long_mm * h / w)
    else: ph, pw = long_mm, max(200.0, long_mm * w / h)
    margin = 10.0
    s = min((pw - 2 * margin) / w, (ph - 2 * margin) / h)  # mm per drawing unit
    page = doc.new_page(width=pw * MM, height=ph * MM)
    ox = margin + ((pw - 2 * margin) - w * s) / 2; oy = margin + ((ph - 2 * margin) - h * s) / 2
    to_page = lambda x, y: ((ox + (x - x0) * s) * MM, (ph - (oy + (y - y0) * s)) * MM)
    p = Painter(page, to_page); p.unit_scale = s * MM
    draw_entities(dw, ents, M(), p, (0, 0, 0), 0)
    p.flush()
    report["pages"].append({"name": "Model", "width_mm": round(pw), "height_mm": round(ph), "mm_per_unit": s})
    return True


def _vp_ok(v):
    """A viewport we can place: a centre and a real, finite size."""
    try:
        w, h = float(v.get("width") or 0), float(v.get("height") or 0)
        return isinstance(v.get("viewportCenter"), dict) and w > 1e-6 and h > 1e-6 and math.isfinite(w) and math.isfinite(h)
    except (TypeError, ValueError):
        return False


def _draw_viewport(dw, page, v, to_page, u):
    """Model space seen through one viewport, clipped to the viewport frame."""
    cx, cy = P(v["viewportCenter"]); vw, vh = float(v["width"]), float(v["height"])
    vc = P(v.get("displayCenter") or v.get("viewCenter") or {})
    zoom = vh / float(v.get("viewHeight") or vh or 1)
    twist = float(v.get("twistAngle") or v.get("viewTwistAngle") or 0)
    m = T(cx, cy) @ R(twist) @ S(zoom, zoom) @ T(-vc[0], -vc[1])
    r0 = to_page(cx - vw / 2, cy + vh / 2); r1 = to_page(cx + vw / 2, cy - vh / 2)
    clip = pymupdf.Rect(r0, r1)
    if clip.is_empty or clip.is_infinite: raise ValueError("empty viewport frame")
    sub = pymupdf.open(); sp = sub.new_page(width=page.rect.width, height=page.rect.height)
    pv = Painter(sp, to_page, clip=clip); pv.unit_scale = u * MM; pv.text_page = page
    frozen = set(v.get("frozenLayerIds") or [])
    before = dw.stats["drawn"]
    try:
        draw_entities(dw, dw.by_owner.get(dw.model_handle, []), m, pv, (0, 0, 0), 0)
        pv.flush()
    except Exception:
        sub.close(); raise
    # how much of the model really lands inside this viewport's frame
    mp = []; collect_points(dw, dw.by_owner.get(dw.model_handle, []), M(), mp, cap=50000)
    inside = sum(1 for q in mp if clip.contains(pymupdf.Point(*to_page(*m.p(*q)))))
    dw.stats.setdefault("viewports", []).append({"drawn": dw.stats["drawn"] - before, "model_points": len(mp), "inside": inside})
    try:
        page.show_pdf_page(clip, sub, 0, clip=clip)
    finally:
        sub.close()


def layout_pages(doc, dw, report):
    made = 0
    imperial = int(dw.d.get("header", {}).get("MEASUREMENT", 1) or 0) == 0
    unit_mm = 25.4 if imperial else 1.0
    for lay in sorted(dw.layouts, key=lambda l: l.get("tabOrder", 0)):
        bh = lay.get("paperSpaceTableId")
        ents = dw.by_owner.get(bh, [])
        vps = [e for e in ents if e.get("type") == "VIEWPORT" and (e.get("status") or 0) >= 0]
        main_ids = {min((v.get("viewportId") or 0) for v in vps)} if vps else set()
        content_vps = [v for v in vps if (v.get("viewportId") or 0) not in main_ids and (v.get("width") or 0) > 0]
        paper_ents = [e for e in ents if e.get("type") != "VIEWPORT"]
        if not content_vps and len(paper_ents) < 3: continue
        pts = []; collect_points(dw, paper_ents, M(), pts)
        content_vps = [v for v in content_vps if _vp_ok(v)]
        for v in content_vps:
            cx, cy = P(v["viewportCenter"]); w2, h2 = v["width"] / 2, v["height"] / 2
            pts += [(cx - w2, cy - h2), (cx + w2, cy + h2)]
        lo, hi = lay.get("minLimit") or {}, lay.get("maxLimit") or {}
        if lo and hi and (hi.get("x", 0) - lo.get("x", 0)) > 0:
            pts += [P(lo), P(hi)]
        box = robust_box(pts)
        if not box: continue
        x0, y0, x1, y1 = box
        pw, ph = (x1 - x0) * unit_mm, (y1 - y0) * unit_mm
        k = 1.0
        if max(pw, ph) < 280: k = 420.0 / max(pw, ph)  # tiny paper units: lift to A3
        if max(pw, ph) * k > 1500: k = 1189.0 / max(pw, ph)
        pw, ph = pw * k, ph * k
        page = doc.new_page(width=pw * MM, height=ph * MM)
        u = unit_mm * k  # mm per paper unit
        to_page = lambda x, y, x0=x0, y0=y0, u=u, ph=ph: ((x - x0) * u * MM, (ph - (y - y0) * u) * MM)
        # model space seen through each viewport, clipped to the viewport frame
        for v in content_vps:
            try:
                _draw_viewport(dw, page, v, to_page, u)
            except Exception as ex:  # a broken viewport is skipped; the rest of the sheet is still drawn
                key = "error:VIEWPORT:" + type(ex).__name__   # the error type only, never its text
                dw.stats["skipped_types"][key] = dw.stats["skipped_types"].get(key, 0) + 1
        p = Painter(page, to_page); p.unit_scale = u * MM
        draw_entities(dw, paper_ents, M(), p, (0, 0, 0), 0)
        p.flush()
        report["pages"].append({"name": lay.get("layoutName"), "width_mm": round(pw), "height_mm": round(ph), "viewports": len(content_vps)})
        made += 1
    return made


def plan_missing_from_sheets(dw):
    """True when model space has content but none of it landed inside any drawn viewport frame."""
    if not dw.by_owner.get(dw.model_handle):
        return False
    return not any((v.get("inside") or 0) > 0 for v in dw.stats.get("viewports", []))


def main():
    src, out = sys.argv[1], sys.argv[2]
    d = json.load(open(src))
    dw = Dwg(d)
    report = {"pages": []}
    doc = pymupdf.open()
    try:
        made = layout_pages(doc, dw, report)
    except Exception:  # the sheets could not be laid out: draw model space instead of failing the file
        doc.close(); doc = pymupdf.open(); report = {"pages": []}; made = 0
        dw.stats["skipped_types"]["error:LAYOUT"] = 1
    if not made:
        model_page(doc, dw, report)
    elif plan_missing_from_sheets(dw):
        # 2026-11-11: sheets came out as a title-block strip with the plan outside every viewport frame.
        # The plan must never be silently lost: draw model space as its own page, first.
        if model_page(doc, dw, report):
            doc.move_page(doc.page_count - 1, 0)
            report["pages"].insert(0, report["pages"].pop())
            dw.stats["model_fallback"] = True
    if doc.page_count == 0:
        only3d = all(e.get("type") in ("3DSOLID", "REGION", "BODY", "MESH", "SURFACE", "POLYLINE3D", "MTEXT", "VIEWPORT") for e in dw.d.get("entities", []))
        raise SystemExit("This DWG holds a 3D model with no 2D plan to read." if only3d else "This DWG has no drawing content to read.")
    doc.save(out, garbage=3, deflate=True)
    report.update(dw.stats)
    if len(sys.argv) > 4:
        try:  # small preview of sheet 1 (about 1000 px wide) for the admin check
            pg = doc[0]
            z = 1000 / max(pg.rect.width, pg.rect.height)
            doc[0].get_pixmap(matrix=pymupdf.Matrix(z, z)).save(sys.argv[4], jpg_quality=70)
        except Exception:
            pass
    if len(sys.argv) > 3: json.dump(report, open(sys.argv[3], "w"))
    else: print(json.dumps(report))


if __name__ == "__main__":
    main()
