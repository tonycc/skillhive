import Link from "next/link";
import { marked } from "marked";

const REGISTRY_URL = process.env.SKILLHIVE_REGISTRY_URL ?? "http://localhost:3001";

interface SkillDetail {
  slug: string;
  name: string;
  summary: string;
  category: string;
  status: string;
  latestVersion: {
    version: string;
    changelog: string;
    body: string;
  } | null;
  visibleDepartments: string[];
}

/** Skill 详情页：使用指引 + SKILL.md 正文渲染 */
export default async function SkillDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  let skill: SkillDetail | null = null;
  try {
    const res = await fetch(`${REGISTRY_URL}/api/skills/${slug}`, {
      cache: "no-store",
    });
    if (res.ok) {
      skill = ((await res.json()) as { data: SkillDetail }).data;
      // 上报浏览埋点（不阻塞渲染）
      void fetch(`${REGISTRY_URL}/api/skills/${slug}/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event: "view", client: "console" }),
      }).catch(() => {});
    }
  } catch {
    // Registry 不可用
  }

  if (!skill) {
    return (
      <main className="container">
        <Link href="/" className="back-link">
          ← 返回技能市场
        </Link>
        <p className="empty-state">技能「{slug}」不存在或 Registry 服务不可用。</p>
      </main>
    );
  }

  const bodyHtml = skill.latestVersion?.body
    ? await marked.parse(skill.latestVersion.body)
    : "";

  return (
    <main className="container">
      <Link href="/" className="back-link">
        ← 返回技能市场
      </Link>

      <header className="site-header" style={{ marginTop: 16 }}>
        <h1>{skill.name}</h1>
      </header>
      <p style={{ color: "var(--text-secondary)" }}>{skill.summary}</p>

      <div className="detail-meta">
        <span>分类：{skill.category}</span>
        <span>版本：v{skill.latestVersion?.version ?? "-"}</span>
        <span>
          可见范围：
          {skill.visibleDepartments.length === 0
            ? "全员"
            : skill.visibleDepartments.join("、")}
        </span>
      </div>

      <div className="usage-tip">
        💡 在 WorkBuddy 对话中通过快捷指令选择「{skill.slug}」即可使用本技能；
        也可以说「用 {skill.name} 帮我…」让 AI 自动调用。
      </div>

      {skill.latestVersion?.changelog && (
        <p style={{ fontSize: 13, color: "var(--text-secondary)" }}>
          最近更新：{skill.latestVersion.changelog}
        </p>
      )}

      <article
        className="markdown-body"
        dangerouslySetInnerHTML={{ __html: bodyHtml }}
      />
    </main>
  );
}
