import SkillMarket, { type SkillCard } from "../components/SkillMarket";

const REGISTRY_URL = process.env.SKILLHIVE_REGISTRY_URL ?? "http://localhost:3001";

/** 技能市场首页（服务端取数，客户端过滤） */
export default async function HomePage() {
  let skills: SkillCard[] = [];
  try {
    const res = await fetch(`${REGISTRY_URL}/api/skills`, { cache: "no-store" });
    if (res.ok) {
      skills = ((await res.json()) as { data: SkillCard[] }).data;
    }
  } catch {
    // Registry 未启动时展示空状态
  }

  return (
    <main className="container">
      <header className="site-header">
        <h1>🐝 SkillHive 技能蜂巢</h1>
        <p>企业 AI 技能市场 · 在 WorkBuddy 中即可使用</p>
      </header>
      <SkillMarket skills={skills} />
    </main>
  );
}
