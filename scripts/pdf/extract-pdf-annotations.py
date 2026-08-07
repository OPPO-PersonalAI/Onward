#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
"""
Extract the highlights and notes Onward writes into a PDF.

Onward stores highlight annotations inside the PDF file itself, using the same
on-disk format as the Dark_PDF_Reader reference project: a standard
/Highlight annotation plus a set of private keys. This script reads them back
out as structured records, so a document can be processed outside the app.

Each highlight yields:
  color            highlight colour (hex, e.g. #f2c14e)
  label            label name (e.g. "Key claim")
  highlightedText  the text that was highlighted
  note             the user's note, or an empty string
  createdAt / updatedAt (+ISO)  timestamps
  page / id        page number / stable id

Identification: a standard /Highlight annotation carrying the private keys
  /CYY_MARK, /CYY_MARK_Label, /CYY_MARK_Id, /CYY_MARK_Data (JSON)
with the note mirrored into /Contents. The private keys are deliberately the
reference project's, not Onward-specific, so both tools read and write the
same bytes.

Usage:
  python3 extract-pdf-annotations.py <file.pdf>                # human readable
  python3 extract-pdf-annotations.py <file.pdf> --json         # JSON
  python3 extract-pdf-annotations.py <file.pdf> --engine fitz  # via PyMuPDF

Requires pypdf (default) or PyMuPDF.
"""
import sys
import os
import json
import pathlib
import argparse
import datetime

MARK_KEY = "CYY_MARK"
APP_ID = "DarkPDFReader"


def _s(v):
    if v is None:
        return None
    try:
        return str(v)
    except Exception:
        return None


def _rgb01_to_hex(arr):
    if not arr or len(arr) < 3:
        return None
    try:
        return "#" + "".join("{:02x}".format(max(0, min(255, round(float(c) * 255)))) for c in arr[:3])
    except Exception:
        return None


def _iso(ms):
    if not isinstance(ms, (int, float)):
        return None
    try:
        return datetime.datetime.utcfromtimestamp(ms / 1000).strftime("%Y-%m-%dT%H:%M:%SZ")
    except Exception:
        return None


def _try_json(text):
    if not text:
        return None
    try:
        return json.loads(text)
    except Exception:
        return None


def _record(page_num, label, note, color_c_hex, data):
    """Merge the standard keys and the CYY_MARK_Data JSON into one clean record."""
    d = data or {}
    color = d.get("color") or color_c_hex
    rec = {
        "page": d.get("page", page_num),
        "color": color,
        "label": d.get("labelName") or label,
        "highlightedText": d.get("textSnapshot"),
        "note": (d.get("note") if d.get("note") is not None else note) or "",
        "createdAt": d.get("createdAt"),
        "updatedAt": d.get("updatedAt"),
        "createdAtISO": _iso(d.get("createdAt")),
        "updatedAtISO": _iso(d.get("updatedAt")),
        "id": d.get("id"),
    }
    return rec


# ---------------- pypdf ----------------
def extract_with_pypdf(path):
    from pypdf import PdfReader

    reader = PdfReader(path)
    out = []
    for page_index, page in enumerate(reader.pages):
        annots = page.get("/Annots")
        if not annots:
            continue
        for ref in annots:
            a = ref.get_object()
            if a.get("/Subtype") != "/Highlight" or ("/" + MARK_KEY) not in a:
                continue
            color_c = None
            if a.get("/C"):
                try:
                    color_c = _rgb01_to_hex([float(x) for x in a.get("/C")])
                except Exception:
                    color_c = None
            data = _try_json(_s(a.get("/" + MARK_KEY + "_Data")))
            out.append(_record(page_index + 1, _s(a.get("/" + MARK_KEY + "_Label")),
                               _s(a.get("/Contents")), color_c, data))

    manifest = None
    try:
        for name, blobs in reader.attachments.items():
            if MARK_KEY + "-manifest" in name and blobs:
                manifest = json.loads(blobs[0].decode("utf-8"))
                break
    except Exception:
        manifest = None
    return out, manifest


# ---------------- PyMuPDF ----------------
def extract_with_fitz(path):
    import pymupdf  # formerly named fitz

    doc = pymupdf.open(path)
    out = []
    for page in doc:
        for a in page.annots(types=[pymupdf.PDF_ANNOT_HIGHLIGHT]):
            typ, _mark = doc.xref_get_key(a.xref, MARK_KEY)
            if typ == "null":
                continue
            color_c = _rgb01_to_hex((a.colors or {}).get("stroke"))
            _, data_raw = doc.xref_get_key(a.xref, MARK_KEY + "_Data")
            _, label_raw = doc.xref_get_key(a.xref, MARK_KEY + "_Label")
            data = _try_json(_decode_pdf_str(data_raw))
            out.append(_record(a.page.number + 1, _decode_pdf_str(label_raw),
                               a.info.get("content"), color_c, data))
    manifest = None
    try:
        for name in doc.embfile_names():
            if MARK_KEY + "-manifest" in name:
                manifest = json.loads(doc.embfile_get(name).decode("utf-8"))
                break
    except Exception:
        manifest = None
    return out, manifest


def _decode_pdf_str(raw):
    if raw is None:
        return None
    raw = raw.strip()
    if raw.startswith("(") and raw.endswith(")"):
        return raw[1:-1]
    return raw


def _save_json(pdf_path, result, count):
    """Write JSON next to the PDF as <name>_CYY_NOTES_<YYYYMMDD-HHMMSS>_<count>_Notes.json."""
    p = pathlib.Path(pdf_path)
    ts = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    out = p.parent / f"{p.stem}_CYY_NOTES_{ts}_{count}_Notes.json"
    out.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return str(out)


def _print_human(highlights):
    print(f"Found {len(highlights)} highlight(s):\n")
    for i, h in enumerate(highlights, 1):
        print(f"[{i}] page {h['page']} · {h['color']} [{h['label']}]")
        if h.get("highlightedText"):
            print(f"    text: {h['highlightedText']}")
        if h.get("note"):
            print(f"    note: {h['note']}")
        if h.get("createdAtISO"):
            print(f"    time: {h['createdAtISO']}")
        print()


def main():
    ap = argparse.ArgumentParser(description="Extract highlights and notes from a PDF")
    ap.add_argument("pdf")
    ap.add_argument("--engine", choices=["pypdf", "fitz"], default="pypdf")
    ap.add_argument("--json", action="store_true", help="write JSON to stdout")
    ap.add_argument("--save", action="store_true", help="save JSON next to the PDF with a generated name")
    args = ap.parse_args()

    highlights, manifest = (extract_with_fitz if args.engine == "fitz" else extract_with_pypdf)(args.pdf)
    result = {
        "source": os.path.abspath(args.pdf),
        "exportedAt": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
        "highlightCount": len(highlights),
        "highlights": highlights,
        "labelPalette": (manifest or {}).get("labels"),
    }

    saved_path = None
    if args.save:
        if highlights:
            saved_path = _save_json(args.pdf, result, len(highlights))
        else:
            print("No highlights found; nothing saved.", file=sys.stderr)

    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        _print_human(highlights)

    if saved_path:
        # Path goes to stderr so it never contaminates JSON on stdout.
        print(f"Saved: {saved_path}", file=sys.stderr)


if __name__ == "__main__":
    main()
