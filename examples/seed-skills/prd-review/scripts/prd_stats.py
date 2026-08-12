#!/usr/bin/env python3
"""统计 PRD 文档概况：字数、章节结构、待办项数量。

用法：python3 prd_stats.py <prd文件路径>
输出：JSON，供 AI 评审时作为背景信息引用。
"""

import json
import re
import sys


def main() -> None:
    if len(sys.argv) != 2:
        print("用法：python3 prd_stats.py <prd文件路径>", file=sys.stderr)
        sys.exit(1)

    with open(sys.argv[1], encoding="utf-8") as f:
        text = f.read()

    # 中文字符 + 英文单词合计作为"字数"
    chars = len(re.findall(r"[一-鿿]", text))
    words = len(re.findall(r"[A-Za-z0-9]+", text))

    headings = re.findall(r"^(#{1,3})\s+(.+)$", text, re.MULTILINE)
    todos = re.findall(r"(?i)\b(TODO|TBD|待定|待确认|待补充)\b", text)

    result = {
        "字数估算": chars + words,
        "章节数": len(headings),
        "章节结构": [f"{'#' * len(h)} {t.strip()}" for h, t in headings],
        "待办项数量": len(todos),
        "待办项提示": "存在未决事项，评审时需逐项确认" if todos else "无显式待办项",
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
