"use client";

import { useMemo, useState } from "react";
import Link from "next/link";

export interface SkillCard {
  id: string;
  slug: string;
  name: string;
  summary: string;
  category: string;
}

/** 技能市场：搜索框 + 按分类分组的卡片列表（客户端过滤） */
export default function SkillMarket({ skills }: { skills: SkillCard[] }) {
  const [keyword, setKeyword] = useState("");

  const filtered = useMemo(() => {
    const kw = keyword.trim();
    if (!kw) return skills;
    return skills.filter((s) => s.name.includes(kw) || s.summary.includes(kw));
  }, [skills, keyword]);

  const grouped = useMemo(() => {
    const map = new Map<string, SkillCard[]>();
    for (const s of filtered) {
      const list = map.get(s.category) ?? [];
      list.push(s);
      map.set(s.category, list);
    }
    return [...map.entries()];
  }, [filtered]);

  return (
    <>
      <input
        className="search-input"
        placeholder="搜索技能，如：周报、发票、翻译…"
        value={keyword}
        onChange={(e) => setKeyword(e.target.value)}
      />

      {grouped.length === 0 ? (
        <p className="empty-state">
          {skills.length === 0
            ? "暂无已发布的技能，IT 同事可通过 skillhive publish 发布。"
            : "没有匹配的技能，换个关键词试试。"}
        </p>
      ) : (
        grouped.map(([category, list]) => (
          <section key={category}>
            <h2 className="category-title">
              {category}（{list.length}）
            </h2>
            <div className="card-grid">
              {list.map((s) => (
                <Link key={s.id} href={`/skills/${s.slug}`} className="skill-card">
                  <span className="name">{s.name}</span>
                  <span className="badge">{s.category}</span>
                  <p className="summary">{s.summary}</p>
                </Link>
              ))}
            </div>
          </section>
        ))
      )}
    </>
  );
}
