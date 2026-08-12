#!/usr/bin/env python3
"""生成 SVG 图表（零第三方依赖）。

用法：python3 make_chart.py '<配置JSON>' <输出文件.svg>
配置：{
  "title": "图表标题",
  "type": "bar" | "line" | "pie",
  "labels": ["1月", "2月", ...],
  "values": [120, 150, ...]
}
"""

import json
import math
import sys

WIDTH, HEIGHT = 640, 400
MARGIN = {"left": 64, "right": 24, "top": 48, "bottom": 48}
PALETTE = ["#4e79a7", "#f28e2b", "#e15759", "#76b7b2", "#59a14f", "#edc948"]


def esc(s: object) -> str:
    return str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def y_axis(parts: list, vmax: float) -> None:
    """Y 轴刻度（0 / 50% / 100% 三档）。"""
    plot_h = HEIGHT - MARGIN["top"] - MARGIN["bottom"]
    for ratio in (0, 0.5, 1):
        y = MARGIN["top"] + plot_h * (1 - ratio)
        label = f"{vmax * ratio:g}"
        parts.append(
            f'<line x1="{MARGIN["left"]}" y1="{y}" x2="{WIDTH - MARGIN["right"]}" y2="{y}" stroke="#e0e0e0"/>'
            f'<text x="{MARGIN["left"] - 8}" y="{y + 4}" text-anchor="end" font-size="11" fill="#666">{esc(label)}</text>'
        )


def render_bar(title: str, labels: list, values: list) -> str:
    vmax = max(values) or 1
    plot_w = WIDTH - MARGIN["left"] - MARGIN["right"]
    plot_h = HEIGHT - MARGIN["top"] - MARGIN["bottom"]
    slot = plot_w / len(values)
    bar_w = min(slot * 0.6, 60)
    parts = [f'<text x="{WIDTH / 2}" y="28" text-anchor="middle" font-size="16" font-weight="bold">{esc(title)}</text>']
    y_axis(parts, vmax)
    for i, (label, value) in enumerate(zip(labels, values)):
        x = MARGIN["left"] + slot * i + (slot - bar_w) / 2
        h = plot_h * value / vmax
        y = MARGIN["top"] + plot_h - h
        parts.append(
            f'<rect x="{x:.1f}" y="{y:.1f}" width="{bar_w:.1f}" height="{h:.1f}" fill="{PALETTE[0]}" rx="2"/>'
            f'<text x="{x + bar_w / 2:.1f}" y="{y - 6:.1f}" text-anchor="middle" font-size="11" fill="#333">{value:g}</text>'
            f'<text x="{x + bar_w / 2:.1f}" y="{HEIGHT - MARGIN["bottom"] + 18}" text-anchor="middle" font-size="11" fill="#666">{esc(label)}</text>'
        )
    return svg(parts)


def render_line(title: str, labels: list, values: list) -> str:
    vmax = max(values) or 1
    plot_w = WIDTH - MARGIN["left"] - MARGIN["right"]
    plot_h = HEIGHT - MARGIN["top"] - MARGIN["bottom"]
    step = plot_w / max(len(values) - 1, 1)
    points = [
        (MARGIN["left"] + step * i, MARGIN["top"] + plot_h * (1 - v / vmax))
        for i, v in enumerate(values)
    ]
    parts = [f'<text x="{WIDTH / 2}" y="28" text-anchor="middle" font-size="16" font-weight="bold">{esc(title)}</text>']
    y_axis(parts, vmax)
    path = " ".join(f"{x:.1f},{y:.1f}" for x, y in points)
    parts.append(f'<polyline points="{path}" fill="none" stroke="{PALETTE[0]}" stroke-width="2.5"/>')
    for (x, y), label, value in zip(points, labels, values):
        parts.append(
            f'<circle cx="{x:.1f}" cy="{y:.1f}" r="4" fill="{PALETTE[0]}"/>'
            f'<text x="{x:.1f}" y="{y - 10:.1f}" text-anchor="middle" font-size="11" fill="#333">{value:g}</text>'
            f'<text x="{x:.1f}" y="{HEIGHT - MARGIN["bottom"] + 18}" text-anchor="middle" font-size="11" fill="#666">{esc(label)}</text>'
        )
    return svg(parts)


def render_pie(title: str, labels: list, values: list) -> str:
    total = sum(values) or 1
    cx, cy, r = WIDTH / 2 - 60, HEIGHT / 2 + 10, 120
    parts = [f'<text x="{WIDTH / 2}" y="28" text-anchor="middle" font-size="16" font-weight="bold">{esc(title)}</text>']
    angle = -math.pi / 2
    for i, (label, value) in enumerate(zip(labels, values)):
        sweep = 2 * math.pi * value / total
        x1, y1 = cx + r * math.cos(angle), cy + r * math.sin(angle)
        x2, y2 = cx + r * math.cos(angle + sweep), cy + r * math.sin(angle + sweep)
        large = 1 if sweep > math.pi else 0
        color = PALETTE[i % len(PALETTE)]
        if len(values) == 1:  # 单值时画整圆
            parts.append(f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="{color}"/>')
        else:
            parts.append(
                f'<path d="M{cx},{cy} L{x1:.1f},{y1:.1f} A{r},{r} 0 {large} 1 {x2:.1f},{y2:.1f} Z" fill="{color}"/>'
            )
        pct = value / total * 100
        parts.append(
            f'<rect x="{WIDTH - 170}" y="{70 + i * 22}" width="12" height="12" fill="{color}"/>'
            f'<text x="{WIDTH - 152}" y="{80 + i * 22}" font-size="12" fill="#333">{esc(label)}（{pct:.1f}%）</text>'
        )
        angle += sweep
    return svg(parts)


def svg(parts: list) -> str:
    body = "\n  ".join(parts)
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{WIDTH}" height="{HEIGHT}" '
        f'font-family="PingFang SC, Microsoft YaHei, sans-serif">\n'
        f'  <rect width="{WIDTH}" height="{HEIGHT}" fill="#fff"/>\n  {body}\n</svg>\n'
    )


def main() -> None:
    if len(sys.argv) != 3:
        print('用法：python3 make_chart.py \'{"title":"...","type":"bar|line|pie","labels":[...],"values":[...]}\' <输出.svg>', file=sys.stderr)
        sys.exit(1)
    cfg = json.loads(sys.argv[1])
    labels, values = cfg["labels"], cfg["values"]
    if len(labels) != len(values):
        print("labels 与 values 长度不一致", file=sys.stderr)
        sys.exit(1)
    renderers = {"bar": render_bar, "line": render_line, "pie": render_pie}
    renderer = renderers.get(cfg.get("type", "bar"))
    if renderer is None:
        print(f"不支持的图表类型：{cfg.get('type')}（可选 bar/line/pie）", file=sys.stderr)
        sys.exit(1)
    with open(sys.argv[2], "w", encoding="utf-8") as f:
        f.write(renderer(cfg.get("title", ""), labels, values))
    print(f"✓ 图表已生成：{sys.argv[2]}")


if __name__ == "__main__":
    main()
