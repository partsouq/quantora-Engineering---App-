// node --test tools/dwg/fail-reason.test.mjs  (no install needed)
import test from "node:test";
import assert from "node:assert/strict";
import { failReason } from "./fail-reason.mjs";

test("a crash keeps only the error type and the script line", () => {
  const err = `Traceback (most recent call last):
  File "/x/tools/dwg/dwg2pdf.py", line 560, in <module>
    main()
  File "/x/tools/dwg/dwg2pdf.py", line 401, in collect_points
    out.append(mat.p(*P(e["startPoint"])))
KeyError: 'startPoint'`;
  assert.equal(failReason(err), " (KeyError at dwg2pdf.py:401)");
});

test("the error text itself is never passed on (it can hold drawing content)", () => {
  const r = failReason(`  File "/x/dwg2pdf.py", line 9, in f\nValueError: layer SECRET-CLIENT-NAME not found`);
  assert.equal(r, " (ValueError at dwg2pdf.py:9)");
  assert.ok(!r.includes("SECRET"));
});

test("a plain reason given on purpose is passed on", () => {
  assert.equal(failReason("This DWG has no drawing content to read.\n"), ": This DWG has no drawing content to read.");
});

test("nothing on stderr adds nothing", () => {
  assert.equal(failReason(""), "");
  assert.equal(failReason(undefined), "");
});
