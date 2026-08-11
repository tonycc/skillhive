interface Skill {
  id: string;
  slug: string;
  name: string;
  summary: string;
  category: string;
}

/** 技能市场首页（服务端组件，直接请求 Registry） */
export default async function HomePage() {
  const registryUrl = process.env.SKILLHIVE_REGISTRY_URL ?? "http://localhost:3001";

  let skills: Skill[] = [];
  try {
    const res = await fetch(`${registryUrl}/api/skills`, { cache: "no-store" });
    if (res.ok) {
      skills = ((await res.json()) as { data: Skill[] }).data;
    }
  } catch {
    // Registry 未启动时展示空状态
  }

  return (
    <main style={{ maxWidth: 960, margin: "0 auto", padding: "48px 24px" }}>
      <h1>🐝 SkillHive 技能蜂巢</h1>
      <p>企业内部 AI Skill 市场 —— 在 WorkBuddy 中即可使用以下技能</p>

      {skills.length === 0 ? (
        <p style={{ color: "#888" }}>
          暂无已发布的 skill。IT 同事可通过 <code>skillhive publish</code> 发布第一个技能。
        </p>
      ) : (
        <ul style={{ padding: 0, listStyle: "none", display: "grid", gap: 16 }}>
          {skills.map((s) => (
            <li
              key={s.id}
              style={{ border: "1px solid #eee", borderRadius: 8, padding: 16 }}
            >
              <strong>{s.name}</strong>
              <span style={{ marginLeft: 8, fontSize: 12, color: "#666" }}>{s.category}</span>
              <p style={{ margin: "8px 0 0", color: "#444" }}>{s.summary}</p>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
