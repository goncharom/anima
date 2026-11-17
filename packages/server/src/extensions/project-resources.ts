import {
  DefaultPackageManager,
  formatSkillsForPrompt,
  getAgentDir,
  loadProjectContextFiles,
  loadSkills,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { defineExtension, section } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";

/**
 * Keep the existing extension name: both roles (including persisted conversations) select
 * coding-tools. Render from each request's cwd instead of copying resources into agent instructions.
 */
export const ProjectCodingTools = defineExtension({
  ...CodingTools,
  sections: [
    ...(CodingTools.sections ?? []),
    section("cwd", (input) => input.env?.cwd ?? input.agent.cwd ?? process.cwd()),
    section("project_context", (input) => {
      const cwd = input.env?.cwd ?? input.agent.cwd ?? process.cwd();
      const files = loadProjectContextFiles({ cwd, agentDir: getAgentDir() });
      if (files.length === 0) return undefined;
      return [
        "Project-specific instructions and guidelines:",
        ...files.map(({ path, content }) =>
          `<project_instructions path=${JSON.stringify(path)}>\n${content}\n</project_instructions>`),
      ].join("\n\n");
    }),
    section("skills", async (input) => {
      const cwd = input.env?.cwd ?? input.agent.cwd ?? process.cwd();
      const agentDir = getAgentDir();
      // Anima already runs coding tools in the selected project; use Pi's SDK trust default.
      const settingsManager = SettingsManager.create(cwd, agentDir);
      const packages = new DefaultPackageManager({ cwd, agentDir, settingsManager });
      // Reuse Pi's .pi/.agents discovery, settings filters, and installed package resources,
      // without executing Pi extensions or installing missing packages during a model request.
      const paths = await packages.resolve(async () => "skip");
      const { skills, diagnostics } = loadSkills({
        cwd, agentDir, includeDefaults: false,
        skillPaths: paths.skills.filter((resource) => resource.enabled).map((resource) => resource.path),
      });
      for (const error of settingsManager.drainErrors()) {
        console.error(`Pi settings ${error.path ?? error.scope}:`, error.error);
      }
      for (const diagnostic of diagnostics) {
        console.error(`Skill ${diagnostic.path}: ${diagnostic.message}`);
      }
      const readers = ["read", "bash"] as const;
      const reader = readers.find((name) => input.agent.tools.some((tool) => tool.name === name))
        ?? (readers.some((name) => input.agent.callable.some((tool) => tool.name === name)) ? "indirect" : undefined);
      return reader ? formatSkillsForPrompt(skills, reader).trim() || undefined : undefined;
    }),
  ],
});
