#!/usr/bin/env python3
"""Read-only structural AEO audit for local HTML or an HTTP(S) URL."""
from __future__ import annotations

import argparse
import json
import re
import sys
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin


class PageParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.title = ""
        self.headings = []
        self.links = []
        self.jsonld = []
        self.visible = []
        self._stack = []
        self._heading = None
        self._title_buf = None
        self._script_buf = None
        self.meta = []
        self.canonical = None

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag not in {"meta", "link", "br", "img", "input", "hr"}:
            self._stack.append(tag)
        if tag in {"h1", "h2", "h3", "h4", "h5", "h6"}:
            heading = {"level": int(tag[1]), "text": "", "question": False}
            self.headings.append(heading)
            self._heading = (tag, heading, [])
        elif tag == "title":
            self._title_buf = []
        elif tag == "a" and attrs.get("href"):
            self.links.append(attrs["href"])
        elif tag == "link" and (attrs.get("rel") or "").lower() == "canonical":
            self.canonical = attrs.get("href")
        elif tag == "meta":
            self.meta.append(attrs)
        elif tag == "script" and attrs.get("type", "").lower() == "application/ld+json":
            self._script_buf = []

    def handle_data(self, data):
        if "script" in self._stack:
            if self._script_buf is not None:
                self._script_buf.append(data)
        elif any(tag in self._stack for tag in {"style", "noscript", "template"}):
            return
        elif self._title_buf is not None:
            self._title_buf.append(data)
        else:
            if self._heading is not None:
                self._heading[2].append(data)
            if "head" not in self._stack:
                self.visible.append(data)

    def handle_endtag(self, tag):
        if tag == "title" and self._title_buf is not None:
            self.title = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", "".join(self._title_buf))).strip()
            self._title_buf = None
        elif self._heading is not None and tag == self._heading[0]:
            text = re.sub(r"\s+", " ", "".join(self._heading[2])).strip()
            self._heading[1]["text"] = text
            self._heading[1]["question"] = text.endswith("?")
            self._heading = None
        elif tag == "script" and self._script_buf is not None:
            raw = "".join(self._script_buf).strip()
            try:
                self.jsonld.append(json.loads(raw))
            except json.JSONDecodeError:
                self.jsonld.append({"_parse_error": True, "raw_prefix": raw[:120]})
            self._script_buf = None
        if tag in self._stack:
            del self._stack[len(self._stack) - 1 - self._stack[::-1].index(tag):]


def load(source: str) -> tuple[str, str]:
    if source.startswith(("http://", "https://")):
        raise ValueError("direct remote URL disabled; use optbrew audit with a scope context")
    return Path(source).read_text(encoding="utf-8"), Path(source).resolve().as_uri()


def audit(source: str) -> dict:
    html, final_url = load(source)
    return audit_html(html, source, final_url)


def audit_html(html: str, source: str, final_url: str | None = None) -> dict:
    final_url = final_url or source
    parser = PageParser()
    parser.feed(html)
    visible = re.sub(r"\s+", " ", " ".join(parser.visible)).strip()
    robots = next((m.get("content", "") for m in parser.meta if (m.get("name") or "").lower() == "robots"), "")
    types = []
    parse_errors = 0
    for block in parser.jsonld:
        if isinstance(block, dict) and block.get("_parse_error"):
            parse_errors += 1
            continue
        values = block if isinstance(block, list) else [block]
        for value in values:
            for item in value.get("@graph", [value]) if isinstance(value, dict) else []:
                if isinstance(item, dict) and item.get("@type"):
                    types.extend(item["@type"] if isinstance(item["@type"], list) else [item["@type"]])
    return {
        "source": source,
        "final_url": final_url,
        "title": parser.title,
        "canonical": urljoin(final_url, parser.canonical) if parser.canonical else None,
        "robots_meta": robots,
        "headings": parser.headings,
        "h1_count": sum(h["level"] == 1 for h in parser.headings),
        "question_heading_count": sum(h["question"] for h in parser.headings),
        "answer_signals": {"question_marks": visible.count("?"), "word_count": len(visible.split())},
        "link_count": len(parser.links),
        "jsonld_types": sorted(set(types)),
        "jsonld_blocks": len(parser.jsonld),
        "jsonld_parse_errors": parse_errors,
        "findings": [
            *(["missing title"] if not parser.title else []),
            *(["expected one H1"] if sum(h["level"] == 1 for h in parser.headings) != 1 else []),
            *(["no question-shaped headings detected"] if not any(h["question"] for h in parser.headings) else []),
            *(["JSON-LD parse error"] if parse_errors else []),
        ],
        "limitations": ["Read-only structure check; does not prove indexing, retrieval, citation, ranking, or conversion.", "Static parsing may miss content rendered only after JavaScript."],
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("source", nargs="?", help="local HTML file")
    ap.add_argument("--stdin", action="store_true", help="read collector-preserved HTML from stdin")
    ap.add_argument("--source-url", help="source URL for --stdin evidence")
    ap.add_argument("--json", action="store_true", dest="as_json", help="emit JSON (default)")
    args = ap.parse_args()
    try:
        if args.stdin:
            if not args.source_url or args.source:
                raise ValueError("--stdin requires --source-url and no positional source")
            result = audit_html(sys.stdin.read(), args.source_url, args.source_url)
        elif args.source:
            result = audit(args.source)
        else:
            raise ValueError("local source or --stdin required")
        print(json.dumps(result, indent=2, sort_keys=True))
    except (OSError, ValueError, TimeoutError) as exc:
        print(f"aeo-audit: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
