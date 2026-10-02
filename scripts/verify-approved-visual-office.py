"""Open generated native decks in LibreOffice without modifying any source.

python3 scripts/verify-approved-visual-office.py --input=.openpbl-runtime/approved-visuals/model-run
The resulting PDF/text/PNG measurements require a separate visual review.
"""
import argparse
import hashlib
import json
import pathlib
import re
import subprocess
from html.parser import HTMLParser


class VisibleText(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []

    def handle_data(self, value):
        self.parts.append(value)


def plain(value):
    parser = VisibleText()
    parser.feed(value or "")
    return "".join(parser.parts)


def normalize(value):
    return re.sub(r"\s|\u200b|\u00ad", "", value)


def digest(filename):
    return hashlib.sha256(filename.read_bytes()).hexdigest()


def run(argv, timeout=90):
    result = subprocess.run(argv, capture_output=True, text=True, timeout=timeout, check=False)
    return {"argv": argv, "returncode": result.returncode, "stdout": result.stdout, "stderr": result.stderr}


def save(filename, value):
    filename.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def main():
    args = argparse.ArgumentParser()
    args.add_argument("--input", required=True)
    args.add_argument("--output")
    args.add_argument("--ids", help="Comma-separated result IDs; defaults to all saved cases.")
    options = args.parse_args()
    root = pathlib.Path.cwd().resolve()
    source = (root / options.input).resolve()
    output = (root / options.output).resolve() if options.output else source / "office-review"
    runtime = root / ".openpbl-runtime"
    if not source.is_relative_to(runtime) or not output.is_relative_to(runtime):
        raise RuntimeError("Office验证仅允许隔离运行目录")
    if output.exists():
        raise RuntimeError("输出已存在；保留旧Office证据，用新目录复验")
    selected = set(options.ids.split(",")) if options.ids else None
    results = [json.loads(filename.read_text()) for filename in sorted((source / "results").glob("*.json"))]
    results = [result for result in results if selected is None or result["id"] in selected]
    if not results:
        raise RuntimeError("没有待检查案例")
    if selected and selected != {result["id"] for result in results}:
        raise RuntimeError("请求案例不完整，不能静默跳过")
    output.mkdir(parents=True)
    exports = json.loads((source / "acceptance-report.json").read_text())
    report = {"method": "实际原生PPTX→LibreOffice→PDF/pdftotext/pdftoppm；不使用PPTX进口器，不等同于Microsoft PowerPoint实开。",
              "input": str(source), "providerCalls": 0, "audioCalls": 0, "courseWrites": 0,
              "officeVersion": run(["libreoffice", "--version"]),
              "exportImplementationSha256": exports.get("exportImplementationSha256"),
              "exportImplementationUnchanged": exports.get("exportImplementationUnchanged"),
              "cases": [], "beautyReview": "pending", "teacherAcceptance": "pending"}
    for result in results:
        result_id = result["id"]
        deck = source / "exports" / f"{result_id}.pptx"
        case_dir = output / result_id
        case_dir.mkdir()
        record = {"id": result_id, "classification": result.get("attemptClassification"), "pptx": str(deck),
                  "pages": [], "visualReview": "pending"}
        report["cases"].append(record)
        try:
            record["pptxSha256Before"] = digest(deck)
            pages = [result["final"]] + result["final"].get("continuationPages", [])
            profile = output / "libreoffice-profile"
            record["conversion"] = run(["libreoffice", "--headless", f"-env:UserInstallation={profile.as_uri()}",
                                         "--convert-to", "pdf", "--outdir", str(case_dir), str(deck)])
            pdf = case_dir / f"{result_id}.pdf"
            if record["conversion"]["returncode"] != 0 or not pdf.exists():
                raise RuntimeError("LibreOffice未输出PDF，原转换日志已保留")
            record["pdfinfo"] = run(["pdfinfo", str(pdf)])
            count = re.search(r"^Pages:\s+(\d+)", record["pdfinfo"]["stdout"], re.MULTILINE)
            record["expectedPages"] = len(pages)
            record["actualPages"] = int(count.group(1)) if count else None
            record["pageCountMatches"] = record["actualPages"] == len(pages)
            record["rasterization"] = run(["pdftoppm", "-png", "-r", "108", str(pdf), str(case_dir / "page")])
            for index, page in enumerate(pages, 1):
                text_file = case_dir / f"page-{index}.txt"
                extraction = run(["pdftotext", "-f", str(index), "-l", str(index), "-layout", str(pdf), str(text_file)])
                visible = text_file.read_text() if text_file.exists() else ""
                expected = []
                for element in page["elements"]:
                    html = element.get("content") if element["type"] == "text" else element.get("text", {}).get("content") if element["type"] == "shape" else None
                    if html:
                        expected.append({"id": element["id"], "text": plain(html)})
                presence = [{**item, "present": normalize(item["text"]) in normalize(visible)} for item in expected]
                png = sorted(case_dir.glob("page-*.png"))
                record["pages"].append({"page": index, "textExtraction": extraction, "screenshot": str(png[index - 1]) if index <= len(png) else None,
                                        "textPresence": presence, "missingExpectedTexts": [item for item in presence if not item["present"]],
                                        "nativeTextChecksPass": all(item["present"] for item in presence), "visualReview": "pending"})
            record["pptxSha256After"] = digest(deck)
            record["sourceDeckUnchanged"] = record["pptxSha256After"] == record["pptxSha256Before"]
            record["status"] = "passed-structure" if record["pageCountMatches"] and record["sourceDeckUnchanged"] and all(page["nativeTextChecksPass"] for page in record["pages"]) else "requires-review"
        except Exception as error:  # A real Office error must remain visible alongside all successful cases.
            record["status"] = "failed"
            record["error"] = str(error)
        save(output / "report.json", report)
        print(json.dumps({"id": result_id, "status": record["status"], "pages": record.get("actualPages"),
                          "missingTexts": sum(len(page["missingExpectedTexts"]) for page in record["pages"])}, ensure_ascii=False), flush=True)
    report["structuralFailures"] = sum(case["status"] != "passed-structure" for case in report["cases"])
    report["limitations"] = ["完整文本检测忽略空白；图形描边、多子path、小dot、路径与外置标注需实际PNG逐页查看。",
                             "Office结构或文本检测通过不能替代与认可样稿的美观比较。", "新音频未生成；教学计划时长不视为实际播放时长。"]
    save(output / "report.json", report)


if __name__ == "__main__":
    main()
