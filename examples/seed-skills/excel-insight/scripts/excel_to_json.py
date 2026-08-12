#!/usr/bin/env python3
"""解析 Excel（.xlsx）为 JSON 摘要，供 AI 分析使用。

用法：python3 excel_to_json.py <文件路径.xlsx>
依赖：openpyxl（缺失时给出安装提示并以退出码 2 退出）
输出：JSON {sheets: [{name, 行数, 列数, columns: [{name, 类型, 统计...}], 样例行}]}
"""

import json
import statistics
import sys

try:
    import openpyxl
except ImportError:
    print(
        json.dumps(
            {"error": "缺少依赖 openpyxl，请先执行：pip3 install openpyxl"},
            ensure_ascii=False,
        )
    )
    sys.exit(2)

MAX_SAMPLE_ROWS = 5
MAX_ROWS = 10000  # 防止超大表撑爆内存


def column_summary(values: list) -> dict:
    """推断列类型并给出统计。"""
    non_empty = [v for v in values if v is not None and v != ""]
    summary: dict = {"非空行数": len(non_empty), "空行数": len(values) - len(non_empty)}
    if not non_empty:
        summary["类型"] = "空"
        return summary
    if all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in non_empty):
        summary["类型"] = "数值"
        summary["最小"] = round(min(non_empty), 4)
        summary["最大"] = round(max(non_empty), 4)
        summary["均值"] = round(statistics.fmean(non_empty), 4)
        summary["合计"] = round(sum(non_empty), 4)
    else:
        summary["类型"] = "文本/其他"
        distinct = {str(v) for v in non_empty}
        summary["去重值数"] = len(distinct)
        if len(distinct) <= 8:
            summary["取值"] = sorted(distinct)
    return summary


def main() -> None:
    if len(sys.argv) != 2:
        print("用法：python3 excel_to_json.py <文件路径.xlsx>", file=sys.stderr)
        sys.exit(1)

    wb = openpyxl.load_workbook(sys.argv[1], read_only=True, data_only=True)
    sheets = []
    for ws in wb.worksheets:
        rows = list(ws.iter_rows(min_row=1, max_row=MAX_ROWS + 1, values_only=True))
        if not rows:
            continue
        headers = [str(h) if h is not None else f"列{i + 1}" for i, h in enumerate(rows[0])]
        data_rows = [r for r in rows[1:] if any(v is not None and v != "" for v in r)]
        columns = []
        for i, name in enumerate(headers):
            values = [r[i] if i < len(r) else None for r in data_rows]
            col = {"name": name}
            col.update(column_summary(values))
            columns.append(col)
        sheets.append(
            {
                "工作表": ws.title,
                "行数": len(data_rows),
                "列数": len(headers),
                "columns": columns,
                "样例行": [dict(zip(headers, (str(v) for v in r))) for r in data_rows[:MAX_SAMPLE_ROWS]],
                "截断提示": f"仅统计前 {MAX_ROWS} 行" if len(data_rows) >= MAX_ROWS else None,
            }
        )
    wb.close()
    print(json.dumps({"sheets": sheets}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
